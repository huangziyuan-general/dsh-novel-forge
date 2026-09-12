// lib/store.js — 书目数据布局与机器状态（纯函数 + 路径表）。
// 机器状态一律 JSON（AGENTS.md 不变量 6）；人类/模型文档一律 Markdown。

import { sanitizeTitle, nextSuffixedId } from './versioning.js';

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
        facts: `${b}/账本/facts.json`,
        foreshadows: `${b}/账本/伏笔.json`,
        audit: `${b}/.novel/audit.jsonl`,
        styleBaseline: `${b}/.novel/style-baseline.json`,
        proposal: (id) => `${b}/.novel/proposals/${id}.json`,
        chapterFile: (n, title, v) => `${b}/正文/第${n}章-${sanitizeTitle(title)}-v${v}.md`,
    };
}

/** 新书机器状态。 */
export function defaultNovel({ title, genre, logline = '', now = new Date().toISOString() }) {
    return {
        title,
        genre,
        logline,
        stage: 'planning',
        createdAt: now,
        updatedAt: now,
        approvals: { outline: {} },
        chapters: {},
        cast: [],
        proposals: [],
    };
}

/** 章节 index 记录（novel.json.chapters[n]）。files 保留近 20 个版本文件名。 */
export function chapterRecord(prev, { title, version, file, chars, summary }) {
    const base = prev ?? { title, versions: [], files: [] };
    return {
        title,
        versions: [...new Set([...(base.versions ?? []), version])].sort((a, b) => a - b),
        files: [...(base.files ?? []), { version, file }].slice(-20),
        latest: version,
        path: file,
        chars,
        summary,
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
