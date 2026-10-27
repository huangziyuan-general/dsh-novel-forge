// lib/noai-cross.js — **跨章** AI 味频次判据（纯函数，零 IO、零模型调用）。
//
// 补的是本项目 noai 八维**全都看不见**的那一类病：八维全是「本章内」判据
// （单一意象 ≤1 次/千字、重复桥段全书 ≤2 次、同一标志小动作 ≤8 次/全书……）。
// 单章干净、连着几十章同一个腔调，八维一律满分——那是长篇最典型的 AI 味，
// 也是读者弃书的主要理由（"每章都在讲道理""同一个动作从头用到尾"）。
//
// 五条判据（阈值来自竞品 B 的量化硬指标，口径按本项目自己的数据形态调整）：
//   ① 标志小动作：同一动作在书里反复出现（默认全书 ≤8 次，按取样范围折算）
//   ② 重复桥段：与前文某章撞场（8 字 shingle 重合率 ≥30%），全书 ≤2 次且间隔 ≥3 章
//   ③ 格言式收尾：以一句总结收场，全书 ≤3 次，且相邻两章不许同型
//   ④ 单一意象：某个意象在**本章**里的密度超过 1 次/千字
//   ⑤ 「不是A是B」句式：本章 ≤2 处
//
// 与八维的关系：**只报不拦**（和 noai 一样是证据不是判决），且不改八维的分数与权重
// （WEIGHTS 恒为 1 的那条测试红线不许动）。跨章判据的结论由写章链收进 warnings，
// 让模型在落盘回执里看见并可改。
//
// 纯函数（AGENTS.md 不变量 2）：不碰 io、不取钟、不写文件。

import lexicon from './data/noai-lexicon.json' with { type: 'json' };
import { repeatedPhrases } from './library.js';

/** 判据默认阈值（可被调用方覆盖）。 */
export const CROSS_DEFAULTS = {
    /** 同一标志小动作：全书上限（按取样范围折算）。 */
    gestureMax: 8,
    /** 重复桥段：全书上限。 */
    bridgeMax: 2,
    /** 两次重复桥段之间至少隔几章。 */
    bridgeGap: 3,
    /** 判定「撞场」的 8 字 shingle 重合率阈值。 */
    bridgeJaccard: 0.30,
    /** 格言式收尾：全书上限。 */
    aphorismMax: 3,
    /** 单一意象密度：每千字上限。 */
    imagePer1k: 1,
    /** 「不是A是B」句式：每章上限。 */
    notAisBMax: 2,
};

/** 虚词字符：含它们的 n-gram 不算「意象」（多是「他的」「一个」这类功能串）。 */
const FUNCTION_CHARS = '的了着是在有个一不很都也就还们这那我你他她它和与及或把被让给对从向到于之其所以但而上下里中';

/** 格言式收尾的标志词（命中其一 + 长度达标 + 不是对话收尾 → 判为格言式收尾）。 */
const APHORISM_RE = /(原来|所谓|这才(是|叫)|这就是|不过是|只不过|从今以后|往后余生|人生|命运|道理|答案|生来|注定)/;

function countAll(text, needle) {
    let count = 0;
    let idx = text.indexOf(needle);
    while (idx !== -1) { count += 1; idx = text.indexOf(needle, idx + needle.length); }
    return count;
}

function shingles(text, k = 8) {
    const clean = String(text ?? '').replace(/\s/g, '');
    const set = new Set();
    for (let i = 0; i <= clean.length - k; i += 1) set.add(clean.slice(i, i + k));
    return set;
}

function jaccard(a, b) {
    if (a.size === 0 || b.size === 0) return 0;
    let inter = 0;
    for (const x of a) if (b.has(x)) inter += 1;
    return inter / (a.size + b.size - inter);
}

/**
 * 章末是不是「格言式收尾」（一句总结收场）。
 * 判据三条同时成立：末段最后一句 · 不是对话 · 长度 6–30 字 · 命中格言标志词。
 * 「原来是他」这种反转句不算（太短、不是总结）。
 */
export function isAphorismEnding(text) {
    const paras = String(text ?? '').split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p !== '');
    const last = paras[paras.length - 1] ?? '';
    if (last === '') return false;
    const sents = last.split(/[。！？!?…]+/).map((s) => s.trim()).filter((s) => s !== '');
    const lastSent = sents[sents.length - 1] ?? '';
    if (lastSent === '') return false;
    if (/[「『“"]/.test(lastSent)) return false;   // 对话收尾不算格言
    const clean = lastSent.replace(/\s/g, '');
    if (clean.length < 5 || clean.length > 30) return false;
    return APHORISM_RE.test(clean);
}

/**
 * 叙述段里的高频意象（去掉对话行——对话里重复的人名与口头语是自然的，不是意象）。
 */
export function topImages(content, { minCount = 3, limit = 5 } = {}) {
    const narration = String(content ?? '')
        .split('\n')
        .filter((l) => !/[「『“"]/.test(l))
        .join('\n');
    if (narration.replace(/\s/g, '').length < 60) return [];
    return repeatedPhrases(narration, { minLen: 3, maxLen: 4, minCount, limit: 20 })
        .filter((x) => ![...x.term].some((ch) => FUNCTION_CHARS.includes(ch)))
        .slice(0, limit);
}

/**
 * 跨章频次判据（主入口，纯函数）。
 *
 * @param content   本章正文
 * @param chapter   本章章号（只用于文案）
 * @param history   已写章节 [{chapter, content}]——传多少章就算多少章的取样范围
 * @param options   阈值覆盖 + totalChapters（全书已写章数，用于把「全书 ≤N 次」
 *                  折算到取样范围上：取样 20 章 / 全书 100 章 → 上限按 1/5 折算）
 * @returns {{issues:string[], metrics:object}}
 */
export function crossChapterFlavor({ content = '', chapter = 0, history = [], options = {} } = {}) {
    const opt = { ...CROSS_DEFAULTS, ...options };
    const text = String(content ?? '');
    const past = (history ?? [])
        .filter((h) => h !== null && typeof h === 'object' && typeof h.content === 'string')
        .sort((a, b) => (a.chapter ?? 0) - (b.chapter ?? 0));
    const scope = past.length + 1;
    const total = Math.max(scope, Number.isInteger(opt.totalChapters) && opt.totalChapters > 0 ? opt.totalChapters : scope);

    const issues = [];
    const metrics = { scope, total };
    // 阈值折算：默认阈值按「取样范围 / 全书」缩放（取样 20 章、全书 100 章 → 上限按 1/5），
    // 并设下限兜底（样本少时别把上限折成 0，那样任何一次命中都成噪声）。
    // 调用方**显式给了阈值就照办**（不折算、不兜底）——调用方说了算。
    const explicit = new Set(Object.keys(options ?? {}));
    const scaled = (key, floor) => {
        const base = opt[key];
        if (explicit.has(key)) return base;
        return Math.max(floor, Math.round((base * scope) / total));
    };

    // ① 标志小动作：同一动作在取样范围里反复出现
    const gestureLimit = scaled('gestureMax', 2);
    const gestureCounts = [];
    for (const term of lexicon.gesture ?? []) {
        let n = countAll(text, term);
        for (const h of past) n += countAll(h.content, term);
        if (n > 0) gestureCounts.push({ term, count: n });
    }
    gestureCounts.sort((a, b) => b.count - a.count);
    for (const g of gestureCounts) {
        if (g.count > gestureLimit) {
            issues.push(`同一标志小动作「${g.term}」在近 ${scope} 章里出现 ${g.count} 次（按全书折算上限 ${gestureLimit} 次）`
                + '——换个属于这个人物的动作，别让全书都靠它');
        }
    }
    metrics.gesture = { limit: gestureLimit, top: gestureCounts.slice(0, 3) };

    // ② 重复桥段：与前文某章撞场
    const bridgeLimit = scaled('bridgeMax', 1);
    const mine = shingles(text);
    const bridges = [];
    for (const h of past) {
        const j = jaccard(mine, shingles(h.content));
        if (j >= opt.bridgeJaccard) bridges.push({ chapter: h.chapter ?? 0, jaccard: Math.round(j * 1000) / 1000 });
    }
    if (bridges.length > bridgeLimit) {
        issues.push(`重复桥段：与第${bridges.map((b) => b.chapter).join('、')}章的 8 字重合率 ≥${Math.round(opt.bridgeJaccard * 100)}%`
            + `（全书折算上限 ${bridgeLimit} 次）——这几章撞的是同一场戏，换个场景或换个切入点`);
    }
    // 间隔判定：**本章**也是一次撞场，必须跟最近那次撞场比距离；
    // 撞场彼此之间也要拉开距离（B 指标原文：「重复桥段 ≤2 次/全书且间隔 ≥3 章」）。
    const ordered = [...bridges].sort((a, b) => (a.chapter ?? 0) - (b.chapter ?? 0));
    const lastHit = ordered[ordered.length - 1];
    if (lastHit !== undefined && (chapter - (lastHit.chapter ?? 0)) < opt.bridgeGap) {
        issues.push(`重复桥段间隔过近：第${lastHit.chapter}章与本章只隔 ${chapter - (lastHit.chapter ?? 0)} 章`
            + `（要求 ≥${opt.bridgeGap} 章）——连着两章演同一场戏，读者会直接弃书`);
    } else {
        for (let i = 1; i < ordered.length; i += 1) {
            const gap = (ordered[i].chapter ?? 0) - (ordered[i - 1].chapter ?? 0);
            if (gap < opt.bridgeGap) {
                issues.push(`重复桥段间隔过近：第${ordered[i - 1].chapter}章与第${ordered[i].chapter}章只隔 ${gap} 章`
                    + `（要求 ≥${opt.bridgeGap} 章）——连着两章演同一场戏，读者会直接弃书`);
                break;
            }
        }
    }
    metrics.bridge = { limit: bridgeLimit, hits: bridges };

    // ③ 格言式收尾：全书次数 + 相邻两章同型
    const aphorismLimit = scaled('aphorismMax', 2);
    const aphorismChapters = past.filter((h) => isAphorismEnding(h.content)).map((h) => h.chapter ?? 0);
    const currentAphorism = isAphorismEnding(text);
    const aphorismTotal = aphorismChapters.length + (currentAphorism ? 1 : 0);
    if (aphorismTotal > aphorismLimit) {
        issues.push(`格言式收尾已出现 ${aphorismTotal} 次（近 ${scope} 章内，全书折算上限 ${aphorismLimit} 次）`
            + '——每章都以一句总结收场，读者会觉得每章都在讲道理；换成场景收束或对话收束');
    }
    if (currentAphorism && past.length > 0) {
        const prev = past[past.length - 1];
        if (isAphorismEnding(prev.content)) {
            issues.push(`连续两章都是格言式收尾（第${prev.chapter ?? 0}章 → 本章）——相邻两章的收尾要换型`);
        }
    }
    metrics.aphorism = { limit: aphorismLimit, total: aphorismTotal, current: currentAphorism };

    // ④ 单一意象：本章内的意象密度上限（1 次/千字）
    const narrationChars = text.split('\n').filter((l) => !/[「『“"]/.test(l)).join('').replace(/\s/g, '').length;
    const imageLimit = Math.max(2, Math.floor((narrationChars / 1000) * opt.imagePer1k));
    const images = topImages(text, { minCount: 3 });
    for (const img of images) {
        if (img.count > imageLimit + 1) {
            issues.push(`单一意象「${img.term}」本章出现 ${img.count} 次（上限约 ${imageLimit} 次/千字）`
                + '——同一个意象反复用，读者的注意力会被磨平；换一个意象或让它只出现一次');
            break;
        }
    }
    metrics.image = { limit: imageLimit, top: images.slice(0, 3) };

    // ⑤ 「不是A是B」句式：每章 ≤2 处
    const notAisB = text.match(/不是[^。！？\n]{1,24}[，,]\s{0,2}(?:而是|是)/g) ?? [];
    if (notAisB.length > opt.notAisBMax) {
        issues.push(`「不是A是B」句式本章 ${notAisB.length} 处（上限 ${opt.notAisBMax} 处/章）`
            + '——这种转折句用多了就是腔调，直接陈述更利落');
    }
    metrics.notAisB = { count: notAisB.length, limit: opt.notAisBMax };

    return { issues, metrics };
}
