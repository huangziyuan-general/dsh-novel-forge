// lib/ledger-core.js — append-only 账本家族的共享纪律（纯函数，零 io）。
//
// 账本家族（facts / relations / arcs / cognition）共享三条无争议纪律：
//   ① 行守卫：畸形行不参与当前值竞逐；
//   ② 时间线排序：按 (chapter, 原始下标) 升序——数组序不是时间序（账本允许补录早章），
//      排序这一件事只能有一份实现（1.3.3 教训：五份时间线实现对畸形行处理互不相同）；
//   ③ 时点快照：按 groupKey 取每个键在时间线上最后一条（最新值）。
//
// 冲突拒绝**不进**本文件——四账本纪律不同：
//   · facts/relations 改值冲突=拒绝；
//   · arcs 同值跳过、改值允许（弧线读数是推进记录不是终态账）；
//   · cognition 同值叠加保留（认知转变是合法事件）。
// 各账本自己写冲突闸。
//
// 与各账本现有函数的对应：
//   facts.factTimeline         → timeline(facts, { isValidRow: factsValidRow })
//   facts.latestFactRows       → latestRows(facts, { isValidRow, getGroupKey })
//   relations.relationTimeline → timeline(relations, { isValidRow: relationsValidRow })
//   relations.latestRelationRows → latestRows(relations, { isValidRow, getGroupKey })
//   arcs.（原来没有）          → timeline(arcs, { isValidRow: arcsValidRow }) — 先补 timeline
//   arcs.（原来没有）          → latestRows(arcs, { isValidRow, getGroupKey }) — arcsAt 改用
//   cognition.（原来没有）     → timeline(rows, { isValidRow, chapterNorm }) — 仅拉 timeline+snapshot
//   cognition.（原来没有）     → latestRows(rows, { ..., getGroupKey }) — resolveCognition 改用

/**
 * 时间线：过滤 + 排序。
 *
 * 规则（四账本共享，不可各写各的）：
 *   · 行必须过 isValidRow；
 *   · chapter 必须是整数；允许经 chapterNorm 归一后再判整数（cognition 的非整数降级为 0 就走这条路）；
 *   · upTo 可选时点章号（含），null = 不设上限；
 *   · 输出按 (chapter 升序, 原始下标升序) —— 同章多条保留原始写入序（append-only 数组序即写入序）。
 *
 * @param rows       行日志数组（null/undefined → []）
 * @param opts.isValidRow 行守卫函数（null = 不过滤，调用方自己保证行合法）
 * @param opts.chapterField chapter 字段名（默认 'chapter'）
 * @param opts.chapterNorm 可选：chapter 归一化函数；null = 非整数直接跳过
 * @param opts.upTo  可选时点章号（含）；null = 不设上限
 * @returns Array<{ r: object, i: number }>
 */
export function timeline(rows, { isValidRow = null, chapterField = 'chapter', chapterNorm = null, upTo = null } = {}) {
    const out = [];
    const list = rows ?? [];
    for (let i = 0; i < list.length; i++) {
        const r = list[i];
        if (isValidRow !== null && !isValidRow(r)) continue;
        let ch = r[chapterField];
        if (chapterNorm !== null) ch = chapterNorm(ch);
        if (!Number.isInteger(ch)) continue;
        if (upTo !== null && ch > upTo) continue;
        // 存归一化后的 chapter 用于排序；输出时去掉内部字段
        out.push({ r, i, _sortCh: ch });
    }
    // 主排序按归一化后的 chapter 升序。|| a.i - b.i 是防御性保留：
    // ECMAScript 2019+ 规范要求 Array.prototype.sort 为稳定排序，同 chapter 的相对顺序
    // 自动保持输入序（即 append-only 写入序）。这行显式写出来是让纪律可见，
    // 万一未来换成非稳定排序实现（比如某些第三方排序库）也不会默默丢掉同章顺序。
    return out.sort((a, b) => a._sortCh - b._sortCh || a.i - b.i).map(({ r, i }) => ({ r, i }));
}

/**
 * 时点快照：从已排序的时间线里按 groupKey 取每个键的**最后一条**。
 *
 * timeline 输出已是时间升序，后遍历到的自动覆盖先遍历到的。
 * 这条纪律与 facts.latestFactRows / relations.latestRelationRows / cognition 的 resolveCognition
 * 里 Map.set(key, value) "后声明胜"同口径。
 *
 * @param timelineRows timeline() 的返回值
 * @param getGroupKey  从一行（行对象 r）提取唯一 groupKey 的函数
 * @returns Map<groupKey, { r, i }> — 键类型取决于 getGroupKey，通常是 string
 */
export function snapshot(timelineRows, getGroupKey) {
    const out = new Map();
    for (const row of timelineRows) {
        const key = getGroupKey(row.r);
        out.set(key, row);
    }
    return out;
}

/**
 * latestRows：timeline + snapshot 的便捷封装。
 * 与各账本现有的 `latestXxxRows` 同形状（Map<groupKey, {r, i}>）。
 */
export function latestRows(rows, opts = {}) {
    const { getGroupKey, ...tlOpts } = opts;
    const tl = timeline(rows, tlOpts);
    return snapshot(tl, getGroupKey);
}
