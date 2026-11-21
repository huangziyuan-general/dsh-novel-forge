// lib/related-chapters.js — 相关历史章节确定性推荐（纯函数，零 token，零 io）。
//
// 简报的既知面是「当前值」：上一章结尾、各台账此刻读数、未回收伏笔清单。但 300 章书里
// 「第 38 章改过主角境界、第 51 章埋了这条伏笔、第 22 章两个角色翻脸」这类**非相邻**
// 关联，模型只能自己想到去 novel_search 现查——想不起来就写崩设定。本模块把这个「该
// 回头读哪几章」做进代码：按四个台账维度反查本章牵动的历史章，每条带**推荐理由**（不
// 给裸章号），进写前简报当追加段（不吃 pack 预算，自封顶）。
//
// 四维（全部确定性，判定口径与既有一致）：
//   ① 伏笔反查：计划回收章 == 本章（或已超期未回收）→ 推荐埋设章（回收要对上原句）
//   ② 出场反查：本章出场人物最近一次在更早章节登场 → 推荐该章（人物刻画要保持一致）
//   ③ 状态反查：本章出场实体的事实/弧线最近一次改动章 → 推荐该章（照新状态写）
//   ④ 关系反查：本章同台的两人对关系最近一次推进章 → 推荐该章
//
// 纪律：跨维去重（一章只推荐一次、保留首个理由）、最近 N 章不推（仍在上下文里，重推是
// 噪声）、封顶条数、只推荐**历史**章（ch < 本章）。无数据＝无推荐（report-only 同档）。

/** 截断到 n 字（省略号计入），理由行不刷屏。 */
function clip(s, n) {
    const t = String(s ?? '');
    return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/** 一行是否有效（字段齐全才参与判定；畸形行滤出，同各台账 isValidRow 的公共部分）。 */
const intCh = (r) => Number.isInteger(r?.chapter) && r.chapter >= 1;

/**
 * @param {object} a
 * @param {number} a.n 本章章号
 * @param {string[]} a.cast 本章出场实体/人物名（场景契约 participants，缺则简报注入名单）
 * @param {Array} a.foreshadows 伏笔台账行 {id, setup, chapter, plan, payoffChapter}
 * @param {Array} a.facts 事实账本行 {entity, key, value, status, chapter, note}
 * @param {Array} a.arcs 弧线账本行 {character, dimension, value, trend, chapter, note}
 * @param {Array} a.relations 关系账本行 {a, b, relation, value, chapter, note}
 * @param {object} a.contracts 场景契约表 { 章号字符串: { participants } }
 * @param {number} a.recentWindow 最近 N 章不推荐（仍在上下文；缺省 3）
 * @param {number} a.maxResults 封顶条数（缺省 5）
 * @returns {{ items: Array<{chapter, code, reason}>, count: number }}
 *   items 按「伏笔 > 出场 > 状态 > 关系」维度序、章号降序排；跨维去重。
 */
export function relatedChapters({
    n, cast = [], foreshadows = [], facts = [], arcs = [], relations = [],
    contracts = {}, recentWindow = 3, maxResults = 5,
}) {
    const castSet = new Set((cast ?? []).map((c) => String(c ?? '').trim()).filter((c) => c !== ''));
    const items = [];
    const seen = new Set();
    const minCh = n - recentWindow; // 只推比「最近窗口」更早的章

    const add = (ch, code, reason) => {
        if (!Number.isInteger(ch) || ch < 1 || ch >= n) return;        // 只推历史章
        if (ch >= minCh) return;                                       // 最近窗口内太近（还在上下文里），不推
        if (seen.has(ch)) return;
        if (items.length >= maxResults) return;
        seen.add(ch);
        items.push({ chapter: ch, code, reason });
    };

    // ① 伏笔：计划回收在本章 / 已超期未回收 → 回到埋设章（对回收章、对上原句）
    for (const f of foreshadows ?? []) {
        if (f === null || typeof f !== 'object' || f.payoffChapter !== null) continue; // 已回收不推
        if (!intCh(f)) continue;
        if (f.plan === n) {
            add(f.chapter, 'foreshadow', `伏笔 ${f.id}「${clip(f.setup, 12)}」计划本章回收——先回读埋设章对上下文`);
        } else if (Number.isInteger(f.plan) && f.plan < n) {
            add(f.chapter, 'foreshadow', `伏笔 ${f.id}「${clip(f.setup, 12)}」已超期（原计划第${f.plan}章，未回收）——回读埋设章再定还法`);
        }
    }

    // ② 出场：本章出场人物最近一次更早登场章（扫场景契约 participants，权威数据面）
    const lastSeen = new Map(); // 名 → 最近（最大）出场章
    for (const [k, c] of Object.entries(contracts ?? {})) {
        const ch = Number(k);
        if (!Number.isInteger(ch) || ch >= n) continue;
        for (const p of c?.participants ?? []) {
            const name = String(p ?? '').trim();
            if (name === '') continue;
            lastSeen.set(name, Math.max(lastSeen.get(name) ?? 0, ch));
        }
    }
    for (const name of [...castSet]) {
        const ch = lastSeen.get(name);
        if (ch !== undefined) add(ch, 'cast', `「${name}」最近一次登场在第${ch}章——人物口吻/定位照旧`);
    }

    // ③ 状态：本章出场实体/人物最近一次事实或弧线改动章（facts + arcs 同源，取最新一条）
    const lastState = new Map(); // 名 → { key, value, chapter }
    const considerState = (name, key, value, ch) => {
        if (ch >= n) return;
        const prev = lastState.get(name);
        if (prev === undefined || ch > prev.chapter) lastState.set(name, { key, value, chapter: ch });
    };
    for (const f of facts ?? []) {
        if (!intCh(f)) continue;
        const name = String(f.entity ?? '').trim();
        if (castSet.has(name)) considerState(name, String(f.key ?? ''), String(f.value ?? ''), f.chapter);
    }
    for (const a of arcs ?? []) {
        if (!intCh(a)) continue;
        const name = String(a.character ?? '').trim();
        if (castSet.has(name)) considerState(name, String(a.dimension ?? a.trend ?? ''), String(a.value ?? ''), a.chapter);
    }
    for (const name of [...castSet]) {
        const st = lastState.get(name);
        if (st) add(st.chapter, 'state', `「${name}」·${clip(st.key, 10)} 现为「${clip(st.value, 10)}」（第${st.chapter}章改）——照新状态写`);
    }

    // ④ 关系：本章同台的两人对，最近一次关系推进章
    const pairKey = (x, y) => [x, y].sort().join('↔');
    const lastPair = new Map(); // pairKey → { a, b, relation, value, chapter }
    for (const r of relations ?? []) {
        if (!intCh(r)) continue;
        const a = String(r.a ?? '').trim(); const b = String(r.b ?? '').trim();
        if (!castSet.has(a) || !castSet.has(b)) continue; // 只有两人都本章登场才推
        const k = pairKey(a, b);
        const prev = lastPair.get(k);
        if (prev === undefined || r.chapter > prev.chapter) {
            lastPair.set(k, { a, b, relation: String(r.relation ?? ''), value: String(r.value ?? ''), chapter: r.chapter });
        }
    }
    for (const p of lastPair.values()) {
        add(p.chapter, 'relation', `「${p.a}↔${p.b}」·${clip(p.relation, 10)} 现为「${clip(p.value, 10)}」（第${p.chapter}章推进）——关系别写反`);
    }

    return { items, count: items.length };
}

/**
 * 简报追加段渲染（纯函数）：无推荐返回 ''（调用方跳过该段）；有则逐条列「第 N 章·理由」。
 * 体量受控（≤ maxResults 条，每条 ≤ 60 字理由）——追加段不吃 pack 预算，须自封顶（同样稿段先例）。
 * @returns string
 */
export function renderRelatedChaptersSection(related, { maxChars = 60 } = {}) {
    const items = related?.items ?? [];
    if (items.length === 0) return '';
    const lines = items.map((r) => `- 第${r.chapter}章（${r.code}）：${clip(r.reason, maxChars)}`);
    return '相关历史章节（按需回读，别整章 read）：\n' + lines.join('\n')
        + '\n——以上是代码按台账反查的关联章；确要精读再用 novel_search / novel_ledger status_at，不整章拉原文';
}
