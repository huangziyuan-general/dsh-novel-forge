// lib/circuit-breaker.js — 熔断计数器（E2 的第二半，纯函数 + 极少量状态）。
//
// 来源：多核协同的「熔断权」——同一章被连续驳回 3 次，说明**问题不在文字，
// 在设定**，此时该回去重校准而不是硬压着改写。核把它写在 persona 里；
// 但按本插件的原则「凡是靠模型自觉的约束都视同没有」，这里给它配一个
// 落盘计数器：第 3 次驳回之后，novel_write_chapter 直接拒绝再写，
// 直到细纲重批 / 场景契约更新 / 用户 force 放行 —— 三条解除通道。
//
// 状态落 novel.json.gateFailures = { "7": 2 }（章号 → 连续驳回次数）。
// 成功保存一章即清零。

/** 连续驳回阈值：达到即熔断。 */
export const BREAKER_THRESHOLD = 3;

/** 当前熔断状态。 */
export function breakerState(novel, n, { threshold = BREAKER_THRESHOLD } = {}) {
    const count = Number(novel?.gateFailures?.[String(n)] ?? 0) || 0;
    const tripped = count >= threshold;
    return {
        chapter: n,
        count,
        threshold,
        tripped,
        reason: tripped
            ? `熔断：第${n}章已连续被驳回 ${count} 次（阈值 ${threshold}）。问题多半不在文字而在设定——先改细纲（novel_outline save_chapter 后须 approve）或本章场景契约（novel_scene save），再动笔；注意计数只在**本章成功落盘**（或 force:true 通过）时清零，改完细纲/契约本身不清零。`
            : null,
    };
}

/**
 * 记一次驳回（内容门禁 / 细纲禁项 / 机审不通过都算）。
 * @returns {number} 更新后的连续驳回次数
 */
export function recordRejection(novel, n, { code = '', detail = '' } = {}) {
    if (novel === null || novel === undefined) return 0;
    novel.gateFailures = novel.gateFailures ?? {};
    const key = String(n);
    novel.gateFailures[key] = (Number(novel.gateFailures[key] ?? 0) || 0) + 1;
    const count = novel.gateFailures[key];
    novel.gateFailures[key + ':last'] = { code, detail: String(detail).slice(0, 300), at: new Date().toISOString() };
    return count;
}

/** 成功保存一章 → 清零该章驳回计数（连带清掉 last 记录）。 */
export function recordSuccess(novel, n) {
    if (novel === null || novel === undefined || novel.gateFailures === undefined) return novel;
    delete novel.gateFailures[String(n)];
    delete novel.gateFailures[String(n) + ':last'];
    return novel;
}

/** 解除通道：细纲重批 / 场景契约更新 / force 放行 → 清零该章计数。 */
export function clearBreaker(novel, n) {
    return recordSuccess(novel, n);
}

/** 熔断概况（面板/看板展示用）。 */
export function breakerDigest(novel) {
    const rows = Object.entries(novel?.gateFailures ?? {})
        .filter(([k]) => !k.includes(':'))
        .map(([k, v]) => ({ chapter: Number(k), count: Number(v) || 0 }))
        .filter((r) => r.count > 0)
        .sort((a, b) => b.count - a.count);
    return { tripped: rows.filter((r) => r.count >= BREAKER_THRESHOLD), rows };
}
