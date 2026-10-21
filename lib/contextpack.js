// lib/contextpack.js — 上下文包组装（纯函数）。
// 一致性硬约束的供给侧：写章前由 novel_briefing / novel_write_chapter 调用，
// 把「模型应该记得但早已看不见」的东西按预算压成固定形态。
//
// 优先级（0.16.3 起分两层，不再是一条直线）：
//   硬需求（全程 budget）：本章细纲 > 承诺书 > 场景契约 > 节奏 > 事实账本 > 未回收伏笔
//   弹性（封顶 budget - 衔接保留额）：人物卡 > 语言基因卡 > 术语表 > 世界书
//   衔接（上一章结尾排在弹性区块之前，其余用保留额）：上一章结尾 > 原著锚段 > 摘要窗口 > 全书大纲
// 为什么把「世界书 > 前章结尾」这条旧序改弯：卡片与世界书的量随书规模线性增长，
// 而衔接是固定需求；真机 101 章书在 6000 字预算下，旧序的结果是**衔接三块整块消失**，
// 简报当面写着「因预算丢弃：上一章结尾…」，模型只能自己 grep/read 整章捞前文
// （上下文从 1.7 万一路爬到 10 万+）。被裁的世界书条目是可再得的（novel_worldbook list /
// 契约白名单 / novel_search），上一章结尾没有别的获取路径——所以它值得一个保留额。

// 场景段标题直接复用门禁那份（不在这里手抄一份）：两处对「哪些段算场景」的判断
// 一旦漂移，覆盖率算的场景与要素表收的词就不是同一批——正是本轮要消灭的「同一算式
// 抄两份」的病。
import { sectionOf, SCENE_HEADINGS } from './gate-metrics.js';

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
/** 上一章结尾截断下限：剩余空间低到这个数以下就没法当"结尾"用，宁可丢并给找回指令。 */
const TAIL_FLOOR_CHARS = 160;
/** 前文摘要的次级保留额：结尾先占位时，从它的富余里划给摘要（见 buildContextPack 内注释）。 */
const SUMMARY_RESERVE_CHARS = 900;

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

// 截断标记：必须**计入** max（此前是 `slice(0, max) + 标记`，实长 max+5）。
// 上一章结尾这类「按剩余预算现算 cap」的区块会因此悄悄超支；超支不多，但预算表的
// 意义就在于每个数字都能对上账，差 5 也是差。
const CLIP_MARK = '…（截断）';
const CLIP_HEADLESS_MARK = '…（前文截断）';

/** 从头截（默认）：保留开头 max 字。用于细纲/大纲/卡片这类「重点在前面」的区块。 */
function clip(s, max) {
    const t = String(s ?? '');
    if (t.length <= max) return t;
    return `${t.slice(0, Math.max(1, max - CLIP_MARK.length))}${CLIP_MARK}`;
}

/**
 * 从**尾**截：保留结尾 max 字（上一章结尾专用）。
 *
 * 为什么必须有个反向版本：「上一章结尾」这块内容的价值全在最后几百字——钩子、最后
 * 一句台词、未回收的动作。按头截等于把它前面那截背景留下、把衔接点扔掉：模型拿到
 * 的「结尾」根本不是结尾，只能回头整章 read（0.19.2 花力气保住这块配额，却把要保的
 * 那部分截没了）。标记也因此挪到前面——被截掉的是前文。
 */
function clipTail(s, max) {
    const t = String(s ?? '');
    if (t.length <= max) return t;
    return `${CLIP_HEADLESS_MARK}${t.slice(-Math.max(1, max - CLIP_HEADLESS_MARK.length))}`;
}

/**
 * 覆盖率检查的「要素」收敛：**细纲真正声明的**要素才算数。
 *
 * 口径：出场人物名（模型显式传入，本章必须覆盖）+ 命中世界书里**在细纲文本中真实出现**的关键词。
 * 为什么不用条目全部 keywords：一条世界书常带几十个泛词（觉醒/神兵/灵弹/弹匣…），
 * 条目被激活就把整串塞进 terms，产出几十条「未在正文出现」——噪声太多模型会整条忽略
 * （真机：第 69 章列了 50+ 词）。只有细纲点名过的词，才真的是「本章声明要写的要素」。
 *
 * forbidden（0.19.1，E2）：契约禁项清单——禁项禁止出现在正文、要素表要求出现在正文，
 * 两套机制对同一个词的要求相反（真机：世界书触发词「灯苗」被自动收进要素表，同时又在
 * 本章契约 forbidden 里，模型收到矛盾指令）。契约优先级高于世界书自动注入：
 * forbidden 里的词不进要素表。纯函数。
 */
export function declaredCoverageTerms({ outline = '', castNames = [], worldEntries = [], forbidden = [] } = {}) {
    const text = String(outline ?? '');
    const banned = new Set((forbidden ?? []).map((t) => String(t ?? '').trim()).filter((t) => t !== ''));
    const terms = [];
    const seen = new Set();
    const add = (t) => {
        const s = String(t ?? '').trim();
        if (s === '' || seen.has(s) || banned.has(s)) return;
        seen.add(s);
        terms.push(s);
    };
    for (const name of castNames) add(name);
    // 只在「本章必写场景」段里判要素（0.19.2，M15）：卷属/本章任务/禁止偏离项里提到的设定词
    // 是**话题**，不是**必写要素**。真机第 5–14 章实证——「条文来源」「代价」「【用】」这些词
    // 只出现在细纲的禁止偏离项里（「不解释条文来源」「不出现无代价能力」），却被收进要素表
    // 要求正文逐字出现：**契约为禁、要素表为必**，同一句话被两套机制读出相反要求。
    // 细纲没写场景段时退回全文匹配，老书口径不受影响。
    // 场景段**存在但为空**时不能退化成空作用域：sectionOf 返回 ''（不是 undefined），
    // 拿它当作用域会让要素表整表变空——覆盖率从「可能误报」变成「静默不报」，而静默
    // 比误报更糟（误报还能人工核，静默是这条链整个消失）。空段按没写场景段处理。
    const scope = sectionOf(text, SCENE_HEADINGS) || text;
    for (const e of worldEntries ?? []) {
        for (const k of e?.keywords ?? []) {
            if (k !== '' && scope.includes(k)) add(k);
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
 * @returns { sections:[{name,content}], totalChars, dropped:[string], recoveryNotes:[string] }
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
    // 真机实测（真机连载本 102 章 / budget=6000）：7 张人物卡 + 7 张
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
    // 上一章结尾：**宁可截短，不许整块丢弃**（0.19.2，M15）。修前它是"要么 600 字、
    // 要么 0 字"：真机第 9–11 章连续三章，头部硬需求（细纲+承诺书+契约+账本+伏笔+卡片）
    // 恰好占到 5,416 字，加上 619 字头部开销只超 35 字，整块结尾就被丢掉——而排在其后的
    // 摘要窗口因为自带 fit 逻辑活了下来（563 字）。同一个包里出现「衔接两件套一死一活」，
    // 说明问题不在预算不够，在退化方式：衔接是包里**唯一没有旁路获取路径**的东西
    // （卡片能 novel_character read、世界书能 list、大纲能 read，上一章结尾只能整章 read）。
    // 所以按剩余空间截断，留够一个下限才放弃；全国连载里 400 字的真实结尾远胜 0 字 + 一句
    // 「你自己去捞」。
    if (prevTail) {
        const tailName = '上一章结尾（衔接从这里开始）';
        // 给摘要留**次级保留额**：两块衔接内容共用一份 continuityReserve，而结尾排在
        // 摘要前面先占位——真机上结尾吃满 600，轮到摘要时 room 已不够，摘要整块进
        // dropped，模型就失去了「不用整章 read 也能知道最近几章发生了什么」的那道闸
        // （0.16.3 之前摘要只注入 1–10 章的病根同源）。保留额只从「结尾超出下限的
        // 那部分」里划，绝不把结尾压到 TAIL_FLOOR 以下——两边都不许死。
        let room = budget - used - tailName.length - 4;
        if (summaries.length > 0) {
            room -= Math.min(SUMMARY_RESERVE_CHARS, Math.max(0, room - TAIL_FLOOR_CHARS));
        }
        const cap = Math.min(CAPS.prevTail, Math.max(0, room));
        if (cap >= TAIL_FLOOR_CHARS) {
            // 截尾不截头：这块的价值全在最后几百字（钩子/最后一句/未回收的动作）
            const body = clipTail(prevTail, cap);
            if (body.trim() !== '') {
                sections.push({ name: tailName, content: body });
                used += body.length + tailName.length + 4;
            }
        } else dropped.push(tailName);
    }
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

    // ── 衔接找回指令：丢弃发生了，就给路 ─────────────────────────────────────
    // 修前真机事故里，模型对简报那句「因预算丢弃：上一章结尾」的反应是去 grep/read
    // 整章捞前文（上下文 1.7 万 → 10 万+）。丢弃登记只是坦白；坦白要带上**恢复路径**
    // 才不会反过来变成逼模型自救的信号。衔接两件套（上一章结尾 / 摘要窗口）是包里
    // 唯一没有旁路获取方式的东西——被丢时必须告诉模型怎么**精确**找回、以及为什么
    // 不许整章 read。指令走 briefing 的 warnings（不占包预算，本就不是上下文内容）。
    const prevChapter = Math.max(1, chapter - 1);
    const continuityDropped = dropped.filter((d) => d === '上一章结尾（衔接从这里开始）' || d === summaryName);
    const recoveryNotes = continuityDropped.length === 0 ? [] : [
        `衔接找回（预算把「${continuityDropped.join('、')}」挤掉了）：`
        + `① 用 novel_search query 检索第 ${prevChapter} 章的关键词拿摘录；`
        + `② 要精确结尾，read 第 ${prevChapter} 章正文文件只取**最后 ~40 行**（用 offset 读尾部）。`
        + `衔接不许凭记忆；两条路都比整章 read 便宜一个量级——整章 read 正是上下文爆掉的那条路。`,
    ];

    return { sections, totalChars: used, dropped, recoveryNotes };
}

/** 渲染为工具输出的纯文本形态。 */
export function renderPack(pack) {
    return pack.sections.map((s) => `<<${s.name}>>\n${s.content}`).join('\n\n');
}
