// lib/arcs.js — 弧线账本（纯函数，零 token，AGENTS.md 不变量 2 纯函数名单成员）。
//
// 主线1（v1.4.0）：长篇最容易烂掉的不是「设定错」，而是「人物弧光停走」——
// 主角立了「从怯懦到无畏」的弧线，写到 60 章还在怯懦；配角立了黑化弧线，
// 40 章后没有任何维度推进。弧线账本把「某维度在第几章推进到值 N」落成可
// 代码判定的账：停滞诊断（stall）是零 token 的硬信号，落成 major 质量债
// （「需重规划」档：影响后续章节结构，建议停下调整）。
//
// 数据形状（账本/arcs.json，append-only 行日志）：
//   { character, dimension, value, chapter, trend, note, ts }
//   · character：人物名（工程 cast 里的名字；不在 cast 不拦——人物可以中途
//     新建，登记弧线时提示即可，不阻断写作）
//   · dimension：弧线维度（模型自由命名：心境/信任度/嫌疑/成长…代码不判词义）
//   · value：当前读数（字符串，数值口径由模型填，代码不解析——「信任度 6/10」
//     与「半信半疑」都是合法值，停滞判定只看**是否有推进**，不判断方向）
//   · trend：可选——模型标注的推进方向（up/down/flat/…），只透传不判定
//
// 判据与 facts/relations 同一套纪律（ledger-core 的 timeline/snapshot）：
//   · arcs 原来是唯一没有独立 timeline 函数的账本（arcsAt 自写 inline snapshot），
//     v1.4.0 起与 facts/relations 对齐：时间线先按 (chapter, 原始下标) 升序，
//     再按 (character, dimension) 取每个键的最后一条 —— 避免"数组序=时间序"假设
//     导致的补录早章后 current 值漂移。
//
// 停滞判据（保守：宁漏勿误）：
//   · 只看「该 (character, dimension) 最后一次推进章」与全书已写最大章的差；
//   · 差距 >= stallChapters（默认 15 章）才报——短书/刚立弧的人物不误报；
//   · 从未登记任何推进（只有 1 行）不算停滞（弧线可能还没开始走），
//     但 0 行推进且全书已写 >= 20 章时提示「该维度从未推进过」。

import { timeline as coreTimeline, latestRows as coreLatestRows } from './ledger-core.js';

/** 默认停滞阈值（章）：最后推进距全书末尾超过 N 章即「弧线停走」。
 *  与下面的 20 配合出一条**刻意的保守盲区**：只推进过一次的弧线在 gap 15–19 时
 *  两边都不命中——stalled 要求 count≥2（单次读数说明不了节奏），no-move 要求
 *  ≥20（不催「可能还在酝酿」的线）。代价：第 40 章推过一次的弧线要等全书 60 章
 *  才报 no-move。改这两个数前先确认要不要收窄这条带。 */
export const ARC_STALL_CHAPTERS = 15;
/** 零推进提示的最低全书长度：写不满 20 章的书不催弧线推进（开篇期正常）。 */
export const ARC_MIN_CHAPTERS_NO_MOVE = 20;

/** 行守卫（与 facts/relations 同纪律）：畸形行不参与判定。 */
function validRow(r) {
    return r !== null && typeof r === 'object'
        && typeof r.character === 'string' && r.character !== ''
        && typeof r.dimension === 'string' && r.dimension !== ''
        && Number.isInteger(r.chapter);
}

/**
 * 弧线时间线。收敛到 ledger-core.timeline()（账本家族共享）。
 * 原来 arcs 没有独立 timeline 函数，arcsAt 自写 inline snapshot ——
 * 现在与 facts/relations 对齐，避免"数组序=时间序"假设漂移。
 */
export function arcTimeline(arcs, { upTo = null } = {}) {
    return coreTimeline(arcs, { isValidRow: validRow, upTo });
}

/** 截至第 n 章，每个 (character, dimension) 的最新一行。 */
export function latestArcRows(arcs, { upTo = null } = {}) {
    return coreLatestRows(arcs, {
        isValidRow: validRow,
        upTo,
        getGroupKey: (r) => `${r.character}\u0000${r.dimension}`,
    });
}

/**
 * 某 (character, dimension) 的最后推进章（无记录返回 null）。
 */
export function arcLastMove(arcs, character, dimension) {
    let last = null;
    for (const r of arcs ?? []) {
        if (!validRow(r) || r.character !== character || r.dimension !== dimension) continue;
        if (last === null || r.chapter > last) last = r.chapter;
    }
    return last;
}

/**
 * 全书弧线停滞诊断（零 token 纯函数；写章链与全书深扫共用这一份）。
 *
 * @param arcs 弧线行日志
 * @param maxWritten 全书已写最大章号（novel.chapters 的最大键；无章节传 0）
 * @param opts.stallChapters 停滞阈值（默认 ARC_STALL_CHAPTERS）
 * @returns [{ character, dimension, lastMove, gap, kind, message }]
 *   kind: 'stalled'（有过推进但停走）| 'no-move'（全书写了 >=20 章该维度从未推进）
 */
export function diagnoseArcStall(arcs, maxWritten, opts = {}) {
    const stall = Number.isInteger(opts.stallChapters) && opts.stallChapters > 0
        ? opts.stallChapters : ARC_STALL_CHAPTERS;
    if (!Number.isInteger(maxWritten) || maxWritten < ARC_MIN_CHAPTERS_NO_MOVE) return [];
    const pairs = new Map();
    for (const r of arcs ?? []) {
        if (!validRow(r)) continue;
        const k = r.character + '\u0000' + r.dimension;
        if (!pairs.has(k)) pairs.set(k, { character: r.character, dimension: r.dimension, lastMove: null, count: 0 });
        const slot = pairs.get(k);
        slot.count += 1;
        if (slot.lastMove === null || r.chapter > slot.lastMove) slot.lastMove = r.chapter;
    }
    const out = [];
    for (const p of pairs.values()) {
        if (p.count === 1 && p.lastMove !== null && maxWritten - p.lastMove >= ARC_MIN_CHAPTERS_NO_MOVE) {
            out.push({
                character: p.character, dimension: p.dimension, lastMove: p.lastMove,
                gap: maxWritten - p.lastMove, kind: 'no-move',
                message: '「' + p.character + '·' + p.dimension + '」全书只在第' + p.lastMove + '章推进过一次，此后 ' + (maxWritten - p.lastMove) + ' 章未动——确认这条弧线是否还需要：不需要就在账本里收掉（登记终值），需要就安排推进',
            });
        } else if (p.count >= 2 && p.lastMove !== null && maxWritten - p.lastMove >= stall) {
            out.push({
                character: p.character, dimension: p.dimension, lastMove: p.lastMove,
                gap: maxWritten - p.lastMove, kind: 'stalled',
                message: '「' + p.character + '·' + p.dimension + '」弧线停在第' + p.lastMove + '章（距当前 ' + (maxWritten - p.lastMove) + ' 章未推进）——弧光停走是长篇最常见的结构债：要么在本章推进一格，要么在 novel_arc update 里登记一次（哪怕「暂时无变化」也要写章号留痕），要么承认这条弧线作废',
            });
        }
    }
    return out.sort((a, b) => a.character.localeCompare(b.character) || a.dimension.localeCompare(b.dimension));
}

/**
 * 追加弧线更新；返回 {arcs, added, skipped}。
 * 语义：append-only——同章同 (character,dimension) 同值幂等跳过（与 facts/relations 同纪律）；
 * 同章改值**不拦**（弧线读数允许同章内修正——它不是终态账，是推进记录，
 * 拦了反而逼模型拆两章记一件事；冲突由 note 留痕）。
 */
export function applyArcUpdates(arcs, updates, { chapter, now } = {}) {
    if (!Number.isInteger(chapter) || chapter < 1) throw new Error('chapter 必须是正整数');
    if (typeof now !== 'string' || now === '') throw new Error('now 必填（ISO 时间戳）——纯函数不取钟，由调用方传入');
    if (!Array.isArray(updates) || updates.length === 0) throw new Error('updates 必须是非空数组');
    const list = Array.isArray(arcs) ? arcs : [];
    const next = [...list];
    const added = [];
    const skipped = [];
    for (const u of updates) {
        if (u === null || typeof u !== 'object') throw new Error('弧线更新必须是对象');
        const character = String(u.character ?? '').trim();
        const dimension = String(u.dimension ?? '').trim();
        if (character === '' || dimension === '') throw new Error('弧线的 character/dimension 不能为空');
        const value = String(u.value ?? '').trim();
        if (value === '') throw new Error('弧线 value 不能为空（' + character + '·' + dimension + '）');
        const last = arcLastMove(list, character, dimension);
        if (last === chapter) {
            const latest = (list ?? []).filter((r) => validRow(r) && r.character === character && r.dimension === dimension && r.chapter === chapter);
            if (latest.length > 0 && String(latest[latest.length - 1].value) === value && String(latest[latest.length - 1].trend ?? '') === String(u.trend ?? '') && String(latest[latest.length - 1].note ?? '') === String(u.note ?? '')) {
                skipped.push({ character, dimension });
                continue;
            }
        }
        const row = { character, dimension, value, chapter, ...(u.trend !== undefined && String(u.trend).trim() !== '' ? { trend: String(u.trend).trim() } : {}), note: String(u.note ?? '').trim(), ts: now };
        next.push(row);
        added.push(row);
    }
    return { arcs: next, added, skipped };
}

/**
 * 弧线时点快照。
 * 收敛到 latestArcRows（ledger-core 的 timeline + snapshot）。
 * 原来 arcsAt 自写 inline snapshot：遍历数组序 + `r.chapter >= cur.chapter`。
 * 那是假设"数组序=时间序"（arcs 补录早章后会漂）。现在先按 chapter+index 排序再取最后一条，
 * 与 factsAt / relationsAt / cognitionFlatRows 同口径。
 */
export function arcsAt(arcs, chapter, { character, dimensions } = {}) {
    if (!Number.isInteger(chapter) || chapter < 1) throw new Error('chapter 必须是正整数');
    const wantDims = Array.isArray(dimensions) && dimensions.length > 0 ? new Set(dimensions) : null;
    const picked = [];
    for (const { r } of latestArcRows(arcs, { upTo: chapter }).values()) {
        if (character !== undefined && r.character !== character) continue;
        if (wantDims !== null && !wantDims.has(r.dimension)) continue;
        picked.push(r);
    }
    return picked
        .sort((x, y) => x.character.localeCompare(y.character) || x.dimension.localeCompare(y.dimension))
        .map((r) => ({
            character: r.character, dimension: r.dimension, value: String(r.value ?? ''),
            chapter: r.chapter,
            ...(r.trend !== undefined ? { trend: String(r.trend) } : {}),
            note: String(r.note ?? ''),
        }));
}
