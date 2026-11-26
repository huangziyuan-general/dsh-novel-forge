// lib/outline-align.js — 细纲对齐行强制（纯函数，零 IO、零模型调用）。
//
// 细纲必须引用全书大纲的卷段（对齐行），否则全书大纲对新细纲失去约束力——细纲
// 自由生长就会长成另一本书。三重锚（承诺书/大纲/logline）都在场，但「对齐行必写」
// 此前只是工具描述里的一句提示词（「align 的结论要落到细纲里」），纯靠模型自觉——
// 正是设计主线反对的那类约束，本模块把它做成机判结构。
//
// 本模块把「对齐行」做成可机判的结构：
//   · 细纲必须含一行「对齐：卷X · <卷段标题或节点>」（「本章定位：…」同认）——
//     这行就是细纲引用全书大纲卷段的机器锚点；
//   · 该行须**命中本章所在卷的标题词**（卷序词「卷一」或卷标题词「凡界」任一）——
//     写「对齐：卷一」而本章实际在卷三 = 没对齐（照抄上一行是漂移最常见形态）；
//   · 全书大纲没有可解析的卷结构（volumeSection 判不出）→ 本检查不适用（无基准可比，
//     与既有 divergence 判据同口径静默跳过）。
//
// 分档接法（调用方 outline-tool）：与「## 本章必写场景」契约段同一先例——
// strict（新建书默认）缺失/不命中直接驳回；warn（存量书缺省）不拒稿但留痕。

import { volumeRange } from './gate.js';

// 对齐关键词族（某连载本 162 章实测的真书写法：对齐说明 / 对齐大纲 / 对齐声明 / 本卷对齐 /
// 本章对齐 / 大纲对齐 / 卷段对齐 都出现过）。交替式按「长的在前」排——JS 交替从左试，
// 若 `对齐` 排前会要求其后紧跟冒号，遇「对齐说明」的「说」失败才回退，把长词列前更稳。
export const ALIGN_KEYWORDS = [
    '本章定位', '卷纲对齐', '全书大纲对齐', '大纲对齐', '本章对齐', '本卷对齐',
    '对齐说明', '对齐声明', '对齐大纲', '对齐与欠账', '卷段对齐', '对应', '对齐',
];

// 行式对齐：行首（允许 列表符 / 序号 / 加粗 前缀）以任一关键词 + 冒号起头、冒号后须有内容。
// 关键词后可跟一个括注（「卷段对齐（71–120 郡城风云）：…」），括注常载卷标题/区间，
// 故**保留**进对齐文本（group1），不当噪声剥掉。不设字数上限——旧版 `.{0,60}$` 把
// 100+ 字的真对齐行整段截掉，卷序词常在被截掉的后半。group2 = 冒号后的对齐陈述。
export const ALIGN_LINE_RE = new RegExp(
    '^\\s*(?:[-*]\\s*|\\d+[.、]\\s*)?'
    + '(?:\\*\\*)?'
    + `(?:${ALIGN_KEYWORDS.join('|')})`
    + '(?:\\*\\*)?'
    + '((?:（[^（）]*）|\\([^()]*\\))?)\\s*'   // group1：关键词后的括注（可空）
    + '[:：]\\s*(\\S.*)$'                        // group2：对齐陈述
);

// 段标题式对齐：`## 本章定位` / `## 全书大纲对齐` / `## 卷段对齐（…）` 等小节。
// 卷序词常落在标题尾注或该节首行正文里，故 findAlignLine 收集「标题尾注 + 该节前几行」作对齐文本。
const ALIGN_HEADING_RE = new RegExp(
    '^\\s*#{1,6}\\s*(?:' + ALIGN_KEYWORDS.join('|') + ')\\s*[:：]?\\s*(.*)$'
);

/** 抽某行卷头（`## 卷X · 标题` 形状）的卷序词与标题词。无卷序词（解析不出区间）返回 null。 */
export function volumeHeadingWords(headerLine) {
    const vol = volumeRange(String(headerLine ?? ''));
    if (vol === null) return null;
    // 卷序词：认卷头**实写**的「卷X」（作者对齐行照抄的就是这个写法，比区间推导更准）；
    // 没写卷序才从区间起章号推导（「第 N 章起」/ 一~十 中文序数）。
    let volumeNo = '';
    const written = String(headerLine).match(/卷[一二三四五六七八九十\d]+/);
    if (written !== null) volumeNo = written[0];
    else {
        const CN = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
        const idx = vol.from - 1;
        volumeNo = (idx >= 0 && idx < CN.length) ? `卷${CN[idx]}` : `第${vol.from}章起`;
    }
    // 标题词：剥「## 」「卷X」「·、: 分隔符与区间标注」，剩下的就是卷标题（可为空）
    const title = String(headerLine)
        .replace(/^#{1,6}\s*/, '')
        .replace(/^卷[一二三四五六七八九十\d]+/, '')
        .replace(/^[·•:：\-\s]+/, '')
        .replace(/[（(].*$/, '')
        .trim();
    return { volumeNo, title };
}

/** 全书大纲里**所有**卷头行（带行文本，供调用方取「本章卷」）。 */
export function volumeHeadingLines(bookOutline) {
    const lines = String(bookOutline ?? '').split('\n');
    const heads = [];
    for (const line of lines) {
        if (/^\s*#{1,6}(?:$|\s|[^#])/.test(line) && volumeRange(line) !== null) heads.push(line);
    }
    return heads;
}

/**
 * 细纲对齐检查（纯判定，save_chapter / approve 关口共用）。
 * @param {object} a
 * @param {string} a.bookOutline 全书大纲全文（null/空 = 无基准，检查不适用）
 * @param {number} a.chapter 章号
 * @param {string} a.outline 本章细纲全文
 * @returns {{ applicable: boolean, ok: boolean, volumeNo: string, volumeTitle: string, alignLine: (string|null), message: (string|null) }}
 *   applicable=false 时 ok=true（跳过不打扰，与 divergence 同口径）。
 */
export function alignCheck({ bookOutline, chapter, outline }) {
    const heads = volumeHeadingLines(bookOutline);
    // 无卷结构 → 无从对齐（不是「没对齐」，是「没有基准」——静默跳过）
    if (heads.length === 0) {
        return { applicable: false, ok: true, volumeNo: '', volumeTitle: '', alignLine: null, message: null };
    }
    // 本章所在卷 = 区间命中该章的**最后一个**卷头（与 gate.volumeSection 同口径：后写的卷说了算）
    let vol = null;
    for (const h of heads) {
        const r = volumeRange(h);
        if (Number.isInteger(chapter) && r !== null && chapter >= r.from && chapter <= r.to) {
            vol = volumeHeadingWords(h);
        }
    }
    if (vol === null) {
        // 有卷头但本章不在任何卷区间（卷界没覆盖到本章）——对齐行无法机判命中，
        // 只要求「有对齐行」（提示卷界缺失，不驳回：区间是大纲自身质量问题）。
        // 行式或段标题式任一算「有」（findAlignLine 两形态都认）。
        const line = findAlignLine(outline);
        return {
            applicable: true, ok: line !== null, volumeNo: '', volumeTitle: '',
            alignLine: line,
            message: line === null
                ? '细纲缺「对齐」行；且本书大纲的卷界没有覆盖到本章（卷区间缺漏）——先补大纲卷区间，再写对齐行'
                : null,
        };
    }
    const line = findAlignLine(outline);
    if (line === null) {
        return {
            applicable: true, ok: false, volumeNo: vol.volumeNo, volumeTitle: vol.title, alignLine: null,
            message: `细纲缺「对齐」行：需一行「对齐：${vol.volumeNo} · ${vol.title || '<卷段节点>'}」（段标题式「## 本章定位 / ## 全书大纲对齐」同认）——细纲引用全书大纲卷段的机器锚点。先跑 novel_outline align（第${chapter}章）拿对齐报告，把结论行落进细纲。`,
        };
    }
    // 命中判定：对齐行须含本章卷的卷序词或卷标题词（任一）——
    // 写「对齐：卷一」而本章在卷三 = 照抄了上一行，不算对齐。
    const expected = [vol.volumeNo, vol.title].filter((t) => t !== '');
    const hit = expected.some((t) => line.includes(t));
    return {
        applicable: true, ok: hit, volumeNo: vol.volumeNo, volumeTitle: vol.title, alignLine: line,
        message: hit ? null : `「${line.slice(0, 40)}…」没有对齐到本章所在卷（${vol.volumeNo} · ${vol.title || '无标题'}）——对齐行照抄了前一卷/节点。按 novel_outline align 第${chapter}章的报告重写这行。`,
    };
}

/** 取细纲里最后一条对齐文本（多条取最后——细纲头部写、尾部补都认）。两种机读形态：
 *  ① 行式：「对齐：卷X · …」及真书变体关键词（对齐说明/本卷对齐/本章定位 等），
 *     列表符/序号/加粗前缀同认；
 *  ② 段标题式：「## 本章定位 / ## 全书大纲对齐 / ## 卷段对齐（…）」——取标题尾注 +
 *     其下至多 3 行正文（遇下一标题为止）拼作对齐文本（卷序词常落在该节首行正文里）。 */
export function findAlignLine(outline) {
    const lines = String(outline ?? '').split('\n');
    let last = null;
    for (let i = 0; i < lines.length; i += 1) {
        const mLine = ALIGN_LINE_RE.exec(lines[i]);
        if (mLine !== null) {
            // 关键词后括注（常载卷标题/区间）与冒号后陈述拼作对齐文本
            last = [mLine[1], mLine[2]].filter((s) => s !== '').join(' ').trim();
            continue;
        }
        const mH = ALIGN_HEADING_RE.exec(lines[i]);
        if (mH !== null) {
            const body = [];
            for (let j = i + 1; j < lines.length && j <= i + 3; j += 1) {
                const t = lines[j].trim();
                if (t === '') continue;
                if (/^\s*#{1,6}\s/.test(lines[j])) break;
                body.push(t);
                if (body.length >= 3) break;
            }
            last = [mH[1].trim(), ...body].filter((s) => s !== '').join(' ');
        }
    }
    return last;
}
