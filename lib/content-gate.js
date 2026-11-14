// lib/content-gate.js — 四维内容门禁（纯函数，零 token）。
//
// 来源：dsh-tool-writing 的 gate 四维（事实矛盾 / 违背承诺书 / 欠账未回应 / 物理硬伤），
// 以及多核协同的「欠账不还禁开新钩」。**适配**为本插件能代码判定的部分：
//
//   ① 事实：死亡实体再现（复用 continuity 的死亡推演）+ 过期状态词（账本旧值仍被使用）
//   ② 承诺：欠账未回应（plan 到期的未回收伏笔在本章零命中）—— 本章还开新钩子则**阻断**
//   ③ 完成度：占位符 / 未完成稿（TODO、待补、此处省略…）—— **阻断**
//   ④ 视角：人称混用（第一人称与第三人称叙述并存，低置信 → 只警告）
//   ⑥ 未知补齐：账本里标 unknown 的属性，正文却断言成具体值 —— **阻断**
//      （设定凭空长出来的入口；账本三态见 lib/ledger.js）
//
// 判定权归属：能算的一律代码算（不靠模型自报「我检查过了」）；算不了的（物理硬伤、
// 创意类承诺违背）留给模型+人，本模块不假装能判。

import { detectHookKind, stripEmphasis } from './hook.js';
import { quotedRanges, maskQuotedText } from './quotes.js';
import { deathTimeline } from './continuity.js';
import { hiddenLeakCheck } from './scene-contract.js';
import { normalizeFactStatus, factTimeline, setupKeywords } from './ledger.js';
// setupKeywords / STOP_CHARS 的定义在 ledger.js（单一实现）；这里 re-export
// 保持既有 import 面（test/logic.test.mjs 从 content-gate 取 setupKeywords）不变。
import { detectStaleRelations } from './relations.js';
import { diagnoseArcStall } from './arcs.js';
import { splitParagraphs } from './paragraphs.js';
import { pledgeAudit } from './pledges.js';

/** 未完成稿标记——这些出现在正文里，说明交的是草稿不是成稿。 */
/* 0.19.1 收窄（真机《样书B》ch37/ch39 两次复发）：裸「待补/待写/待填」会命中
 * 行文正常词组（剧情小字「环环待补」=「每一环都当补上」的叙事，不是草稿标记）——
 * 工具黑名单篡改剧情语义。中文标记词改为只认**标记形态**：
 *   · 括号包裹：（待补）/【待写】/（待填）；
 *   · 句读定位：「待补：」紧跟在句首/句号/分号/换行之后（「环环待补」的前字是
 *     汉字，不命中）。
 * 英文 TODO/FIXME/TBD/XXX/??? 无汉字边界问题，保留裸匹配。 */
const PLACEHOLDER_RE = /(TODO|FIXME|\bTBD\b|XXX|\?\?\?|此处省略|此处略|留白待|(?:[（【\[]\s*待(?:补|写|填|插入)\s*[）】\]])|(?:^|[。！？!?；;（【\[\n])\s*待(?:补|写|填|插入)\s*[:：])/;
const PLACEHOLDER_SOFT_RE = /(待定|略去)/;
/** 人称代词。句边界补 ASCII !?——「他!」「她?」也是句首（0.13.6）。 */
const FIRST_PERSON = /(?:^|[。！？…!?\n])\s*我(?!们)/;
const THIRD_PERSON = /(?:^|[。！？…!?\n])\s*(?:他|她)(?!们)/;

export { setupKeywords };

/** 账本的「当前值 / 历史值」推演：截至第 n 章，每个 entity·key 的最新值与曾用值。
 *  「哪些行参与、按什么顺序」不在这重写——用 lib/ledger.js 的 factTimeline（唯一实现）。 */
export function factStatesAt(facts, n) {
    const map = new Map(); // entity·key -> { value, chapter, history:[{value, chapter}] }
    for (const { f } of factTimeline(facts, { upTo: n })) {
        const k = `${f.entity}\u0000${f.key}`;
        const value = String(f.value ?? '');
        const status = normalizeFactStatus(f.status);
        const cur = map.get(k);
        if (cur === undefined) {
            map.set(k, { entity: f.entity, key: f.key, value, status, chapter: f.chapter, history: [] });
            continue;
        }
        // 同值也可能换状态（confirmed -> unknown），状态是终态的一部分；不能只看 value。
        if (cur.value !== value) {
            cur.history.push({ value: cur.value, chapter: cur.chapter });
        }
        cur.value = value;
        cur.status = status;
        cur.chapter = f.chapter;
    }
    return map;
}

/**
 * 未知占位词：正文用它们表达「仍然未知」时**不算**替设定补齐。
 * 「境界是不详」是守住未知，「境界是筑基三层」是编了一个值——两者必须分开。
 */
const UNKNOWN_PLACEHOLDERS = [
    '未知', '不详', '不明', '未明', '难测', '莫测', '不得而知', '尚不可知', '无从得知',
    '难以得知', '不可知', '待定', '悬', '成谜', '是个谜', '一团迷雾', '说不清', '看不清',
    '玄', '谁也不知道', '没人知道', '尚未可知', '仍是未知',
];

function escapeRegExp(s) {
    return String(s ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 断言值尾部的语气词（值本身以「了/的/呢」结尾时把语气词摘掉，好放进文案里）。
 *
 * 保守条件：摘掉后**至少还剩 2 个字**才摘——「死了」摘成「死」就改了原意，
 * 「筑基三层了」摘成「筑基三层」才是我们要的。
 */
const VALUE_TAIL_PARTICLE = /[了的地得呢吧啊呀嘛哦噢]$/;
function trimAssertedValue(raw) {
    const v = String(raw ?? '');
    if (v.length > 2 && VALUE_TAIL_PARTICLE.test(v)) return v.slice(0, -1);
    return v;
}

/**
 * 第 ⑥ 维：**未知补齐**（借竞品 A 的 unknown 机制）。
 *
 * 要治的病：设定里没写的，模型自己编一个填进正文——那个编的值随后落进账本，
 * 就成了「事实」。账本把该属性标成 status=unknown（作者明确说「这个还没定」），
 * 正文却对它做了正向断言（「境界是筑基三层」）——这是**设定凭空长出来**的入口。
 *
 * 判定口径（宁可漏判不可误判）：
 *   ① 该 entity·key 在第 n 章时点的状态是 unknown；
 *   ② 同一个**段落**里同时出现 entity 名与 key（归因——否则没法确定这是谁的属性）；
 *   ③ key 后面跟着正向断言连接词（是/为/＝/已是/达到…）且给出了一个**具体值**；
 *   ④ 该值不是「未知/不详/不得而知」这类占位词（守住未知不算补齐）。
 *
 * 阻断级但**不计入熔断**（与「非成稿」同一档）：这是设定没定的问题，不是稿子写砸了；
 * 熔断额度留给「同一章反复写砸」那种需要改细纲的情况。修法有两条，都写在驳回文案里：
 * 把这处断言从正文删掉，或用 novel_ledger update 把该事实落定（状态改成 confirmed）。
 */
export function detectUnknownFills({ content = '', facts = [], chapter = 0 } = {}) {
    const text = String(content ?? '');
    if (text === '') return [];
    const states = factStatesAt(facts, chapter);
    const unknowns = [...states.values()].filter((s) => s.status === 'unknown');
    if (unknowns.length === 0) return [];
    const paras = splitParagraphs(text);
    const hits = [];
    for (const u of unknowns) {
        const keyEsc = escapeRegExp(u.key);
        const re = new RegExp(
            `${keyEsc}\\s*(?:已经|已|就|便|正是|竟是|就是|是|为|＝|=|达到|升至|降至|成了|变作|变为)\\s*([^\\s，。！？；：、「」（）()]{1,12})`,
        );
        for (const para of paras) {
            if (!para.includes(u.key)) continue;
            if (!para.includes(u.entity)) continue;   // 同段才归因
            const m = para.match(re);
            if (m === null) continue;
            const value = trimAssertedValue(m[1]);
            if (value === '') continue;
            if (UNKNOWN_PLACEHOLDERS.some((w) => value.includes(w))) continue;
            hits.push({ entity: u.entity, key: u.key, value, reason: u.note ?? '', since: u.chapter });
            break;
        }
    }
    return hits;
}

// ── 成稿缺陷（1.6.x）：截断 / AI 自述 / 工程词泄漏 / 章内逐字复读 ──────────────
//
// 这四类病在语义层不明显，但都是**生成过程残留在正文里**的硬伤：半截稿、模型自述、
// 写作流程词、同一段/同一句反复贴。代码能判的只做「命中即报」，不假装能判语义；
// 全部在判定前**剥掉引号内的合法对白**——角色说「我无法完成」是台词，不是模型拒答。

// 引号剥离见 lib/quotes.js（区间/对白剥离唯一实现）。
// 这里原样转出，保持既有测试与调用方的导入路径不变。
export { quotedRanges, maskQuotedText } from './quotes.js';

function lineNoOf(text, index) {
    let line = 1;
    for (let i = 0; i < index && i < text.length; i += 1) if (text[i] === '\n') line += 1;
    return line;
}

/** 命中处上下文（行号 + 前后各 12 字），驳回文案要能直接定位。 */
function hitAt(text, index, length = 1) {
    const line = lineNoOf(text, index);
    const from = Math.max(0, index - 12);
    const to = Math.min(text.length, index + length + 12);
    const excerpt = text.slice(from, to).replace(/\n/g, ' ').trim();
    return { line, excerpt };
}

/** 句末标点：截断判定只认这些收尾（含引号/括号收口与省略号）。 */
const TERMINAL_CHARS = new Set(['。', '！', '？', '!', '?', '…', '”', '"', '」', '』', '）', ')', '】', '》', '〉', '～', '~', '.']);
/** 最短可见长度：低于此值的短稿交给机审字数下限，不在截断判据里重复报。 */
const TRUNCATION_MIN_CHARS = 80;

/**
 * 截断判定（纯函数，内容门禁与批量续写共用）：
 * 可见字数 ≥80 且末字不是句末标点 → 视为半截稿。
 * 低于 80 字不判截断（那是「根本没写」，交给字数下限与续写路径）。
 * @returns {{truncated:boolean, chars:number, last:string, tail:string}}
 */
export function truncatedDraft(text) {
    const raw = String(text ?? '');
    const visible = stripEmphasis(raw).replace(/\s/g, '').length;
    const tail = raw.replace(/\s+$/, '');
    if (visible < TRUNCATION_MIN_CHARS || tail === '') {
        return { truncated: false, chars: visible, last: '', tail: '' };
    }
    const last = tail[tail.length - 1];
    return { truncated: !TERMINAL_CHARS.has(last), chars: visible, last, tail: tail.slice(-24) };
}

/** AI 自述 / 拒答（命中前已剥引号内对白）。 */
const AI_SELF_RE = /作为(?:一个)?(?:AI|人工智能|语言模型|大模型)|我是(?:一个)?(?:AI|人工智能|语言模型|大模型)|我无法(?:继续)?(?:创作|生成|提供|完成|续写)|无法满足(?:该|这个|您|你的)?(?:请求|要求)|\bas an AI\b|\bI(?:'m| am) an AI\b/i;
/** 强工程词：写作流程/系统层的词，正文里出现即过程泄漏。 */
const ENGINEERING_TERM_RE = /细纲|情节点|卷纲|目标情绪|字数目标|章首钩子|章尾钩子|任务单|\bscene card\b|\bprompt\b|\bschema\b|上下文包|系统提示词|修复指令/i;

/** 复读归一化：去空白与引号标记，保留标点（「完全逐字」才判）。 */
function normalizeRepeat(s) {
    return String(s ?? '').replace(/[\s“”‘’「」『』"]/g, '');
}

/** 章内逐字复读：相邻段完全相同（≥8 字）或同句重复 ≥3 次（≥12 字）。 */
export function detectVerbatimRepeat(text) {
    const masked = maskQuotedText(text);
    const paras = splitParagraphs(masked);
    const normParas = paras.map(normalizeRepeat);
    const hits = [];
    for (let i = 1; i < normParas.length; i += 1) {
        const a = normParas[i - 1];
        const b = normParas[i];
        if (a.length >= 8 && a === b) {
            hits.push({ kind: 'paragraph', paragraph: i, length: b.length, excerpt: paras[i].trim().slice(0, 24) });
        }
    }
    const counts = new Map();
    for (const m of masked.matchAll(/[^。！？!?…\n]+/g)) {
        const s = normalizeRepeat(m[0]);
        if (s.length < 12) continue;
        const cur = counts.get(s);
        if (cur === undefined) counts.set(s, { count: 1, index: m.index });
        else cur.count += 1;
    }
    for (const [sentence, info] of counts) {
        if (info.count < 3) continue;
        const pos = hitAt(masked, info.index ?? 0, sentence.length);
        hits.push({ kind: 'sentence', count: info.count, length: sentence.length, sentence, ...pos });
    }
    return hits;
}

/**
 * 四维内容门禁。
 *
 * @param inputs {
 *   content,                  // 本章正文（必有）
 *   chapter,                  // 章号
 *   facts = [],               // 账本
 *   foreshadows = [],         // 伏笔台账
 *   cast = [],                // 本章出场人物（可选）
 *   actorNames = [],          // 已知实体名（cast + 账本 entity），用于死亡再现扫描
 *   contract = null,          // 场景契约（可为归一后对象或 { hidden:[...] }）——悬念保护
 *   minChapterChars,          // 可选：低于此字数提示（机审已有一道，这里不重复拦）
 * }
 * @returns { ok, blocking:[], warnings:[], checks:{...}, stats }
 *   ok=false 表示存在 blocking 项 —— 调用方（novel_write_chapter）应拒绝落盘，除非 force。
 */
export function contentGate({
    content,
    chapter,
    facts = [],
    foreshadows = [],
    cast = [],
    actorNames = [],
    contract = null,
    relations = [],
    arcs = [],
    maxWritten = 0,
    pledges = [],
} = {}) {
    const text = String(content ?? '');
    const blocking = [];
    const warnings = [];

    // ①a 死亡实体再现（事实/连续性里最硬的一条）
    const deaths = deathTimeline(facts);
    const names = [...new Set([...(cast ?? []), ...(actorNames ?? []), ...deaths.keys()])].filter((x) => typeof x === 'string' && x.trim() !== '');
    const deadHits = [];
    for (const name of names) {
        const d = deaths.get(name);
        if (d === undefined) continue;
        if (d.chapter >= chapter) continue; // 本章（或更晚）才死的，本章出现正常
        if (!text.includes(name)) continue;
        deadHits.push({ name, deadAt: d.chapter, value: d.value });
    }
    for (const h of deadHits) {
        // 1.0.1（真机终章假阳性）：终结性回看段豁免——整章回看宿簿/账册时逐页列举
        // 已完结账目（「某某，一笔账，讫」），死者名字出现 ≠ 复活。判定：该死者在
        // 本章**每一次**出现都落在含结词指纹（讫/一笔勾销/账已平）的句子里，降级为
        // warning 请人工确认；任一次出现不带结词则维持阻断（真复活仍拦）。
        const sentenceAt = (t, idx) => {
            const before = t.slice(0, idx);
            const start = Math.max(before.lastIndexOf('\n'), before.lastIndexOf('。'), before.lastIndexOf('！'), before.lastIndexOf('？'), before.lastIndexOf('”')) + 1;
            let end = idx;
            while (end < t.length && !/[。！？\n]/.test(t[end])) end++;
            if (end < t.length && /[。！？]/.test(t[end])) end++;
            return t.slice(start, end);
        };
        const idxs = [];
        for (let i = text.indexOf(h.name); i !== -1; i = text.indexOf(h.name, i + h.name.length)) idxs.push(i);
        const allSettled = idxs.length > 0 && idxs.every((ix) => /讫|一笔勾销|账已平/.test(sentenceAt(text, ix)));
        if (allSettled) {
            warnings.push({
                code: 'dead-character-mention',
                message: `「${h.name}」（第${h.deadAt}章${h.value}）在本章仅出现于结账回看句（含「讫」等结词）——判定为回顾性提及非复活，请人工确认`,
            });
        } else {
            blocking.push({
                code: 'dead-character-present',
                message: `「${h.name}」已在第${h.deadAt}章${h.value}，本章正文却出现——死亡人物复活。确为闪回/回忆请在细纲或正文开头写明「回忆」标记后 force 放行`,
            });
        }
    }

    // ①b 过期状态词：账本里已被更新覆盖的旧值仍然出现在正文
    const states = factStatesAt(facts, chapter);
    const staleHits = [];
    for (const s of states.values()) {
        if (s.history.length === 0) continue;
        for (const old of s.history) {
            // 只查有辨识度的值（≥2 字，且与新值不同）——短词/数字误报率高
            if (String(old.value).length < 2 || old.value === s.value) continue;
            if (!text.includes(old.value)) continue;
            staleHits.push({ entity: s.entity, key: s.key, old: old.value, now: s.value, since: s.chapter });
            break;
        }
    }
    for (const h of staleHits) {
        warnings.push({
            code: 'stale-state',
            message: `正文出现「${h.entity}·${h.key}」的旧值「${h.old}」（第${h.since}章起已更新为「${h.now}」）——若不是刻意回忆，属于穿了旧状态`,
        });
    }

    // ② 欠账未回应（C3 检查侧）
    const dueDebts = (foreshadows ?? []).filter((f) => f && f.payoffChapter === null
        && Number.isInteger(f.plan) && f.plan <= chapter && Number.isInteger(f.chapter) && f.chapter < chapter);
    const hookKind = detectHookKind(text);
    const unanswered = [];
    for (const d of dueDebts) {
        const kws = setupKeywords(d.setup);
        if (!kws.some((k) => text.includes(k))) unanswered.push(d);
    }
    let debtCheck = { due: dueDebts.length, unanswered: unanswered.length, newHook: hookKind };
    if (unanswered.length > 0 && hookKind !== null) {
        blocking.push({
            code: 'debt-unanswered-with-new-hook',
            message: `追读铁律：第${unanswered.map((d) => d.id).join('、')}号伏笔已到预计回收章（${unanswered.map((d) => `第${d.plan}章`).join('、')}）却在本章零回应，本章还开了新钩子（${hookKind}）——欠账未还禁开新钩，先还旧账（回应或在 novel_ledger foreshadow_payoff 登记回收）`,
        });
    } else if (unanswered.length > 0) {
        warnings.push({
            code: 'debt-unanswered',
            message: `第${unanswered.map((d) => d.id).join('、')}号伏笔已到期未回收，本章也没提到——建议近期安排回收，别让读者忘了`,
        });
    }

    // ⑤ 开钩未登记（0.19.0）：《某连载本》105 章审校实证——伏笔.json 止于第 33 章，
    // 此后约 15 个大钩子零登记，写前简报的「未回收伏笔」注入从此失效，模型写新章根本
    // 看不见自己埋的钩子，偏离自我加速。检测：章末检出语义钩子（hookKind 非空）但伏笔
    // 台账没有本章 setup 条目 → 非阻断警告（收束/呼应旧线的章末钩不算新钩，由作者判断），
    // 但每章都可见——「登记」这件事从自愿调用变成每次开钩都被点名。
    const hookUnregistered = hookKind !== null
        && !(foreshadows ?? []).some((f) => f && Number.isInteger(f.chapter) && f.chapter === chapter);
    if (hookUnregistered) {
        debtCheck.newHookUnregistered = true;
        warnings.push({
            code: 'open-hook-unregistered',
            message: `本章章末检出钩子（${hookKind}）但伏笔台账没有本章登记——若这是新钩（新人物/新谜团/新悬念），立即 novel_ledger foreshadow_setup 登记（带 plan 预计回收章）：未登记的钩子写前简报看不见，后文必忘。收束/呼应旧线的章末钩可忽略本条。`,
        });
    }

    // ③ 未完成稿占位符
    const ph = text.match(PLACEHOLDER_RE);
    if (ph !== null) {
        blocking.push({
            code: 'placeholder',
            message: `正文含未完成稿标记「${ph[1]}」——草稿不能落盘，补完再交`,
        });
    }
    const phSoft = text.match(PLACEHOLDER_SOFT_RE);
    if (phSoft !== null) {
        warnings.push({
            code: 'placeholder-soft',
            message: `正文出现「${phSoft[1]}」——若为叙事修辞（如「略去不表」）可忽略；若为未完成标记请补完后再交`,
        });
    }

    // ③.5 成稿缺陷四连（1.6.x，全部 critical / 可 force 放行）：
    //   截断（半截稿）/ AI 自述与拒答 / 强工程词泄漏 / 章内逐字复读。
    // 统一在**剥掉引号内对白**后的文本上判——角色说「我无法完成」是合法台词。
    const masked = maskQuotedText(text);
    const trunc = truncatedDraft(text);
    const truncation = trunc.truncated ? { last: trunc.last, chars: trunc.chars, tail: trunc.tail } : null;
    if (truncation !== null) {
        blocking.push({
            code: 'truncated-draft',
            message: `正文疑似截断：可见 ${truncation.chars} 字，结尾「…${truncation.tail}」停在「${truncation.last}」上而不是句末标点——先把最后一句写完再交；确为有意留白请用 force:true 放行`,
        });
    }
    let aiSelf = null;
    const aiHit = masked.match(AI_SELF_RE);
    if (aiHit !== null) {
        const pos = hitAt(masked, aiHit.index ?? 0, aiHit[0].length);
        aiSelf = { term: aiHit[0], ...pos };
        blocking.push({
            code: 'ai-self-narration',
            message: `正文出现 AI 自述/拒答「${aiHit[0]}」（第${pos.line}行「${pos.excerpt}」）——小说正文不能出现模型身份或写作过程的话，删掉这一处并按剧情重写`,
        });
    }
    let engineeringLeak = null;
    const engHit = masked.match(ENGINEERING_TERM_RE);
    if (engHit !== null) {
        const pos = hitAt(masked, engHit.index ?? 0, engHit[0].length);
        engineeringLeak = { term: engHit[0], ...pos };
        blocking.push({
            code: 'engineering-term-leak',
            message: `正文泄漏写作工程术语「${engHit[0]}」（第${pos.line}行「${pos.excerpt}」）——细纲/提示词/任务单这类流程词不该进入正文，改成场景内的自然表达`,
        });
    }
    const repeatHits = detectVerbatimRepeat(text);
    for (const h of repeatHits) {
        if (h.kind === 'paragraph') {
            blocking.push({
                code: 'verbatim-repeat',
                message: `章内逐字复读：第${h.paragraph}段与第${h.paragraph + 1}段完全相同（「${h.excerpt}」，${h.length} 字）——删掉一段或改写，同一段不许重复贴两次`,
            });
        } else {
            blocking.push({
                code: 'verbatim-repeat',
                message: `章内逐字复读：句子「${h.sentence.slice(0, 24)}」在本章重复 ${h.count} 次（第${h.line}行）——同一句反复贴是生成残留，保留一次，其余改写或删除`,
            });
        }
    }

    // ④ 人称混用（低置信，只警告）
    // 判定单位是【连续叙述段的声音】，不是全章代词计数。两层真机教训（真机导入书监控）：
    // ① 引语里的「他/她/我」是角色在说话——先剥对话跨度（「…」/"…"，同行有闭引号才剥）；
    // ② 叙述句首的「他」也常是第一人称笔法：「。他把钥匙放到桌上」是叙述者转述他人动作，
    //    甚至可以有整段无「我」的场景交代段——按段/按章数他/她都必然误报。
    // 真信号是【意外切换】：第三人称叙述要成串才有意义——「连续 ≥3 段句首他/她且段内无我」
    // 与第一人称叙述并存才算混用；孤立的转述段/交代段（被「我」段隔开）是正常笔法。
    // 段路口径走 lib/paragraphs.js（单换行与空行同权）——旧口径下导入稿整章=1 段，
    // 「连续 ≥3 段句首他/她」永远不成立，人称混用检测形同虚设。
    const narrationParas = splitParagraphs(text)
        .map((p) => p.replace(/[「"][^」"]*[」"]/g, '').trim())
        .filter((p) => p !== '');
    const firstCount = (narrationParas.join('\n').match(new RegExp(FIRST_PERSON.source, 'g')) ?? []).length;
    let thirdCount = 0;
    let thirdRun = 0;
    let maxThirdRun = 0;
    for (const p of narrationParas) {
        if (THIRD_PERSON.test(p) && !p.includes('我')) {
            thirdCount += 1;
            thirdRun += 1;
            if (thirdRun > maxThirdRun) maxThirdRun = thirdRun;
        } else {
            thirdRun = 0;
        }
    }
    let personCheck = { firstCount, thirdCount, thirdRun: maxThirdRun, mixed: false };
    if (firstCount >= 5 && maxThirdRun >= 3) {
        personCheck.mixed = true;
        warnings.push({
            code: 'person-mixed',
            message: `章内出现连续 ${maxThirdRun} 段第三人称叙述（段内无叙述者「我」），与第一人称叙述（${firstCount} 处）并存——若视角应当统一请改稿；多视角切换请确认是有意为之`,
        });
    }

    // ⑤ 悬念保护：契约声明的隐藏人物出现在正文（B3）
    const hiddenNames = Array.isArray(contract?.hidden) ? contract.hidden : [];
    const hiddenLeaks = hiddenNames.length === 0 ? [] : hiddenLeakCheck({ content: text, hidden: hiddenNames });
    for (const name of hiddenLeaks) {
        blocking.push({
            code: 'hidden-character-leaked',
            message: `「${name}」被场景契约声明为本章隐藏人物，正文却出现了其名——揭晓前不该有任何痕迹（这是泄底，读者一旦看到名字后面的反转就废了一半）。`
                + '若本章确实要揭晓，先 novel_scene save 把该人物移出 hidden 再写',
        });
    }

    // ⑥ 未知补齐（①的三态配套）：账本标 unknown 的属性，正文却对它断言了具体值
    const unknownFills = detectUnknownFills({ content: text, facts, chapter });
    for (const h of unknownFills) {
        blocking.push({
            code: 'unknown-fact-filled',
            message: `「${h.entity}·${h.key}」在账本里是**未知**（第${h.since}章起${h.reason === '' ? '' : `·原因：${h.reason}`}），`
                + `本章正文却断言它是「${h.value}」——未知就是未知，正文不得替设定补一个值（编出来的值落进账本就成了「事实」）。`
                + `两条修法二选一：把这处断言从正文删掉（写成「至今不明」也是好写法），`
                + `或用 novel_ledger update 把该事实落定（状态用 confirmed，值写实际设定）。`,
        });
    }

    // ⑦ 关系矛盾（v1.4.0 主线1，warning 档）：正文仍按旧关系写（当前值缺席而旧值在场）。
    // 与 ①b 过期状态词同档（warning 不拦）：关系是软设定，误拦比漏报更糟（回忆/闪回
    // 合法引用旧关系），但每章都可见——「按新关系写」从自觉变成每次被点名。
    const staleRelations = detectStaleRelations({ content: text, relations, chapter });
    for (const h of staleRelations) {
        warnings.push({
            code: 'relation-contradiction',
            message: `「${h.a}↔${h.b}·${h.relation}」第${h.nowChapter}章起是「${h.now}」，正文仍按旧值「${h.old}」写——若非刻意回忆，关系线穿帮了（用 novel_relation update 核对该章是否该推进）`,
        });
    }

    // ⑧ 弧线停走（v1.4.0 主线1，warning 档 + major 质量债）：与 ⑤.5 的 warn() 通道同源——
    // 写章链把本章命中的停走弧线落一条 major 债（「需重规划」档：影响后续章节结构），
    // 内容门禁只在**本章**给出即时提示（全量深扫走 novel_project check 的 fullscan）。
    const arcStalls = diagnoseArcStall(arcs, maxWritten);
    for (const a of arcStalls) {
        warnings.push({
            code: a.kind === 'stalled' ? 'arc-stalled' : 'arc-no-move',
            message: a.message,
        });
    }

    // ⑨ 叙事契约（借鉴天命 v2.8.7 Pledge/Deadline/SecretReveal + 火宝审计 schema）：
    // 到期未兑现（warning，每章点名）；broken 契约同时存在到期未还伏笔（error，阻断——
    // 欠账未还禁开新线的契约级版本）。是否**兑现**由模型显式登记，代码只强制到期可见。
    // 到期判定的章号口径：写第 n 章时，本章本身即将成为「第 n 章」——若按落库前的
    // maxWritten（n-1）算，到期章正好是 n 的契约要等到写第 n+1 章才被点名，永远晚一章。
    // 所以取 max(maxWritten, chapter)；arcs 仍用原始 maxWritten（弧线停走口径不动）。
    const pledgeMax = Math.max(Number.isInteger(maxWritten) ? maxWritten : 0, Number.isInteger(chapter) ? chapter : 0);
    const pledgeIssues = pledgeAudit(pledges, { maxWritten: pledgeMax, dueDebts: unanswered });
    for (const pi of pledgeIssues) {
        if (pi.severity === 'error') {
            blocking.push({ code: pi.code, message: pi.message, where: pi.where, nodeIds: pi.nodeIds, chapters: pi.chapters });
        } else {
            warnings.push({ code: pi.code, message: pi.message, where: pi.where, nodeIds: pi.nodeIds, chapters: pi.chapters });
        }
    }

    return {
        ok: blocking.length === 0,
        blocking, warnings,
        checks: { deadHits, staleHits, debtCheck, placeholder: ph === null ? null : ph[1], personCheck, hiddenLeaks, unknownFills, staleRelations, arcStalls, pledgeIssues, truncation, aiSelf, engineeringLeak, verbatimRepeat: repeatHits },
        stats: { chars: text.replace(/\s/g, '').length, blocking: blocking.length, warnings: warnings.length },
    };
}

/** 一行摘要（供工具 render）。 */
export function contentGateDigest(gate) {
    if (gate.blocking.length === 0 && gate.warnings.length === 0) return '内容门禁：通过 ✓';
    const lines = [
        ...gate.blocking.map((b) => `✗ ${b.message}`),
        ...gate.warnings.map((w) => `⚠ ${w.message}`),
    ];
    return `内容门禁${gate.ok ? '' : '（不通过）'}：\n${lines.join('\n')}`;
}
