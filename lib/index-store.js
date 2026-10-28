// lib/index-store.js — 派生检索索引（书/.novel/index.db）的 io 收口。
//
// node:fs 例外（AGENTS.md 不变量 1）：sqlite 二进制无法走文本 fs 通道。落盘路径必须
// 经 io.abs() → 宿主 ctx.fs.resolve 取得（容器防护不绕过）；仅当宿主 fs 不暴露真实路径
// （远端/虚拟后端）时才退回 io.cwd 拼路径，并用 statSync 验证那是真实本地目录。
//
// 为什么要单独一个模块：novel_search 工具、novel_project repair、REST /continuity 三处
// 都要读这个索引，三处各写一遍「解析路径 / 建目录 / 校验本地后端 / 关句柄」迟早漂移——
// 哪一处漏了本地后端校验，就是把索引写进说不清的地方（静默故障）。这里收一份。

import { mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
    openIndex, loadSqlite, indexedChapters, pruneChapters, chunkChapter, upsertChunks, indexStats,
    readTagCacheForTexts, CORPUS_PROJECT,
} from './retrieval.js';
import { applyCachedTags } from './tag-cache.js';
import { ghostIndexChapters } from './health.js';
import { chapterRelPath } from './store.js';

/**
 * 解析索引库的**真实磁盘路径**；解析不出返回 null（调用方按「索引不可用」降级，不抛）。
 *
 * 宿主的 fs 是沙箱抽象，resolve() 可能返回不透明 target（{targetKey, displayPath}）——
 * 而 node:sqlite 要的就是真实路径。所以先从 io.abs 取，取不到再看 io.cwd 是否真实本地目录。
 */
export async function resolveIndexPath(io, p) {
    try {
        const abs = await io.abs(p.indexDb);
        if (typeof abs === 'string' && abs !== '') return abs;
    } catch { /* 宿主 fs 不提供绝对路径，走 cwd 拼 */ }
    if (typeof io?.cwd === 'string' && io.cwd !== '') {
        // ⚠️ 安全前提（2026-10-28 复核锁死）：这条回退**不做 containment 复核**，之所以
        // 安全是因为 p.indexDb 是固定模板（store.js pathsFor：`${book}/.novel/index.db`），
        // 且 book 已过 assertBookName / validBookId 白名单（禁分隔符、前导点、限长）。
        // 若将来 indexDb 变成数据驱动（从 novel.json 或入参读路径），这里必须先加
        // realWithin 同族的越界校验（见 mcp-standalone.js），否则就是路径逃逸口。
        const candidate = join(io.cwd, p.indexDb);
        try { if (statSync(io.cwd).isDirectory()) return candidate; } catch { /* 非本地后端 */ }
    }
    return null;
}

/**
 * 打开索引（默认含目录创建）。sqlite 不可用 / 无法落盘时返回 `{ok:false, db:null, reason}`，
 * **不抛**——索引是派生物，索引不可用绝不该阻断写作或对账。
 *
 * `create:false` 为**只读语义**：库文件不存在就按「索引尚未建立」降级返回，
 * 绝不 mkdir / new DatabaseSync——否则只读的 REST GET /continuity 会凭空写出
 * `.novel/index.db`（真机事故：一次体检把索引目录建了出来）。
 */
export async function openIndexForBook(io, p, { create = true } = {}) {
    const runtime = await loadSqlite();
    if (runtime === null) {
        return { ok: false, db: null, reason: '本运行时不提供 node:sqlite（需要 Node 22+）' };
    }
    const abs = await resolveIndexPath(io, p);
    if (abs === null) {
        return { ok: false, db: null, reason: '当前文件系统后端不暴露真实路径，索引无法落盘' };
    }
    if (create) {
        try {
            mkdirSync(dirname(abs), { recursive: true });
        } catch (error) {
            return { ok: false, db: null, reason: `索引目录创建失败：${error.message}` };
        }
    } else {
        let exists = false;
        try { exists = statSync(abs).isFile(); } catch { exists = false; }
        if (!exists) return { ok: false, db: null, reason: '索引尚未建立（.novel/index.db 不存在）' };
    }
    return openIndex(abs);
}

/**
 * 只读：索引里已收录的章号。不可用 / 尚未建库 → `{ok:false, reason, chapters:[]}`（不抛）。
 * 供 /continuity 的存储体检用（只诊断、不修改、**不产生写副作用**）。
 */
export async function readIndexedChapters(io, p) {
    const opened = await openIndexForBook(io, p, { create: false });
    if (!opened.ok) return { ok: false, reason: opened.reason, chapters: [] };
    try {
        return { ok: true, reason: null, chapters: indexedChapters(opened.db) };
    } finally {
        try { opened.db.close(); } catch { /* 已关闭则忽略 */ }
    }
}

/**
 * 建/增量建检索索引（**单一实现**）。
 *
 * 两个消费者：① `novel_search action=build`（模型/面板主动建）；
 * ② 章节落盘后的**自动续索引**（lib/chapter-commit.js）。
 * 以前建索引的逻辑长在工具 execute 里，想在提交链上复用就得抄一遍——抄出来的第二份
 * 一定漂移（标签保留、越书路径收口、全量时清删章幽灵块这几条保护会缺在其中一边）。
 *
 * `only=null` → 全量（并清理书里已删章的旧块）；`only=[n]` → 只收这几章（不动其它章）。
 * 任何一步不可用都按降级返回、**绝不抛**：索引是派生物，建索引失败不该把成稿报成失败。
 */
export async function indexChapters({ io, p, book, novel, only = null }) {
    const keys = Object.keys(novel?.chapters ?? {})
        .map(Number).filter((k) => Number.isInteger(k) && k >= 1).sort((a, b) => a - b);
    const wanted = (only === null ? keys : only.map(Number).filter((k) => keys.includes(k)));
    if (wanted.length === 0) {
        return { ok: false, reason: '本书没有可索引的章节', scanned: 0, added: 0, updated: 0, removed: 0, skipped: 0, chunks: 0, indexedChapters: 0, tagged: 0 };
    }
    const opened = await openIndexForBook(io, p);
    if (!opened.ok) {
        return { ok: false, reason: opened.reason, scanned: 0, added: 0, updated: 0, removed: 0, skipped: 0, chunks: 0, indexedChapters: 0, tagged: 0 };
    }
    try {
        const chunks = [];
        let scanned = 0;
        for (const k of wanted) {
            // 路径收口（跟进项①）：越书路径按缺章跳过，不把污染路径交给 readText。
            const rel = chapterRelPath(novel.chapters[String(k)], book);
            if (rel === null) continue;
            const content = await io.readText(rel);
            if (content === null) continue;
            scanned += 1;
            // ⚠️ 语料写死 project（**隔离闸门的源头**）：本函数只喂「本书章节路径」，
            // 读到的每一段都是作者自己的正文。以后若要接书库/外部参考素材，
            // 必须**新开一条索引路径**并显式写 corpus='reference'——绝不能把语料
            // 参数开放给调用方，否则外部小说原文会顺着这条路进索引、被检索召回、
            // 进续写上下文（竞品人名与设定污染本书）。
            chunks.push(...chunkChapter(content, { chapter: k, corpus: CORPUS_PROJECT }));
        }
        // 标签按**内容指纹**回填，不是按章继承（v1.3.0 修）。
        //
        // 旧做法是章级继承：`SELECT DISTINCT ch, tags` → Map<ch, tags> → 整章共用一份。
        // 那是**污染的来源**：给第 2 段打的「雪夜 决斗」会盖到第 1、3、4 段身上，
        // 检索因此召回根本不写决斗的段落（已复现）。
        //
        // 改成按块文本的指纹从缓存取：标签跟着**内容**走，块的序号因正文改写而移位
        // 也不会错位；重建索引后标签自动回来，不必把几百块重新打标一遍。
        const cache = readTagCacheForTexts(opened.db, chunks.map((c) => c.text));
        const tagged = applyCachedTags(chunks, cache);
        const result = upsertChunks(opened.db, tagged, only === null ? new Set(keys) : undefined);
        const stats = indexStats(opened.db);
        return {
            ok: true, reason: null, scanned,
            added: result.added, updated: result.updated, removed: result.removed, skipped: result.skipped,
            chunks: stats.chunks, indexedChapters: stats.chapters, tagged: stats.tagged,
        };
    } finally {
        try { opened.db.close(); } catch { /* 已关闭则忽略 */ }
    }
}

/**
 * 对账修复：清掉索引里指向「书里已无此章」的幽灵块。
 * 索引是派生物，删错重跑 build 即得，所以这里**真删**（与正文「只报告不删」相反）。
 * 只读打开（create:false）：repair 本是写动作，但在从没建过索引的书上跑 repair
 * 不该凭空 mkdir + 造一个空 index.db——没有索引就没有幽灵可清，按「尚未建立」降级。
 * 不可用 → `{ok:false, reason, ghostChapters:[], removed:0}`（repair 照常继续，不阻断，
 * reason 经 indexNote 透出）。
 */
export async function pruneGhostIndex(io, p, novelChapterKeys) {
    const opened = await openIndexForBook(io, p, { create: false });
    if (!opened.ok) return { ok: false, reason: opened.reason, ghostChapters: [], removed: 0 };
    try {
        const ghostChapters = ghostIndexChapters(indexedChapters(opened.db), novelChapterKeys);
        const removed = pruneChapters(opened.db, ghostChapters);
        return { ok: true, reason: null, ghostChapters, removed };
    } finally {
        try { opened.db.close(); } catch { /* 已关闭则忽略 */ }
    }
}