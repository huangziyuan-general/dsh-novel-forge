// lib/store.js — 书目数据布局与机器状态（纯函数 + 路径表）。
// 机器状态一律 JSON（AGENTS.md 不变量 6）；人类/模型文档一律 Markdown。

import { chapterFileName, sanitizeTitle, nextSuffixedId } from './versioning.js';

/** 书内相对路径表（POSIX，工作区相对）。 */
export function pathsFor(book) {
    const b = book;
    // 正文目录名单一真相：chapterFile 与 repair 的孤儿扫描共用它。
    // 各处再拼一次字面量，目录改名时写入与扫描会分家——扫描扫不到东西会报「零孤儿」，
    // 那是假清白，比报错更糟。
    const chaptersDir = `${b}/正文`;
    return {
        meta: `${b}/novel.json`,
        bookOutline: `${b}/大纲/全书大纲.md`,
        outlineDir: `${b}/大纲/细纲`,
        chapterOutline: (n) => `${b}/大纲/细纲/第${n}章.md`,
        character: (name) => `${b}/人物/${sanitizeTitle(name)}.md`,
        worldbook: `${b}/设定/世界书.json`,
        glossary: `${b}/设定/术语表.json`,
        promise: `${b}/设定/故事承诺书.md`,
        sceneContracts: `${b}/设定/场景契约.json`,
        voices: `${b}/设定/语言基因.json`,
        facts: `${b}/账本/facts.json`,
        foreshadows: `${b}/账本/伏笔.json`,
        audit: `${b}/.novel/audit.jsonl`,
        styleBaseline: `${b}/.novel/style-baseline.json`,
        // G1 检索索引（派生物：删了重跑即得，绝不参与一致性判定）
        indexDb: `${b}/.novel/index.db`,
        proposalsDir: `${b}/.novel/proposals`,
        proposal: (id) => `${b}/.novel/proposals/${id}.json`,
        // 章节文件名格式统一走 versioning.chapterFileName（与 parseChapterFileName/nextVersion 同源）
        chaptersDir,
        chapterFile: (n, title, v) => `${chaptersDir}/${chapterFileName(n, title, v)}`,
    };
}

/**
 * `novel.json` 的数据格式版本锚点（方向3）。
 *
 * 为什么要有它：此前每次加字段/改语义都是「临时补丁」（如 worldbook id 回填），
 * 盘上数据到底是哪一版、还差哪些结构，没人能判定。落一个版本号后，「这本旧书需要升级」
 * 成为可判定的事实；升级逻辑集中在 migrateNovel（幂等、失败不阻断写作）。
 *
 * 维护约定：改了 novel.json 的结构（新增必需容器字段 / 字段语义变更）就 +1，
 * 并在 migrateNovel 里补对应的补结构分支。纯加可选字段不算。
 */
export const SCHEMA_VERSION = 1;

/**
 * 书目稳定 id（方向4）：书目录名会被改名/被多根同名拷贝撞车，`book` 只是**定位用的
 * 目录名**，不是身份。落一个稳定 id 后，「同名书的哪一份」才有可靠判据。
 * 刻意不 import node:crypto——本模块会被打进浏览器 bundle（panel 与宿主共用会话判据）。
 */
export function newBookId(now = Date.now()) {
    return `nb_${now.toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * novel.json 数据格式迁移（**纯函数**，幂等）。旧书读到时自动补齐结构锚点。
 *
 * 语义（重要）：
 *   - 只**补结构**、不改内容：缺失的容器字段补空壳，旧书补稳定 id。
 *   - 版本缺失 → 视为 v0；已是当前 → 只补缺的字段；**高于当前 → 一律不动**
 *     （用户可能装过更新的插件，本地降级不得把数据改坏）。
 *   - 幂等：对已迁移的书再跑一次返回 changed:false。
 *
 * @returns {{ novel, from:number, to:number, changed:boolean, notes:string[] }}
 */
export function migrateNovel(novel) {
    const notes = [];
    if (novel === null || typeof novel !== 'object') return { novel, from: 0, to: 0, changed: false, notes };
    const from = Number.isInteger(novel.schemaVersion) ? novel.schemaVersion : 0;
    if (from > SCHEMA_VERSION) {
        notes.push(`本书数据版本 v${from} 高于本插件支持的 v${SCHEMA_VERSION}——可能装过更新的插件，不做降级迁移`);
        return { novel, from, to: from, changed: false, notes };
    }
    let changed = false;
    const ensureObj = (key, label) => {
        if (novel[key] === null || typeof novel[key] !== 'object' || Array.isArray(novel[key])) {
            novel[key] = {}; changed = true; notes.push(label);
        }
    };
    if (typeof novel.id !== 'string' || novel.id === '') { novel.id = newBookId(); changed = true; notes.push('补稳定 id'); }
    if (!Array.isArray(novel.sessions)) { novel.sessions = []; changed = true; notes.push('补会话归属集'); }
    if (!Array.isArray(novel.cast)) { novel.cast = []; changed = true; notes.push('补人物名册'); }
    if (!Array.isArray(novel.proposals)) { novel.proposals = []; changed = true; notes.push('补提案索引'); }
    ensureObj('chapters', '补章节索引');
    ensureObj('gateFailures', '补熔断计数');
    ensureObj('approvals', '补审批表');
    // 克隆书曾落成 approvals:{}，approve 读 approvals.outline 会 TypeError——旧书一并补上
    if (novel.approvals.outline === null || typeof novel.approvals.outline !== 'object' || Array.isArray(novel.approvals.outline)) {
        novel.approvals.outline = {}; changed = true; notes.push('补细纲审批对象（缺它 approve 会报错）');
    }
    if (from < SCHEMA_VERSION) { changed = true; notes.push(`数据格式 v${from} → v${SCHEMA_VERSION}`); }
    novel.schemaVersion = SCHEMA_VERSION;
    return { novel, from, to: SCHEMA_VERSION, changed, notes };
}

/** 新书机器状态。session 传了就把创建会话记进归属集（面板按会话过滤列表）。 */
export function defaultNovel({ title, genre, logline = '', now = new Date().toISOString(), session = null }) {
    return {
        id: newBookId(),
        // 数据格式版本锚点：新书直接落当前版本，旧书由 migrateNovel 在读到时补齐
        schemaVersion: SCHEMA_VERSION,
        title,
        genre,
        logline,
        sessions: session ? [session] : [],
        // 九阶段状态机（lib/phases.js）的当前阶段；phases 记每阶段状态与 PhaseReport。
        stage: 'topic',
        phases: {},
        createdAt: now,
        updatedAt: now,
        approvals: { outline: {} },
        chapters: {},
        cast: [],
        proposals: [],
        // 熔断计数器（lib/circuit-breaker.js）：章号 → 连续驳回次数。
        gateFailures: {},
    };
}

/**
 * 会话归属：这本书是否属于某会话。
 *
 * 列表按会话过滤（「项目跟会话走」）的**唯一判据**，所以放在这里当纯函数，
 * 服务端 REST 与面板共用一份实现。`sessions` 缺失/为空 = 未归属（旧版建的书），
 * 不属于任何会话 —— 由面板的「认领」通道补录。
 */
export function bookInSession(novel, sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return false;
    return (novel?.sessions ?? []).includes(sessionId);
}

/** 是否未归属（任何会话都看不到，等认领）。 */
export function isUnclaimed(novel) {
    return (novel?.sessions ?? []).length === 0;
}

/**
 * 把会话补录进书的归属集。
 * @returns {boolean} 是否真的改了（已存在或 sessionId 为空 → false）
 */
export function addBookSession(novel, sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return false;
    if (!Array.isArray(novel.sessions)) novel.sessions = [];
    if (novel.sessions.includes(sessionId)) return false;
    novel.sessions.push(sessionId);
    return true;
}

/** 章节 index 记录（novel.json.chapters[n]）。files 保留近 20 个版本文件名。
 *  gate 传入时落盘契约指标（覆盖率/偏离度/漏写场景/命中禁项，带时间戳）——趋势可查。 */
export function chapterRecord(prev, { title, version, file, chars, summary, gate }) {
    const base = prev ?? { title, versions: [], files: [] };
    return {
        title,
        versions: [...new Set([...(base.versions ?? []), version])].sort((a, b) => a - b),
        files: [...(base.files ?? []), { version, file }].slice(-20),
        latest: version,
        path: file,
        chars,
        // summary 缺省补 ''：REST 面板存章不传 summary（undefined 混进 novel_project
        // status/repair 的输出会让宿主 lossless JSON 拒收整次调用——真机已复现）；
        // 工具写的章在面板再存一版时，旧 summary 也不能被 REST 路径抹掉
        summary: summary ?? base.summary ?? '',
        ...(gate === undefined || gate === null ? (base.gate === undefined ? {} : { gate: base.gate }) : { gate }),
        updatedAt: new Date().toISOString(),
    };
}

/** 从章节记录解析「当前正文」的工作区相对路径（rec.path 优先，回退 files 末条）。
 *  0.13.1 事故：server-api 曾读不存在的 rec.file 还另拼一层 bookId/正文/ → 阅读器恒空。
 *  schema 只认 path / files[].file，两者都已含书目前缀，直接交给 fsio.readText。 */
export function chapterRelPath(rec) {
    return rec?.path ?? (rec?.files ?? []).at(-1)?.file ?? null;
}

/** 事实账本 / 伏笔台账为空时的初始形态。 */
export const emptyFacts = [];
export const emptyForeshadows = [];

/**
 * 世界书条目 id 的**单一生成入口**。工具（novel_worldbook add）、REST 面板
 * （POST /worldbook）与导入都必须走它，保证 id 方案一致（`W` 前缀自增）。
 *
 * 曾有两条并行方案（工具 `W1`、REST 用 Math.max 数字自增），对已有字符串 id 求
 * 数值会得 NaN → 落盘成 `"id": null`（真机可复现）。统一到 `W` 前缀后这类事故从根上消失。
 */
export function nextWorldEntryId(entries) {
    return nextSuffixedId((Array.isArray(entries) ? entries : []).map((e) => e?.id), 'W');
}

/**
 * 世界书条目 id 的**单一比较入口**。契约是字符串（工具默认 `'W1'`），但历史数据里
 * 可能混有数字（旧 REST 面板建过），一律按字符串比较。
 *
 * ⚠️ 严禁调用方自行 `Number(id)` 强转：`Number('W1')` = NaN，比较恒假 → 面板
 * 「编辑 / 启用·停用」对工具生成的条目**静默失效**（点了没反应，真机已复现）。
 * 任一值为 null/undefined 时返回 false（find 语义：空 id 不匹配任何条目）。
 */
export function sameEntryId(a, b) {
    if (a === undefined || a === null || b === undefined || b === null) return false;
    return String(a) === String(b);
}

/** 世界书条目校验。priority（0-100，默认 50）决定预算不足时的注入顺序。 */
export function normalizeWorldEntry({ id, keywords = [], content, always = false, priority = 50 }, existing = []) {
    if (typeof content !== 'string' || content.trim() === '') throw new Error('世界书条目 content 不能为空');
    if (!Array.isArray(keywords) || (keywords.length === 0 && !always)) {
        throw new Error('世界书条目需要至少一个关键词，或 always:true 常驻注入');
    }
    const eid = id ?? nextWorldEntryId(existing);
    if (existing.some((e) => sameEntryId(e.id, eid))) throw new Error(`世界书条目 id 重复：${eid}`);
    const prio = Number.isInteger(priority) ? Math.max(0, Math.min(100, priority)) : 50;
    return { id: eid, keywords: keywords.map(String), content: content.trim(), always: Boolean(always), priority: prio };
}
