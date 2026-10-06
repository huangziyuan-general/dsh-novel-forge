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
import { openIndex, loadSqlite, indexedChapters, pruneChapters } from './retrieval.js';
import { ghostIndexChapters } from './health.js';

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