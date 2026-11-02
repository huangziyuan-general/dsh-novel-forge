// lib/relations.js — 关系账本（纯函数，零 token，AGENTS.md 不变量 2 纯函数名单成员）。
//
// 主线1（v1.4.0）：事实账本记的是「实体的状态」（境界/位置/持有），记不了「两个实体
// 之间的关系」（A 与 B 是盟友还是仇敌、X 对 Y 的信任度）。关系崩坏的崩法与事实错
// 不同：同一个「A·B 关系」键在 12 章是盟友、45 章变仇敌，模型只拿最新值写 46 章的
// 桥段没问题——但如果细纲里 46 章要写「盟友并肩作战」而账本 45 章已翻脸，就是
// 关系矛盾；如果全书对同一对 (A,B) 反复横跳（盟友→仇敌→盟友）而没有中间事件支撑，
// 就是关系漂移（读者视角的人设崩塌）。
//
// 数据形状（账本/relations.json，append-only 行日志，与 facts 同构）：
//   { a, b, relation, value, chapter, note, ts }
//   · a/b：实体名（对称对——(a,b) 与 (b,a) 是同一对，归一化在 relationPair 收口）
//   · relation：关系维度（盟友/仇敌/师徒/信任度/立场…，模型自由命名，代码不判词义）
//   · value：该维度当前值（字符串，可含数值口径——数值漂移判定复用 continuity 的口径）
//
// 判据与 facts 同一套纪律（ledger-core 的 timeline/snapshot）：
//   · 时间线按 (chapter, 原始下标) 升序——补录早章是常态，数组顺序不是时间顺序；
//   · 同章同对同维度多次改值 = 冲突（applyRelationUpdates 拦）；
//   · 当前值 = 时间线上最后写到的那条（latestRelationRows 唯一出口，视图与门禁同源）。

import { timeline as coreTimeline, latestRows as coreLatestRows } from './ledger-core.js';

/**
 * 关系对归一：(a,b) 与 (b,a) 是同一对。
 * 键形 `${smaller}\u0000${larger}`（字典序），保证「A 对 B」与「B 对 A」落到同一线上。
 * relation 维度不参与键（同一对不同维度各有一条线）。
 */
export function relationPair(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || a.trim() === '' || b.trim() === '') {
        throw new Error('关系对的两个实体名不能为空');
    }
    const x = a.trim();
    const y = b.trim();
    if (x === y) throw new Error(`关系对两端不能是同一实体：「${x}」`);
    const [smaller, larger] = x.localeCompare(y) <= 0 ? [x, y] : [y, x];
    return { a: smaller, b: larger, key: `${smaller}\u0000${larger}` };
}

/** 关系行守卫：畸形行不参与时间线（与 ledger-core 共享纪律）。 */
function isValidRelationRow(r) {
    return r !== null && typeof r === 'object'
        && typeof r.a === 'string' && typeof r.b === 'string' && r.a !== '' && r.b !== ''
        && typeof r.relation === 'string' && r.relation !== ''
        && Number.isInteger(r.chapter);
}

/**
 * 关系时间线（**唯一一份**「哪些行参与当前值竞逐、按什么顺序」的判据）。
 * 排序逻辑收敛到 ledger-core.timeline()（账本家族共享）。
 *
 * @param relations 行日志数组
 * @param upTo 可选时点章号（含）；null = 不设上限
 * @returns [{ f, i }]（章号升序，同章按写入序）
 */
export function relationTimeline(relations, { upTo = null } = {}) {
    const tl = coreTimeline(relations, { isValidRow: isValidRelationRow, upTo });
    return tl.map(({ r, i }) => ({ f: r, i }));
}

/**
 * 截至第 n 章，每对 (a,b)·relation 的最新一行（时间线上最后写到的那条）。
 * @returns Map<`${a}\u0000${b}\u0000${relation}`, {f, i}>
 */
export function latestRelationRows(relations, { upTo = null } = {}) {
    const map = coreLatestRows(relations, {
        isValidRow: isValidRelationRow,
        upTo,
        getGroupKey: (r) => {
            const pair = relationPair(r.a, r.b);
            return `${pair.key}\u0000${r.relation}`;
        },
    });
    const out = new Map();
    for (const [k, { r, i }] of map) out.set(k, { f: r, i });
    return out;
}

/**
 * 第 n 章时点快照（与 ledger.factsAt 同款语义：时点推演，不拿最新值糊）。
 * @returns [{a, b, relation, value, chapter, note}]（按对/维度排序）
 */
export function relationsAt(relations, chapter, { pair, relations: dims } = {}) {
    if (!Number.isInteger(chapter) || chapter < 1) throw new Error('chapter 必须是正整数');
    const pairKey = pair !== undefined ? relationPair(pair[0], pair[1]).key : null;
    const wantDims = Array.isArray(dims) && dims.length > 0 ? new Set(dims) : null;
    const picked = [];
    for (const { f } of latestRelationRows(relations, { upTo: chapter }).values()) {
        const pk = relationPair(f.a, f.b).key;
        if (pairKey !== null && pk !== pairKey) continue;
        if (wantDims !== null && !wantDims.has(f.relation)) continue;
        picked.push(f);
    }
    return picked
        .sort((x, y) => relationPair(x.a, x.b).key.localeCompare(relationPair(y.a, y.b).key) || x.relation.localeCompare(y.relation))
        .map((f) => ({ a: f.a, b: f.b, relation: f.relation, value: String(f.value ?? ''), chapter: f.chapter, note: f.note ?? '' }));
}

/**
 * 单 (a,b) 对某维度的演化线（「A 和 B 的关系是怎么一步步变成现在这样的」——
 * 对账「哪一章翻的脸」的唯一通道，与 ledger.statusTimeline 同职责）。
 */
export function relationTimelineOf(a, b, relation, relations) {
    const pair = relationPair(a, b);
    const want = pair.key;
    const dim = String(relation ?? '').trim();
    if (dim === '') throw new Error('relation 维度不能为空');
    return relationTimeline(relations)
        .filter(({ f }) => relationPair(f.a, f.b).key === want && f.relation === dim)
        .map(({ f }) => ({ chapter: f.chapter, value: String(f.value ?? ''), note: f.note ?? '' }));
}

/**
 * 追加关系更新；返回 {relations, added, conflicts}。
 *
 * 冲突规则与 applyFactUpdates 同构（抄出来的判据必须同口径）：
 *   · 同 (a,b,relation) 同章改值 = 冲突拒绝（同章只落一行终态）；
 *   · 同值幂等跳过（note 变了不拦——关系备注不是终态的一部分，但记在 added 外）。
 * @param updates [{a, b, relation, value, note?}]
 * @param now ISO 时间戳（纯函数不取钟）
 */
export function applyRelationUpdates(relations, updates, { chapter, now } = {}) {
    if (!Number.isInteger(chapter) || chapter < 1) throw new Error('chapter 必须是正整数');
    if (typeof now !== 'string' || now === '') throw new Error('now 必填（ISO 时间戳）——纯函数不取钟，由调用方传入');
    const list = Array.isArray(relations) ? relations : [];
    if (!Array.isArray(updates) || updates.length === 0) throw new Error('updates 必须是非空数组');
    const next = [...list];
    const added = [];
    const conflicts = [];
    for (const u of updates) {
        if (u === null || typeof u !== 'object') throw new Error('关系更新必须是对象');
        const value = u.value;
        if (value === undefined || value === null || String(value).trim() === '') {
            throw new Error(`relation.value 不能为空（${u.a}↔${u.b}·${u.relation}）`);
        }
        const v = String(value);
        const pair = relationPair(u.a, u.b);
        const dim = String(u.relation ?? '').trim();
        if (dim === '') throw new Error('relation 维度不能为空');
        const note = u.note ?? '';
        const key = `${pair.key}\u0000${dim}`;
        // 最新一条（时间线口径，不是数组序——补录早章后数组序会说谎）
        const rows = relationTimeline(next, {}).filter((r) => `${relationPair(r.f.a, r.f.b).key}\u0000${r.f.relation}` === key);
        const latest = rows.length > 0 ? rows[rows.length - 1].f : undefined;
        if (latest !== undefined && latest.chapter === chapter) {
            if (String(latest.value) !== v) {
                conflicts.push({
                    a: pair.a, b: pair.b, relation: dim,
                    current: String(latest.value),
                    attempted: v,
                    reason: `「${pair.a}↔${pair.b}·${dim}」当前为「${String(latest.value)}」（第${latest.chapter}章起），`
                        + `同一章内改为「${v.slice(0, 40)}」被拒绝——同一关系对同一维度在同一章只落一行终态；`
                        + '过程变化写进 note（如「先决裂、章末和解」），或只报本章还没落过账的维度',
                });
                continue;
            }
            // 同值幂等跳过
            continue;
        }
        const row = { a: pair.a, b: pair.b, relation: dim, value: v, note, chapter, ts: now };
        next.push(row);
        added.push(row);
    }
    return { relations: next, added, conflicts };
}

// ── 关系矛盾闸（内容门禁的第七维，warning 级——关系是软设定，误拦比漏报更糟）──
//
// 病：正文写「A 与 B 盟友并肩作战」，但关系账本 45 章已翻脸成仇敌——模型拿的是
// 旧关系（或细纲写串了线）。facts 有过期状态词闸（stale-state，warning 同档），
// 关系账本上线后没有对应的一档就是「供给与检测不对称」——账本记了，门禁看不见。
//
// 判据（保守，宁漏勿误）：
//   · 只查**当前值**（截至本章）；历史值不做全文匹配（盟友期台词在翻脸章的回忆里
//     复现是正常叙事，facts 的 stale-state 也只查当前与「已被覆盖的旧值」，关系对
//     旧值口径太宽会刷屏——所以关系维度只报「当前值出现在正文里但正文语义相反」
//     判不了的部分：正文里当前值缺席且旧值在场）。
//   · 具体实现：截至本章的最新值 V_now；若正文不含 V_now 的关键词（≥2 字）而含某条
//     更早不同值 V_old 的关键词 → warning「A↔B·relation 第 N 章起是 V_now，正文仍按
//     旧值 V_old 写」。值太短（<2 字）或同对同维度从未改过（无旧值）→ 不查。
export function detectStaleRelations({ content = '', relations = [], chapter = 0 } = {}) {
    const text = String(content ?? '');
    if (text === '' || !Number.isInteger(chapter) || chapter < 1) return [];
    const current = [...latestRelationRows(relations, { upTo: chapter }).values()];
    const hits = [];
    for (const { f } of current) {
        const pair = relationPair(f.a, f.b);
        const dim = f.relation;
        const nowValue = String(f.value ?? '');
        if (nowValue.length < 2) continue; // 太短的值没有辨识度，跳过（同 stale-state 口径）
        if (text.includes(nowValue)) continue; // 正文用的就是当前值，正常
        // 找该对·维度下比当前值更早的不同值
        const history = relationTimeline(relations, { upTo: chapter })
            .filter((r) => relationPair(r.f.a, r.f.b).key === pair.key && r.f.relation === dim)
            .map((r) => String(r.f.value));
        const older = [...new Set(history.filter((v) => v !== nowValue && v.length >= 2))];
        for (const old of older) {
            if (text.includes(old)) {
                hits.push({ a: pair.a, b: pair.b, relation: dim, now: nowValue, nowChapter: f.chapter, old });
                break; // 每对·维度只报一条（同 facts stale-state：break 防刷屏）
            }
        }
    }
    return hits;
}
