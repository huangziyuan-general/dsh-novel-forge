// lib/quality-trend.js — 质量趋势（纯函数，零 io，零模型调用）。
//
// bookQualityView 回答「这本书现在欠多少债」，本模块回答「这本书在变好还是变差」：
// 把逐章的 noai 分（审计行 write_chapter/saved 的 noaiScore）、契约覆盖率（章节索引
// gate.coverage）、质量债档（novel.json.quality.debts）三条序列拉成时间线，
// 出方向判读与风险旗标。三条序列全是**既有数据的读法**，不新增任何落盘。
//
// 判读纪律（与 noai/风格基线同一档：证据不是判决）：
//   · 只报数与方向，不贴「写得好/坏」标签——是否要改是作者的事；
//   · 序列太短（<4 个有效点）不判方向（统计噪声），只给现状；
//   · noaiScore 是落盘后的八维分（越低越好），gate.coverage 越高越好，
//     债档 hard > major > minor（越重越该先处理）——方向判读按各序列的语义定。

import { DEBT_LEVELS } from './quality-debt.js';

/** 取一段数值序列里非空的均值；全空返回 null。 */
function mean(xs) {
    const valid = (xs ?? []).filter((x) => Number.isFinite(x));
    if (valid.length === 0) return null;
    return Math.round(valid.reduce((a, b) => a + b, 0) / valid.length * 10) / 10;
}

/**
 * 解析 audit.jsonl 里的「逐章 saved 行」为按章号排序的 noai 序列。
 * 只认 `action === 'write_chapter/saved'` 且带 `noaiScore`（0 也认）的行；
 * 非本版本的历史行没有 noaiScore 的跳过（不造数）。
 * @param auditText audit.jsonl 全文
 * @returns [{ chapter, noaiScore }] 章号升序、去重（同章取最后一版）
 */
export function savedNoaiSeries(auditText) {
    const byChapter = new Map();
    for (const line of String(auditText ?? '').split('\n')) {
        if (line.trim() === '') continue;
        let j; try { j = JSON.parse(line); } catch { continue; }
        if (j?.action !== 'write_chapter/saved') continue;
        if (!Number.isInteger(j.chapter)) continue;
        // noaiScore 必须是有限整数（0 合法）；缺省/非数字的历史行不进序列
        if (typeof j.noaiScore !== 'number' || !Number.isFinite(j.noaiScore)) continue;
        byChapter.set(j.chapter, { chapter: j.chapter, noaiScore: Math.round(j.noaiScore) });
    }
    return [...byChapter.values()].sort((a, b) => a.chapter - b.chapter);
}

/** 某章的未结质量债按档计数（novel.json.quality.debts[章号]）。 */
function debtCountsOf(novel, chapter) {
    const items = Array.isArray(novel?.quality?.debts?.[String(chapter)]) ? novel.quality.debts[String(chapter)] : [];
    const counts = { hard: 0, major: 0, minor: 0 };
    for (const it of items) {
        if (it === null || typeof it !== 'object') continue;
        const lvl = DEBT_LEVELS[it.level] !== undefined ? it.level : (DEBT_LEVELS[it.code] ?? 'minor');
        counts[lvl] += 1;
    }
    return counts;
}

/** 给定一批章号里，某债码（如 promise-drift / promise-term-below）的未结条目总数。
 *  单一纯实现——旗标判定（quality-trend）与任何后续「近 N 章有某题材债」的读侧共用，不抄第二份。 */
export function countPromiseDebt(novel, chapters, code) {
    let total = 0;
    for (const ch of (Array.isArray(chapters) ? chapters : [])) {
        const items = Array.isArray(novel?.quality?.debts?.[String(ch)]) ? novel.quality.debts[String(ch)] : [];
        total += items.filter((it) => it !== null && typeof it === 'object' && it.code === code).length;
    }
    return total;
}

/**
 * 组装质量趋势。
 * @param auditText  audit.jsonl 全文（noai 序列来源；读不到传 null → 序列为空）
 * @param novel      novel.json（章节索引 gate.coverage + quality.debts）
 * @param opts       { window?: number } 只保留最近 window 个 saved 章（默认 20）
 * @returns {{ series, noaiTrend, gateCoverageTrend, riskFlags, note }}
 *   series          [{chapter, noaiScore, gateCoverage, debtHard, debtMajor, debtMinor}]
 *   noaiTrend       'rising' | 'falling' | 'flat' | null（近 1/3 段均值 vs 前 2/3；<4 点为 null）
 *   gateCoverageTrend 同上（覆盖率语义：升=更贴细纲）
 *   riskFlags       ['noai-rising', 'hard-debt-recent', 'coverage-drop',
 *                    'promise-drift-recent', 'promise-term-below-recent']（空数组=无风险旗标）
 *   note            人话判读（序列太短时说明原因，不硬判）
 */
export function qualityTrend(auditText, novel, { window = 20 } = {}) {
    let noaiRows = savedNoaiSeries(auditText);
    if (Number.isInteger(window) && window > 0) noaiRows = noaiRows.slice(-window);

    const series = noaiRows.map((r) => {
        const rec = novel?.chapters?.[String(r.chapter)];
        const gate = rec?.gate;
        const hasCoverage = gate !== null && typeof gate === 'object'
            && typeof gate.coverage === 'number' && Number.isFinite(gate.coverage);
        const debts = debtCountsOf(novel, r.chapter);
        // 缺契约段的章没有 gateCoverage——键必须**省略**（宿主 lossless 校验拒 null，
        // 与 charLimits「只有自定义才带键」同一条纪律）。
        return {
            chapter: r.chapter,
            noaiScore: r.noaiScore,
            ...(hasCoverage ? { gateCoverage: gate.coverage } : {}),
            debtHard: debts.hard, debtMajor: debts.major, debtMinor: debts.minor,
        };
    });

    const noaiTrend = directionTrend(series.map((s) => s.noaiScore));
    const gateCoverageTrend = directionTrend(series.map((s) => s.gateCoverage).filter((v) => typeof v === 'number'));

    const riskFlags = [];
    const last5 = series.slice(-5);
    if (last5.some((s) => s.debtHard > 0)) riskFlags.push('hard-debt-recent');
    const last3 = series.slice(-3);
    if (last3.length === 3
        && last3.every((s) => typeof s.gateCoverage === 'number')
        && last3.every((s) => s.gateCoverage < 80)) {
        riskFlags.push('coverage-drop');
    }
    if (noaiTrend === 'rising') riskFlags.push('noai-rising');
    // 题材承诺漂移旗标（P2/P3 批次信号进趋势面，会话接力盲区补丁）：近 5 章落过
    // promise-drift（批次漂移）或 promise-term-below（条款脱靶）债——数据走既有
    // quality.debts，不重读正文、不拉 12 轴（无逐章落盘序列，塞趋势要现读全书，
    // 与零 token 档矛盾）。两旗标分列：drift=结构信号（major），term-below=记账信号（minor）。
    const last5Chapters = last5.map((s) => s.chapter);
    if (countPromiseDebt(novel, last5Chapters, 'promise-drift') > 0) riskFlags.push('promise-drift-recent');
    if (countPromiseDebt(novel, last5Chapters, 'promise-term-below') > 0) riskFlags.push('promise-term-below-recent');

    const note = series.length < 4
        ? `有效样本 ${series.length} 章（不足 4 章，暂不判方向）——只报当前值，不报趋势`
        : (noaiTrend === 'rising' ? `noai 分近段走高（越写越 AI）——回看近期章的 noai topIssues，定向改`
            : noaiTrend === 'falling' ? 'noai 分近段走低——保持当前写法'
            : 'noai 分近段平稳')
            + (riskFlags.includes('hard-debt-recent') ? '；最近 5 章有 hard 级质量债未结——先回头核对' : '')
            + (riskFlags.includes('promise-drift-recent') ? '；最近 5 章有题材承诺批次漂移债——回头核对承诺书条款与全书大纲' : '')
            + (riskFlags.includes('promise-term-below-recent') ? '；最近 5 章有题材承诺条款脱靶债——题材在悄悄换轨，核对承诺书' : '');

    return { series, noaiTrend, gateCoverageTrend, riskFlags, note };
}

/** 序列方向：后 1/3 段均值 vs 前 2/3 段。差 <5（或 <20% 相对）判 flat。点不足 4 个返回 null。 */
function directionTrend(values) {
    const valid = (values ?? []).filter((v) => typeof v === 'number' && Number.isFinite(v));
    if (valid.length < 4) return null;
    const cut = Math.floor((valid.length * 2) / 3);
    const early = mean(valid.slice(0, cut));
    const late = mean(valid.slice(cut));
    if (early === null || late === null) return null;
    const delta = late - early;
    const rel = early !== 0 ? Math.abs(delta) / Math.abs(early) : 0;
    if (Math.abs(delta) < 5 && rel < 0.2) return 'flat';
    return delta > 0 ? 'rising' : 'falling';
}
