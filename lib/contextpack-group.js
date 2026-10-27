// lib/contextpack-group.js — 上下文块的冲突组消解 + 丢弃次序声明（纯函数，零 IO、零模型调用）。
//
// 补的是 `lib/contextpack.js` 的一个结构性短板：它有成熟的硬预算与保留额，但
// **`push()` 是纯顺序填充**——同一主题有两块讲得不一样的东西时，谁挤掉谁靠的是
// 遍历顺序，不是显式规则。报告里点名的那句病根：
//
//   「世界书多本书目/场景契约都可能对同一实体给出不同描述——现在靠顺序「后者挤掉
//   前者」，靠的是 push 的遍历顺序，不是显式规则。」
//
// 本模块把「顺序即优先级」这条隐式约定改成**显式声明**：
//   ① **冲突组**：同一主题只能留一块。组内按 authority → freshness → priority →
//      required → 声明顺序 裁决，输出一条「为什么留 A 丢 B」的记录。
//   ② **dropOrder**：超预算时**先丢哪个**由声明说了算，不再由 push 顺序隐式决定。
//
// 与既有机制的关系（很重要，别读错）：
//   · **默认行为一字不变**。没声明组、没声明 dropOrder 的块，裁决与丢弃结果与
//     改造前逐字节一致——真机踩坑换来的保留额机制不是拿来重写的。
//   · dropOrder 的默认值由**声明顺序**导出（声明越早 → 保留越优先 → 越晚丢），
//     所以「先到先得」这条既有语义被原样保留，只是从「碰巧」变成了「声明」。
//   · 权威性（authority）是本项目对 C 的 `freshness → priority → required` 的
//     **适配**：C 靠时间戳比新鲜度，本项目没有可比的时间戳（世界书条目无
//     updatedAt、人物卡是 Markdown 文件），但有更强的**语义权威**信号——
//     人物卡是专用的权威描述，世界书是泛设定，账本是已落地的事实。
//     所以 authority 排第一，freshness（若数据上拿得到）排第二。
//
// 纯函数（AGENTS.md 不变量 2）：输入输出皆数据，不碰 io、不取钟、不写文件。

/**
 * 块的权威性分级（本项目的语义权威，不是「谁先来」）。
 *
 * 数值只在本模块内部有意义——它表达的是「同一主题讲得不一样时，谁更该被采信」：
 *   character 人物卡   —— 这个人物的**专用**描述，是权威来源
 *   facts    事实账本   —— 已经落地成事实（带章节戳），比设定更「新」
 *   voice    语言基因卡 —— 说话方式的专用来源
 *   world    世界书条目 —— 泛设定，容易和专用描述打架
 *   generic  其它
 */
export const AUTHORITY = {
    character: 100,
    facts: 90,
    voice: 80,
    world: 50,
    generic: 30,
};

/** 冲突组前缀：按**主题实体**分组，不是按区块种类。 */
export const GROUP_PREFIX = {
    entity: 'entity:',   // 同一个「人/物」的描述
    voice: 'voice:',     // 同一个人的说话方式
    fact: 'fact:',       // 同一条事实口径
};

/**
 * 推断一个块的冲突组。
 *
 * @param kind   区块种类（character / voice / world / facts / outline / contract …）
 * @param name   区块显示名（如「人物卡·张三」「世界书·W7」）
 * @param subject 主题实体名（人物名等）；世界书条目由调用方判定它讲的是谁
 * @returns {string|null} 组键；null 表示自成一组（不参与组内竞争）
 */
export function groupFor({ kind, name = '', subject = null } = {}) {
    const subj = typeof subject === 'string' && subject.trim() !== '' ? subject.trim() : null;
    if (kind === 'character' && subj !== null) return `${GROUP_PREFIX.entity}${subj}`;
    if (kind === 'voice' && subj !== null) return `${GROUP_PREFIX.voice}${subj}`;
    if (kind === 'world' && subj !== null) return `${GROUP_PREFIX.entity}${subj}`;
    return null;
}

/**
 * 块的比较键（组内裁决用）。
 *
 * 顺序：authority → freshness → priority → required → 声明顺序。
 *   authority  本项目的语义权威（见 AUTHORITY）
 *   freshness  新鲜度戳（越大越新）。**可选**——本项目多数块拿不到可比的时间戳，
 *              拿不到就当 0（本模块不虚构新鲜度）。
 *   priority   声明的优先级（世界书条目自带 priority 0-100）
 *   required   是否硬需求（硬需求不许被同组的非硬需求挤掉）
 *   order      声明顺序（最后的兜底：完全同级时先声明的留下）
 */
function compareCandidates(a, b) {
    const auth = (b.authority ?? 0) - (a.authority ?? 0);
    if (auth !== 0) return auth;
    const fresh = (b.freshness ?? 0) - (a.freshness ?? 0);
    if (fresh !== 0) return fresh;
    const prio = (b.priority ?? 0) - (a.priority ?? 0);
    if (prio !== 0) return prio;
    const req = (b.required === true ? 1 : 0) - (a.required === true ? 1 : 0);
    if (req !== 0) return req;
    return (a.order ?? 0) - (b.order ?? 0);
}

/** 裁决键（用于判「两块讲得一样好」→ 平权都留，不替用户做主）。 */
function tieKey(c) {
    return [c.authority ?? 0, c.freshness ?? 0, c.priority ?? 0, c.required === true ? 1 : 0].join('|');
}

/**
 * 冲突组消解：同一组只留一块，其余出局并**记下原因**。
 *
 * 「记下原因」是这一轮的关键：冲突消解最怕消解得**看不见**——模型不知道
 * 自己拿到的这一块是赢来的还是碰巧排在前面的，简报也就没法提示「另有一处说法
 * 不同，你按这个写」。落选块的名字与原因会进 dropped 之外的独立通道，由调用方
 * 决定怎么告诉模型。
 *
 * **平权规则**：组内两块裁决键完全相同（一样权威、一样新、一样优先）时**都留**。
 * 本项目里最常见的情形是两条世界书条目 priority 都是默认的 50——它们讲得同样
 * 权威，替用户挑一条留下就是**凭空替他做主**，而且可能裁掉一条完全正常的设定。
 * 只有用户明确标了不同 priority（或一方是硬需求/专用描述）时才裁决。
 *
 * @param candidates [{ key, name, group, authority, freshness, priority, required, order }]
 * @returns { kept:[候选], dropped:[{候选, winner, reason}] }
 */
export function resolveConflicts(candidates = []) {
    const list = Array.isArray(candidates) ? candidates : [];
    /** @type {Map<string, any[]>} */
    const byGroup = new Map();
    const kept = [];
    const dropped = [];

    for (const c of list) {
        const g = typeof c?.group === 'string' && c.group !== '' ? c.group : null;
        if (g === null) { kept.push(c); continue; }
        if (!byGroup.has(g)) byGroup.set(g, []);
        byGroup.get(g).push(c);
    }

    for (const [group, members] of byGroup) {
        if (members.length === 1) { kept.push(members[0]); continue; }
        // 排序：胜者在前；同分时保持声明顺序（compareCandidates 末位兜底）
        const ranked = [...members].sort(compareCandidates);
        const winner = ranked[0];
        kept.push(winner);
        for (const loser of ranked.slice(1)) {
            // 平权：讲得一样好 → 都留，不替用户做主
            if (tieKey(loser) === tieKey(winner)) { kept.push(loser); continue; }
            dropped.push({
                candidate: loser,
                winner,
                group,
                reason: `同一主题「${group}」有两块讲法不同：留「${winner.name}」（${authorityReason(winner, loser)}），`
                    + `丢「${loser.name}」（${authorityReason(loser, winner)}）`,
            });
        }
    }

    // 同一**对象**去重：一条世界书条目可能同时出现在多个组的候选里（多主题），
    // 只保留第一次出现的。按 key 字符串去重是错的——两块不同的候选可能共用 key
    // （例如两条世界书条目 id 相同但内容不同），按字符串去重会误删其中一块。
    const unique = [];
    const seenObj = new Set();
    for (const c of kept) {
        if (seenObj.has(c)) continue;
        seenObj.add(c);
        unique.push(c);
    }
    return { kept: unique, dropped };
}

/**
 * 说清「这一块凭什么赢（或凭什么输）」——裁决记录必须能自证，不能只给结论。
 *
 * **只说决定胜负的那一个键**，且方向必须与事实一致。
 *
 * 为什么不能把所有不一样的键都列出来：裁决键有四级（权威性 → 新鲜度 → 优先级 →
 * 硬需求），**只有第一个不一样的键才是真正起作用的那个**。把后面几级也列上，
 * 会让人以为「它每一项都赢」——实际上人物卡赢的是权威性（100 > 50），它的优先级
 * 反而更低（0 < 50）。写「优先级 0 > 50」是**一句假的不等式**。
 *
 * 为什么不能拿 `>` 当分隔符：原文案写的是「权威性 ${a} > ${b}」，本意是「a 对 b」，
 * 但符号读起来就是「a 大于 b」——败者侧会印出「权威性 50 > 100」。这段文案会进
 * 简报告警给模型看，一句假的不等式足以让模型误判谁更权威。
 */
function authorityReason(candidate, other) {
    const a = candidate.authority ?? 0;
    const b = other.authority ?? 0;
    if (a !== b) return `权威性 ${a} ${a > b ? '高于' : '低于'}对方 ${b}`;
    const fa = candidate.freshness ?? 0;
    const fb = other.freshness ?? 0;
    if (fa !== fb) return `同样权威，但新鲜度 ${fa} ${fa > fb ? '高于' : '低于'}对方 ${fb}`;
    const pa = candidate.priority ?? 0;
    const pb = other.priority ?? 0;
    if (pa !== pb) return `同样权威、同样新鲜，但优先级 ${pa} ${pa > pb ? '高于' : '低于'}对方 ${pb}`;
    if ((candidate.required === true) !== (other.required === true)) {
        return candidate.required === true ? '同样权威，但它标了硬需求' : '同样权威，但它没标硬需求';
    }
    return '同级，按声明顺序先到先得';
}

/**
 * 牺牲优先级：某块「有多容易被牺牲」。**越大越先被牺牲**。
 *
 * 缺省 = 永不牺牲（-Infinity）：没声明的块（硬需求：细纲/承诺书/契约/账本/伏笔/
 * 节奏，以及全书大纲）**永远不会被踢掉给别的块腾地方**——它们是必须保住的。
 *
 * 与「保留优先级」是两件事：保留优先级 = 谁先入包 = 声明顺序（既有行为，一字不变）；
 * 牺牲优先级 = 预算不够时谁先被踢 = 本函数管的。
 */
export function sacrificePriority(candidate) {
    const v = candidate?.dropOrder;
    return (typeof v === 'number' && Number.isFinite(v)) ? v : Number.NEGATIVE_INFINITY;
}

/**
 * 挑牺牲品：从已装入的块里选「比当前块更该被牺牲」的那一块。
 *
 * 规则：牺牲品的优先级必须 **严格大于** 当前块的优先级（更不值钱）。
 * 找不到 → 当前块自己丢（既有行为）。
 *
 * 为什么要求「严格大于」：否则会出现「锚段（最可牺牲）自己装不下，
 * 却去踢掉次可牺牲的语言卡来给自己腾位置」这种反直觉的结果——牺牲品必须
 * 比被保住的那块更不值钱，否则牺牲顺序就乱了。
 *
 * @param packed    已装入的块 [{ name, content }]
 * @param current   当前装不下的块 { dropOrder }
 * @param priorityOf 可选：优先级查询函数（packed 元素不带 dropOrder 时用它查）。
 *                   返回的必须是 packed 里的**原对象**——调用方要按它做 splice。
 * @returns 被牺牲的块或 null
 */
export function pickVictim(packed = [], current = {}, priorityOf = null) {
    const cur = sacrificePriority(current);
    // 回调返回值必须规范化：没声明 dropOrder 的块回调会返回 undefined，
    // 而 undefined <= -Infinity 恒为 false —— 不规范化就会把**硬需求块**
    // （细纲/承诺书/契约）当成牺牲品踢掉。宁可漏牺牲，不可牺牲错块。
    const pr = (x) => {
        const v = typeof priorityOf === 'function' ? priorityOf(x) : sacrificePriority(x);
        return (typeof v === 'number' && Number.isFinite(v)) ? v : Number.NEGATIVE_INFINITY;
    };
    let best = null;
    let bestPr = cur;
    for (const p of Array.isArray(packed) ? packed : []) {
        const v = pr(p);
        if (v === Number.NEGATIVE_INFINITY) continue; // 没声明 = 永不牺牲
        if (v <= cur) continue;                       // 没当前块该牺牲 → 不动它
        if (best === null || v > bestPr) { best = p; bestPr = v; }
    }
    return best;
}

/**
 * 世界书条目讲的是谁：从条目内容与关键词里找本章出场人物。
 *
 * 为什么要判：世界书条目没有「这是谁的设定」这种字段，只能靠文本命中。
 * 判定要求**条目内容或关键词里出现该人物名**——只出现在 keywords 里也算
 * （关键词本就是「这条讲谁」的触发面）。
 *
 * 一个人名命中多个条目是常态（张三有三条设定）——那它们全在 `entity:张三` 组里，
 * 组内按 authority → priority 裁决，priority 高的留。
 *
 * @param entry    世界书条目 { content, keywords }
 * @param names    本章出场人物名
 * @returns {string[]} 命中的人物名（去重，长的名字优先——「张三丰」应先于「张三」命中）
 */
export function entrySubjects(entry, names = []) {
    const content = String(entry?.content ?? '');
    const keywords = Array.isArray(entry?.keywords) ? entry.keywords.map((k) => String(k ?? '')) : [];
    const hay = `${content}\n${keywords.join('\n')}`;
    const list = (names ?? [])
        .filter((n) => typeof n === 'string' && n.trim() !== '')
        .map((n) => n.trim())
        .sort((a, b) => b.length - a.length); // 长名优先：「张三丰」不该被「张三」抢走
    const hits = [];
    for (const n of list) {
        if (!hay.includes(n)) continue;
        // 已被更长的名字覆盖（「张三」被「张三丰」命中过就不再单列）
        if (hits.some((h) => h.includes(n))) continue;
        hits.push(n);
    }
    return hits;
}

/**
 * 世界书条目按**触发词连通分量**分组（没有人物卡时的裁决依据）。
 *
 * 为什么需要它：讲「同一个人」的判定原本靠人物名（entrySubjects），但那一路
 * 要求该人物**有卡**。没有卡的角色，多条世界书条目各写各的——正是报告点名的
 * 「世界书多本书目对同一实体给出不同描述」。这时唯一可用的信号是**触发词**：
 * 两条条目的 keywords 有交集，就有可能讲的是一回事。
 *
 * 连通分量（并查集）：A 与 B 共享词、B 与 C 共享词 → A/B/C 同组。
 * 组键取该分量里 id 最小的那条（稳定、可复现）。
 *
 * @returns {Map<number,string>} 目索引 → 组键（无触发词的条目不在任何组里）
 */
export function settingGroupKeys(entries = []) {
    const list = Array.isArray(entries) ? entries : [];
    const parent = list.map((_, i) => i);
    const find = (x) => {
        while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
        return x;
    };
    const union = (a, b) => { const ra = find(a); const rb = find(b); if (ra !== rb) parent[rb] = ra; };
    const owner = new Map(); // keyword → 第一个含它的条目索引
    list.forEach((e, i) => {
        for (const k of Array.isArray(e?.keywords) ? e.keywords : []) {
            const key = String(k ?? '').trim();
            if (key === '') continue;
            if (owner.has(key)) union(owner.get(key), i);
            else owner.set(key, i);
        }
    });
    // 组代表 = 分量内 id 最小者（稳定）
    const rep = new Map();
    list.forEach((e, i) => {
        const r = find(i);
        const id = String(e?.id ?? String(i));
        if (!rep.has(r)) rep.set(r, id);
        else if (id < rep.get(r)) rep.set(r, id);
    });
    const out = new Map();
    list.forEach((e, i) => {
        const id = String(e?.id ?? '');
        if (id === '') return;
        const kws = Array.isArray(e?.keywords) ? e.keywords.filter((k) => String(k ?? '').trim() !== '') : [];
        if (kws.length === 0) return;   // 没触发词的条目无从判同 → 不进组
        out.set(i, `setting:${rep.get(find(i))}`);
    });
    return out;
}

/**
 * 实体冲突消解（本项目特化入口）：人物卡 / 世界书条目之间「讲同一个人」时的裁决。
 *
 * 场景来自真机痛点：世界书里同一个角色可能散在好几条条目里，各写各的；
 * 人物卡又另有一份描述。改造前是**顺序填充**——谁排在后面谁把前面的挤掉，
 * 挤掉的是不是该挤的那条全凭遍历顺序。本函数把这件事变成显式规则：
 *
 *   ① 人物卡 vs 世界书条目（讲同一人）→ **人物卡留**。它是这个人物的**专用**
 *      描述，世界书是泛设定条目；专用来源压泛来源是本项目的语义权威。
 *   ② 世界书条目 vs 世界书条目（讲同一人、且没有人物卡）→ **priority 高的留**
 *      （世界书条目自带 priority 0-100，本就是「预算不足时先入上下文」的序）。
 *   ③ 一条世界书条目讲了好几个人 → 它进多个组；**只要在任一组里落选就整条出局**
 *      （半个设定进包比整条出局更糟——它会带着被否掉的那部分口径一起进去）。
 *
 * 人物卡缺失时世界书条目照常入包（组里只有它自己 = 无冲突）✓
 *
 * @param castCards    [{ name, card }]
 * @param worldEntries [{ id, content, keywords, priority }]
 * @returns { excludedWorld:string[], conflicts:{group,winner,loser,reason}[] }
 *          excludedWorld = 被裁决掉的界书条目 id（不入包）
 */
export function resolveEntityConflicts({ castCards = [], worldEntries = [] } = {}) {
    const cards = Array.isArray(castCards) ? castCards : [];
    const entries = Array.isArray(worldEntries) ? worldEntries : [];
    const names = cards.map((c) => c?.name).filter((n) => typeof n === 'string' && n.trim() !== '');

    const candidates = [];
    const settingGroups = settingGroupKeys(entries);
    cards.forEach((c, i) => {
        const name = String(c?.name ?? '').trim();
        if (name === '') return;
        candidates.push({
            key: `character:${name}`,
            name: `人物卡·${name}`,
            kind: 'character',
            subject: name,
            group: groupFor({ kind: 'character', subject: name }),
            authority: AUTHORITY.character,
            order: i,
        });
    });
    entries.forEach((e, i) => {
        const id = String(e?.id ?? '');
        if (id === '') return;
        // 每个条目只进**一个**组：讲的人有人物卡 → entity 组（与人物卡比权威性）；
        // 没人的人物卡 → setting 组（按触发词连通分量，与同类条目比 priority）。
        // 只进一个组避免「在 A 组赢、在 B 组输」这种自相矛盾的两条命。
        const subjects = entrySubjects(e, names);
        const group = subjects.length > 0
            ? groupFor({ kind: 'world', subject: subjects[0] })
            : (settingGroups.get(i) ?? null);
        if (group === null) return;
        candidates.push({
            key: `world:${id}`,
            name: `世界书·${id}`,
            kind: 'world',
            subject: subjects[0] ?? null,
            group,
            authority: AUTHORITY.world,
            priority: Number.isInteger(e?.priority) ? e.priority : 50,
            order: cards.length + i,
        });
    });

    const { kept, dropped } = resolveConflicts(candidates);

    // 落选 → 整条世界书条目出局（任一组输了就出局）
    const excluded = new Set();
    const conflicts = [];
    for (const d of dropped) {
        const key = String(d.candidate?.key ?? '');
        if (key.startsWith('world:')) excluded.add(key.slice('world:'.length));
        conflicts.push({
            group: d.group,
            winner: d.winner?.name ?? '',
            loser: d.candidate?.name ?? '',
            reason: d.reason,
        });
    }

    // kept 里胜出的世界书条目 id（用于确认哪些条目留了下来）
    const keptWorld = new Set();
    for (const c of kept) {
        const key = String(c?.key ?? '');
        if (key.startsWith('world:')) keptWorld.add(key.slice('world:'.length));
    }

    return { excludedWorld: [...excluded], keptWorld: [...keptWorld], conflicts };
}
