// lib/milestone.js — 全书大纲「卷规划节点」台账：本章该对齐哪个节点、哪些节点已逾期。
//
// 为什么另起一个模块，而不是继续调 outlineDivergence：
// 那道闸问的是「细纲措辞像不像本卷规划段」，判据是 2-gram 重合度 + 概念词命中率。
// 真机连载本实测 46 章只报 1 次——卷规划段里「第 X-Y 章」的章号 bigram、以及「的/是/在」
// 这类虚词组合，在细纲里同样高频，把命中率垫到阈值之上；而真相是「据点连拔」「并发档位」
// 「结契」这类里程碑**整段没写**——措辞相似度看不出「没写」，只看得出「写得不像」。
//
// 本模块换个问法：不比措辞，按**章号区间**判定里程碑有没有被正文兑现过。
// 输出是「摊开 + 标记可疑」，不做终审（与 continuity 的人工核清单同一口径）：
// 零命中的短概念词只是欠账候选，措辞换了说法、或作者有意改线，都可能零命中。
//
// 已知边界：功能字分隔符会把实体词内的同形字一并劈开（真机验证实证「并发 8→32」整词
// 消失），固定度量词走 PROTECTED_TERMS 保护表整词摘出还原；大纲括号里的元注释
//（换图钩子/伏笔类）进 STOP_TERMS，不冒充情节点。

import { volumeRange } from './gate.js';

/** 节点文本切成概念词的分隔符：标点、箭头、以及把长句劈开的虚词。 */
// 说明：虚词集刻意不含「无/未/已/会/能/要/就/都」——它们在人名与专名里常见
// （「某角色名」「未能」「就会」），当分隔符会把实体词劈成碎片，反而制造假欠账。
const SPLIT = /[、，,。；;：:（）()【】\[\]<>《》→←\-—~～\/|\\\s"'“”‘’]+|[被欲将把让使给并而其之的是在与和及或以于则且但若如因所由从向对]/g;

/** 概念词里的结构词：只起连接作用，零命中不构成欠账信号。 */
const STOP_TERMS = new Set([
    '章节', '本章', '全书', '本卷', '以下', '以上', '期间', '前后', '进行', '开始', '继续', '完成',
    '之一', '部分', '内容', '情节', '故事', '阶段', '主线', '支线', '以及', '或者', '然后', '最后',
    '其中', '分别', '主要', '相关', '各种', '一个', '两个', '三个', '名场', '场面',
    // 元注释词：大纲里写「（约第 6 章换图钩子）」「埋伏笔」是写作指令不是情节点，
    // 章号剥掉后残留的元词不进欠账清单（真机验证 2026-10-25：换图钩子被记成欠账）。
    '钩子', '换图钩子', '伏笔', '收线', '埋线', '换图',
    // 界域名：只是卷标题前缀（「凡界（第 1-60 章…）」），不是可兑现的章节点——
    // 留着会让每一章都报「凡界/仙界 尚未兑现」的噪声，挤掉真正的欠账信号（档位词要留）。
    '凡界', '人仙界', '仙界', '神界',
]);

/**
 * 从全书大纲解析卷规划节点。
 *
 * 认两种形状（与大纲的通行写法对齐）：
 *   `### 卷一 · XX（第 1-60 章，…）`  卷头，带区间
 *   `- 第 31-50 章：蚀全面反扑→…`      条目，自带区间时以条目为准
 * 条目没有自己的章号区间时，回落到所属卷的区间。
 */
export function parseMilestones(bookOutline) {
    const lines = String(bookOutline ?? '').split('\n');
    const nodes = [];
    let vol = null;
    for (const raw of lines) {
        const line = raw.trim();
        if (line === '') continue;
        // 只有「卷」标题设卷；其它标题（「## 六、写作纪律」之类）一律清卷——
        // 不清的话纪律段的条目会被挂到最后一条卷区间上，凭空多出一批假节点。
        if (/^#{1,6}(?:$|\s|[^#])/.test(line)) {
            const isVolume = /^#{2,6}\s*卷/.test(line);
            vol = isVolume ? volumeRange(line) : null;
            // 卷头自己也是一个节点：并发标尺那类全局指标常只写在卷标题里
            //（「卷一 · 凡界（第 1-60 章，并发 8→三千）」），不收条目就永远看不到。
            if (isVolume && vol !== null) {
                // 「卷一 · 凡界」这种卷序前缀不是概念，剥掉——留着会让每章都报「卷一」欠账。
                const title = line.replace(/^#{2,6}\s*/, '').replace(/^卷[一二三四五六七八九十\d]+\s*[·•:：\-\s]*/, '');
                nodes.push({ from: vol.from, to: vol.to, text: title });
            }
            continue;
        }
        if (!/^[-*]\s+/.test(line)) continue;
        const body = line.replace(/^[-*]\s+/, '');
        const open = /^第\s*(\d+)\s*章\s*(?:起|开始|往后)(?=$|[\s。．.，,、:：)）])(?:[\s。．.，,、:：)）]\s*(.*))?$/.exec(body);
        const closed = open === null
            ? /^第\s*(\d+)\s*(?:[-–—~]\s*(\d+))?\s*章(?=$|[\s:：，,。])(?:[\s:：，,。]\s*(.*))?$/.exec(body)
            : null;
        const m = open ?? closed;
        if (m !== null) {
            const from = Number(m[1]);
            const to = open !== null ? Number.POSITIVE_INFINITY
                : m[2] === undefined ? from : Number(m[2]);
            if (to >= from) nodes.push({ from, to, text: (open !== null ? m[2] : m[3] ?? '').trim() });
            continue;
        }
        // 无心章号的条目：归到所属卷（卷区间缺失时整卷都算，交给调用方按章号过滤）
        if (vol !== null) nodes.push({ from: vol.from, to: vol.to, text: body });
    }
    return nodes.map((n) => ({ ...n, terms: conceptTerms(n.text) }));
}

/**
 * 节点文本 → 概念词。
 *
 * `short`（2-4 字）是实体词（分部 / 立威 / 结契 / 档位 256），零命中才算欠账信号；
 * 超过 4 字的是描述语（「某组织据点连拔」），措辞换了说法很正常，零命中不判——
 * 只留着给模型看它该往哪个方向写。
 */
// 度量词保护表：词内含功能字（并发→被劈成发）的固定词，切分前整词摘出、切分后还原。
// 真机验证 2026-10-25 实证：「并发 8→32」产不出任何概念词，档位无从追踪；需要保护的词
// 随真书语料补充，摘出是整词匹配，不会误伤「合并」「对阵」这类偶合词的其余部分。
const PROTECTED_TERMS = ['并发'];
const PROTECT_RE = new RegExp(`(${PROTECTED_TERMS.join('|')})`, 'g');

export function conceptTerms(text) {
    const out = [];
    const seen = new Set();
    const restored = [];
    const src = String(text ?? '')
        .replace(/第\s*\d+\s*(?:[-–—~]\s*\d+)?\s*章/g, ' ')
        .replace(PROTECT_RE, (_, w) => {
            restored.push(w);
            return `\u0001${restored.length - 1}\u0001`;
        });
    // 「约第 30 章反扑」里的章号已在上面整段摘掉：它既不是概念（正文里出现「第 30 章」
    // 纯属巧合），留着还会把前后文字劈成「约第」「章反扑」两个碎片，污染欠账清单。
    for (const seg of src.split(SPLIT)) {
        const t = seg.trim();
        if (t === '') continue;
        const prot = /^\u0001(\d+)\u0001$/.exec(t);
        if (prot !== null) {
            const w = restored[Number(prot[1])];
            if (!seen.has(w)) { seen.add(w); out.push({ term: w, short: w.length <= 4 }); }
            continue;
        }
        // 纯数字只认三位数以上：「8」「32」在正文里到处都是，「128」才是档位。
        if (/^\d+$/.test(t)) {
            if (t.length < 3 || seen.has(t)) continue;
        } else if (!/^[一-龥A-Za-z0-9]{2,8}$/.test(t) || seen.has(t)) continue;
        if (STOP_TERMS.has(t)) continue;
        seen.add(t);
        out.push({ term: t, short: t.length <= 4 });
    }
    return out;
}

/**
 * 节点台账。
 *
 * @param {object} o
 * @param {string} o.bookOutline 全书大纲正文
 * @param {number} o.chapter     当前章号（即将写的那一章）
 * @param {Array<{n:number,text:string}>} [o.chapters] 已写正文（用于判定兑现；缺省只列不判）
 * @param {string} [o.outlineText] 本章细纲（判定「本章有没有回应本卷节点」）
 */
export function milestoneLedger({ bookOutline, chapter, chapters = null, outlineText = null }) {
    const nodes = parseMilestones(bookOutline);
    const corpus = chapters ?? [];
    const hasOutline = outlineText !== null;
    const rows = nodes.map((n) => {
        const status = chapter > n.to ? 'past' : (chapter >= n.from ? 'active' : 'pending');
        const terms = n.terms.map((t) => {
            const hit = corpus.find((c) => c.text.includes(t.term)) ?? null;
            const inOutline = outlineText !== null && outlineText.includes(t.term);
            return { ...t, hit: hit !== null, hitChapter: hit === null ? null : hit.n, inOutline };
        });
        return { from: n.from, to: n.to, text: n.text, status, terms };
    });
    const active = rows.filter((r) => r.status === 'active' && r.terms.length > 0);
    // 已过区间、且短概念词零命中 = 欠账候选（措辞换了说法也会命中不了，故只摊开不终审）。
    // 当前细纲已经点名过的词不算“未回应”；hit 仍保持“已写正文已兑现”的原语义。
    const overdue = rows
        .filter((r) => r.status === 'past')
        .map((r) => ({
            ...r,
            missed: r.terms.filter((t) => t.short && !t.hit && !t.inOutline).map((t) => t.term),
            planned: r.terms.filter((t) => t.short && !t.hit && t.inOutline).map((t) => t.term),
        }))
        .filter((r) => r.missed.length > 0 || r.planned.length > 0);
    const upcoming = rows.filter((r) => r.status === 'pending').slice(0, 2);
    return { chapter, hasOutline, active, overdue, upcoming, total: rows.length };
}

/**
 * 台账 → 给模型的文本。
 *
 * 顺序刻意是「先说本章该对齐谁，再说欠账」：写细纲的人第一眼要看到的是方向，
 * 欠账是第二位的（它多半要改大纲，不是改本章）。
 */
const DEFAULT_LEDGER_ROWS = 12;
const DEFAULT_LEDGER_TERMS = 8;

function ledgerRange(from, to) {
    return to === Number.POSITIVE_INFINITY ? `第${from}章起` : `第${from}-${to}章`;
}

function clippedTerms(terms, maxTerms) {
    const shown = terms.slice(0, maxTerms);
    const rest = terms.length - shown.length;
    return shown.length === 0 ? '' : shown.join('、') + (rest > 0 ? `（另有 ${rest} 个）` : '');
}

function clippedText(text, maxChars = 40) {
    return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

export function formatLedger(ledger, options = {}) {
    if (ledger.total === 0) return '';
    const maxRows = Math.max(1, Number.isInteger(options.maxRows) ? options.maxRows : DEFAULT_LEDGER_ROWS);
    const maxTerms = Math.max(1, Number.isInteger(options.maxTerms) ? options.maxTerms : DEFAULT_LEDGER_TERMS);
    const out = [];
    if (ledger.active.length > 0) {
        const activeRows = ledger.active.slice(0, maxRows);
        for (const r of activeRows) {
            const planned = r.terms.filter((t) => t.short && !t.hit && t.inOutline).map((t) => t.term);
            const miss = r.terms.filter((t) => t.short && !t.hit && !t.inOutline).map((t) => t.term);
            out.push(`${ledgerRange(r.from, r.to)}（本章落在区间内）：${clippedText(r.text)}`);
            if (planned.length > 0) out.push(`  当前细纲已回应：${clippedTerms(planned, maxTerms)}`);
            if (miss.length > 0) out.push(`  ${ledger.hasOutline ? '本章细纲未回应' : '尚未兑现'}：${clippedTerms(miss, maxTerms)}`);
        }
        if (ledger.active.length > activeRows.length) {
            out.push(`（另有 ${ledger.active.length - activeRows.length} 个活跃节点未展开）`);
        }
    } else {
        out.push(`本卷规划里没有覆盖第${ledger.chapter}章的区间节点——确认大纲的卷界要不要补。`);
    }
    if (ledger.overdue.length > 0) {
        out.push(ledger.hasOutline
            ? '区间的章号已过；按已写正文与当前细纲摊开（欠账候选，也可能是换了说法或有心改线）：'
            : '区间的章号已过、短概念词仍零命中（欠账候选，也可能是换了说法或有心改线）：');
        const overdueRows = ledger.overdue.slice(0, maxRows);
        for (const r of overdueRows) {
            // 带上节点原文：只给零命中的词，模型看不出该补什么；给它整句才知道往哪写。
            const head = clippedText(r.text);
            const missed = clippedTerms(r.missed, maxTerms);
            const planned = clippedTerms(r.planned ?? [], maxTerms);
            const details = [
                missed.length > 0 ? `仍未安排：${missed}` : '',
                planned.length > 0 ? `当前细纲已排补：${planned}` : '',
            ].filter(Boolean).join('；');
            out.push(`  ${ledgerRange(r.from, r.to)}：${details}　← 节点原文「${head}」`);
        }
        if (ledger.overdue.length > overdueRows.length) {
            out.push(`（另有 ${ledger.overdue.length - overdueRows.length} 个逾期节点未展开）`);
        }
    }
    if (ledger.upcoming.length > 0) {
        out.push(`后续节点：${ledger.upcoming.map((r) => `${ledgerRange(r.from, r.to)} ${r.text.slice(0, 20)}`).join('；')}`);
    }
    return out.join('\n');
}
