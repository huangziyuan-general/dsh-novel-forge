// lib/noai.js — 结构性去 AI 味扫描（纯函数，零模型调用、零费用）。
//
// 六维判定（对齐社区插件的分类学，并补足它们没做的结构指标）：
//   cliche    模板句命中（词库，出现即计）
//   stock     库存词密度（千字频次）
//   emotion   情绪直写（telling 而非 showing）
//   template  句式模板 + 省略号/破折号滥用 + 段尾升华腔
//   structure 段落/句长方差过低 = 节奏单调（结构性指标，词库抓不住的那类）
//   dilution  信息稀释（重复 bigram 率 + 「的」密度）
//
// 每维 0-100（越高越 AI），总分加权。所有阈值是启发式，
// 用真实样本校准；判定结果永远只是「证据」，不是判决。

import lexicon from './data/noai-lexicon.json' with { type: 'json' };

const WEIGHTS = { cliche: 0.2, stock: 0.15, emotion: 0.15, template: 0.2, structure: 0.18, dilution: 0.12 };
const LEVELS = [[20, '清爽'], [40, '轻微'], [60, '明显'], [Number.POSITIVE_INFINITY, '严重']];

function clamp01(x) { return Math.max(0, Math.min(1, x)); }

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
    for (const phrase of lexicon.cliche) {
        let count = 0;
        const lines = [];
        let idx = raw.indexOf(phrase);
        while (idx !== -1) {
            count += 1;
            if (lines.length < 3) lines.push(lineOf(raw, idx));
            idx = raw.indexOf(phrase, idx + phrase.length);
        }
        if (count > 0) { clicheCount += count; clicheHits.push({ term: phrase, count, lines }); }
    }
    clicheHits.sort((a, b) => b.count - a.count);
    const clicheScore = densityScore(clicheCount, chars, 0.8, 6);

    // ② stock：库存词千字密度。
    const stockHits = [];
    let stockCount = 0;
    for (const term of lexicon.stock) {
        const count = countAll(raw, term);
        if (count > 0) { stockCount += count; stockHits.push({ term, count, per1k: Math.round(((count * 1000) / chars) * 10) / 10 }); }
    }
    stockHits.sort((a, b) => b.count - a.count);
    const stockScore = densityScore(stockCount, chars, 6, 22);

    // ③ emotion：情绪直写。
    const emotionHits = [];
    let emotionCount = 0;
    const emotionPatterns = [...lexicon.emotion.patterns, ...lexicon.emotion.singles.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))];
    for (const pat of emotionPatterns) {
        const re = new RegExp(pat, 'g');
        let m = re.exec(raw);
        while (m !== null) {
            emotionCount += 1;
            if (emotionHits.length < topK * 2) emotionHits.push({ match: m[0], line: lineOf(raw, m.index) });
            m = re.exec(raw);
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
        if (count > 0) { pairedCount += count; templateHits.push({ term: p.name, count }); }
    }
    const summaryHits = [];
    let summaryCount = 0;
    for (const p of lexicon.templates.summaryPatterns) {
        const matches = raw.match(new RegExp(p.regex, 'g')) ?? [];
        if (matches.length > 0) { summaryCount += matches.length; summaryHits.push({ term: p.name, count: matches.length }); }
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
    const paragraphs = raw.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p.length > 0);
    const paraLens = paragraphs.map((p) => p.replace(/\s/g, '').length);
    const sentences = raw.split(/[。！？!?…]+/).map((s) => s.trim()).filter((s) => s.length > 0);
    const sentLens = sentences.map((s) => s.replace(/\s/g, '').length);
    const paraCv = coefficientOfVariation(paraLens);
    const sentCv = coefficientOfVariation(sentLens);
    const structureScore = Math.round(scoreFromCv(paraCv) * 0.6 + scoreFromCv(sentCv) * 0.4);

    // ⑥ dilution：重复 bigram 率 + 「的」密度。
    const clean = raw.replace(/\s/g, '');
    const bigrams = new Map();
    for (let i = 0; i < clean.length - 1; i += 1) {
        const bg = clean.slice(i, i + 2);
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

    const categories = {
        cliche: { score: clicheScore, total: clicheCount, hits: clicheHits.slice(0, topK) },
        stock: { score: stockScore, total: stockCount, hits: stockHits.slice(0, topK) },
        emotion: { score: emotionScore, total: emotionCount, hits: emotionHits.slice(0, topK) },
        template: { score: templateScore, paired: pairedCount, summary: summaryCount, ellipsis, dash, hits: templateHits.filter((h) => h.count > 0).slice(0, topK) },
        structure: { score: structureScore, paraCount: paragraphs.length, avgPara: Math.round(paraLens.reduce((a, b) => a + b, 0) / Math.max(1, paraLens.length)), paraCv: Math.round(paraCv * 100) / 100, sentCv: Math.round(sentCv * 100) / 100 },
        dilution: { score: dilutionScore, bigramRate: Math.round(bigramRate * 1000) / 1000, dePerSentence: Math.round(dePerSent * 10) / 10 },
    };

    const score = Math.round(
        clicheScore * WEIGHTS.cliche + stockScore * WEIGHTS.stock + emotionScore * WEIGHTS.emotion
        + templateScore * WEIGHTS.template + structureScore * WEIGHTS.structure + dilutionScore * WEIGHTS.dilution
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
    return issues.slice(0, topK);
}
