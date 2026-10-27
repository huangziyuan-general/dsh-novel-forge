// lib/ledger.js — 事实账本与伏笔台账（纯函数）。
// 一致性硬约束的数据侧：账本冲突在这里判定，写章工具据此拒绝保存。

import { nextSuffixedId } from './versioning.js';

/**
 * 事实的三态（借竞品 A 的 values / unknown / blockers）。
 *
 *   confirmed —— 已确认的事实。正文可以直接依据它写。
 *   unknown   —— **明确未知**（且带原因）。正文**不得**替它补齐一个值：
 *                设定里没写的，模型自己编一个填进正文，那个编的值就成了「事实」
 *                （本项目要治的「设定凭空长出来」）。
 *   pending   —— 待复核（有一个候选值，但还没确认）。可以写进正文，但要让读者
 *                看出这是未定论——多半用于「传闻/将信将疑」的状态。
 *
 * 缺省是 confirmed：旧账本记录没有 status 字段，一律按已确认读（向后兼容，
 * 不改旧书语义）。
 */
export const FACT_STATUS = ['confirmed', 'unknown', 'pending'];

/** 归一化事实状态：非法值一律当 confirmed（宁可信旧值，也不让脏数据卡住写作）。 */
export function normalizeFactStatus(status) {
    if (status === undefined || status === null || status === '') return 'confirmed';
    const s = String(status).trim().toLowerCase();
    return FACT_STATUS.includes(s) ? s : 'confirmed';
}

/** 读一条事实的状态（旧记录无 status → confirmed）。 */
export function factStatusOf(fact) {
    return normalizeFactStatus(fact?.status);
}


/** 冲突文案里的值截断：完整值可能上千字符（真机 avg 524 / max 1042），
 * 直接拼进 reason 会让审计行与报错信息不可读。结构化字段 current/attempted 保留全值。 */
function clipValue(v, max = 40) {
    const s = String(v ?? '');
    return s.length <= max ? s : `${s.slice(0, max)}…`;
}

/** 追加事实更新；返回 {facts, added, conflicts}。
 * 冲突规则：同 entity+key 的最新记录与本次值不同、且 latest.chapter === chapter
 * —— 同章内改值视为可疑（重写未换版本），拒绝；补录更早章节或跨章改值是正常
 * 的剧情推进/回填，放行并留历史（0.13.6 修正：原先 >= 把补录也拒了，与报错文案自相矛盾）。
 * @param updates [{entity, key, value, note?, status?}]
 * @param now ISO 时间戳——**必填**：纯函数不取钟（AGENTS.md 不变量 2），由调用方传入。
 */
export function applyFactUpdates(facts, updates, { chapter, now } = {}) {
    if (!Number.isInteger(chapter) || chapter < 1) throw new Error('chapter 必须是正整数');
    if (typeof now !== 'string' || now === '') throw new Error('now 必填（ISO 时间戳）——纯函数不取钟，由调用方传入');
    const next = [...facts];
    const added = [];
    const conflicts = [];
    for (const u of updates) {
        if (u === null || typeof u !== 'object') throw new Error('fact 更新必须是对象');
        const { entity, key, value } = u;
        const status = normalizeFactStatus(u.status);
        if (typeof entity !== 'string' || entity.trim() === '') throw new Error('fact.entity 不能为空');
        if (typeof key !== 'string' || key.trim() === '') throw new Error('fact.key 不能为空');
        if (value === undefined || value === null || String(value).trim() === '') {
            throw new Error(`fact.value 不能为空（${entity}.${key}）`);
        }
        const note = u.note ?? '';
        if (status === 'unknown' && String(note).trim() === '') {
            throw new Error(`status=unknown 必须写明未知原因（${entity}.${key}）：`
                + '写成「实体|键|未知|为什么现在还不知道」。未知必须有边界，否则它会变成「懒得查设定」的挡箭牌。');
        }
        const history = next.filter((f) => f.entity === entity && f.key === key);
        const latest = history[history.length - 1];
        if (latest !== undefined && latest.value !== value && latest.chapter === chapter) {
            conflicts.push({
                entity,
                key,
                current: latest.value,
                attempted: value,
                reason: `「${entity}.${key}」当前为「${clipValue(latest.value)}」（第${latest.chapter}章起），同一章内改为「${clipValue(value)}」被拒绝；同一键在同一章只落一行终态——过程变化写进备注（如「先承墨骨拓具、章末并入王贵油纸包」），或只报本章还没落过账的键。重写同章同样受此限（账本按章记终态，与版本无关）：已落账的键从 facts_updates 省略；正文表述确实变了，用 novel_ledger update 落到实际变化的章号并备注`,
            });
            continue;
        }
        if (latest !== undefined && latest.value === value) {
            // 同值：幂等跳过。但**状态变了**就不是幂等——状态也是终态的一部分。
            if (factStatusOf(latest) === status) continue;
            if (latest.chapter === chapter) {
                conflicts.push({
                    entity,
                    key,
                    current: latest.value,
                    attempted: value,
                    reason: `「${entity}.${key}」在本章已落账（值「${clipValue(value)}」，状态「${factStatusOf(latest)}」），`
                        + `现在要改成状态「${status}」——同一键在同一章只落一行终态，状态不能靠第二次 update 悄悄改。`
                        + '若确实要改状态，请落到实际变化的章号，或用 novel_ledger update 覆盖成新值再标状态。',
                });
                continue;
            }
        }
        const fact = { entity, key, value: String(value), status, chapter, note, ts: now };
        next.push(fact);
        added.push(fact);
    }
    return { facts: next, added, conflicts };
}

/** 查询：按 entity/key 过滤，取每个 entity+key 的最新值。
 * 「最新」按 chapter 取最大（同章并列取后写入的）——账本允许补录早章，
 * 只看数组顺序会把补录误当成当前值（0.13.6 修正，与 factsAt 的时点语义对齐）。 */
export function queryFacts(facts, { entity, key, sinceChapter } = {}) {
    const latest = new Map();
    const idx = new Map();
    facts.forEach((f, i) => {
        if (entity !== undefined && f.entity !== entity) return;
        if (key !== undefined && f.key !== key) return;
        if (sinceChapter !== undefined && f.chapter < sinceChapter) return;
        const k = `${f.entity}\u0000${f.key}`;
        const j = idx.get(k);
        if (j === undefined || f.chapter >= facts[j].chapter) {
            latest.set(k, f);
            idx.set(k, i);
        }
    });
    return [...latest.values()]
        .map((f) => ({ ...f, status: factStatusOf(f) }))
        .sort((a, b) => a.entity.localeCompare(b.entity) || a.key.localeCompare(b.key));
}

/** 上下文包用的紧凑摘要行：「测试角色·境界: 筑基三层（第12章起）」。
 * cast 实体优先、其余实体跟上（都在 limit 内）——写章简报只看人物卡会漏掉
 * 门派/地点/信物的状态线，而一致性检测用的是全部实体（0.13.6 修正：供给与检测对称）。
 *
 * 三态在摘要里**必须显形**：status=unknown 的行标成「未知（原因：…）」，
 * status=pending 的行标成「待复核」——模型在简报里看见「这里还没定」，
 * 才不会在正文里替它编一个值（这正是 A 的 unknown 机制要的效果：
 * 「未知不得用主档或更早值补齐」靠的就是这条摘要行进上下文）。
 */
export function factsDigest(facts, entities, limit = 40) {
    const rows = queryFacts(facts, {});
    if (entities !== undefined && entities.length > 0) {
        const cast = new Set(entities);
        rows.sort((a, b) => (cast.has(a.entity) ? 0 : 1) - (cast.has(b.entity) ? 0 : 1));
    }
    return rows.slice(0, limit).map((r) => {
        const st = factStatusOf(r);
        if (st === 'unknown') {
            const why = String(r.note ?? '').trim();
            return `${r.entity}·${r.key}: 未知（第${r.chapter}章起${why === '' ? '' : `·原因：${why}`}）——**设定未定，正文不得替它补一个值**`;
        }
        if (st === 'pending') {
            return `${r.entity}·${r.key}: ${r.value}（第${r.chapter}章起·待复核）`;
        }
        return `${r.entity}·${r.key}: ${r.value}（第${r.chapter}章起）`;
    });
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
 * @returns [{entity, key, value, status, chapter, note}]（按 entity/key 排序）
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
        .map((f) => ({ entity: f.entity, key: f.key, value: f.value, status: factStatusOf(f), chapter: f.chapter, note: f.note ?? '' }));
}

/**
 * 单实体的状态演化线：全部变更记录按章号排序。
 *
 * 回答「X 的状态是怎么一步步变成现在这样的」——status_at / factsDigest 的**事实依据**，
 * 也是对账「某个值是哪一章被谁改掉的」的唯一通道。
 *
 * @param entity 实体名（必填）
 * @param keys   可选：只看这些键
 * @returns [{chapter, key, value, status, note}]（章号升序，同章保持写入顺序）
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
        .map(({ f }) => ({ chapter: f.chapter, key: f.key, value: f.value, status: factStatusOf(f), note: f.note ?? '' }));
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
