// lib/library.js — 书库（外部小说「饲料」）的切分与结构分析（纯函数，零 token 零依赖）。
//
// 书库解决的是「**学别人怎么写**」，不是「把自己这本写下去」。所以这里只做两件事：
// 把外部小说切成一章一章，再把**可参照的数字**算出来——章节长度曲线 / 对话密度 /
// 段落节奏 / 章末钩子率 / 高频意象。把「凭感觉学」换成「照着自己的数调」。
//
// 边界：书库是**只读饲料**。它不参与一致性判定（对照标准是别人，不是本书），
// 也不进上下文包——上下文包只喂自己书里的东西。

import { splitIntoChapters } from './import.js';
import { detectHookKind } from './hook.js';

/** 书库落点：工作区根下的 `书库/`，与各书目平级——多本书共享同一批饲料。 */
export const LIBRARY_DIR = '书库';
export const LIBRARY_INDEX = `${LIBRARY_DIR}/library.json`;
export const workDir = (id) => `${LIBRARY_DIR}/${id}`;
export const sourcePath = (id) => `${LIBRARY_DIR}/${id}/原文.txt`;

/** 一轮导入最多接受的字符数——挡「误把整本合集倒进来」导致的卡顿。 */
export const MAX_SOURCE_CHARS = 3_000_000;

/** 作品 id：由标题净化而来（禁路径分隔符等），同一标题只允许一份。 */
export function libraryId(title) {
    const raw = String(title ?? '').trim();
    if (raw === '') throw new Error('作品名不能为空');
    const id = raw.replace(/[\\/:*?"<>|\s]+/g, '_').replace(/^\.+/, '').slice(0, 64);
    if (id === '') throw new Error(`作品名不合法：「${raw}」`);
    return id;
}

const round = (n, digits = 3) => Number.isFinite(n) ? Number(n.toFixed(digits)) : 0;
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const mean = (xs) => (xs.length === 0 ? 0 : sum(xs) / xs.length);

/** 中位数（偶数个取中间两个的均值）。 */
function median(xs) {
    if (xs.length === 0) return 0;
    const s = [...xs].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** 变异系数（标准差/均值）——衡量「章节长度忽长忽短」的程度，0 = 完全均匀。 */
export function coefficientOfVariation(xs) {
    if (xs.length < 2) return 0;
    const m = mean(xs);
    if (m === 0) return 0;
    const variance = mean(xs.map((x) => (x - m) ** 2));
    return round(Math.sqrt(variance) / m);
}

const DIALOGUE_RE = /["“][^"”]*["”]|「[^」]*」/g;
const SENTENCE_SPLIT = /[。！？!?…]+/;
const NOISE_RE = /[\s\d\p{P}\p{S}]/gu;

/** 单章结构指标（纯函数，正文进、数字出）。 */
export function chapterMetrics(text) {
    const src = String(text ?? '');
    const chars = src.replace(/\s/g, '').length;
    const paragraphs = src.split(/\n+/).filter((p) => p.trim() !== '').length;
    const dialogueChars = (src.match(DIALOGUE_RE) ?? []).join('').replace(/\s/g, '').length;
    const sentences = src.split(SENTENCE_SPLIT).map((s) => s.replace(/\s/g, '')).filter((s) => s !== '');
    const hookKind = detectHookKind(src);
    return {
        chars,
        paragraphs,
        dialogueChars,
        dialogueRatio: chars === 0 ? 0 : round(dialogueChars / chars),
        sentenceCount: sentences.length,
        meanSentence: round(mean(sentences.map((s) => s.length)), 1),
        // null = 末段没检出钩子（问句/省略/悬念/感叹四类中一个都没中）
        hookKind,
    };
}

/**
 * 重复短语挖掘——「这个作者爱用什么词」。
 *
 * 不做分词（无依赖可用，且中文分词器对网文特有名词反而更差），改用
 * 3–4 字 n-gram 频次：只留出现 ≥minCount 次的，再去掉被更长的高频串**包含**的结果
 * （「青铜古灯」留下时就不必再报「青铜古」「青古灯」）。
 */
export function repeatedPhrases(text, { minLen = 3, maxLen = 4, minCount = 3, limit = 15 } = {}) {
    const clean = String(text ?? '').replace(NOISE_RE, '');
    if (clean.length < minLen) return [];
    const counts = new Map();
    for (let len = minLen; len <= maxLen; len += 1) {
        for (let i = 0; i + len <= clean.length; i += 1) {
            const s = clean.slice(i, i + len);
            counts.set(s, (counts.get(s) ?? 0) + 1);
        }
    }
    const candidates = [...counts.entries()]
        .filter(([, c]) => c >= minCount)
        .sort((a, b) => (b[0].length - a[0].length) || (b[1] - a[1]) || a[0].localeCompare(b[0]));
    const kept = [];
    for (const [term, count] of candidates) {
        // 已由更长的串代表（含：被包含，或是周期串的**错位窗口**——
        // 「青铜古灯」重复三次会顺带产生「古灯青铜」「灯青铜古」，后者在 (k+k) 里必然出现）
        if (kept.some(([k]) => k.includes(term) || (term.length <= k.length && `${k}${k}`.includes(term)))) continue;
        kept.push([term, count]);
    }
    return kept.sort((a, b) => b[1] - a[1]).slice(0, limit).map(([term, count]) => ({ term, count }));
}

/**
 * 整部作品的结构画像。
 *
 * @param chapters [{title, content}]——书库的切分结果，或自家书的逐章正文，
 *   两边喂同一个函数才能**并排比**（这是 compareStructures 的前提）。
 */
export function analyzeStructure(chapters) {
    const list = (chapters ?? []).filter((c) => typeof c?.content === 'string' && c.content.trim() !== '');
    const per = list.map((c) => ({ title: c.title ?? '', ...chapterMetrics(c.content) }));
    const lengths = per.map((c) => c.chars);
    const totalChars = sum(lengths);
    const dialogueChars = sum(per.map((c) => c.dialogueChars));
    const hooks = per.filter((c) => c.hookKind !== null);
    const hookKinds = {};
    for (const c of hooks) hookKinds[c.hookKind] = (hookKinds[c.hookKind] ?? 0) + 1;
    const paragraphCounts = per.map((c) => c.paragraphs);
    const allText = list.map((c) => c.content).join('\n');
    return {
        chapters: per.length,
        chars: totalChars,
        length: {
            mean: Math.round(mean(lengths)),
            median: Math.round(median(lengths)),
            min: lengths.length === 0 ? 0 : Math.min(...lengths),
            max: lengths.length === 0 ? 0 : Math.max(...lengths),
            cv: coefficientOfVariation(lengths),
        },
        // 对话密度：引号内字符占全文比——「靠对话推进」还是「靠叙述推进」的粗略代理
        dialogueRatio: totalChars === 0 ? 0 : round(dialogueChars / totalChars),
        paragraph: {
            mean: round(mean(paragraphCounts), 1),
            max: paragraphCounts.length === 0 ? 0 : Math.max(...paragraphCounts),
        },
        // 章末钩子率：网文追读的关键指标，自家书低于对标作品就该查末段写法
        hookRate: per.length === 0 ? 0 : round(hooks.length / per.length),
        hookKinds,
        topPhrases: repeatedPhrases(allText),
        freeform: {
            // 前 3 章平均长度——番茄式「前几章定生死」的粗略参照
            firstThreeMean: Math.round(mean(lengths.slice(0, 3))),
            // 单句均长：越长越容易「读着累」
            meanSentence: round(mean(per.map((c) => c.meanSentence).filter((n) => n > 0)), 1),
        },
        perChapter: per,
    };
}

/** 从整篇文本切章（书库导入用；复用正文导入同一套标题识别）。 */
export function chaptersFromText(text) {
    return splitIntoChapters(text).map((c) => ({ title: c.title, content: c.content }));
}

/** 并排对比：自己 vs 对标。只给**能直接照着调**的项，不做评分。 */
export function compareStructures(mine, theirs) {
    const rows = [
        { label: '章数', mine: mine.chapters, theirs: theirs.chapters },
        { label: '平均章长（字）', mine: mine.length.mean, theirs: theirs.length.mean },
        { label: '中位章长（字）', mine: mine.length.median, theirs: theirs.length.median },
        { label: '最短/最长章（字）', mine: `${mine.length.min}/${mine.length.max}`, theirs: `${theirs.length.min}/${theirs.length.max}` },
        { label: '长度波动 cv', mine: mine.length.cv, theirs: theirs.length.cv },
        { label: '对话密度', mine: mine.dialogueRatio, theirs: theirs.dialogueRatio },
        { label: '平均段数/章', mine: mine.paragraph.mean, theirs: theirs.paragraph.mean },
        { label: '章末钩子率', mine: mine.hookRate, theirs: theirs.hookRate },
        { label: '单句均长（字）', mine: mine.freeform.meanSentence, theirs: theirs.freeform.meanSentence },
    ];
    return rows;
}

/** 结构画像的紧凑摘要行（工具渲染用）。 */
export function structureDigest(a, name = '本书') {
    return [
        `${name}：${a.chapters} 章 / ${a.chars} 字`,
        `章长 均值 ${a.length.mean} 中位 ${a.length.median}（${a.length.min}–${a.length.max}）波动 ${a.length.cv}`,
        `对话密度 ${(a.dialogueRatio * 100).toFixed(1)}% · 章末钩子率 ${(a.hookRate * 100).toFixed(0)}% · 单句均长 ${a.freeform.meanSentence} 字`,
    ].join('\n');
}
