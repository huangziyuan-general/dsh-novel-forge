// lib/contextpack.js — 上下文包组装（纯函数）。
// 一致性硬约束的供给侧：写章前由 novel_briefing / novel_write_chapter 调用，
// 把「模型应该记得但早已看不见」的东西按预算压成固定形态——
// 优先级：本章细纲 > 人物卡 > 账本摘要 > 伏笔 > 世界书 > 前章结尾 > 章节摘要 > 全书大纲。

const CAPS = {
    chapterOutline: 1200,
    characterCard: 700,
    castTotal: 2800, // 人物卡总预算：卡多时均摊，不许挤掉排在其后的账本/伏笔/世界书
    glossary: 500,
    worldEntry: 400,
    prevTail: 600,
    summary: 140,
    bookOutline: 700,
};

/** 世界书条目匹配（SillyTavern 式）：always 常驻；任一关键词命中即激活；
 * 递归激活——已激活条目的内容参与下一轮扫描（最多 rounds 轮，防 runaway）；
 * 结果按 priority 降序排（预算不足时高优先级条目先入上下文）。纯函数。 */
export function matchWorldEntries(entries, texts, { rounds = 2 } = {}) {
    const activated = new Set();
    const active = [];
    let sources = texts.filter((t) => typeof t === 'string');
    for (let r = 0; r < Math.max(1, rounds); r += 1) {
        const hay = sources.join('\n');
        let grew = false;
        for (const e of entries ?? []) {
            if (activated.has(e.id)) continue;
            if (e.always || (e.keywords ?? []).some((k) => k !== '' && hay.includes(k))) {
                activated.add(e.id);
                active.push(e);
                grew = true;
            }
        }
        if (!grew) break;
        sources = active.map((e) => e.content); // 递归：条目内容成为下一轮的扫描源
    }
    return active.sort((a, b) => (b.priority ?? 50) - (a.priority ?? 50));
}

function clip(s, max) {
    const t = String(s ?? '');
    return t.length <= max ? t : `${t.slice(0, max)}…（截断）`;
}

/**
 * 组装上下文包。
 * @param inputs { chapter, chapterOutline, bookOutline, castCards:[{name,card}],
 *                 worldEntries, factsDigest:[string], foreshadowDigest:[string],
 *                 prevTail, summaries:[string], budget }
 * @returns { sections:[{name,content}], totalChars, dropped:[string] }
 */
export function buildContextPack(inputs) {
    const {
        chapter,
        chapterOutline = '',
        bookOutline = '',
        castCards = [],
        worldEntries = [],
        factsDigest = [],
        glossaryDigest = [],
        foreshadowDigest = [],
        prevTail = '',
        summaries = [],
        budget = 6000,
    } = inputs;

    const dropped = [];
    const sections = [];
    let used = 0;

    const push = (name, content, cap) => {
        const body = clip(content, cap);
        if (body.trim() === '') return;
        const cost = body.length + name.length + 4; // renderPack 的 <<name>> header 计入预算
        if (used + cost > budget) { dropped.push(name); return; }
        sections.push({ name, content: body });
        used += cost;
    };

    push(`本章细纲（第${chapter}章·必须逐点覆盖）`, chapterOutline, CAPS.chapterOutline);
    if (castCards.length > 0) {
        // 人物卡均摊总预算：8 张卡时每张 ≤350，账本/伏笔/世界书不会被挤掉。
        const share = Math.min(CAPS.characterCard, Math.max(200, Math.floor(CAPS.castTotal / castCards.length)));
        for (const c of castCards) push(`人物卡·${c.name}`, c.card, share);
    }
    if (factsDigest.length > 0) push('事实账本·本章必须遵守', factsDigest.join('\n'), 900);
    if (glossaryDigest.length > 0) push('术语表', glossaryDigest.join('\n'), CAPS.glossary);
    if (foreshadowDigest.length > 0) push('未回收伏笔', foreshadowDigest.join('\n'), 400);
    for (const e of worldEntries) push(`世界书·${e.id}`, e.content, CAPS.worldEntry);
    if (prevTail) push('上一章结尾（衔接从这里开始）', prevTail, CAPS.prevTail);
    for (const s of summaries.slice(0, 10)) push('前文章节摘要', s, CAPS.summary);
    push('全书大纲', bookOutline, CAPS.bookOutline);

    return { sections, totalChars: used, dropped };
}

/** 渲染为工具输出的纯文本形态。 */
export function renderPack(pack) {
    return pack.sections.map((s) => `<<${s.name}>>\n${s.content}`).join('\n\n');
}
