// lib/context-adaptive.js — 上下文窗口超限后的单次降载策略（纯函数）。

export const CONTEXT_RETRY_RATIO = 0.75;

export function isContextWindowExceeded(error) {
    return error?.code === 'CONTEXT_WINDOW_EXCEEDED';
}

/** 宿主未提供真实 token 窗口时只按字符比例缩减，不宣称 token 精度。 */
export function reducedContextBudget(current) {
    if (!Number.isInteger(current) || current <= 1000) return null;
    return Math.max(1000, Math.floor(current * CONTEXT_RETRY_RATIO));
}

/** 审稿意见是可选材料；原稿、禁项与作者指导永远不在此裁。 */
export function reducedReviewIssues(issues) {
    const rows = Array.isArray(issues) ? issues : [];
    if (rows.length === 0) return null;
    return rows.length === 1 ? [] : rows.slice(0, Math.max(1, Math.floor(rows.length / 2)));
}
