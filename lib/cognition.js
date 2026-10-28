// lib/cognition.js — 认知账本（谁知道什么 / 不知道什么 / 读者已知什么）。
//
// 来源：竞品 QMAI 的 character-cognition（三态认知账本 + readerKnows 信息差维）。
// 它治的病在 DSH 同样真实：事实账本记的是「世界是什么样」，记不了「**人物以为**
// 世界是什么样」——身份保密、伏笔未揭、背后议论，这些桥段的崩法从来不是设定错，
// 而是「不该知道的人知道了」。此前 DSH 没有任何一层管这个边界。
//
// 数据：`账本/cognition.json`，**append-only 行日志**（与事实账本同构）：
//   { subject, verb: 'knows'|'doesNotKnow', info, chapter, ts }
// 当前状态永远是视图函数算出来的派生物——「谁在哪一章得知了什么」可重放、可对账，
// knows 后声明自动顶掉同名 info 的 doesNotKnow（认知转变是合法事件，不是冲突）。
//
// 口径（代码强制 > 提示词自觉）：
//   · 输入走严格词表「知道 / 不知道」，不做「得知/察觉/意识到」的同义词解析
//     （QMAI 用正则猜自然语言，猜错就静默记反——DSH 宁可让模型多打两个字）；
//   · 「读者|不知道」拒收：悬念是默认态，读者不知道的事不需要记账，记账只记「事件」；
//   · 负向条款（不知道）在简报里**整条呈现、按条数封顶、绝不按字符截断**——
//     截断一条否定句会反转它的语义（QMAI cognition-context 的同一教训）；
//   · 认知倒退（对已知的 info 重申「不知道」）不拦——失忆/假装失忆是合法桥段，
//     但必须显形（regressions），不许静默。

/** 输入词表：verb 的两种合法声明。 */
export const COGNITION_VERBS = { knows: '知道', doesNotKnow: '不知道' };

/** 视图里每个人物的条目数封顶（知道/不知道各算一套；负向条款不截断、只按条数限量）。 */
export const COGNITION_VIEW_CAP = 8;

/**
 * 解析认知更新多行文本（纯函数）。
 *
 * 行格式：「谁|知道|信息」 / 「谁|不知道|信息」 / 「读者|知道|信息」。
 * 与 facts_updates 的三段位对齐，模型不需要学第二套分隔符语法。
 *
 * @param text 多行文本；undefined/空串 → []（不提供不校验）
 * @returns [{subject, verb, info}]（verb 为机器值 knows/doesNotKnow）
 */
export function parseCognitionLines(text) {
    if (text === undefined || text === null) return [];
    if (typeof text !== 'string') throw new Error('cognition_updates 必须是多行文本（每行「谁|知道|信息」）');
    const lines = text.split('\n').map((l) => l.trim()).filter((l) => l !== '');
    return lines.map((line, i) => {
        const parts = line.split('|').map((s) => s.trim());
        if (parts.length !== 3 || parts.some((s) => s === '')) {
            throw new Error(`cognition_updates 第 ${i + 1} 行格式错误：「${line}」——每行三段「谁|知道|信息」，两根竖线都不能少`);
        }
        const [subject, verbRaw, info] = parts;
        const verb = verbRaw === COGNITION_VERBS.knows ? 'knows'
            : verbRaw === COGNITION_VERBS.doesNotKnow ? 'doesNotKnow' : null;
        if (verb === null) {
            throw new Error(`cognition_updates 第 ${i + 1} 行动词不认识：「${verbRaw}」——只接受「知道 / 不知道」，统一词表才对得上账（「得知/察觉/意识到」请改写为「知道」）`);
        }
        if (subject === '读者' && verb === 'doesNotKnow') {
            throw new Error(`cognition_updates 第 ${i + 1} 行：「读者|不知道」不收——悬念是默认态，读者不知道的事不需要记账；只有「读者知道了」才改变信息差格局`);
        }
        return { subject, verb, info };
    });
}

/**
 * 追加认知更新（纯函数）。认知倒退不拦但显形。
 *
 * @param rows    既有行日志（账本/cognition.json）
 * @param updates [{subject, verb, info}]（parseCognitionLines 的产物）
 * @param ctx {chapter, now} 章号与时间戳（纯函数不取钟，调用方传）
 * @returns {{rows, added, regressions}}
 *          rows = 追加后的全量行日志；added = 本次新增行；regressions = 倒退提示（人话）
 */
export function applyCognitionUpdates(rows, updates, { chapter, now }) {
    if (!Array.isArray(rows)) throw new Error('cognition rows 必须是数组');
    if (!Number.isInteger(chapter) || chapter < 1) throw new Error('chapter 必须是正整数');
    const next = [...rows];
    const added = [];
    const regressions = [];
    // 倒退判据的基线 = 本次更新**之前**的视图（同一批里先知后忘不算倒退，算转变）。
    const baseline = cognitionView(rows);
    const knownAt = (subject, info) => baseline.characters
        .some((c) => c.name === subject && c.knows.includes(info));
    for (const u of updates) {
        const subject = String(u?.subject ?? '').trim();
        const info = String(u?.info ?? '').trim();
        if (subject === '' || info === '') throw new Error('认知更新的 subject/info 不能为空');
        if (u.verb !== 'knows' && u.verb !== 'doesNotKnow') throw new Error(`认知动词非法：${String(u?.verb)}`);
        if (u.verb === 'doesNotKnow' && knownAt(subject, info)) {
            regressions.push(`${subject} 在此之前已经知道「${info}」——本次又声明「不知道」。失忆/装傻是合法桥段，但请确认这不是笔误（账本会如实记下这次倒退）`);
        }
        const row = { subject, verb: u.verb, info, chapter, ts: now };
        next.push(row);
        added.push(row);
    }
    return { rows: next, added, regressions };
}

/**
 * 内部解析（单一真相源）：行日志 → 每个 (subject, info) 的**最终声明**。
 * append-only 日志的数组序 = 时间序，后声明胜；atChapter 过滤章号上限；
 * subjects 过滤人物（读者不受 subjects 过滤——它是全局维）。
 */
function resolveCognition(rows, { subjects = null, atChapter = null } = {}) {
    const list = Array.isArray(rows) ? rows : [];
    const at = Number.isInteger(atChapter) ? atChapter : null;
    const want = subjects === null ? null : new Set(subjects);
    const resolved = new Map(); // "subject\0info" → {subject, verb, info, chapter}
    const readerResolved = new Map(); // info → {subject:'读者', verb:'knows', info, chapter}
    for (const r of list) {
        if (!r || typeof r !== 'object') continue;
        if (at !== null && Number(r.chapter) > at) continue;
        const subject = String(r.subject ?? '').trim();
        const info = String(r.info ?? '').trim();
        if (subject === '' || info === '') continue;
        const chapter = Number.isInteger(r.chapter) ? r.chapter : 0;
        if (subject === '读者') {
            if (r.verb === 'knows') readerResolved.set(info, { subject, verb: 'knows', info, chapter });
            continue;
        }
        if (want !== null && !want.has(subject)) continue;
        resolved.set(`${subject}\u0000${info}`, { subject, verb: r.verb, info, chapter });
    }
    return { resolved, readerResolved };
}

/**
 * 当前认知视图（纯函数）：行日志 → { characters:[{name,knows,doesNotKnow}], readerKnows }。
 * 同一 (subject, info) 的多行由 resolveCognition 裁决（后声明胜）。
 */
export function cognitionView(rows, options = {}) {
    const { resolved, readerResolved } = resolveCognition(rows, options);
    const byChar = new Map();
    for (const r of resolved.values()) {
        if (!byChar.has(r.subject)) byChar.set(r.subject, { knows: [], doesNotKnow: [] });
        byChar.get(r.subject)[r.verb === 'knows' ? 'knows' : 'doesNotKnow'].push(r.info);
    }
    const characters = [...byChar.entries()].map(([name, slot]) => ({
        name,
        knows: slot.knows.slice(0, COGNITION_VIEW_CAP),
        doesNotKnow: slot.doesNotKnow.slice(0, COGNITION_VIEW_CAP),
    }));
    return { characters, readerKnows: [...readerResolved.values()].map((r) => r.info).slice(0, COGNITION_VIEW_CAP) };
}

/**
 * 认知视图的扁平行形状（纯函数）：与 novel_ledger cognition 动作的 schema 对齐
 * （每行带 chapter，供对账「这个认知是哪一章变的」）。与 cognitionView 同源同判。
 */
export function cognitionFlatRows(rows, options = {}) {
    const { resolved, readerResolved } = resolveCognition(rows, options);
    return [...resolved.values(), ...readerResolved.values()];
}

/**
 * 简报「人物认知边界」段的正文（纯函数）。空视图返回 null（不占预算）。
 *
 * 负向条款排前面（泄底事故都出在「不知道」上）；条目按 COGNITION_VIEW_CAP 封顶、
 * 整条呈现——按字符截断一条否定句会反转它的语义。
 */
export function cognitionSection(view) {
    const v = view ?? { characters: [], readerKnows: [] };
    const lines = [];
    for (const c of v.characters ?? []) {
        if (c.doesNotKnow.length > 0) lines.push(`${c.name} 不知道：${c.doesNotKnow.join('；')}`);
        if (c.knows.length > 0) lines.push(`${c.name} 知道：${c.knows.join('；')}`);
    }
    if ((v.readerKnows ?? []).length > 0) lines.push(`读者已知：${v.readerKnows.join('；')}`);
    if (lines.length === 0) return null;
    lines.push('边界纪律：人物只能用自己知道的信息说话行事——「不知道」的事要么自然错过、要么明确写出他的困惑，绝不能未卜先知；「读者已知、人物不知道」的信息差是用来造张力的，不是用来泄底的。');
    return lines.join('\n');
}

/**
 * 信息差警戒（纯函数）：本章出场人物里带着「不知道」清单的，逐人点名。
 * 走 warnings 不走包区块——警戒是元信息，不该吃上下文预算。
 */
export function cognitionWarnings(view, castNames) {
    const v = view ?? { characters: [] };
    const cast = new Set(castNames ?? []);
    const hits = (v.characters ?? []).filter((c) => cast.has(c.name) && c.doesNotKnow.length > 0);
    if (hits.length === 0) return [];
    return [`信息差警戒：${hits.map((c) => `${c.name} 不知道〔${c.doesNotKnow.join('、')}〕`).join('；')}`
        + '——笔下人物只能用自己知道的信息说话行事，别让「不知道」变成说漏嘴。'];
}
