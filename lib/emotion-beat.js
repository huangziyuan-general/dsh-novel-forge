// lib/emotion-beat.js — 情感节拍卡（纯函数，零 IO、零模型调用）。
//
// 写前规划「这一章的情感形状」：整体弧线 + 若干拍，每拍四格——场景目标 / 情感基调 /
// 读者感受 / 角色变化。细纲的拍是「写什么」（场景内动作/环境/对话要点），pacing 是
// 写后验节奏档位，这一层是**写前定弧线**：定「这一章读者该感受到什么、谁该发生什么
// 变化」。登记走 novel_ledger beat_set（台账 设定/情感节拍.json，按书隔离、按章一张卡），
// 消费走写前简报追加段「本章情感弧线」（不吃 pack 预算、自封顶、空则整段省略）。
//
// 纪律（与既有台账同档）：
//   · 台账缺失/损坏按空处理——旧书零回归；
//   · 一章一张卡，beat_set 同名覆盖（改弧线就该改那张，不并影子卡）；
//   · 拍序号自动补全；空拍（四格全空）滤出（不制造噪声位）；
//   · 纯函数不取钟：updatedAt 由调用方传入（同 relations/arcs 的 now 纪律）。

/** 情感节拍行式解析：多行「场景目标|情感基调|读者感受|角色变化」，竖线分隔、可省段（右移补空）。
 *  返回 { beats, errors }——坏行（空行/纯注释）静默跳过，解析不出任何字段进 errors。 */
export function parseEmotionBeatsText(raw, { maxBeats = 12 } = {}) {
    const beats = [];
    const errors = [];
    for (const line of String(raw ?? '').split(/\r?\n/)) {
        const t = line.trim();
        if (t === '' || t.startsWith('#')) continue;
        const cells = t.split('|').map((c) => c.trim());
        const filled = cells.some((c) => c !== '');
        if (!filled) {
            errors.push(`空拍（「${t.slice(0, 12)}…」）——四格全空没有信息量，已跳过`);
            continue;
        }
        beats.push({
            sceneGoal: cells[0] ?? '',
            emotionTone: cells[1] ?? '',
            readerFeeling: cells[2] ?? '',
            characterGrowth: cells[3] ?? '',
        });
        if (beats.length >= maxBeats) break;
    }
    if (beats.length >= maxBeats && String(raw ?? '').split(/\r?\n/).filter((l) => l.trim() !== '' && !l.trim().startsWith('#')).length > maxBeats) {
        errors.push(`超过 ${maxBeats} 拍上限，超出部分未登记`);
    }
    return { beats, errors };
}

/** 一行节拍是否有效（至少一格非空；四格皆字符串）。 */
export function validBeatRow(b) {
    if (b === null || typeof b !== 'object') return false;
    const fields = ['sceneGoal', 'emotionTone', 'readerFeeling', 'characterGrowth'];
    if (!fields.every((f) => typeof b[f] === 'string')) return false;
    return fields.some((f) => b[f].trim() !== '');
}

/**
 * 按章存卡（reconcile）：existing（章号字符串 → 卡）+ 新卡 → 新表。
 * 一章一张卡：同章覆盖（改弧线就改那张卡，不并影子卡）；卡空（整体弧线空 + 无有效拍）
 * 则删除该章（清卡比留一张空卡干净）。
 * @returns { cards: object, changed: 'set'|'cleared'|'none' }
 */
export function setEmotionBeatCard(existing, chapter, { overallArc = '', beats = [], now = null }) {
    const cards = {};
    for (const [k, v] of Object.entries(existing ?? {})) if (v && typeof v === 'object') cards[String(k)] = v;
    const key = String(chapter);
    const validBeats = (Array.isArray(beats) ? beats : []).filter(validBeatRow);
    const arc = String(overallArc ?? '').trim();
    if (arc === '' && validBeats.length === 0) {
        if (cards[key] === undefined) return { cards, changed: 'none' };
        delete cards[key];
        return { cards, changed: 'cleared' };
    }
    cards[key] = {
        chapter: Number(chapter),
        overallArc: arc,
        beats: validBeats,
        ...(now ? { updatedAt: now } : {}),
    };
    return { cards, changed: 'set' };
}

/** 按章取卡（无则 null；畸形卡滤出返回 null，不炸消费面）。 */
export function emotionBeatFor(cards, chapter) {
    const c = cards?.[String(chapter)];
    if (c === undefined || c === null || typeof c !== 'object') return null;
    if (!Array.isArray(c.beats) || c.beats.length === 0 && String(c.overallArc ?? '').trim() === '') return null;
    return c;
}

/**
 * 简报追加段渲染（纯函数）：无卡/无有效内容返回 ''（调用方整段省略）；
 * 有则逐拍列「目标/基调/读者/变化」，封顶 8 拍 × 每格 30 字（追加段不吃 pack 预算须自封顶）。
 * @returns string
 */
export function renderEmotionBeatSection(card, { maxBeats = 8, perCell = 30 } = {}) {
    if (card === null) return '';
    const clip = (s) => {
        const t = String(s ?? '').trim();
        return t.length > perCell ? `${t.slice(0, perCell - 1)}…` : t;
    };
    const lines = [];
    const arc = clip(card.overallArc ?? '');
    if (arc !== '') lines.push(`本章情感弧线：${arc}`);
    const beats = (Array.isArray(card.beats) ? card.beats : []).filter(validBeatRow).slice(0, maxBeats);
    for (const b of beats) {
        const cells = [
            b.sceneGoal !== '' ? `目标 ${clip(b.sceneGoal)}` : '',
            b.emotionTone !== '' ? `基调 ${clip(b.emotionTone)}` : '',
            b.readerFeeling !== '' ? `读者 ${clip(b.readerFeeling)}` : '',
            b.characterGrowth !== '' ? `变化 ${clip(b.characterGrowth)}` : '',
        ].filter((s) => s !== '');
        if (cells.length > 0) lines.push(`▸ ${cells.join('｜')}`);
    }
    if (lines.length === 0) return '';
    return lines.join('\n') + '\n——情感弧线是写前规划位（节奏快慢另有 pacing 段）：把读者的感受落进场景，别直写「他很愤怒」这类结论句。';
}
