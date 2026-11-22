// lib/ladders.js — 进度阶梯台账（书级「随进度演进的线」，纯函数，零 IO、零模型调用）。
//
// 补的是既有两面都查不出的结构性事故：`arcs` 是**反应式**账本（模型写了才登记，
// 没登记的线查不出「该走没走」），`milestone` 查的是「大纲概念词该出现了没出现」
// （欠账）。唯独没有**规划式**的书级进度线：「全书力量线第 40 章前应到第 3 级、
// 支线『某势力线』近 30 章还得有出场」这种**先排后验**的落点。长篇最典型的塌陷
// ——一条线中段断了 200 章没人发现——只有规划过才可能报出来。
//
// 台账（账本/阶梯.json，与 arcs 同目录同构）：线（name）→ 级（rung）列表，
// 每级 { chapter（第 N 章前应到）, label（这一级是什么）, check（怎么验证），
// reached（哪一章登记过达到）}。
//
// 纪律（与既有台账同档）：
//   · 登记是**创作行为**（save_book/align 时由模型按全书大纲排出、或作者手排）；
//     核对是**代码行为**（ladder_check / 简报段，确定性零 token）——同 pledges 的分工；
//   · 逾期：某级「第 N 章前应到」、N 已过而未登记 reached → 点名（report-only，
//     拦的语义归门禁）；
//   · 停滞：某线**达到过**之后 ≥ stallGap 章没再推进 → 点名；从未达到过不算停滞
//     （拿「没有证据」当「有反证」是误报源——与逾期判据分开，不掺在一起）；
//   · 一行式 `线名|级别|第N章前应到|验证法`，坏行进 errors 不炸整批。

import { nextSuffixedId } from './versioning.js';

/** 一行式解析：多行「线名|级别|章|验证法」（后段可省、空行/# 注释跳过）。
 *  返回 { lines, errors }——lines 是按线名归组的级（同线多级相邻或交错都行）。 */
export function parseLadderLines(raw, { perLine = 10 } = {}) {
    const lines = new Map();
    const errors = [];
    for (const line of String(raw ?? '').split(/\r?\n/)) {
        const t = line.trim();
        if (t === '' || t.startsWith('#')) continue;
        const cells = t.split('|').map((c) => c.trim());
        const name = cells[0] ?? '';
        if (name === '') {
            errors.push(`缺线名（「${t.slice(0, 14)}…」）——行式「线名|级别|第N章前应到|验证法」`);
            continue;
        }
        const label = cells[1] ?? '';
        // 章号格兼容「第1章前应到」「第 3 章」「1」——抽首个数字串（工具描述教的就是带「第…章」的写法）。
        const chapterRaw = String(cells[2] ?? '').trim();
        const chapterMatch = chapterRaw.match(/(\d+)\s*章?/);
        const chapter = chapterMatch ? Number.parseInt(chapterMatch[1], 10) : Number.NaN;
        if (!Number.isInteger(chapter) || chapter < 1) {
            errors.push(`线「${name}」缺有效章号（收到「${chapterRaw}」）——「第 N 章前应到」必须是正整数`);
            continue;
        }
        let group = lines.get(name);
        if (group === undefined) {
            group = { name, rungs: [] };
            lines.set(name, group);
        }
        // 每线级数上限：超限行不登记（错误消息与实际行为一致——先判再入，别先入再告）。
        if (group.rungs.length >= perLine) {
            errors.push(`线「${name}」超过 ${perLine} 级上限，本行未登记（「${t.slice(0, 20)}…」）`);
            continue;
        }
        group.rungs.push({ chapter, label, check: cells[3] ?? '' });
    }
    return { lines: [...lines.values()], errors };
}

/** 一行阶梯是否有效（畸形行滤出，不炸消费面）。 */
export function validLadderRow(l) {
    if (l === null || typeof l !== 'object') return false;
    if (typeof l.name !== 'string' || l.name.trim() === '') return false;
    if (!Array.isArray(l.rungs)) return false;
    return l.rungs.every((r) => r !== null && typeof r === 'object'
        && Number.isInteger(r.chapter) && r.chapter >= 1
        && typeof r.label === 'string' && typeof r.check === 'string');
}

/**
 * 台账合并：existing + add 线 + remove 线名 → 新数组。
 * 线按 name upsert（同名覆盖级表：改计划就该整条改，不并影子线）；新线 id 走
 * nextSuffixedId（gap 安全，同写法规则先例——线 id 只在台账内唯一、无跨文档引用）；
 * remove 按线名删整线。
 * @returns { lines: object[], added: string[], removed: string[] }
 */
export function reconcileLadders(existing, addLines = [], removeNames = []) {
    const current = (Array.isArray(existing) ? existing : []).filter(validLadderRow);
    const byName = new Map(current.map((l) => [l.name, l]));
    const nextId = () => nextSuffixedId([...byName.values()].map((l) => l.id), 'L');
    const added = [];
    for (const l of addLines ?? []) {
        const prev = byName.get(l.name);
        // 同名 = 覆盖整条线的计划（改计划就整条改，不并影子线）；reached 实绩只保留
        // 在「新计划里仍有同章号级」的格子上（章节号是实绩与计划对齐的锚）。
        const prevReached = new Map((prev?.rungs ?? [])
            .filter((r) => Number.isInteger(r.reached)).map((r) => [r.chapter, r.reached]));
        const rungs = (l.rungs ?? [])
            .map((r) => ({
                chapter: r.chapter, label: r.label, check: r.check,
                reached: prevReached.get(r.chapter) ?? null,
            }))
            .sort((a, b) => a.chapter - b.chapter);
        byName.set(l.name, { id: prev?.id ?? nextId(), name: l.name, rungs });
        added.push(prev ? `${l.name}（更新）` : l.name);
    }
    const removed = [];
    for (const n of removeNames ?? []) {
        const name = String(n).trim();
        if (byName.has(name)) {
            byName.delete(name);
            removed.push(name);
        }
    }
    return { lines: [...byName.values()], added, removed };
}

/** 按线名删整线（ladder_remove 面）。 */
export function removeLadders(lines, names = []) {
    const drop = new Set((names ?? []).map((n) => String(n).trim()).filter((n) => n !== ''));
    const rest = (Array.isArray(lines) ? lines : []).filter(validLadderRow).filter((l) => !drop.has(l.name));
    return { lines: rest, removed: [...drop].filter((n) => (lines ?? []).some((l) => l?.name === n)) };
}

/**
 * 实绩登记（ladder_reach 面）：某线某级「第 atChapter 章已达到」。
 * 按（线名 + 级章号）定位那一格；线或级不存在 → 响亮失败（实绩记在计划外的
 * 格子上 = 台账与计划脱钩，静默落盘会把「该走没走」的判据污染掉）。
 * reached 可改（回退实绩：发现判错了就改——同 facts 的改值走新行的纪律反过来，
 * 阶梯的 reached 是同一格的实测修正，不是时间线追加）。
 * @returns { lines, reachedLine, reachedRung }
 */
export function markReached(lines, lineName, rungChapter, atChapter) {
    const list = (Array.isArray(lines) ? lines : []).filter(validLadderRow);
    const idx = list.findIndex((l) => l.name === lineName);
    if (idx === -1) throw new Error(`阶梯线不存在：「${lineName}」——先 ladder_add 登记计划`);
    const line = list[idx];
    const rung = line.rungs.find((r) => r.chapter === rungChapter);
    if (rung === undefined) throw new Error(`线「${lineName}」没有第 ${rungChapter} 章这一级——ladder_add 的级号要对上计划`);
    const next = list.map((l, i) => (i === idx
        ? { ...l, rungs: l.rungs.map((r) => (r === rung ? { ...r, reached: atChapter } : r)) }
        : l));
    return { lines: next, reachedLine: lineName, reachedRung: rungChapter };
}

/**
 * 某章时点的线状态（纯判定，ladder_check / 简报共用同一份）：
 *  @param {object[]} lines 台账
 *  @param {number} n 当前章（写章时 = 本章；巡检时 = 已写最大章）
 *  @returns {Array<{ name, at, next, overdue, stalled, issues }> }
 *   at/next = 第 n 章应处/下一级的级（chapter ≤ n 的最高级 / 其后第一级）；
 *   overdue = 计划窗口（第 chapter 章前）已过而未登记达到的一级（取最早的一级）；
 *   stalled = 前一级**已达标**且**下一级也逾期**——「该走没走」以计划线为钟
 *   （计划窗口没过就不算停，避免「刚达标、下一格还在计划窗口内」的误报；
 *   「从未登记实绩」不算停滞——拿没有证据当有反证是误报源，逾期判据独立报）。
 */
export function ladderStatusAt(lines, n, _opts = {}) {
    const out = [];
    for (const l of (Array.isArray(lines) ? lines : []).filter(validLadderRow)) {
        // 判定与落盘顺序解耦：reconcile 落盘的级已按章号排序，但台账是手可编的 JSON——
        // 判定前就地排序（副本），乱序数据不让 at/next/停滞对错位（总览视图同样先排再渲染）。
        const rungs = [...(l.rungs ?? [])].sort((a, b) => a.chapter - b.chapter);
        const at = [...rungs].reverse().find((r) => r.chapter <= n) ?? null;
        const next = rungs.find((r) => r.chapter > n) ?? null;
        const overdue = rungs.find((r) => r.chapter <= n && r.reached == null) ?? null;
        // stalled：存在「已达标级 + 其后逾期未达级」相邻对（计划线为钟）
        let stalledPair = null;
        for (const r of rungs) {
            if (!Number.isInteger(r.reached)) continue;
            const nxt = rungs.find((x) => x.chapter > r.chapter && x.chapter <= n && x.reached == null);
            if (nxt !== undefined) { stalledPair = { from: r, to: nxt }; break; }
        }
        const issues = [];
        if (overdue !== null) {
            issues.push(`「${l.name}」第 ${overdue.chapter} 章前该到「${overdue.label || '本级'}」仍未登记达到${overdue.check ? `（验证法：${overdue.check}）` : ''}`);
        }
        if (stalledPair !== null) {
            issues.push(`「${l.name}」自「${stalledPair.from.label || `第${stalledPair.from.chapter}章级`}」于第 ${stalledPair.from.reached} 章达标后，下一级「${stalledPair.to.label || `第${stalledPair.to.chapter}章级`}」（第 ${stalledPair.to.chapter} 章前该到）已 ${n - stalledPair.to.chapter} 章未推进`);
        }
        out.push({ name: l.name, at, next, overdue, stalled: stalledPair !== null, issues });
    }
    return out;
}

/**
 * 简报追加段渲染（纯函数）：无线返回 ''（调用方整段省略）；有则逐线给
 * 「当前应在/下一级/逾期/停滞」，封顶 8 线。同 related-chapters 追加段先例：
 * 不吃 pack 预算，自封顶；无问题也报位置（规划面的价值是「照这个走」，不只是报坏）。
 */
export function renderLadderSection(lines, n, { maxLines = 8, perLineChars = 60 } = {}) {
    const status = ladderStatusAt(lines, n).slice(0, maxLines);
    if (status.length === 0) return '';
    const clip = (s) => {
        const t = String(s ?? '').trim();
        return t.length > perLineChars ? `${t.slice(0, perLineChars - 1)}…` : t;
    };
    const body = status.map((s) => {
        const rungText = (r) => (r.label !== '' ? r.label : `第${r.chapter}章级`);
        const parts = [
            s.at ? `现应在「${clip(rungText(s.at))}」` : '（尚无计划级）',
            s.next ? `第 ${s.next.chapter} 章前迈到「${clip(rungText(s.next))}」` : null,
        ].filter(Boolean);
        const flags = s.issues.map((i) => `⚠ ${i}`);
        return `- ${s.name}：${parts.join('；')}${flags.length > 0 ? '\n' + flags.join('\n') : ''}`;
    });
    return `进度阶梯（${n} 章时点）：\n${body.join('\n')}\n——按各级验证法核对「该走没走」；达到时登记 ladder_reach（实绩不登记，停滞/逾期永远报不出来）。`;
}
