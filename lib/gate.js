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
