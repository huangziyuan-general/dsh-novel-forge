// lib/polish.js — 纯函数：段落级润色病灶定位（AI 味/长段/钩子）。
// 定位→模型改写→走 novel_propose 落提案：润色也不覆盖旧版。

import { scanAiFlavor } from './noai.js';
import { detectHookKind } from './hook.js';

/**
 * 段落级热点扫描：返回有问题的段落及原因，供用户/模型精准修改。
 * 超过 top 条按严重度截断。
 * @returns {chapterHook, paragraphs:[{paragraph,chars,issues[],aiScore}]}
 */
export function analyzeParagraphs(content, { top = 20 } = {}) {
    const text = String(content ?? '');
    const paras = text.split(/\n{2,}/).map((p) => p.trim()).filter((p) => p.length > 0);
    const out = [];
    paras.forEach((p, idx) => {
        const issues = [];
        const chars = p.replace(/\s/g, '').length;
        const ai = scanAiFlavor(p, { topK: 2 });
        if (ai.score >= 30) issues.push(`AI 味偏高（${ai.score}）：${(ai.topIssues[0] ?? '').slice(0, 40)}`);
        if (chars > 220) issues.push(`段落过长（${chars} 字）——考虑拆段或删冗余`);
        if (/^(因为|所以|因此|于是).+，.{5,}。/m.test(p) && chars < 80) issues.push('结论式短句连贯出现，有灌输腔');
        if (issues.length > 0) out.push({ paragraph: idx + 1, chars, aiScore: ai.score, issues });
    });
    out.sort((a, b) => (b.aiScore - a.aiScore) || (b.chars - a.chars));
    return {
        chapterHook: detectHookKind(text),
        paragraphs: out.slice(0, top),
    };
}