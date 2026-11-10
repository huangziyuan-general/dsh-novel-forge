// lib/polish.js — 纯函数：段落级润色病灶定位（AI 味/长段/钩子）。
// 定位→模型改写→走 novel_propose 落提案：润色也不覆盖旧版。

import { scanAiFlavor } from './noai.js';
import { detectHookKind } from './hook.js';
import { splitParagraphs } from './paragraphs.js';

// ── 语句不通顺：言说动词的宾语被物件顶替 ─────────────────────────────────────
//
// 病原型（用户实证）：「把自己家那口大黑铁锅喊了半条街」
// 病根：言说动词（喊/说/嚷…）要求宾语是「被说出去的内容」，这里被**物件**顶了宾语
// 槽——读者按字面读会卡住（锅怎么喊？）。正常形态是把内容补全：
// 「他要觉醒那口大黑铁锅这件事，他跑着喊了半条街」。
//
// 形态由三件同时成立才判定，缺一放行（宁可漏检，不制造假阳性）：
//   ① 把/将字句（受事前置，是这项语病唯一的高发句式）；
//   ② 言说动词后跟**范围补语**（半条街 / 整座城 / 三条巷）——补语把「喊」当成
//      传播动作，这时宾语就必须是内容；不带范围补语的「把他喊了回来」「把话说清楚」
//      都是正常句（喊人、说内容），一律放行；
//   ③ 宾语不含言说内容词（话/事/名字/消息/秘密/经过/来意/真相/实情/原委…）。
//      「把整件事的原委说了」是正常句，放行。
const SPEECH_OBJ_DEFECT_RE = /(?:把|将)([^，。！？；、\s]{2,16}?)(?:喊|嚷|吼|吆喝|说|讲|念|告诉|宣布)(?:了|着|过)[^，。！？；、\s]{0,4}?(?:街|巷|村|镇|城|院|楼|路)/g;
/** 宾语里出现这些字 = 说的是内容，正常用法（放行）。 */
const SPEECH_CONTENT_RE = /话|名|事|消息|秘密|想法|主意|经过|来意|真相|实情|原委|条件|要求|意见|感受|经历|供词|口供/;

/** @returns {string[]} 病灶原句片段（已过滤言说内容宾语） */
export function findSpeechObjDefects(text) {
    const out = [];
    const re = new RegExp(SPEECH_OBJ_DEFECT_RE.source, 'g');
    let m = re.exec(String(text ?? ''));
    while (m !== null) {
        const obj = m[1] ?? '';
        // 代词宾语（把他喊了…）也在放行侧：喊人是正常用法
        if (!SPEECH_CONTENT_RE.test(obj) && !/^[他她它我你咱]{1,2}(们|自己)?$/.test(obj)) {
            out.push(m[0]);
        }
        m = re.exec(String(text ?? ''));
    }
    return out;
}

/**
 * 段落级热点扫描：返回有问题的段落及原因，供用户/模型精准修改。
 * 超过 top 条按严重度截断。
 * @returns {chapterHook, paragraphs:[{paragraph,chars,issues[],aiScore}]}
 */
export function analyzeParagraphs(content, { top = 20 } = {}) {
    const text = String(content ?? '');
    const paras = splitParagraphs(text);
    const out = [];
    paras.forEach((p, idx) => {
        const issues = [];
        const chars = p.replace(/\s/g, '').length;
        const ai = scanAiFlavor(p, { topK: 2 });
        if (ai.score >= 30) issues.push(`AI 味偏高（${ai.score}）：${(ai.topIssues[0] ?? '').slice(0, 40)}`);
        if (chars > 220) issues.push(`段落过长（${chars} 字）——考虑拆段或删冗余`);
        if (/^(因为|所以|因此|于是).+，.{5,}。/m.test(p) && chars < 80) issues.push('结论式短句连贯出现，有灌输腔');
        // 语句不通顺（用户实证的病根）：言说动词的宾语被物件顶替，读起来「卡住」。
        // 只报不代改——改写交给 polish 通道，病灶定位必须精确到原句片段。
        for (const frag of findSpeechObjDefects(p)) {
            issues.push(`语句不通顺：「${frag}」——言说动词的宾语应是「说的内容」，`
                + '现在被物件顶了。改成「……这件事，他跑着喊了半条街」这类把内容补全的写法');
        }
        if (issues.length > 0) out.push({ paragraph: idx + 1, chars, aiScore: ai.score, issues });
    });
    out.sort((a, b) => (b.aiScore - a.aiScore) || (b.chars - a.chars));
    return {
        chapterHook: detectHookKind(text),
        paragraphs: out.slice(0, top),
    };
}

// ── 保守编辑守卫（来源：dsh-tool-writing 的 autoproof） ──────────────────────
//
// 润色最大的风险不是「没改好」，而是**改出了新错**：校对模型自作主张重写、
// 把形近字替错、把短句膨胀成长段。tw 的 autoproof 用三条保守规则防这个，
// 我们把它适配成「整章提交」形态的守卫（我们的润色是整章提交而非逐条替换）：
//
//   ① 标题行不得改（首行形似 `第N章`/`# 标题` 时）
//   ② 易混字黑名单：改后引入了原文没有的形近字 → 判定校对自伤（直接拒绝）
//   ③ 长度纪律：整章膨胀超阈值、或单段膨胀超 2 倍+20 → 是重写不是润色
//   ④ 段落对齐：相似度太低 = 整段被换掉；大面积如此 → 疑似重写而非润色
//
// 「可议项只报告不代改」由 analyzeParagraphs 保证（它本来就不改正文）。

/** 高危易混字黑名单：这些字被「顺手改错」的概率极高，且错得隐蔽。 */
export const CONFUSABLE_CHARS = ['恨', '戍', '戌', '柝', '祗', '祇', '菅', '圮'];

function bigramSet(s) {
    const set = new Set();
    const t = String(s).replace(/\s/g, '');
    for (let i = 0; i < t.length - 1; i += 1) set.add(t.slice(i, i + 2));
    return set;
}

function jaccardSet(a, b) {
    if (a.size === 0 && b.size === 0) return 1;
    let inter = 0;
    for (const x of a) if (b.has(x)) inter += 1;
    return inter / (a.size + b.size - inter);
}

const HEADING_RE = /^(#{1,6}\s|第[0-9一二三四五六七八九十百零]+[章节回])/;

/** 数字 token：阿拉伯数字（可带小数/百分号），全角先归一——数字是事实，不是文风。 */
const NUMBER_TOKEN_RE = /[0-9０-９]+(?:[.．][0-9０-９]+)?[%％]?/g;

/** 归一化数字 token：全角→半角、全角句点→半角、百分号统一。 */
function normalizeNumberToken(t) {
    return t
        .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
        .replace(/[．]/g, '.')
        .replace(/[％]/g, '%');
}

/**
 * 数字 token 多重集（纯函数）：`3` 出现两次就记 2，位置不参与比较。
 * 只认阿拉伯数字——中文数词（三/三百）不做转换（改写「三」为「3」是排版，
 * 但中文数词与量词粘连，代码判不准，宁可漏判也不误伤）。
 */
export function numberTokenMultiset(text) {
    const map = new Map();
    for (const raw of String(text ?? '').match(NUMBER_TOKEN_RE) ?? []) {
        const t = normalizeNumberToken(raw);
        map.set(t, (map.get(t) ?? 0) + 1);
    }
    return map;
}

function countOccurrences(text, needle) {
    if (needle === '') return 0;
    let count = 0;
    let idx = text.indexOf(needle);
    while (idx !== -1) {
        count += 1;
        idx = text.indexOf(needle, idx + needle.length);
    }
    return count;
}

/** 数字多重集差异（纯函数）：返回 [{token, before, after}]。 */
export function numberTokenDiff(original, edited) {
    const a = numberTokenMultiset(original);
    const b = numberTokenMultiset(edited);
    const tokens = new Set([...a.keys(), ...b.keys()]);
    const out = [];
    for (const token of tokens) {
        const before = a.get(token) ?? 0;
        const after = b.get(token) ?? 0;
        if (before !== after) out.push({ token, before, after });
    }
    return out;
}

/** 人物专名出现次数差异（纯函数）：返回 [{name, before, after}]。 */
export function properNameDiff(original, edited, names = []) {
    const seen = new Set();
    const out = [];
    for (const raw of names) {
        const name = String(raw ?? '').trim();
        // 单字名与空名不判：误命中率过高（「林」「他」这类会扫出满屏假阳性）。
        if (name.length < 2 || seen.has(name)) continue;
        seen.add(name);
        const before = countOccurrences(String(original ?? ''), name);
        const after = countOccurrences(String(edited ?? ''), name);
        if (before !== after) out.push({ name, before, after });
    }
    return out;
}

/** 补丁提案的语义检查边界（如实标注，不假装能判）。 */
export const PATCH_SEMANTIC_NOTE = '补丁只校验：每处 find 在基线稿唯一匹配、补丁区间互不重叠、修改比例不超上限、应用后仍走原有字数/机审门禁；改写后的语义是否符合意图，代码判不了，需人工看提案预览';

/** 单份补丁提案的最大修改比例：find 与 replace 逐条取大者，超过就走整章提案。 */
export const PATCH_MAX_TOUCH_RATIO = 0.35;

/**
 * 应用文本补丁（纯函数，原子）：任何一条不满足就抛错，**不返回半成品**。
 *
 * 口径：
 *   · 每条 find 在基线稿里必须**恰好出现一次**（0 次 = 定位失效，2+ 次 = 会改错地方）；
 *   · 补丁区间互不重叠（重叠意味着两条补丁抢同一段文字，顺序一换结果就不同）；
 *   · 从后往前替换（前面的替换不改变后面补丁的偏移）；
 *   · 每条 find/replace 的字符规模取大者，合计占基线稿比例 ≤ maxTouchRatio。
 *
 * @returns {{text, patches:Array, touchedChars, touchedRatio}}
 */
export function applyTextPatches(baseText, patches, { maxTouchRatio = PATCH_MAX_TOUCH_RATIO } = {}) {
    const base = String(baseText ?? '');
    if (!Array.isArray(patches) || patches.length === 0) {
        throw new Error('补丁提案需要至少一条 patch：{ find, replace }');
    }
    const located = [];
    for (let i = 0; i < patches.length; i += 1) {
        const p = patches[i];
        if (p === null || typeof p !== 'object') throw new Error(`第 ${i + 1} 条 patch 不是对象`);
        const find = typeof p.find === 'string' ? p.find : '';
        const replace = typeof p.replace === 'string' ? p.replace : null;
        if (find === '') throw new Error(`第 ${i + 1} 条 patch 的 find 为空——补丁必须给出要定位的原句`);
        if (replace === null) throw new Error(`第 ${i + 1} 条 patch 的 replace 必须是字符串（删改用空串）`);
        let at = base.indexOf(find);
        if (at === -1) throw new Error(`第 ${i + 1} 条 patch 定位失败：find「${find.slice(0, 40)}」在基线稿里找不到——补丁必须逐字引用基线稿原文`);
        const second = base.indexOf(find, at + find.length);
        if (second !== -1) {
            throw new Error(`第 ${i + 1} 条 patch 的 find「${find.slice(0, 40)}」在基线稿里出现多次，无法唯一匹配——请把 find 扩到足以唯一定位（前后多带几个字）`);
        }
        located.push({ index: i, find, replace, start: at, end: at + find.length });
    }
    const sorted = [...located].sort((a, b) => a.start - b.start);
    for (let i = 1; i < sorted.length; i += 1) {
        if (sorted[i].start < sorted[i - 1].end) {
            throw new Error(`第 ${sorted[i - 1].index + 1} 条与第 ${sorted[i].index + 1} 条 patch 定位区间重叠（位置 ${sorted[i - 1].start}-${sorted[i - 1].end} / ${sorted[i].start}-${sorted[i].end}）——同一段文字只能被一条补丁修改`);
        }
    }
    const baseChars = base.replace(/\s/g, '').length;
    const touchedChars = located.reduce((sum, x) => sum + Math.max(x.find.length, x.replace.length), 0);
    const touchedRatio = baseChars === 0 ? 0 : touchedChars / baseChars;
    if (touchedRatio > maxTouchRatio) {
        throw new Error(`补丁修改规模 ${Math.round(touchedRatio * 100)}%（${touchedChars}/${baseChars} 字），超过上限 ${Math.round(maxTouchRatio * 100)}%——这已不是局部修补，请改用整章 content 提案`);
    }
    let text = base;
    for (const p of [...located].sort((a, b) => b.start - a.start)) {
        text = text.slice(0, p.start) + p.replace + text.slice(p.end);
    }
    return {
        text,
        patches: located.map(({ index, find, replace, start, end }) => ({ index, find, replace, start, end })),
        touchedChars,
        touchedRatio,
    };
}
/**
 * 保守编辑守卫：对照原稿审查润色稿，把「可能改错」的地方挑出来。
 * 纯函数，零 token。
 *
 * @param original 磁盘上的原稿
 * @param edited   模型提交的润色稿
 * @param opts { growthLimit=1.3 整章膨胀上限, paraGrowthLimit=2 单段膨胀上限（另有 +20 字宽容）,
 *               minSim=0.4 段落同源阈值, massRewriteRatio=0.4 大面积重写阈值,
 *               names=[] 人物专名表（出现次数不变校验） }
 * @returns { ok, blocking:[...], warnings:[...], risks:[{severity,code,message}], stats }
 *   ok = 无 blocking。blocking 级必须拒绝提交；warnings 级随提案返回给用户看。
 */
export function validatePolishEdits(original, edited, opts = {}) {
    const {
        growthLimit = 1.3, paraGrowthLimit = 2, minSim = 0.4, massRewriteRatio = 0.4, names = [],
    } = opts;
    const orig = String(original ?? '');
    const next = String(edited ?? '');
    const risks = [];

    // ① 标题行保护
    const firstLine = (s) => (s.split('\n').find((l) => l.trim() !== '') ?? '').trim();
    const of = firstLine(orig);
    const nf = firstLine(next);
    if (of !== nf && HEADING_RE.test(of)) {
        risks.push({ severity: 'error', code: 'heading-changed', message: `首行标题被改动（「${of}」→「${nf}」）——标题不参与润色，章节名由 novel_write_chapter 管理` });
    }

    // ② 易混字黑名单
    const introduced = CONFUSABLE_CHARS.filter((c) => next.includes(c) && !orig.includes(c));
    if (introduced.length > 0) {
        risks.push({ severity: 'error', code: 'confusable-char', message: `润色稿引入了原文没有的高危易混字「${introduced.join('、')}」——这通常是校对模型自己写错的信号，请逐处核对该字是否用对` });
    }

    // ②.5 数字与专名保护（1.6.x）：润色只改措辞，不改事实。
    //   · 数字 token 多重集不变（`3` 两次仍是两次，允许整十/全角格式归一）；
    //   · 人物专名出现次数不变（少一次 = 漏写，多一次 = 换了人）。
    // 中文数词（三/三百）判不准，明确不做（见 numberTokenMultiset 注释）；
    // 改写后的语义是否正确同样判不了——这里只守「数字与专名没被顺手改掉」。
    const numDiff = numberTokenDiff(orig, next);
    if (numDiff.length > 0) {
        const detail = numDiff.slice(0, 4).map((d) => `「${d.token}」${d.before}→${d.after} 次`).join('、');
        risks.push({
            severity: 'error', code: 'number-token-changed',
            message: `润色稿改动了数字 token：${detail}${numDiff.length > 4 ? ` 等 ${numDiff.length} 项` : ''}——润色只改措辞不改事实数字；确需改数字请走 novel_propose 的正常提案`,
        });
    }
    const nameDiff = properNameDiff(orig, next, names);
    if (nameDiff.length > 0) {
        const detail = nameDiff.slice(0, 4).map((d) => `「${d.name}」${d.before}→${d.after} 次`).join('、');
        risks.push({
            severity: 'error', code: 'proper-name-count-changed',
            message: `润色稿改动了人物专名出现次数：${detail}${nameDiff.length > 4 ? ` 等 ${nameDiff.length} 项` : ''}——少一次是漏写、多一次是换了人；请核对原意，不要借润色改人物`,
        });
    }

    // ③ 整章长度纪律
    const oc = orig.replace(/\s/g, '').length;
    const nc = next.replace(/\s/g, '').length;
    if (oc > 0 && nc > oc * growthLimit) {
        risks.push({ severity: 'warning', code: 'chapter-growth', message: `润色稿比原稿多 ${nc - oc} 字（${oc}→${nc}，+${Math.round((nc / oc - 1) * 100)}%）——润色应删冗而不是扩写；确认不是把「重写」当润色交了` });
    }

    // ④ 段落对齐：相似度过低 = 整段被换
    const origParas = splitParagraphs(orig);
    const nextParas = splitParagraphs(next);
    const nextSig = nextParas.map((p) => bigramSet(p));
    const used = new Set();
    let rewritten = 0;
    const grown = [];
    for (const p of origParas) {
        const sig = bigramSet(p);
        let best = { idx: -1, sim: -1 };
        for (let i = 0; i < nextParas.length; i += 1) {
            if (used.has(i)) continue;
            // 长度差距过大的候选直接压分，避免长段抢走短段的匹配
            const sim = jaccardSet(sig, nextSig[i]);
            if (sim > best.sim) best = { idx: i, sim };
        }
        if (best.idx === -1) { rewritten += 1; continue; }
        used.add(best.idx);
        if (best.sim < minSim) {
            rewritten += 1;
            continue;
        }
        const ocp = p.replace(/\s/g, '').length;
        const ncp = nextParas[best.idx].replace(/\s/g, '').length;
        if (ocp > 0 && ncp > ocp * paraGrowthLimit + 20) grown.push(`¶${best.idx + 1}（${ocp}→${ncp} 字）`);
    }
    if (origParas.length >= 5 && rewritten / origParas.length > massRewriteRatio) {
        risks.push({ severity: 'warning', code: 'mass-rewrite', message: `${rewritten}/${origParas.length} 段与原稿几乎无重叠——这是重写而非润色，请确认意图（重写应走 novel_propose 的正常提案）` });
    }
    if (grown.length > 0) {
        risks.push({ severity: 'warning', code: 'paragraph-growth', message: `单段膨胀超 ${paraGrowthLimit} 倍：${grown.slice(0, 3).join('、')}${grown.length > 3 ? ` 等 ${grown.length} 处` : ''}——多半是注水，建议压回去` });
    }

    const blocking = risks.filter((r) => r.severity === 'error');
    return {
        ok: blocking.length === 0,
        blocking,
        warnings: risks.filter((r) => r.severity === 'warning'),
        risks,
        stats: {
            origChars: oc, editedChars: nc, paragraphs: origParas.length,
            rewrittenParagraphs: rewritten, introducedConfusables: introduced,
            numberTokenDiff: numDiff, properNameDiff: nameDiff,
        },
    };
}
// ── 审稿引文 grounding（v1.4.0 主线3）────────────────────────────────────────
//
// 来源：竞品 MirrorNovel 的 semanticMemory evidence 校验（已落在 lib/ledger.js 的
// validateFactEvidence——facts_updates 的「正文原句」子串硬校验）。
// 本模块把同一套校验**复用**给审稿侧：`novel_polish` 的审稿/润色回执如果带
// 「引用了正文某句」，引用必须逐字（忽略空白）在原文里找到——找不到就是
// 模型在编造引文（审稿幻觉的高频形态：凭印象引一句不存在的原话当证据）。
// 校验纯函数、零 token，与 validateFactEvidence 同纪律：不提供不校验（向后
// 兼容：旧调用没有引文参数时行为一字不差），提供了就必须是真的。
//
// 为什么不直接 import validateFactEvidence：它的入参形状是 {entity,key} 对，
// 审稿引文是 {label, quote} 对（「第2章开头」引「…原句…」）。两者共用**归一化
// 判据**（忽略空白 + 最小长度 4 字）但**校验形状不同**，故单列一个纯函数，
// 判据常量 MIN_QUOTE_CHARS 与 MIN_EVIDENCE_CHARS 同值（4），口径不抄第二份正文。

/** 审稿引文归一化后的最小长度（与 ledger.MIN_EVIDENCE_CHARS 同值，不同语义不复用常量名）。 */
export const MIN_QUOTE_CHARS = 4;

/**
 * 校验审稿引文与原文的一致性（纯函数）。
 *
 * @param quotes  [{label, quote}]——label 是「这条引文指向的位置」（人话，如「第2章开头」/「段3」），
 *                quote 是模型声称引用的原句。
 * @param content  被审稿/润色的原文全文。
 * @returns 违规清单（空数组 = 全部通过 / 未提供引文）；每条违规带 label + 人话原因。
 *
 * 口径（对齐 validateFactEvidence，一条一条对齐不重造）：
 *   · 引文（忽略全部空白差异后）必须是原文的**子串**——不许改写转述，审稿证据
 *     的价值就在「逐字」；
 *   · 归一化后 < MIN_QUOTE_CHARS 拒收（4 字以下几乎必然在原文里撞上，定位不到具体内容，
 *     是仪式不是证据——与 evidence 同判据）；
 *   · 不提供不校验（调用方没传 quotes 时直接 []，旧行为一字不动）。
 */
export function validateReviewQuotes(quotes, content) {
    const list = Array.isArray(quotes) ? quotes : [];
    if (list.length === 0) return [];
    if (typeof content !== 'string') throw new Error('content 必须是字符串');
    const hay = content.replace(/\s+/g, '');
    const violations = [];
    for (const q of list) {
        if (q === null || typeof q !== 'object') throw new Error('quote 必须是对象');
        const label = String(q.label ?? '').trim() || '（未标注位置）';
        const raw = String(q.quote ?? '');
        const norm = raw.replace(/\s+/g, '');
        if (norm.length < MIN_QUOTE_CHARS) {
            violations.push({
                label,
                reason: `引文太短（忽略空白后 ${norm.length} 字，至少 ${MIN_QUOTE_CHARS} 字）——这么短的片段几乎必然在原文里撞上，定位不到具体内容；请摘一个能定位到「这句话在哪」的完整短句。`,
            });
            continue;
        }
        if (!hay.includes(norm)) {
            violations.push({
                label,
                reason: `引文「${raw.slice(0, 40)}${raw.length > 40 ? '…' : ''}」在原文里逐字找不到（忽略空白差异）——审稿证据必须摘自原文原句，不许改写转述或凭印象补全。`,
            });
        }
    }
    return violations;
}
