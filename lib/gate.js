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

/** 全书大纲的卷头解析：认「（1-40章）」「（1-40）」「1-40 章」三种写法的章区间。 */
function volumeRange(header) {
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
        if (/^#{1,3}\s/.test(lines[i])) {
            const range = volumeRange(lines[i]);
            if (range !== null) heads.push({ line: i, range });
        }
    }
    const hit = heads.find((h) => n >= h.range.from && n <= h.range.to);
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
 * 细纲与卷规划段的重合度。<0.15 视为方向存疑（调用方决定警告与否）。
 * 细纲侧只抽「场景描述行」的声音——细纲的格式行（「## 本章必写场景」等标题）不进集合。
 */
export function outlineDivergence(volumeText, chapterOutline) {
    const sceneLines = String(chapterOutline ?? '').split('\n')
        .filter((l) => /^\s*[-*]\s/.test(l) || (l.trim() !== '' && !/^#/.test(l.trim())))
        .join('\n');
    const v = bigramSet(volumeText);
    const o = bigramSet(sceneLines);
    return { jaccard: Math.round(jaccard(v, o) * 1000) / 1000 };
}
