// lib/ledger.js — 事实账本与伏笔台账（纯函数）。
// 一致性硬约束的数据侧：账本冲突在这里判定，写章工具据此拒绝保存。

import { nextSuffixedId } from './versioning.js';

/** 追加事实更新；返回 {facts, added, conflicts}。
 * 冲突规则：同 entity+key 的最新记录与本次值不同、且 latest.chapter >= chapter
 * —— 同章内改值视为可疑（重写未换版本），拒绝；跨章改值是正常的剧情推进，放行并留历史。
 * @param updates [{entity, key, value, note?}]
 */
export function applyFactUpdates(facts, updates, { chapter, now = new Date().toISOString() } = {}) {
    if (!Number.isInteger(chapter) || chapter < 1) throw new Error('chapter 必须是正整数');
    const next = [...facts];
    const added = [];
    const conflicts = [];
    for (const u of updates) {
        if (u === null || typeof u !== 'object') throw new Error('fact 更新必须是对象');
        const { entity, key, value } = u;
        if (typeof entity !== 'string' || entity.trim() === '') throw new Error('fact.entity 不能为空');
        if (typeof key !== 'string' || key.trim() === '') throw new Error('fact.key 不能为空');
        if (value === undefined || value === null || String(value).trim() === '') {
            throw new Error(`fact.value 不能为空（${entity}.${key}）`);
        }
        const history = next.filter((f) => f.entity === entity && f.key === key);
        const latest = history[history.length - 1];
        if (latest !== undefined && latest.value !== value && latest.chapter >= chapter) {
            conflicts.push({
                entity,
                key,
                current: latest.value,
                attempted: value,
                reason: `「${entity}.${key}」当前为「${latest.value}」（第${latest.chapter}章起），同一章内改为「${value}」被拒绝；确需改写请先换新版本或调整 chapter`,
            });
            continue;
        }
        if (latest !== undefined && latest.value === value) continue; // 幂等
        const fact = { entity, key, value: String(value), chapter, note: u.note ?? '', ts: now };
        next.push(fact);
        added.push(fact);
    }
    return { facts: next, added, conflicts };
}

/** 查询：按 entity/key 过滤，取每个 entity+key 的最新值。 */
export function queryFacts(facts, { entity, key, sinceChapter } = {}) {
    const latest = new Map();
    for (const f of facts) {
        if (entity !== undefined && f.entity !== entity) continue;
        if (key !== undefined && f.key !== key) continue;
        if (sinceChapter !== undefined && f.chapter < sinceChapter) continue;
        latest.set(`${f.entity}\u0000${f.key}`, f);
    }
    return [...latest.values()].sort((a, b) => a.entity.localeCompare(b.entity) || a.key.localeCompare(b.key));
}

/** 上下文包用的紧凑摘要行：「林晚·境界: 筑基三层（第12章起）」。 */
export function factsDigest(facts, entities, limit = 40) {
    const rows = queryFacts(facts, {});
    const wanted = entities === undefined || entities.length === 0
        ? rows
        : rows.filter((r) => entities.includes(r.entity));
    return wanted.slice(0, limit).map((r) => `${r.entity}·${r.key}: ${r.value}（第${r.chapter}章起）`);
}

/** 账本 chapter 护栏：更新章号不得超前于已写章节 +1（模型填错章号会静默污染历史）。
 * @param chapter          本次更新的章号
 * @param maxWrittenChapter 已写到的最大章号（无章节传 0）
 */
export function assertLedgerChapter(chapter, maxWrittenChapter) {
    if (!Number.isInteger(chapter) || chapter < 1) throw new Error('chapter 必须是正整数');
    const max = Number.isInteger(maxWrittenChapter) && maxWrittenChapter > 0 ? maxWrittenChapter : 0;
    if (max >= 1 && chapter > max + 1) {
        throw new Error(`chapter 超前：全书已写到第${max}章，账本更新章号不得超过 ${max + 1}。写章时的状态变化应随 novel_write_chapter 的 facts_updates 落账。`);
    }
}

// ── 时点推演（B2）────────────────────────────────────────────────────────────
//
// queryFacts 回答「**现在**是什么」，这里回答「**第 n 章时**是什么」。
// 写第 80 章要回溯第 12 章的境界、或核对「第 40 章断腿第 50 章还能跑」，
// 靠「最新值」是算不出来的——必须按章号累加推演。

/**
 * 第 n 章时点的状态快照。
 *
 * 推演规则：取 `chapter <= n` 的全部记录，每个 entity+key 保留**章号最大**的一条
 * （同章多条取**最后写入**的一条——数组顺序即写入顺序）。
 * 注意不能简单取「数组里最后一条」：补录早期章节是常态（先写第 12 章、后补第 3 章），
 * 那会把新值覆盖成旧值。
 *
 * @param chapter 时点章号（含）
 * @param entities 可选：只看这些实体
 * @param keys 可选：只看这些键
 * @returns [{entity, key, value, chapter, note}]（按 entity/key 排序）
 */
export function factsAt(facts, chapter, { entities, keys } = {}) {
    if (!Number.isInteger(chapter) || chapter < 1) throw new Error('chapter 必须是正整数');
    const wantEntities = Array.isArray(entities) && entities.length > 0 ? entities : null;
    const wantKeys = Array.isArray(keys) && keys.length > 0 ? keys : null;
    const picked = new Map();
    for (const f of facts ?? []) {
        if (f === null || typeof f !== 'object') continue;
        if (!Number.isInteger(f.chapter) || f.chapter > chapter) continue;
        if (wantEntities !== null && !wantEntities.includes(f.entity)) continue;
        if (wantKeys !== null && !wantKeys.includes(f.key)) continue;
        const k = `${f.entity}\u0000${f.key}`;
        const cur = picked.get(k);
        // 章号更大 → 覆盖；同章 → 后写的覆盖（推演语义）
        if (cur === undefined || f.chapter >= cur.chapter) picked.set(k, f);
    }
    return [...picked.values()]
        .sort((a, b) => String(a.entity).localeCompare(String(b.entity)) || String(a.key).localeCompare(String(b.key)))
        .map((f) => ({ entity: f.entity, key: f.key, value: f.value, chapter: f.chapter, note: f.note ?? '' }));
}

/**
 * 单实体的状态演化线：全部变更记录按章号排序。
 *
 * 回答「X 的状态是怎么一步步变成现在这样的」——status_at / factsDigest 的**事实依据**，
 * 也是对账「某个值是哪一章被谁改掉的」的唯一通道。
 *
 * @param entity 实体名（必填）
 * @param keys   可选：只看这些键
 * @returns [{chapter, key, value, note}]（章号升序，同章保持写入顺序）
 */
export function statusTimeline(facts, entity, { keys } = {}) {
    if (typeof entity !== 'string' || entity.trim() === '') throw new Error('entity 不能为空');
    const wantKeys = Array.isArray(keys) && keys.length > 0 ? keys : null;
    return (facts ?? [])
        .map((f, seq) => ({ f, seq }))
        .filter(({ f }) => f !== null && typeof f === 'object' && f.entity === entity)
        .filter(({ f }) => wantKeys === null || wantKeys.includes(f.key))
        .filter(({ f }) => Number.isInteger(f.chapter))
        .sort((a, b) => (a.f.chapter - b.f.chapter) || (a.seq - b.seq))
        .map(({ f }) => ({ chapter: f.chapter, key: f.key, value: f.value, note: f.note ?? '' }));
}

// ── 伏笔台账 ────────────────────────────────────────────────────────────────

export function foreshadowSetup(list, { id, setup, chapter, plan }) {
    if (typeof setup !== 'string' || setup.trim() === '') throw new Error('伏笔 setup 不能为空');
    // 自动 id 取已用最大编号+1（gap 安全），不会和手工删条目留下的 id 静默碰撞。
    const fid = id ?? nextSuffixedId(list.map((f) => f.id), 'F');
    // plan：预计回收章号（Crucible 式 Plants & Payoffs——超期未回收是可代码判定的硬信号）。
    const planChapter = Number.isInteger(plan) && plan >= 1 ? plan : null;
    const existing = list.find((f) => f.id === fid);
    if (existing !== undefined) {
        // 同 id 且未回收 = 改期/改写（否则超期的 plan 永远只能等 payoff，没有重新规划通道）。
        if (existing.payoffChapter !== null) {
            throw new Error(`伏笔 ${fid} 已在第${existing.payoffChapter}章回收，不能再改期`);
        }
        const nextPlan = plan === undefined ? existing.plan : planChapter;
        return list.map((f) => (f.id === fid ? { ...f, setup: setup.trim(), chapter, plan: nextPlan } : f));
    }
    return [...list, { id: fid, setup: setup.trim(), chapter, plan: planChapter, payoffChapter: null }];
}

export function foreshadowPayoff(list, id, chapter) {
    const f = list.find((x) => x.id === id);
    if (f === undefined) throw new Error(`伏笔不存在：${id}`);
    if (f.payoffChapter !== null) throw new Error(`伏笔 ${id} 已在第${f.payoffChapter}章回收`);
    return list.map((x) => (x.id === id ? { ...x, payoffChapter: chapter } : x));
}

export function openForeshadows(list) {
    return list.filter((f) => f.payoffChapter === null);
}

/** 超期伏笔：已到/超过预计回收章仍未收（Crucible 的 payoff 追踪落成硬告警）。 */
export function overdueForeshadows(list, currentChapter) {
    if (!Number.isInteger(currentChapter)) return [];
    return openForeshadows(list)
        .filter((f) => Number.isInteger(f.plan) && currentChapter > f.plan)
        .sort((a, b) => a.plan - b.plan);
}

export function foreshadowDigest(list, limit = 8, currentChapter) {
    // 超期优先，其次按预计回收章、埋设章排序——先还旧账再开新账。
    const rows = openForeshadows(list).sort((a, b) => {
        const pa = Number.isInteger(a.plan) ? a.plan : Number.POSITIVE_INFINITY;
        const pb = Number.isInteger(b.plan) ? b.plan : Number.POSITIVE_INFINITY;
        return (pa - pb) || (a.chapter - b.chapter);
    });
    return rows.slice(0, limit).map((f) => {
        const planTxt = Number.isInteger(f.plan) ? `，预计第${f.plan}章收` : '';
        const overdue = currentChapter !== undefined && Number.isInteger(f.plan) && currentChapter > f.plan ? '，⚠已超期' : '';
        return `${f.id}·未回收（第${f.chapter}章埋${planTxt}${overdue}）: ${f.setup}`;
    });
}
