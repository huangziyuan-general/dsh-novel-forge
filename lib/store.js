// lib/store.js — 书目数据布局与机器状态（纯函数 + 路径表）。
// 机器状态一律 JSON（AGENTS.md 不变量 6）；人类/模型文档一律 Markdown。

import { chapterFileName, sanitizeTitle, nextSuffixedId } from './versioning.js';

/** 书内相对路径表（POSIX，工作区相对）。 */
export function pathsFor(book) {
    const b = book;
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
        proposal: (id) => `${b}/.novel/proposals/${id}.json`,
        // 章节文件名格式统一走 versioning.chapterFileName（与 parseChapterFileName/nextVersion 同源）
        chapterFile: (n, title, v) => `${b}/正文/${chapterFileName(n, title, v)}`,
    };
}

/** 新书机器状态。session 传了就把创建会话记进归属集（面板按会话过滤列表）。 */
export function defaultNovel({ title, genre, logline = '', now = new Date().toISOString(), session = null }) {
    return {
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
        summary,
        ...(gate === undefined || gate === null ? (base.gate === undefined ? {} : { gate: base.gate }) : { gate }),
        updatedAt: new Date().toISOString(),
    };
}

/** 事实账本 / 伏笔台账为空时的初始形态。 */
export const emptyFacts = [];
export const emptyForeshadows = [];

/** 世界书条目校验。priority（0-100，默认 50）决定预算不足时的注入顺序。 */
export function normalizeWorldEntry({ id, keywords = [], content, always = false, priority = 50 }, existing = []) {
    if (typeof content !== 'string' || content.trim() === '') throw new Error('世界书条目 content 不能为空');
    if (!Array.isArray(keywords) || (keywords.length === 0 && !always)) {
        throw new Error('世界书条目需要至少一个关键词，或 always:true 常驻注入');
    }
    const eid = id ?? nextSuffixedId(existing.map((e) => e.id), 'W');
    if (existing.some((e) => e.id === eid)) throw new Error(`世界书条目 id 重复：${eid}`);
    const prio = Number.isInteger(priority) ? Math.max(0, Math.min(100, priority)) : 50;
    return { id: eid, keywords: keywords.map(String), content: content.trim(), always: Boolean(always), priority: prio };
}
