// lib/audit.js — 确定性章节审计（纯函数，零模型调用）。
// 机审与模型审分离：这里只算「有明确对错」的指标；审稿的口味判断交给模型，
// 但必须引用本审计的数字作证据，压缩「和稀泥」空间。

import { detectHookKind } from './hook.js';

function shingles(text, k = 8) {
    const clean = String(text ?? '').replace(/\s/g, '');
    const set = new Set();
    for (let i = 0; i <= clean.length - k; i += 1) set.add(clean.slice(i, i + k));
    return set;
}

function jaccard(a, b) {
    if (a.size === 0 && b.size === 0) return 0;
    let inter = 0;
    for (const x of a) if (b.has(x)) inter += 1;
    return inter / (a.size + b.size - inter);
}

/**
 * @param inputs { content, previous:[{chapter, content}], terms:[string] }
 *   terms = 出场人物名 + 命中世界书关键词（覆盖率检查）。
 */
export function computeAudit({ content, previous = [], terms = [] }) {
    const clean = String(content ?? '');
    const chars = clean.replace(/\s/g, '').length;
    const lines = clean.split('\n');
    const paragraphs = clean.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p.length > 0);
    const sentences = clean.split(/[。！？!?…]+/).map((s) => s.trim()).filter((s) => s.length > 0);

    const dialogueLines = lines.filter((l) => /[「“]/.test(l)).length;
    const dialogueChars = lines.filter((l) => /[「“]/.test(l)).join('').replace(/\s/g, '').length;

    // 章末钩子启发式（共享 hook.js）
    // 输出契约：缺省字段必须省略键——null/undefined 都会被宿主判 INVALID_TOOL_OUTPUT。
    const kind = detectHookKind(clean);
    const hook = kind !== null ? { detected: true, kind } : { detected: false };

    // 与前文重复：8 字 shingle 的最大 Jaccard。
    const mine = shingles(clean);
    let worst = null;
    for (const prev of previous) {
        const score = jaccard(mine, shingles(prev.content));
        if (worst === null || score > worst.jaccard) worst = { chapter: prev.chapter, jaccard: Math.round(score * 1000) / 1000 };
    }

    const missingTerms = terms.filter((t) => t !== '' && !clean.includes(t));

    return {
        chars,
        paragraphCount: paragraphs.length,
        avgParagraphChars: paragraphs.length === 0 ? 0 : Math.round(chars / paragraphs.length),
        sentenceCount: sentences.length,
        dialogueRatio: chars === 0 ? 0 : Math.round((dialogueChars / chars) * 100) / 100,
        endingHook: hook,
        repetition: worst ?? { jaccard: 0 },
        coverage: { terms: terms.length, missing: missingTerms },
    };
}

/**
 * 机审判定（写章门禁第二道：内容合格线）。
 * @param config { minChapterChars, maxChapterChars }
 */
export function auditVerdict(audit, { minChapterChars, maxChapterChars }) {
    const problems = [];
    const warnings = [];
    // 目标字数：上下限中值取整到百位（与 briefing「目标 N 字左右」同口径）。
    // 驳回文案必须带「还差多少 + 目标多少」——只说「低于下限 2000」模型无从下手（真机 89/102 次驳回都是这条）。
    const target = Math.round((minChapterChars + maxChapterChars) / 2 / 100) * 100;
    if (audit.chars < minChapterChars) {
        problems.push(`正文 ${audit.chars} 字，低于下限 ${minChapterChars}（还差 ${minChapterChars - audit.chars} 字，本章目标 ${target} 字左右）——把细纲里的场景写细写透（动作/环境/对话拉满），不要注水凑字`);
    }
    if (audit.chars > maxChapterChars) problems.push(`正文 ${audit.chars} 字，超过上限 ${maxChapterChars}（拆章或扩写细纲）`);
    if (audit.repetition.jaccard >= 0.35) problems.push(`与第${audit.repetition.chapter}章高度重复（8字重合率 ${audit.repetition.jaccard}）——查跨章复读`);
    if (audit.chars >= minChapterChars && audit.paragraphCount < 3) problems.push(`段落数 ${audit.paragraphCount} 过少——不是一整块墙`);
    // 达到下限但未达目标：**非阻断**提醒（不是驳回）。篇幅长期贴着下限会让连载显得单薄。
    if (audit.chars >= minChapterChars && audit.chars < target) {
        warnings.push(`正文 ${audit.chars} 字，已过下限但未达目标 ${target} 字左右（还差约 ${target - audit.chars} 字）——本章已保存，下章尽量写足`);
    }
    if (audit.endingHook.detected === false) warnings.push('章末未检出钩子（问句/悬念/省略/感叹）——网文追读大忌，建议改写末段');
    if (audit.coverage.terms > 0 && audit.coverage.missing.length > 0) {
        // 只列前 10 项：词表过宽时可能几十条，模型会整条忽略（真机第 69 章列了 50+ 词）。
        const shown = audit.coverage.missing.slice(0, 10);
        const more = audit.coverage.missing.length - shown.length;
        warnings.push(`细纲声明的要素未在正文出现（${audit.coverage.missing.length} 项）：${shown.join('、')}${more > 0 ? `…等 ${more} 项` : ''}`);
    }
    return { ok: problems.length === 0, problems, warnings };
}
