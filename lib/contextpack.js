// lib/contextpack.js — 上下文包组装（纯函数）。
// 一致性硬约束的供给侧：写章前由 novel_briefing / novel_write_chapter 调用，
// 把「模型应该记得但早已看不见」的东西按预算压成固定形态。
//
// 优先级（0.16.3 起分两层，不再是一条直线）：
//   硬需求（全程 budget）：本章细纲 > 承诺书 > 场景契约 > 节奏 > 事实账本 > 未回收伏笔
//   弹性（封顶 budget - 衔接保留额）：人物卡 > 语言基因卡 > 术语表 > 世界书
//   衔接（用得到保留额）：上一章结尾 > 原著锚段 > 章节摘要窗口 > 全书大纲
// 为什么把「世界书 > 前章结尾」这条旧序改弯：卡片与世界书的量随书规模线性增长，
// 而衔接是固定需求；真机 101 章书在 6000 字预算下，旧序的结果是**衔接三块整块消失**，
// 简报当面写着「因预算丢弃：上一章结尾…」，模型只能自己 grep/read 整章捞前文
// （上下文从 1.7 万一路爬到 10 万+）。被裁的世界书条目是可再得的（novel_worldbook list /
// 契约白名单 / novel_search），上一章结尾没有别的获取路径——所以它值得一个保留额。

const CAPS = {
    chapterOutline: 1200,
    characterCard: 700,
    castTotal: 2800, // 人物卡总预算：卡多时均摊，不许挤掉排在其后的账本/伏笔/世界书
    voiceCard: 320,
    voiceTotal: 1000, // 语言基因卡总预算（同人物卡：均摊，不许挤掉账本）
    sceneContract: 500,
    glossary: 500,
    worldEntry: 400,
    prevTail: 600,
    summary: 140,
    summariesBlock: 1600, // 前文摘要**整块**上限（窗口见 SUMMARY_KEEP）
    bookOutline: 700,
    promise: 600,
};

// 前文摘要窗口：开篇留 SUMMARY_HEAD_KEEP 章（人物与世界的第一印象），其余名额给**最近**几章
// （续写的衔接全靠它们）。总数仍是一眼看得完的十条，预算没多花。
const SUMMARY_HEAD_KEEP = 2;
const SUMMARY_KEEP = 10;

/** 衔接保留额（字）：上一章结尾 + 摘要窗口（≈600 + 900）。
 *  弹性区块（人物卡/语言基因卡/世界书/术语表）封顶在 budget - 本值 之内均摊退化。 */
const CONTINUITY_RESERVE_CHARS = 1500;

/**
 * 追读节奏硬约束（来源：dsh-tool-writing 的章节纪律 + 多核协同的铁律）。
 * 固定注入：网文的追读率靠「承诺 → 兑现」的节奏，不能凭感觉。
 */
export const RHYTHM_CONSTRAINT = [
    '上一章欠账未回应前，本章不许开新钩子——先把旧账还上。',
    '每 600–900 字给一次微兑现（信息揭示 / 小反转 / 情绪落点 / 爽点）。',
    '到期未回收的伏笔优先在本章兑现；回收后用 novel_ledger foreshadow_payoff 登记。',
    '章末必须留钩子，但不许用新悬念掩盖旧欠账。',
].join('\n');

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
 * 覆盖率检查的「要素」收敛：**细纲真正声明的**要素才算数。
 *
 * 口径：出场人物名（模型显式传入，本章必须覆盖）+ 命中世界书里**在细纲文本中真实出现**的关键词。
 * 为什么不用条目全部 keywords：一条世界书常带几十个泛词（觉醒/神兵/灵弹/弹匣…），
 * 条目被激活就把整串塞进 terms，产出几十条「未在正文出现」——噪声太多模型会整条忽略
 * （真机：第 69 章列了 50+ 词）。只有细纲点名过的词，才真的是「本章声明要写的要素」。
 * 纯函数。
 */
export function declaredCoverageTerms({ outline = '', castNames = [], worldEntries = [] } = {}) {
    const text = String(outline ?? '');
    const terms = [];
    const seen = new Set();
    const add = (t) => {
        const s = String(t ?? '').trim();
        if (s === '' || seen.has(s)) return;
        seen.add(s);
        terms.push(s);
    };
    for (const name of castNames) add(name);
    for (const e of worldEntries ?? []) {
        for (const k of e?.keywords ?? []) {
            if (k !== '' && text.includes(k)) add(k);
        }
    }
    return terms;
}

/**
 * 组装上下文包。
 * @param inputs { chapter, chapterOutline, bookOutline, castCards:[{name,card}],
 *                 worldEntries, factsDigest:[string], foreshadowDigest:[string],
 *                 prevTail, summaries:[string], anchors:[{kind,para}],
 *                 fingerprint, budget }
 * @returns { sections:[{name,content}], totalChars, dropped:[string] }
 */
export function buildContextPack(inputs) {
    const {
        chapter = 1,
        chapterOutline = '',
        bookOutline = '',
        promise = '',
        sceneContract = '',
        castCards = [],
        voiceCards = [],
        worldEntries = [],
        factsDigest = [],
        glossaryDigest = [],
        foreshadowDigest = [],
        prevTail = '',
        summaries = [],
        anchors = [],
        fingerprint = '',
        rhythm = true,
        budget = 6000,
    } = inputs;

    const dropped = [];
    const sections = [];
    let used = 0;

    // ── 预算分配：衔接拿保留额，弹性区块在剩余里均摊退化 ────────────────────
    // 真机实测（《开局觉醒加特林》101 章 / 第 102 章 / budget=6000）：7 张人物卡 + 7 张
    // 语言基因卡 + 9 条世界书共吃 3,881 字，加上承诺书与账本后 room 只剩 ≈113 ——
    // 「上一章结尾 / 原著锚段 / 全书大纲」三块**整块被丢**、摘要窗口只剩一行。
    // 后果不是"少看点资料"：简报里那句「因预算丢弃：上一章结尾…」等于当面告诉模型
    // 前文没给够，它只能自己去 grep/read 整章捞（真机同一发会话的上下文从 1.7 万
    // 一路爬到 10 万+）。这些卡片随书规模线性增长，而衔接是**固定需求**，
    // 所以给衔接划保留额：卡片/基因卡/世界书/术语表封顶在 elasticCeil，装不下就
    // 如实进 dropped（它们本就有均摊机制），衔接四件套用得到保留额。
    const continuityReserve = Math.min(CONTINUITY_RESERVE_CHARS, Math.floor(budget / 3));
    const elasticCeil = Math.max(0, budget - continuityReserve);

    const push = (name, content, cap, ceil = budget) => {
        const body = clip(content, cap);
        if (body.trim() === '') return;
        const cost = body.length + name.length + 4; // renderPack 的 <<name>> header 计入预算
        if (used + cost > ceil) { dropped.push(name); return; }
        sections.push({ name, content: body });
        used += cost;
    };

    push(`本章细纲（第${chapter}章·必须逐点覆盖）`, chapterOutline, CAPS.chapterOutline);
    // 承诺书排在细纲之后：它约束的是「整本书对读者的承诺」，优先级高于任何单章技巧。
    push('故事承诺书（本书对读者的承诺·本章不许违背）', promise, CAPS.promise);
    // 场景契约：本章谁能出场、什么不许写（隐藏人物**不在**此区块内——见 scene-contract.js）
    push('场景契约（本章人物与禁区·硬约束）', sceneContract, CAPS.sceneContract);
    if (rhythm) push('追读节奏·硬约束（网文追读的命门）', RHYTHM_CONSTRAINT, 300);
    if (castCards.length > 0) {
        // 人物卡均摊总预算：8 张卡时每张 ≤350，账本/伏笔/世界书不会被挤掉。
        // 再套一层 elasticCeil：卡片随书规模线性增长，弹性区块整体不得挤掉衔接的保留额。
        const share = Math.min(CAPS.characterCard, Math.max(200, Math.floor(CAPS.castTotal / castCards.length)));
        for (const c of castCards) push(`人物卡·${c.name}`, c.card, share, elasticCeil);
    }
    if (voiceCards.length > 0) {
        // 语言基因卡紧跟人物卡：管「怎么说话」，是防「千人一腔」的供给侧。
        const share = Math.min(CAPS.voiceCard, Math.max(160, Math.floor(CAPS.voiceTotal / voiceCards.length)));
        for (const c of voiceCards) push(`语言基因卡·${c.name}（对话必须符合）`, c.card, share, elasticCeil);
    }
    if (factsDigest.length > 0) push('事实账本·本章必须遵守', factsDigest.join('\n'), 900);
    // 术语表与世界书同为弹性区块：条目数随设定量增长，封顶在 elasticCeil、装不下如实进 dropped
    if (glossaryDigest.length > 0) push('术语表', glossaryDigest.join('\n'), CAPS.glossary, elasticCeil);
    if (foreshadowDigest.length > 0) push('未回收伏笔', foreshadowDigest.join('\n'), 400);
    for (const e of worldEntries) push(`世界书·${e.id}`, e.content, CAPS.worldEntry, elasticCeil);
    if (prevTail) push('上一章结尾（衔接从这里开始）', prevTail, CAPS.prevTail);
    if (anchors.length > 0) {
        const body = [fingerprint, ...anchors.map((a) => `【${a.kind === 'dialogue' ? '对话感' : '叙述感'}】${a.para}`)].filter((s) => s !== '').join('\n\n');
        // 锚段是「模仿味道」的参考，不是衔接必需——和卡片同属弹性层，否则它会跟摘要窗口
        // 抢同一份保留额（真机上摘要恰恰是防整章 read 的那道闸）。
        push('原著锚段（照这个味道写——模仿语感与节奏，勿抄词句，勿把数字当写作规则）', body, 700, elasticCeil);
    }
    // 前文摘要：曾经的实现是 `summaries.slice(0, 10)`——升序数组取前 10 条 = **只给第 1–10 章**。
    // 写第 60 章时模型看不见第 59 章发生过什么，只能自己去整章 read 找回前文（真机 97 章
    // 新会话第一回合 in_tok 13 万级的来源之一，也正是「输出预算纪律」要治的那个病根）。
    // 逐行 push 还有两个副作用：同名 header 重复 10 遍；预算耗尽时按 push 顺序丢掉的是
    // **数组尾部**——恰好是最接近当前的那几章，裁剪方向整个是反的。
    // 现在合成一个区块：窗口=开篇 + 最近，装不下时从**头部**淘汰（开篇先让位，最近一章绝不许掉队）。
    const summaryName = '前文章节摘要（开篇+最近·非全量）';
    if (summaries.length > 0) {
        // 每条摘要先**压成一行**再进窗口。两个真机理由：① Windows 读盘文本带 CRLF，
        // 不压平就把 \r 一路带进简报（本项目在 CR 上栽过两次：present 参数夹带连续 CR →
        // 单步 32K 空白输出判 max-tokens；宿主 lossless JSON 对控制字符敏感）；
        // ② 模型写的 summary 本身可能含换行，一条散成多行后「十条 = 十行」的窗口与淘汰
        // 都不再成立（半截章号会被当成独立行丢掉）。压平后再逐条就地截断（不整行挤掉）。
        const oneLine = (s) => String(s ?? '').replace(/[\r\n]+/g, ' ').trim();
        const lines = summaries.map(oneLine).filter((t) => t !== '').map((t) => (t.length <= CAPS.summary ? t : `${t.slice(0, CAPS.summary - 1)}…`));
        const windowed = lines.length <= SUMMARY_KEEP
            ? lines
            : [...lines.slice(0, SUMMARY_HEAD_KEEP),
                '……（中间章节从略：要找回具体段落用 novel_search query，不要整章读正文）',
                ...lines.slice(-(SUMMARY_KEEP - SUMMARY_HEAD_KEEP))];
        const room = budget - used - summaryName.length - 4; // 与 push 同口径的余量
        let block = windowed.join('\n');
        const fit = Math.min(CAPS.summariesBlock, room);
        while (block.length > fit && block.split('\n').length > 1) {
            block = block.split('\n').slice(1).join('\n'); // 从头部淘汰（丢最早的开篇，不丢最近）
        }
        if (block.length <= fit && block.trim() !== '') push(summaryName, block, CAPS.summariesBlock);
        else dropped.push(summaryName);
    }
    push('全书大纲', bookOutline, CAPS.bookOutline);

    return { sections, totalChars: used, dropped };
}

/** 渲染为工具输出的纯文本形态。 */
export function renderPack(pack) {
    return pack.sections.map((s) => `<<${s.name}>>\n${s.content}`).join('\n\n');
}
