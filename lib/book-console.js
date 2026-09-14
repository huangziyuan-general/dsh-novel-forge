// lib/book-console.js — 「锻炉」数据面：把书目的机器状态文件解析成紧凑控制台摘要。
//
// 纯函数模块：输入皆文件文本（novel.json / 账本/facts.json / 账本/伏笔.json /
// .novel/style-baseline.json），输出皆数据对象；io（remote 读盘）只在 client 半。
// 这样可以用 node --test 直测解析逻辑，把浏览器半的"解析→渲染"核心钉在无浏览器门禁里。
//
// 容错原则：任何文件缺失 / 非法 JSON / 结构不符都不能让面板崩——字段降级为空/null，
// 并在每项上给出可读的 parseError。

/**
 * 解析 novel.json（机器状态）。真实结构见 lib/store.js defaultNovel：
 * { title, genre, logline, stage, approvals:{outline:{}}, chapters:{}, cast, ... }。
 * @param {string|null} text
 */
export function parseNovel(text) {
    if (text === null || text === undefined) return { ok: false, missing: true, title: null, genre: null, stage: null, chapters: null, approved: null, castCount: null, parseError: null };
    let j;
    try {
        j = JSON.parse(text);
    } catch (e) {
        return { ok: false, missing: false, parseError: 'novel.json 非法 JSON：' + e.message, title: null, genre: null, stage: null, chapters: null, approved: null, castCount: null };
    }
    const chapterNums = j.chapters && typeof j.chapters === 'object' ? Object.keys(j.chapters).map(Number).filter(Number.isInteger) : [];
    const approved = j.approvals && j.approvals.outline && typeof j.approvals.outline === 'object'
        ? Object.keys(j.approvals.outline).map(Number).filter(Number.isInteger)
        : [];
    const gateFailures = j.gateFailures && typeof j.gateFailures === 'object'
        ? Object.entries(j.gateFailures)
            .filter(([k]) => !k.includes(':'))
            .map(([k, v]) => ({ chapter: Number(k), count: Number(v) || 0 }))
            .filter((r) => Number.isInteger(r.chapter) && r.count > 0)
            .sort((a, b) => b.count - a.count)
        : [];
    return {
        ok: true,
        missing: false,
        parseError: null,
        title: j.title ?? null,
        genre: j.genre ?? null,
        stage: j.stage ?? 'topic',
        chapters: chapterNums,
        approved,
        castCount: Array.isArray(j.cast) ? j.cast.length : (j.cast ? 1 : 0),
        // 九阶段明细（v0.10.0）与熔断计数（v0.10.0）——面板可选用，缺失即空
        phases: j.phases && typeof j.phases === 'object' ? j.phases : {},
        gateFailures,
    };
}

/**
 * 解析 账本/facts.json（事实账本，数组）。条目结构 { entity, key, value, chapter, note, ts }。
 * @param {string|null} text
 */
export function parseFacts(text) {
    if (text === null || text === undefined) return { ok: false, missing: true, rows: [], parseError: null };
    let j;
    try {
        j = JSON.parse(text);
    } catch (e) {
        return { ok: false, missing: false, rows: [], parseError: 'facts.json 非法 JSON：' + e.message };
    }
    if (!Array.isArray(j)) return { ok: false, missing: false, rows: [], parseError: 'facts.json 顶层应为数组' };
    return { ok: true, missing: false, rows: j, parseError: null };
}

/** 取账本里每个 entity·key 的最新值（与 lib/ledger.js queryFacts 同口径），限制条数。 */
export function currentFacts(rows, limit = 12) {
    const latest = new Map();
    for (const f of rows || []) {
        if (!f || typeof f.entity !== 'string') continue;
        const k = `${f.entity}\u0000${f.key}`;
        const prev = latest.get(k);
        if (!prev || (f.chapter ?? 0) >= (prev.chapter ?? 0)) latest.set(k, f);
    }
    return [...latest.values()]
        .sort((a, b) => a.entity.localeCompare(b.entity) || a.key.localeCompare(b.key))
        .slice(0, limit);
}

/**
 * 解析 账本/伏笔.json（数组）。条目结构 { id, setup, chapter, plan, payoffChapter }。
 * @param {string|null} text
 * @param {number|undefined} currentChapter - 用于判超期（plan < current 且未回收）。
 */
export function parseForeshadows(text, currentChapter = undefined) {
    if (text === null || text === undefined) return { ok: false, missing: true, total: 0, open: 0, overdue: 0, parseError: null };
    let j;
    try {
        j = JSON.parse(text);
    } catch (e) {
        return { ok: false, missing: false, total: 0, open: 0, overdue: 0, parseError: '伏笔.json 非法 JSON：' + e.message };
    }
    if (!Array.isArray(j)) return { ok: false, missing: false, total: 0, open: 0, overdue: 0, parseError: '伏笔.json 顶层应为数组' };
    const open = j.filter((f) => f && !Number.isInteger(f.payoffChapter));
    const overdue = open.filter((f) => currentChapter !== undefined && Number.isInteger(f.plan) && currentChapter > f.plan).length;
    return { ok: true, missing: false, total: j.length, open: open.length, overdue, parseError: null };
}

/**
 * 解析 .novel/style-baseline.json。结构 { book, chapters, baseline:{ dims }, builtAt }。
 * @param {string|null} text
 */
export function parseStyle(text) {
    if (text === null || text === undefined) return { ok: false, missing: true, built: false, chapters: null, dims: [], builtAt: null, parseError: null };
    let j;
    try {
        j = JSON.parse(text);
    } catch (e) {
        return { ok: false, missing: false, built: false, dims: [], parseError: 'style-baseline.json 非法 JSON：' + e.message };
    }
    const dimsObj = j && j.baseline && j.baseline.dims ? j.baseline.dims : null;
    const dims = dimsObj
        ? Object.entries(dimsObj).map(([key, d]) => ({
              key,
              mu: d && typeof d.mu === 'number' ? d.mu : null,
              sigma: d && typeof d.sigma === 'number' ? d.sigma : null,
          }))
        : [];
    return {
        ok: true,
        missing: false,
        built: true,
        chapters: j && Number.isInteger(j.chapters) ? j.chapters : null,
        dims,
        builtAt: j && j.builtAt ? j.builtAt : null,
        parseError: null,
    };
}

/** 一书的状态阶段中文标签。 */
/** 阶段中文标签。九阶段（lib/phases.js）+ 旧五阶段别名都认。
 *  本模块刻意零 import（面板 bundle 只搬纯函数），故这里自带一份词表；
 *  词表口径与 lib/phases.js 的 PHASES[].label 保持一致。 */
export function stageLabel(stage) {
    const map = {
        // 九阶段（v0.10.0 起）
        topic: '立意', setting: '设定', character: '人物', outline: '大纲', volume: '分卷',
        chapter: '细纲', writing: '正文', revision: '修订', done: '完稿',
        // 旧五阶段（未迁移的老数据）
        planning: '规划', drafting: '正文', revising: '修订',
    };
    return map[stage] ?? stage ?? '—';
}

/**
 * 汇总一本书的控制台摘要。
 * @param {object} opts - { name, novel, facts, foreshadows, style, currentChapter }
 * 其中 novel/facts/foreshadows/style 都是文件文本字符串或 null（缺失）。
 */
export function summarizeBook({ name, novel = null, facts = null, foreshadows = null, style = null, currentChapter = undefined } = {}) {
    const n = parseNovel(novel);
    const f = parseFacts(facts);
    const v = parseForeshadows(foreshadows, currentChapter);
    const s = parseStyle(style);
    const chaptersSorted = (n.chapters ?? []).sort((a, b) => a - b);
    const maxChapter = chaptersSorted.length ? chaptersSorted[chaptersSorted.length - 1] : undefined;
    return {
        name,
        title: n.title ?? name,
        genre: n.genre,
        stage: n.stage,
        stageLabel: stageLabel(n.stage),
        chapters: n.chapters ? n.chapters.length : null,
        approved: n.approved ? n.approved.length : null,
        castCount: n.castCount,
        facts: f.ok ? f.rows.length : 0,
        current: currentFacts(f.rows, 6),
        foreshadows: v,
        style: s,
        maxChapter: maxChapter ?? undefined,
        parseError: n.parseError || f.parseError || v.parseError || s.parseError || null,
    };
}