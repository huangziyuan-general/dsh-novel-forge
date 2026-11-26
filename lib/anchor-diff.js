// lib/anchor-diff.js — 锚点改写 diff（纯函数，零 IO、零模型调用）。
//
// 缺口（某连载本 2026-11-25 真案卷）：全书大纲与承诺书是门禁的**参照物**（尺子）——
// P1 对齐闸、P2 承诺条款、divergence 双判据量的都是「正文 vs 锚点」。外部审计改写把
// 两份锚点整体替换成另一套立意后，门禁拿「商战正文 vs 商战锚点」对账，偏差归零，
// 且 audit 只记 chars 不记内容——「尺子何时被谁改成什么」事后无从回答。
//
// 本模块只补**可见性**，不做拦截（方向性改写是作者的权力，拦 = 替作者裁决）：
// 改写前对旧/新两版做结构 diff——卷段 kept/removed/added、题材词群 lost/gained、
// 字数变化率、方向性自申报词命中——五个强信号供调用方（save_book / promise 写分支）
// 在 audit 与回执里点名「本次锚点改动动了什么」。首写（无旧文）与正常小改全静默，
// 零回归；判据全确定性，零 token。
//
// 口径纪律：bigram/jaccard 借 gate.js 的共享实现（单一口径，不抄第二份）；
// 卷段抽取复用 outline-align.js 的 volumeHeadingLines（卷头行集合 diff 与 P1 同基准）。

import { bigramSet, jaccard } from './gate.js';
import { volumeHeadingLines } from './outline-align.js';

/** 方向性自申报词表（作者/审计在改尺子时写进正文的声明语，高精确度、宁可窄）。
 *  题材词不进这里（走 genreTerms diff 单独判，两路信号不混）。
 *  判据用**集合差**：新文引入了旧文没有的声明词才算——豆包版自带「修订说明」后
 *  的每次小改不重复亮灯；「修订→回撤」「回撤→再改方向」则都因引入新词而亮灯。 */
export const SELF_DECLARED_TERMS = [
    '修订说明', '不再承诺', '实际走向', '以成稿为准', '按成稿',
    '重建说明', '回撤', '改回', '搁置',
];

/** 卷段指纹：卷头行剥 `#`、卷序词、区间标注、括注后的标题词（kept 判定用）。 */
function volumeFingerprint(headerLine) {
    return String(headerLine)
        .replace(/^#{1,6}\s*/, '')
        .replace(/^卷[一二三四五六七八九十\d]+/, '')
        .replace(/^[·•:：\-\s]+/, '')
        .replace(/[（(].*$/, '')
        .trim();
}

/** 题材词群统计只吃**正文行**：剔标题行（`#` 起头，卷段结构已由 volumes 信号管）与
 *  自申报 meta 行（修订说明/重建说明 是记账话，不是故事内容）——否则骨架词（卷/第/章）
 *  与 meta 词（重建/原案/修订）占掉高频位，把真题材词（修为/官仓/黑风）稀释没了。 */
function bodyText(text) {
    return String(text ?? '')
        .split('\n')
        .filter((l) => {
            const t = l.trim();
            if (t === '' || /^#{1,6}\s/.test(t)) return false;
            return !SELF_DECLARED_TERMS.some((k) => t.includes(k));
        })
        .join('');
}

// 停用字（纯虚词/结构字，同 outlineDivergence TERM_STOP 口径但收窄——**不含** 为/被/大/第/卷/章/节/书：
// 「修为/被掳/大货车/章节」是内容词，一刀切掉会把题材词群洗没）：
const TERM_STOP_CHARS = '的了是在和与之有个也很会能要不这那你我他她它们着过又还没从向对于而但其此所述等再更最只么呢吧啊上下来去中把'.split('');

/** 正文行里频次 ≥minFreq 的高频 2-gram（题材词群；含任一停用字的 bigram 不数）。 */
function freqBigrams(text, minFreq = 2, top = 12) {
    const clean = bodyText(text).replace(/[\s\p{P}\p{S}]/gu, '');
    const freq = new Map();
    for (let i = 0; i < clean.length - 1; i += 1) {
        const g = clean.slice(i, i + 2);
        if (TERM_STOP_CHARS.includes(g[0]) || TERM_STOP_CHARS.includes(g[1])) continue;
        freq.set(g, (freq.get(g) ?? 0) + 1);
    }
    return [...freq.entries()]
        .filter(([, n]) => n >= minFreq)
        .sort((a, b) => b[1] - a[1])
        .slice(0, top)
        .map(([g]) => g);
}

/** 去空白字数（变化率判据的分母口径，同 noai 的 chars 口径：字数是读者的字数）。 */
const cleanChars = (text) => String(text ?? '').replace(/\s/g, '').length;

/**
 * 锚点改写 diff（新旧两版全文 → 结构变化摘要）。纯函数。
 * @param {{oldText: (string|null), newText: string}} a oldText 为 null/'' = 首写。
 * @returns {{
 *   applicable: boolean,               // 首写（无旧文）→ false（调用方整段跳过）
 *   charDelta: number,                  // 新旧字数变化率（新-旧）/旧，round2；旧为 0 时省略（null）
 *   jaccard: number,                    // 新旧全文 bigram Jaccard（round3，展示用）
 *   volumes: { kept: number, removed: number, added: number },  // 卷段对账
 *   genreTerms: { lost: string[], gained: string[] },          // 高频 2-gram 消失/新现（各取 top12）
 *   selfDeclared: boolean,              // 新文引入了旧文没有的方向性自申报词（集合差）
 *   major: boolean,                     // 任一强信号：自申报 / 卷段群不重合(kept=0 且任一侧有卷段) /
 *                                       //   双低重合(jaccard<0.15 且 termHitRate<0.10) / 字数突变(≥±40%) /
 *                                       //   题材词群流失(旧文高频词过半消失)
 * }}
 *   major 只是「该在回执里点名」的机器信号——拦不拦、要不要回滚，裁决留给人。
 */
export function anchorDiff({ oldText, newText }) {
    const oldClean = cleanChars(oldText);
    const isNewer = oldClean === 0;
    if (isNewer) return { applicable: false, charDelta: null, volumes: { kept: 0, removed: 0, added: 0 }, genreTerms: { lost: [], gained: [] }, selfDeclared: false, major: false };

    const oldBig = bigramSet(oldText);
    const newBig = bigramSet(newText);
    // termHitRate：旧文**故事词群**被新文正文直接引用的比例（借 outlineDivergence 双判据口径，
    // 锚点级把 0.02 放宽到 0.10——整本重写但同题材的润色命中率仍 >0.10，换血则 ≈0）。
    // 词群两侧都只数正文行（bodyText）——meta 声明行/卷段标题不进题材词，否则
    // 「修订说明/重建说明」这类记账话会稀释真词群（修为/官仓 该数的数不到）。
    const oldTop = freqBigrams(oldText);
    const newBody = bodyText(newText).replace(/[\s\p{P}\p{S}]/gu, '');
    const oldBody = bodyText(oldText).replace(/[\s\p{P}\p{S}]/gu, '');
    const hit = oldTop.length === 0 ? 0 : oldTop.filter((g) => newBody.includes(g)).length;
    const termHitRate = oldTop.length === 0 ? 1 : hit / oldTop.length;

    // 卷段对账：卷头指纹集合的 kept / removed / added
    const oldVols = volumeHeadingLines(oldText).map(volumeFingerprint).filter((f) => f !== '');
    const newVols = volumeHeadingLines(newText).map(volumeFingerprint).filter((f) => f !== '');
    const kept = newVols.filter((v) => oldVols.includes(v)).length;
    const removed = oldVols.length - kept;
    const added = newVols.length - kept;

    // 题材词群：旧文故事词群在新文正文消失（lost）；新文故事词群在旧文缺席（gained）
    const lost = oldTop.filter((g) => !newBody.includes(g));
    const gained = freqBigrams(newText).filter((g) => !oldBody.includes(g));

    const charDelta = Math.round(((cleanChars(newText) - oldClean) / oldClean) * 1000) / 1000;
    const jac = jaccard(oldBig, newBig);
    // 自申报（**集合差**语义）：新文引入了旧文没有的声明词才算——豆包版自带「修订说明」
    // 后的每次小改不重复亮灯；「修订→回撤」「回撤→再改方向」因引入新声明词而亮灯。
    const selfDeclared = SELF_DECLARED_TERMS.some((t) => String(newText).includes(t) && !String(oldText ?? '').includes(t));
    // 五个强信号（单一结构信号不升级：改措辞的字数也会 ±40%；自申报/词群换血是方向性证据）：
    const volumeChurn = removed > 0 || added > 0; // 尺子的卷段结构变了（增/删卷段都该可见）
    const doubleLow = jac < 0.15 && termHitRate < 0.1;
    const charSpikes = Math.abs(charDelta) >= 0.4;
    // 题材词群流失：旧文故事词群（top12）过半在新文正文消失 = 立意换血。单独判而不靠 jaccard——
    // 「商战→修仙」这类回撤时卷段标题多半保留（kept>0、jaccard 不低），只有词群流失亮灯；
    // 同题材润色/扩写旧词群几乎全保留（流失率 ≈0），不误报。
    const genreChurn = oldTop.length > 0 && lost.length / oldTop.length >= 0.5;
    const major = selfDeclared || volumeChurn || doubleLow || charSpikes || genreChurn;

    return {
        applicable: true,
        charDelta,
        jaccard: Math.round(jac * 1000) / 1000,
        volumes: { kept, removed, added },
        genreTerms: { lost: lost.slice(0, 8), gained: gained.slice(0, 8) },
        selfDeclared,
        major,
    };
}

/** 回执/audit 用的一行摘要（major 才出；不 major 返回 '' 让调用方整段省略）。 */
export function renderAnchorDiffSummary(diff) {
    if (!diff || diff.major === false) return '';
    const parts = [];
    if (diff.selfDeclared) parts.push('本次改写引入方向性自申报（修订说明/回撤/不再承诺 类）');
    if (diff.volumes.removed > 0 || diff.volumes.added > 0) parts.push(`卷段 ${diff.volumes.kept}留/${diff.volumes.removed}删/${diff.volumes.added}增`);
    if (diff.charDelta !== null && Math.abs(diff.charDelta) >= 0.4) parts.push(`字数 ${Math.round(diff.charDelta * 100)}%`);
    if (diff.genreTerms.lost.length > 0) parts.push(`流失词群 ${diff.genreTerms.lost.slice(0, 4).join('、')}`);
    if (diff.genreTerms.gained.length > 0) parts.push(`新增词群 ${diff.genreTerms.gained.slice(0, 4).join('、')}`);
    return `锚点方向性变更（${parts.join('；')}）——门禁参照物被换，偏差判据随之失效，请核对是否有意为之`;
}
