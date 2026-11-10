// lib/noai.js — 结构性去 AI 味扫描（纯函数，零模型调用、零费用）。
//
// 八维判定（对齐社区插件的分类学，并补足它们没做的结构指标）：
//   cliche    模板句命中（词库，出现即计）
//   stock     库存词密度（千字频次）
//   emotion   情绪直写（telling 而非 showing）
//   template  句式模板 + 省略号/破折号滥用 + 段尾升华腔
//   structure 段落/句长方差过低 = 节奏单调（结构性指标，词库抓不住的那类）
//   dilution  信息稀释（重复 bigram 率 + 「的」密度）
//   formula   断章公式（短宣言+叹号收尾）
//   defaultword AI 默认值词（动作/身体部位的默认选项）——实词，只能按密度计，
//               命中即计分会满屏假阳性（「他屏住气息」也是一次命中）
//
// 每维 0-100（越高越 AI），总分加权。所有阈值是启发式，
// 用真实样本校准；判定结果永远只是「证据」，不是判决。

import lexicon from './data/noai-lexicon.json' with { type: 'json' };
import { splitParagraphs } from './paragraphs.js';

// 八维（defaultword 是 1.0.2 新增的第八维，权重从其余七维按比例匀出，总和恒为 1）。
const WEIGHTS = { cliche: 0.17, stock: 0.12, emotion: 0.12, template: 0.17, structure: 0.15, dilution: 0.11, formula: 0.09, defaultword: 0.07 };
const LEVELS = [[20, '清爽'], [40, '轻微'], [60, '明显'], [Number.POSITIVE_INFINITY, '严重']];

function clamp01(x) { return Math.max(0, Math.min(1, x)); }

/**
 * 词库条目取匹配串。v3 起条目是对象（{pattern, enabled, minHits, perKilo, evidence}），
 * 但保留对旧裸字符串的兼容——外部自定义词库可能还是老格式。
 */
export function ruleText(entry) {
    return typeof entry === 'string' ? entry : entry.pattern;
}

/**
 * 条目级判定口径（v3）：命中数 ≥ minHits 且千字密度 ≥ perKilo 才算该条命中。
 *
 * 默认值刻意取 minHits=1、perKilo=0 —— 语义上等价于 v2 的「命中即计」，
 * 所以词库迁移本身不改变任何分数。阈值收紧只能发生在**单条**上（例如
 * 「落定」这类在正常文本里高频出现的词，可单独设 minHits/perKilo），
 * 而不是给整个词库换一个全局数字。
 *
 * enabled:false 的条目留在词库里可见、参与解析，但不参与判定。
 * 字段缺失（旧词库/外部词库）时回退上面的默认口径，不抛错。
 */
export function entryQualifies(count, chars, entry) {
    if (typeof entry === 'string') return count > 0;
    if (entry.enabled === false) return false;
    if (count <= 0) return false;
    const minHits = Number.isFinite(entry.minHits) ? entry.minHits : 1;
    if (count < minHits) return false;
    const perKilo = Number.isFinite(entry.perKilo) ? entry.perKilo : 0;
    if (perKilo <= 0) return true;
    if (chars <= 0) return false;
    return (count * 1000) / chars >= perKilo;
}

/** 千字频次线性映射到 0-100：[t0, t1] 之外饱和。 */
function densityScore(count, chars, t0, t1) {
    if (chars === 0) return 0;
    const per1k = (count * 1000) / chars;
    return Math.round(100 * clamp01((per1k - t0) / (t1 - t0)));
}

function lineOf(text, index) {
    let line = 1;
    for (let i = 0; i < index && i < text.length; i += 1) if (text[i] === '\n') line += 1;
    return line;
}

function std(values) {
    if (values.length < 2) return 0;
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
    return Math.sqrt(variance);
}

function coefficientOfVariation(values) {
    // 空输入直接给 0：mean 会算成 0/0=NaN，而 `mean === 0` 挡不住 NaN，
    // NaN 一路传进总分后 JSON.stringify 变 null —— 宿主按 schema 判 INVALID_TOOL_OUTPUT
    // （触发例：非空白但全是句末标点的文本，如「……」→ sentences=[]）。
    if (values.length === 0) return 0;
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    if (mean === 0) return 0;
    return std(values) / mean;
}

function countAll(text, needle) {
    let count = 0;
    let idx = text.indexOf(needle);
    while (idx !== -1) { count += 1; idx = text.indexOf(needle, idx + needle.length); }
    return count;
}

function scoreFromCv(cv) {
    // cv≈0 完全单调 → 95 分；cv≥0.55 节奏丰富 → 5 分以下。
    return Math.round(95 * clamp01((0.55 - cv) / 0.55)) + 5 * (cv < 0.1 ? 1 : 0);
}

/**
 * 主入口。
 * @param text   章节正文
 * @param opts   { topK?: number }
 */
export function scanAiFlavor(text, { topK = 8 } = {}) {
    const raw = String(text ?? '');
    const chars = raw.replace(/\s/g, '').length;
    if (chars === 0) {
        return { score: 0, level: '清爽', chars: 0, categories: emptyCategories(), topIssues: ['（空文本）'] };
    }

    // ① cliche：模板句逐条统计（含首次命中行号，便于定位改写）。
    const clicheHits = [];
    let clicheCount = 0;
    for (const entry of lexicon.cliche) {
        const phrase = ruleText(entry);
        let count = 0;
        const lines = [];
        let idx = raw.indexOf(phrase);
        while (idx !== -1) {
            count += 1;
            if (lines.length < 3) lines.push(lineOf(raw, idx));
            idx = raw.indexOf(phrase, idx + phrase.length);
        }
        if (entryQualifies(count, chars, entry)) { clicheCount += count; clicheHits.push({ term: phrase, count, lines }); }
    }
    clicheHits.sort((a, b) => b.count - a.count);
    const clicheScore = densityScore(clicheCount, chars, 0.8, 6);

    // ② stock：库存词千字密度。
    const stockHits = [];
    let stockCount = 0;
    for (const entry of lexicon.stock) {
        const term = ruleText(entry);
        const count = countAll(raw, term);
        if (entryQualifies(count, chars, entry)) { stockCount += count; stockHits.push({ term, count, per1k: Math.round(((count * 1000) / chars) * 10) / 10 }); }
    }
    stockHits.sort((a, b) => b.count - a.count);
    const stockScore = densityScore(stockCount, chars, 6, 22);

    // ③ emotion：情绪直写。
    const emotionHits = [];
    let emotionCount = 0;
    const emotionRules = [
        ...lexicon.emotion.patterns.map((entry) => ({ entry, source: ruleText(entry) })),
        ...lexicon.emotion.singles.map((entry) => ({ entry, source: ruleText(entry).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') })),
    ];
    for (const { entry, source } of emotionRules) {
        const re = new RegExp(source, 'g');
        const found = [];
        let m = re.exec(raw);
        while (m !== null) { found.push({ match: m[0], index: m.index }); m = re.exec(raw); }
        if (!entryQualifies(found.length, chars, entry)) continue;
        emotionCount += found.length;
        for (const f of found) {
            if (emotionHits.length < topK * 2) emotionHits.push({ match: f.match, line: lineOf(raw, f.index) });
        }
    }
    const emotionScore = densityScore(emotionCount, chars, 0.5, 5);

    // ④ template：配对句式 + 段尾升华 + 标点滥用。
    const templateHits = [];
    let pairedCount = 0;
    for (const p of lexicon.templates.paired) {
        const count = new RegExp(p.regex, 'g').test(raw)
            ? (raw.match(new RegExp(p.regex, 'g')) ?? []).length
            : 0;
        if (entryQualifies(count, chars, p)) { pairedCount += count; templateHits.push({ term: p.name, count }); }
    }
    const summaryHits = [];
    let summaryCount = 0;
    for (const p of lexicon.templates.summaryPatterns) {
        const matches = raw.match(new RegExp(p.regex, 'g')) ?? [];
        if (entryQualifies(matches.length, chars, p)) { summaryCount += matches.length; summaryHits.push({ term: p.name, count: matches.length }); }
    }
    const ellipsis = countAll(raw, lexicon.templates.markers.ellipsis);
    const dash = countAll(raw, lexicon.templates.markers.dash);
    const per1kEll = (ellipsis * 1000) / chars;
    const per1kDash = (dash * 1000) / chars;
    templateHits.push({ term: '省略号……', count: ellipsis }, { term: '破折号——', count: dash });
    const templateScore = Math.min(100, Math.round(
        densityScore(pairedCount, chars, 0.4, 3) * 0.4
        + densityScore(summaryCount, chars, 0.3, 2.5) * 0.25
        + Math.min(100, per1kEll * 9) * 0.2
        + Math.min(100, per1kDash * 9) * 0.15
    ));

    // ⑤ structure：段落与句长方差（词库抓不住的结构性平庸）。
    // 段路口径走 lib/paragraphs.js（单换行/空行同权、剔标题行）——否则 docx 导入书
    // 整章=1 段，paraCv=0 会让本维虚高（实测 60 vs 真值 11.5）。
    const paragraphs = splitParagraphs(raw);
    const paraLens = paragraphs.map((p) => p.replace(/\s/g, '').length);
    const sentences = raw.split(/[。！？!?…]+/).map((s) => s.trim()).filter((s) => s.length > 0);
    const sentLens = sentences.map((s) => s.replace(/\s/g, '').length);
    const paraCv = coefficientOfVariation(paraLens);
    const sentCv = coefficientOfVariation(sentLens);
    const structureScore = Math.round(scoreFromCv(paraCv) * 0.6 + scoreFromCv(sentCv) * 0.4);

    // ⑥ dilution：重复 bigram 率 + 「的」密度。
    // 0.19.1（E18）：bigram 只在**叙述文本**上算——对话行的重复 bigram（人称/口头语/
    // 上下句承接）是对话体的自然属性，不是 AI 痕迹；真机对话占比 0.5-0.7 的章
    // bigram 率 0.33-0.44 全被误报「信息稀释」。对话行（含对话标记的行）剔除后再统计；
    // 纯对话章叙述为空 → bigramRate=0，该维分数由「的」密度独立支撑。
    const clean = raw.replace(/\s/g, '');
    const narration = raw.split('\n').filter((l) => !/[「『“"]/.test(l)).join('\n').replace(/\s/g, '');
    const bigramSource = narration.length >= 40 ? narration : ''; // 叙述过短（<40字）→ 无叙述可判，rate=0
    const bigrams = new Map();
    for (let i = 0; i < bigramSource.length - 1; i += 1) {
        const bg = bigramSource.slice(i, i + 2);
        bigrams.set(bg, (bigrams.get(bg) ?? 0) + 1);
    }
    let repeated = 0;
    let total = 0;
    for (const [, c] of bigrams) { total += c; if (c > 1) repeated += c - 1; }
    const bigramRate = total === 0 ? 0 : repeated / total;
    const deCount = countAll(clean, '的');
    const dePerSent = sentences.length === 0 ? 0 : deCount / sentences.length;
    const dilutionScore = Math.round(
        Math.min(100, Math.max(0, (bigramRate - 0.18) * 480)) * 0.6
        + Math.min(100, Math.max(0, (dePerSent - 2.2) * 40)) * 0.4
    );

    // ⑦ formula：断章公式——《某连载本》105 章审校实证：100+ 章连续「一句揭底宣言
    // +叹号」收尾（141 个章节文件 78 个叹号收尾），同构率近乎 100%，是可检测的生成痕迹。
    // 两处计分：章末段最后一句 ≤24 字且以叹号收（断章位直接命中，权重最重）+ 全文 ≤24 字
    // 短叹号句占比（55% 实测值 → 40 分封顶段；健康书 2-3% → 0 分）。
    const endingPara = paragraphs[paragraphs.length - 1] ?? '';
    const endSents = endingPara.split(/[。…]+/).map((s) => s.trim()).filter((s) => s.length > 0);
    const lastSent = (endSents[endSents.length - 1] ?? '').replace(/[」”"]$/, '');
    const endFormula = /[！!]\s*$/.test(lastSent) && lastSent.replace(/[！!]/g, '').replace(/\s/g, '').length <= 24;
    const exclaimShort = sentences.filter((s) => s.length <= 24 && /[！!]\s*$/.test(s)).length;
    const exclaimRatio = sentences.length === 0 ? 0 : exclaimShort / sentences.length;
    const formulaScore = Math.round(
        (endFormula ? 60 : 0)
        + Math.min(40, Math.max(0, (exclaimRatio - 0.03) * 320))
    );

    // ⑧ defaultword：AI 默认值词（动作/身体部位的默认选项）。
    // 与 cliche 的差别：cliche 是「模板句」，出现即计；这些是**实词**，单个出现完全
    // 正常（谁都会写「气息」），只有成片出现才说明模型在套默认值——所以必须按
    // 千字密度计，绝不能命中即计分（否则「他屏住气息」一句话就把分打满，全是假阳性）。
    // 实证来源：跨书素材库（「喉结动了动」在 15 个文件里出现；「摩挲」被用户点名）。
    const defaultwordHits = [];
    let defaultwordCount = 0;
    for (const entry of lexicon.defaultword) {
        const term = ruleText(entry);
        const count = countAll(raw, term);
        if (entryQualifies(count, chars, entry)) {
            defaultwordCount += count;
            defaultwordHits.push({ term, count, per1k: Math.round(((count * 1000) / chars) * 10) / 10 });
        }
    }
    defaultwordHits.sort((a, b) => b.count - a.count);
    // 密度制在短样本上必然失真，两道闸门缺一不可（实测反例：「他屏住气息，转身出了门。」
    // 12 字里 1 次命中 → 每千字 83 次 → 直接打满 100 分）：
    //   ① 绝对计数下限 3：单个词偶然出现（「屏住气息」是正常写法），绝不算痕迹；
    //   ② 样本下限 800 字：与本项目「密度类指标以章为单位」的纪律一致——polish 逐段
    //      扫描时每段都只有几百字，此时该维归 0，判据留给章级扫描。
    const defaultwordScore = defaultwordCount < 3 || chars < 800
        ? 0
        : densityScore(defaultwordCount, chars, 1, 5);

    const categories = {
        cliche: { score: clicheScore, total: clicheCount, hits: clicheHits.slice(0, topK) },
        stock: { score: stockScore, total: stockCount, hits: stockHits.slice(0, topK) },
        emotion: { score: emotionScore, total: emotionCount, hits: emotionHits.slice(0, topK) },
        template: { score: templateScore, paired: pairedCount, summary: summaryCount, ellipsis, dash, hits: templateHits.filter((h) => h.count > 0).slice(0, topK) },
        structure: { score: structureScore, paraCount: paragraphs.length, avgPara: Math.round(paraLens.reduce((a, b) => a + b, 0) / Math.max(1, paraLens.length)), paraCv: Math.round(paraCv * 100) / 100, sentCv: Math.round(sentCv * 100) / 100 },
        dilution: { score: dilutionScore, bigramRate: Math.round(bigramRate * 1000) / 1000, dePerSentence: Math.round(dePerSent * 10) / 10 },
        formula: { score: formulaScore, endFormula, exclaimShort, exclaimRatio: Math.round(exclaimRatio * 1000) / 1000 },
        defaultword: { score: defaultwordScore, total: defaultwordCount, hits: defaultwordHits.slice(0, topK) },
    };

    const score = Math.round(
        clicheScore * WEIGHTS.cliche + stockScore * WEIGHTS.stock + emotionScore * WEIGHTS.emotion
        + templateScore * WEIGHTS.template + structureScore * WEIGHTS.structure + dilutionScore * WEIGHTS.dilution
        + formulaScore * WEIGHTS.formula + defaultwordScore * WEIGHTS.defaultword
    );
    const level = LEVELS.find(([max]) => score < max)?.[1] ?? '严重';

    const topIssues = buildTopIssues(categories, topK);
    // 短文本置信提示：密度类指标按千字频次换算，几百字的统计噪声大，必须声明。
    if (chars < 1500) topIssues.push(`文本较短（${chars} 字），密度类指标的参考性有限，建议以章为单位扫描`);

    return { score, level, chars, categories, topIssues };
}

function emptyCategories() {
    return {
        cliche: { score: 0, total: 0, hits: [] },
        stock: { score: 0, total: 0, hits: [] },
        emotion: { score: 0, total: 0, hits: [] },
        template: { score: 0, paired: 0, summary: 0, ellipsis: 0, dash: 0, hits: [] },
        structure: { score: 0, paraCount: 0, avgPara: 0, paraCv: 0, sentCv: 0 },
        dilution: { score: 0, bigramRate: 0, dePerSentence: 0 },
        formula: { score: 0, endFormula: false, exclaimShort: 0, exclaimRatio: 0 },
        defaultword: { score: 0, total: 0, hits: [] },
    };
}

/** 人读摘要：按维度分排序给前 topK 条可操作建议。 */
function buildTopIssues(cats, topK) {
    const issues = [];
    if (cats.cliche.score >= 20) issues.push(`模板句 ${cats.cliche.total} 处（如「${cats.cliche.hits[0]?.term ?? ''}」第${cats.cliche.hits[0]?.lines?.[0] ?? '?'}行）——整句重写，不要换词`);
    if (cats.stock.score >= 20) issues.push(`库存词密度过高：${cats.stock.hits.slice(0, 4).map((h) => `${h.term}×${h.count}`).join('、')}`);
    if (cats.emotion.score >= 20) issues.push(`情绪直写 ${cats.emotion.total} 处——改为动作/环境/留白暗示`);
    if (cats.template.score >= 20) {
        const t = cats.template;
        if (t.paired > 0) issues.push(`配对句式 ${t.paired} 处——削减到每章≤1`);
        if (t.summary > 0) issues.push(`段尾升华腔 ${t.summary} 处——删掉「这让/这使得」式总结`);
        if (t.ellipsis >= 5) issues.push(`省略号 ${t.ellipsis} 处——留白不靠标点`);
    }
    if (cats.structure.score >= 40) issues.push(`段落/句长方差过低（paraCv=${cats.structure.paraCv}, sentCv=${cats.structure.sentCv}）——节奏单调，长短段交错`);
    if (cats.dilution.score >= 40) issues.push(`信息稀释：重复 bigram 率 ${cats.dilution.bigramRate}，平均每句 ${cats.dilution.dePerSentence} 个「的」——删冗余修饰`);
    if (cats.formula.score >= 40) {
        const f = cats.formula;
        issues.push(`断章公式${f.endFormula ? '（章末正是「短宣言+叹号」）' : ''}：短叹号句占比 ${Math.round(f.exclaimRatio * 100)}%——至少三分之一章节改为场景收束/对话收束，叹号收尾不算钩子`);
    }
    if (cats.defaultword.score >= 20) {
        // 只报不代改：这些词单个出现都正常，改法是「换成具体的、属于这个人物的动作」，
        // 模型自己换同义词等于没改。
        issues.push(`AI 默认值词 ${cats.defaultword.total} 处：${cats.defaultword.hits.slice(0, 4).map((h) => `${h.term}×${h.count}`).join('、')}——换成具体的、属于这个人物的动作/部位，别用通用款`);
    }
    return issues.slice(0, topK);
}

// ── 「一句一段」占比（structure 维的盲区补充）──────────────────────────────
//
// structure 用段落/句长**变异系数**判节奏单调，但整章都是一句一段、且长短还比较均匀时，
// CV 可能落在正常区（每段都短、方差不大）——「全章碎句」已经发生，CV 却看不见。
// 这里单独量「一句一段」的**占比**，不改 scanAiFlavor 的八维名称/顺序/返回结构：
// novel_noai_scan 的输出 schema 不受影响，新判据由写章链单独消费。
//
// 口径（可解释、便于回放复核）：
//   · 段落 = lib/paragraphs.js 的 splitParagraphs（单换行/空行同权、剔标题行）；
//   · 句数 = 段落内句末标点 [。！？!?…] 的出现次数（「……」连续省略号算 1 次；
//     引号收尾不额外算句，避免「走吧。」被拆成两截而漏判）；
//   · 一句一段 = 句数恰好 1，且非空白字符数 ≤ 40；
//   · 占比 = 命中段 / 总段数。
// 短样本（<15 段）返回 insufficient：polish 逐段调用只有一两段，判据留给章级。
//
// 阈值 0.45 是两本真机书整章回放定的（不入发行面的中性指代）：
//   长篇正常本 49 章：中位 0.136、p95 0.324、max 0.405 → 0/49 触发；
//   碎句本 40 章：中位 0.349、p90 0.448、max 0.519 → 4/40 触发（ch 1/5/8/11，46%–52%）。
// 0.45 高于正常本最大值（0.405）约 11%，又压在碎句本 p90（0.448）之上——只抓
// 「接近半数段落都是一句一段」的极端章；试过 0.35，碎句本 20/40 触发（隔章就报，
// 会挤掉同预算里的其他告警）。改阈值前先重跑这两组回放。
export const ONE_SENTENCE_PARA_RATIO = 0.45;
const ONE_SENTENCE_PARA_MAX_CHARS = 40;
const ONE_SENTENCE_PARA_MIN_PARAGRAPHS = 15;

/**
 * @param text 章节正文
 * @param opts { maxChars?: 单段字数上限, minParagraphs?: 最少段数 }
 * @returns {status:'ok'|'insufficient', ratio, hits, paragraphs, chars}
 */
export function oneSentenceParagraphProfile(text, { maxChars = ONE_SENTENCE_PARA_MAX_CHARS, minParagraphs = ONE_SENTENCE_PARA_MIN_PARAGRAPHS } = {}) {
    const raw = String(text ?? '');
    const chars = raw.replace(/\s/g, '').length;
    const paragraphs = splitParagraphs(raw);
    if (paragraphs.length < minParagraphs) {
        return { status: 'insufficient', ratio: 0, hits: 0, paragraphs: paragraphs.length, chars };
    }
    let hits = 0;
    for (const p of paragraphs) {
        const marks = (p.match(/[。！？!?…]+/g) ?? []).length;
        if (marks === 1 && p.replace(/\s/g, '').length <= maxChars) hits += 1;
    }
    return { status: 'ok', ratio: hits / paragraphs.length, hits, paragraphs: paragraphs.length, chars };
}

// ── 为什么没有「局部句式聚集」扫描（设计决定档案，2026-11-10 撤除）────────────
//
// 曾实现过两类判据并随后全部撤除，数据（本机 17 个书目录、517 章 96.1 万字、
// 先剥成对引号内台词的全口径回放）：
//   · 过渡词聚集（同一过渡词章内 ≥N 次）：11 个候选词 517 章总出现 3 次，
//     章内 ≥2/≥3、同句 ≥2/≥3、相邻两句/三句 ≥3 六种口径触发率全部 0/517；
//   · 句内聚集（缓冲词/动作副词同句合计 ≥N）：≥3 命中 0/517（永不响），
//     ≥2 命中 3/517 且逐条人工判定全是「一种…另一种…」的正常列举。
// 结论按「0% 触发 = 失效」撤除：一个在本机语料上永不响（或响即误报）的告警
// 不配占预算。放宽词表做对照诊断后触发的也全是正常叙述——换词表救不活，
// 要区分「堆叠」与「正常列举」需要语义判断，代码判不了。
// 将来若引入该类判据，必须先在新语料上回放出非零且非 FP 的触发率再动手。
