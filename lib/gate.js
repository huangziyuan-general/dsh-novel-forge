// lib/gate.js — 阶段门禁（纯函数）。
// 代码强制的核心之一：novel_write_chapter 在 execute 里先问它；
// 「模型口头跳阶段」在这里变成一个 throw。
//
// 自 0.10.0 起阶段链由九阶段状态机（lib/phases.js）提供，本文件只保留
// **门禁**与**推进**两个语义：闸口怎么判、状态怎么走。入场条件与 PhaseReport
// 在 phases.js。旧五阶段名（planning/outline/drafting/revising/done）作为别名
// 继续可用——老书盘上的 stage 不用改。

import {
    PHASES, PHASE_IDS, canonicalPhase, phaseIndex, phaseLabel, phaseMeta,
    touchPhase, enterPhase, phaseBoard, checkPhaseEntry, deriveStage,
} from './phases.js';

/** 九阶段 id（旧名别名见 phases.LEGACY_STAGE）。 */
export const STAGES = PHASE_IDS;

export { PHASES, canonicalPhase, phaseIndex, phaseLabel, phaseMeta, enterPhase, phaseBoard, checkPhaseEntry, deriveStage };

/**
 * 写章门禁：第 n 章细纲必须已批准。
 * @param novel  novel.json 内容（null = 书不存在）
 * @param n      章号
 * @param force  用户显式放行（记审计）
 */
export function gateChapterWrite(novel, n, { force = false } = {}) {
    if (novel === null || novel === undefined) {
        return { ok: false, forced: false, reason: '书目不存在：先用 novel_project init 创建', rules: ['书目不存在'] };
    }
    const approved = novel.approvals?.outline?.[String(n)] === true;
    if (approved) {
        return { ok: true, forced: false, reason: `第${n}章细纲已批准`, rules: [] };
    }
    if (!force) {
        return {
            ok: false,
            forced: false,
            reason: `阶段门禁未通过：第${n}章细纲尚未批准。先用 novel_outline 保存细纲，再 novel_outline approve 批准；确要跳过须 force:true（将记入审计）。`,
            rules: [`第${n}章细纲未批准`],
        };
    }
    return { ok: true, forced: true, reason: `force 放行：第${n}章细纲未批准（已记入审计）`, rules: [`force 放行：细纲未批准`] };
}

/**
 * 写章后的阶段推进（→ writing；首次进入时更新）。默认只前进不后退。
 * 接受九阶段 id 或旧别名；顺带把 phases 记录点亮，供看板展示。
 */
export function advanceStage(novel, stage) {
    const id = canonicalPhase(stage);
    if (novel === null || novel === undefined || id === null) return novel;
    const cur = phaseIndex(novel.stage ?? PHASE_IDS[0]);
    const next = phaseIndex(id);
    if (next > cur) {
        novel.stage = id;
        touchPhase(novel, id, 'in_progress');
    }
    return novel;
}

/** 显式把阶段设为指定值（阶段重置/纠正通道；不走只前进的 advanceStage）。 */
export function resetStage(novel, stage) {
    const id = canonicalPhase(stage);
    if (id === null) {
        throw new Error(
            `未知阶段：${stage}（可用：${PHASE_IDS.join(' / ')}；兼容旧名：planning / outline / drafting / revising / done）`,
        );
    }
    novel.stage = id;
    touchPhase(novel, id, 'in_progress');
    return novel;
}

/**
 * 0.19.0：细纲→全书大纲方向校验（纯函数）。
 * 《开局觉醒加特林》105 章审校实证的 P0：剧情从第 25 章起彻底脱离全书大纲、卷二
 * 应写的「青岚兵院」整段未发生——门禁链没有任何一处校验「细纲/正文 vs 全书大纲」，
 * 大纲对细纲的约束力只在写前简报注入（提醒不是校验），「代码强制」在这一环恰好
 * 退化为提示词自觉；驳回压力下的细纲重写窗口（真机 ch24 一小时三驳两轮重写）
 * 就成了自由换线的窗口。这里补的是**可见性闸**（warning 不阻断——拐线可能是合理的
 * 创作演化，但要可见、要提醒把大纲一起更新）：细纲与本章所在卷的规划段 2-gram
 * 重合度过低就点名。
 */

/**
 * 全书大纲的卷头解析：认「（1-40章）」「（1-40）」「1-40 章」三种**闭合**写法，
 * 以及「第 71 章起」这种**开区间**写法。
 *
 * 开区间为什么必须认：长篇的最后一卷通常不封顶（「第七十一章起」写到完结）。
 * 只认闭合写法时该卷头不成立 → volumeSection 返回 null → 调用方整段跳过
 * 「细纲与本卷规划重合度」的方向闸（lib/tools/outline-tool.js 的 if (vol !== null)）。
 * 也就是**每本书的最后一卷——恰好是大揭示所在的那一卷——永久没有方向闸**。
 */
function volumeRange(header) {
    // 开区间：起头标记必须收在行尾（允许尾随标点/括号），避免把「第 1 章 起手」
    // 这类正文语义误判成区间。
    const open = header.match(/第\s*(\d{1,4})\s*章\s*(?:起|开始|往后)[\s。．.，,、)）]*$/);
    if (open !== null) {
        const from = Number(open[1]);
        if (Number.isInteger(from) && from > 0) return { from, to: Number.POSITIVE_INFINITY };
    }
    const m = header.match(/[（(]\s*(\d{1,4})\s*[-–—~]\s*(\d{1,4})\s*(?:章)?\s*[)）]/)
        ?? header.match(/(\d{1,4})\s*[-–—~]\s*(\d{1,4})\s*章/);
    if (!m) return null;
    const a = Number(m[1]);
    const b = Number(m[2]);
    return Number.isInteger(a) && Number.isInteger(b) && a <= b ? { from: a, to: b } : null;
}

/**
 * 定位第 n 章所在卷的规划段（从该卷头行到下一卷头行/文末）。
 * 大纲没有可解析的卷结构（无卷头或头行无章区间）时返回 null——静默跳过校验，不打扰。
 */
export function volumeSection(bookOutline, n) {
    const lines = String(bookOutline ?? '').split('\n');
    const heads = [];
    for (let i = 0; i < lines.length; i += 1) {
        // 标题形状与 lib/phase-io.js 的 detectVolumePlan 对齐（那里 `#` 后可不带空格）：
        // 同一份大纲两个函数认的形状不同，会让「卷结构过了阶段闸、方向闸却看不见」。
        // 「1–6 个 # 后面跟空白/行尾/非 # 字符」= CommonMark 的 ATX 标题；7 个以上不算。
        if (/^\s*#{1,6}(?:$|\s|[^#])/.test(lines[i])) {
            const range = volumeRange(lines[i]);
            if (range !== null) heads.push({ line: i, range });
        }
    }
    // 重叠时取**最后一个**命中卷，不是第一个：开区间（「第 71 章起」＝ to:Infinity）
    // 未必出现在大纲末尾——作者改了卷规划却忘了给老卷头封顶时，「卷一 1-100」+「卷二 71 起」
    // 这种并存是常态。取第一个命中会让第 80 章落在卷一，方向闸拿错的规划段比没有闸更坏
    // （它会稳定地警告「你拐线了」，而真相只是卷头没更新）。取最后命中＝后写的卷说了算，
    // 与「大纲后段是前段的修订」这个阅读直觉一致；规范大纲（区间不重叠）下两者等价。
    const hit = heads.filter((h) => n >= h.range.from && n <= h.range.to).at(-1);
    if (hit === undefined) return null;
    const nextLine = heads.filter((h) => h.line > hit.line).map((h) => h.line)[0] ?? lines.length;
    const section = lines.slice(hit.line, nextLine).join('\n').trim();
    return section.length > 0 ? section : null;
}

/** 中文 2-gram 集合（去空白/标点）。 */
function bigramSet(text) {
    const clean = String(text ?? '').replace(/[\s\p{P}\p{S}]/gu, '');
    const set = new Set();
    for (let i = 0; i < clean.length - 1; i += 1) set.add(clean.slice(i, i + 2));
    return set;
}

function jaccard(a, b) {
    if (a.size === 0 && b.size === 0) return 0;
    let inter = 0;
    for (const x of a) if (b.has(x)) inter += 1;
    return inter / (a.size + b.size - inter);
}

/**
 * 细纲与卷规划段的重合度。
 *
 * 双判据（0.19.1，真机《第七夜班》42 章 12+ 次全误报的修复）：
 *   · jaccard：2-gram 集合重合度——对「概括 vs 细化」的粒度差天然低分（卷规划是
 *     每 5-6 夜一句的概括句，细纲是具体场景），单看它必误报；
 *   · termHitRate：卷段 bigram 词被细纲**直接引用**的比例——只要细纲在同一条
 *     故事线上，就会复用卷段的核心概念词（守则/守夜/店门/账…），命中率显著高；
 *     真拐线（剧情彻底脱离卷规划）时两个指标一起崩。
 * 调用方应以「双低才警告」（jaccard < 0.15 且 termHitRate < 0.12）为判据，
 * 只报确定异常——噪音太多模型会整条忽略。
 */
export function outlineDivergence(volumeText, chapterOutline) {
    const sceneLines = String(chapterOutline ?? '').split('\n')
        .filter((l) => /^\s*[-*]\s/.test(l) || (l.trim() !== '' && !/^#/.test(l.trim())))
        .join('\n');
    // 词命中率的卷段 bigram 过滤停用字：「的账/了门/在店」这类含虚词组合没有方向性
    // 信息，留在集合里稀释命中率、压平真拐线与同线的区分度（校准依据：同线细纲对
    // 概念词命中率 0.2+，拐线细纲 ~0）。
    const TERM_STOP = new Set('的了是在和与之有个也很会能要不这那你我他她它们着过又还没从向对为以于而但其此所述等再更最只么呢吧啊上下来去中把被'.split(''));
    const vAll = bigramSet(volumeText);
    const vTerms = [...vAll].filter((g) => !TERM_STOP.has(g[0]) && !TERM_STOP.has(g[1]));
    const o = bigramSet(sceneLines);
    let hit = 0;
    for (const g of vTerms) if (sceneLines.includes(g)) hit += 1;
    const termHitRate = vTerms.length === 0 ? 1 : hit / vTerms.length;
    return {
        // jaccard 保持原语义（全量 bigram 集合）——旧用例与外部调用方不感知过滤
        jaccard: Math.round(jaccard(vAll, o) * 1000) / 1000,
        termHitRate: Math.round(termHitRate * 1000) / 1000,
    };
}
