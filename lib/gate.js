// lib/gate.js — 阶段门禁（纯函数）。
// 代码强制的核心之一：novel_write_chapter 在 execute 里先问它；
// 「模型口头跳阶段」在这里变成一个 throw。

const STAGES = ['planning', 'outline', 'drafting', 'revising', 'done'];

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

/** 写章后的阶段推进（drafting；首次进入时更新）。默认只前进不后退。 */
export function advanceStage(novel, stage) {
    const cur = STAGES.indexOf(novel?.stage ?? 'planning');
    const next = STAGES.indexOf(stage);
    if (next > cur) novel.stage = stage;
}

/** 显式把阶段设为指定值（阶段重置/纠正通道；不走只前进的 advanceStage）。 */
export function resetStage(novel, stage) {
    if (!STAGES.includes(stage)) throw new Error(`未知阶段：${stage}（可用：${STAGES.join(' / ')}）`);
    novel.stage = stage;
    return novel;
}