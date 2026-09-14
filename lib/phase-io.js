// lib/phase-io.js — 阶段判定的**事实快照**（IO 装配，判定仍归 lib/phases.js）。
//
// 九阶段的入场条件全是纯函数，但需要「世界书几条 / 人物几张卡 / 大纲在不在」
// 这类事实。这里把它们一次性读齐，喂给 phases.js。IO 与判定分离的写法与
// continuity-io.js 同源：面板 REST 与工具面共用一份装配，判定逻辑可单测。

import { validateContinuity } from './continuity.js';
import { loadContinuityInputs } from './continuity-io.js';

/**
 * 汇总阶段判定所需事实。
 * @param io    fsio
 * @param p     pathsFor(book)
 * @param novel novel.json 内容
 * @param opts  { continuity = true } —— 关掉可省去全书读盘（章节很多时用）
 */
export async function loadPhaseFacts(io, p, novel, { continuity = true } = {}) {
    const bookOutlineRaw = await io.readText(p.bookOutline);
    const bookOutline = bookOutlineRaw ?? '';
    const promiseRaw = await io.readText(p.promise);
    const promise = promiseRaw ?? '';
    const worldbook = (await io.readJson(p.worldbook)) ?? [];
    const chapters = novel?.chapters ?? {};
    const approvals = Object.keys(novel?.approvals?.outline ?? {});

    const savedChapterKeys = Object.keys(chapters).filter((k) => chapters[k]?.path !== undefined);
    const allApprovedWritten = approvals.length > 0 && approvals.every((k) => chapters[k]?.path !== undefined);
    const maxSaved = savedChapterKeys.reduce((m, k) => Math.max(m, Number(k) || 0), 0);
    const maxApproved = approvals.reduce((m, k) => Math.max(m, Number(k) || 0), 0);

    let continuityErrors = 0;
    if (continuity && savedChapterKeys.length > 0) {
        const inputs = await loadContinuityInputs(io, p, novel);
        continuityErrors = validateContinuity(inputs).stats.errors;
    }

    return {
        logline: novel?.logline ?? '',
        title: novel?.title ?? '',
        castCount: Array.isArray(novel?.cast) ? novel.cast.length : 0,
        worldbookCount: worldbook.length,
        hasPromise: String(promise).trim() !== '',
        hasBookOutline: String(bookOutline).trim() !== '',
        hasVolumePlan: detectVolumePlan(bookOutline),
        approvedOutlineCount: approvals.length,
        savedChapterCount: savedChapterKeys.length,
        maxApprovedChapter: maxApproved,
        maxSavedChapter: maxSaved,
        allApprovedWritten,
        continuityErrors,
    };
}

/**
 * 大纲里是否分了卷/幕/部（长篇结构信号）。纯函数，单独导出便于测试。
 * 认三种写法：Markdown 标题含 卷/幕/部/篇、正文里的「第X卷」、以及
 * 「分卷」「卷纲」这类小标题。
 */
export function detectVolumePlan(bookOutline) {
    const t = String(bookOutline ?? '');
    if (t.trim() === '') return false;
    if (/^\s*#{1,6}\s*.*(卷|幕|部|篇)\s*$/m.test(t)) return true;
    if (/第\s*[0-9一二三四五六七八九十百]+\s*[卷幕部篇]/.test(t)) return true;
    if (/(分卷|卷纲|分幕|幕纲|卷结构)/.test(t)) return true;
    return false;
}
