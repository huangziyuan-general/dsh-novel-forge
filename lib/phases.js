// lib/phases.js — 九阶段状态机（纯函数，零 token）。
//
// 为什么要有它：旧版 `lib/gate.js` 只有五个阶段（planning/outline/drafting/
// revising/done），门禁只查得到一件事——「这一章的细纲批了没」。于是
// 「设定没定就想写大纲」「大纲没过就想写正文」「第一章还没写就想宣布完稿」
// 全都拦不住。这里把鱼的九阶段链搬过来，每一阶段带**入场条件**（纯函数判定）
// 与 **PhaseReport**（passed / errorCount / warningCount），阶段推进可审计、可回退。
//
// 兼容：旧书的 `novel.stage` 是 planning/outline/drafting/revising/done，
// 通过 LEGACY_STAGE 别名映射进新链，判定与展示都认——用户盘上的老数据零迁移成本。

/** 九阶段：id 即 novel.stage 的取值。order 用于「只前进」比较。 */
export const PHASES = [
    { id: 'topic', label: '立意', order: 0, entry: '一句话故事（logline）已定' },
    { id: 'setting', label: '设定', order: 1, entry: '世界书有条目或已写故事承诺书' },
    { id: 'character', label: '人物', order: 2, entry: '至少一张人物卡' },
    { id: 'outline', label: '大纲', order: 3, entry: '全书大纲已保存' },
    { id: 'volume', label: '分卷', order: 4, entry: '大纲含卷/幕/部结构' },
    { id: 'chapter', label: '细纲', order: 5, entry: '至少一章细纲已批准' },
    { id: 'writing', label: '正文', order: 6, entry: '至少一章正文已保存' },
    { id: 'revision', label: '修订', order: 7, entry: '至少一章正文，且全书一致性无硬伤' },
    { id: 'done', label: '完稿', order: 8, entry: '所有已批细纲都有正文' },
];

export const PHASE_IDS = PHASES.map((p) => p.id);

/** 阶段状态（鱼的四态 + locked）。 */
export const PHASE_STATUS = ['locked', 'in_progress', 'review', 'approved', 'skipped'];

/** 旧五阶段 → 新九阶段别名。老书 stage 落在这些键上照常工作。 */
export const LEGACY_STAGE = {
    planning: 'topic',
    outline: 'outline',
    drafting: 'writing',
    revising: 'revision',
    done: 'done',
};

/** 旧名专属展示标签（旧值直接展示时给一个不变的中文，避免面板文字跳动）。 */
export const LEGACY_STAGE_LABEL = {
    planning: '规划', outline: '大纲', drafting: '正文', revising: '修订', done: '完结',
};

/**
 * 归一化阶段名：接受九阶段 id 或旧的五阶段别名。
 * @returns {string|null} 九阶段 id；无法识别返回 null
 */
export function canonicalPhase(stage) {
    if (typeof stage !== 'string' || stage === '') return null;
    if (PHASE_IDS.includes(stage)) return stage;
    return LEGACY_STAGE[stage] ?? null;
}

/** 阶段序号；无法识别返回 -1。 */
export function phaseIndex(stage) {
    const id = canonicalPhase(stage);
    return id === null ? -1 : PHASES.find((p) => p.id === id).order;
}

/** 阶段中文标签（认九阶段 id 与旧别名）。 */
export function phaseLabel(stage) {
    const id = canonicalPhase(stage);
    if (id !== null) return PHASES.find((p) => p.id === id).label;
    return LEGACY_STAGE_LABEL[stage] ?? stage ?? '—';
}

export function phaseMeta(stage) {
    const id = canonicalPhase(stage);
    return id === null ? null : PHASES.find((p) => p.id === id);
}

/**
 * 每阶段的**入场条件**：纯函数，由事实快照 facts 判定。
 * 用 test 而不是读盘——IO 走 lib/phase-io.js 的 loadPhaseFacts。
 */
const REQUIREMENTS = {
    topic: [
        { label: '一句话故事（logline）为空——先把「这本书讲什么」写出来', test: (f) => String(f.logline ?? '').trim() !== '' },
    ],
    setting: [
        { label: '世界书为空且无故事承诺书——设定先于大纲', test: (f) => (f.worldbookCount ?? 0) >= 1 || f.hasPromise === true },
    ],
    character: [
        { label: '还没有人物卡——novel_character save 至少建一张', test: (f) => (f.castCount ?? 0) >= 1 },
    ],
    outline: [
        { label: '全书大纲未保存——novel_outline save_book', test: (f) => f.hasBookOutline === true },
    ],
    volume: [
        { label: '大纲里没有卷/幕/部结构——长篇先分卷再铺细纲', test: (f) => f.hasVolumePlan === true },
    ],
    chapter: [
        { label: '没有已批准的细纲——novel_outline save_chapter + approve', test: (f) => (f.approvedOutlineCount ?? 0) >= 1 },
    ],
    writing: [
        { label: '还没有已保存的正文——novel_write_chapter', test: (f) => (f.savedChapterCount ?? 0) >= 1 },
    ],
    revision: [
        { label: '还没有可修订的正文', test: (f) => (f.savedChapterCount ?? 0) >= 1 },
        { label: '全书一致性存在硬伤——先 novel_project check 修完再宣布进入修订', test: (f) => (f.continuityErrors ?? 0) === 0 },
    ],
    done: [
        { label: '还没有已批细纲', test: (f) => (f.approvedOutlineCount ?? 0) >= 1 },
        { label: '尚有已批细纲没有正文——完稿前补齐', test: (f) => f.allApprovedWritten === true },
    ],
};

/** 某阶段的入场条件是否满足（纯函数）。 */
export function checkPhaseEntry(phaseId, facts = {}) {
    const id = canonicalPhase(phaseId);
    if (id === null) throw new Error(`未知阶段：${phaseId}（可用：${PHASE_IDS.join(' / ')}）`);
    const missing = [];
    for (const req of REQUIREMENTS[id] ?? []) {
        let ok = false;
        try { ok = req.test(facts) === true; } catch { ok = false; }
        if (!ok) missing.push(req.label);
    }
    return { phase: id, ok: missing.length === 0, missing };
}

/**
 * 由 phases 记录推当前阶段：取「已被显式标记过」的最靠后阶段。
 * 仅用于展示/对账；`novel.stage` 才是权威字段。
 */
export function deriveStage(novel) {
    const rec = novel?.phases ?? {};
    let best = -1;
    for (const id of PHASE_IDS) {
        const s = rec[id]?.status;
        if (s === undefined || s === 'locked') continue;
        best = Math.max(best, phaseIndex(id));
    }
    if (best < 0) return canonicalPhase(novel?.stage) ?? PHASE_IDS[0];
    return PHASES[best].id;
}

/**
 * 记一笔阶段记录（自动推进用，不查入场条件）。
 * 已 approved 的阶段不被降级回 in_progress（避免重复触碰把状态打回去）。
 */
export function touchPhase(novel, stage, status = 'in_progress', extra = {}) {
    const id = canonicalPhase(stage);
    if (novel === null || novel === undefined || id === null) return novel;
    novel.phases = novel.phases ?? {};
    const cur = novel.phases[id] ?? null;
    if (cur?.status === 'approved' && status === 'in_progress') return novel;
    novel.phases[id] = { ...(cur ?? {}), status, at: new Date().toISOString(), ...extra };
    return novel;
}

/** 造一份 PhaseReport（鱼的口径：passed / errorCount / warningCount）。 */
export function phaseReport({ phase, status = 'approved', errorCount = 0, warningCount = 0, notes = [] } = {}) {
    const id = canonicalPhase(phase);
    return {
        phase: id ?? phase,
        status,
        passed: errorCount === 0,
        errorCount,
        warningCount,
        notes: Array.isArray(notes) ? notes : [String(notes)],
        at: new Date().toISOString(),
    };
}

/**
 * 显式进入某阶段：查入场条件，通过（或 force）则落 novel.stage + phases 记录。
 * 不抛错（与 resetStage 不同）——返回 {ok:false, missing} 交由调用方决定怎么告知。
 * `report` 交由调用方传入（例如 revision 阶段带上一致性校验数字）。
 */
export function enterPhase(novel, stage, { force = false, facts = {}, report = null, actor = 'agent' } = {}) {
    const id = canonicalPhase(stage);
    if (id === null) throw new Error(`未知阶段：${stage}（可用：${PHASE_IDS.join(' / ')}；兼容旧名：${Object.keys(LEGACY_STAGE).join(' / ')}）`);
    if (novel === null || novel === undefined) throw new Error('书目不存在');
    const chk = checkPhaseEntry(id, facts);
    if (!chk.ok && !force) {
        return {
            ok: false, phase: id, label: phaseLabel(id), forced: false, missing: chk.missing,
            reason: `阶段「${phaseLabel(id)}」入场条件未满足：\n${chk.missing.map((m) => `- ${m}`).join('\n')}`,
        };
    }
    const idx = phaseIndex(id);
    novel.stage = id;
    novel.phases = novel.phases ?? {};
    // 越过的前置阶段记 skipped（可审计的「跳阶段」），已完成的不动
    for (const p of PHASES) {
        if (p.order >= idx) break;
        if (novel.phases[p.id] === undefined) novel.phases[p.id] = { status: 'skipped', at: new Date().toISOString(), report: null };
    }
    const rep = report ?? phaseReport({
        phase: id, status: chk.ok ? 'approved' : 'in_progress',
        errorCount: chk.ok ? 0 : chk.missing.length,
        notes: chk.ok ? [] : [`force 放行：${chk.missing.join('；')}`],
    });
    novel.phases[id] = { status: 'approved', at: rep.at, report: rep, actor: chk.ok ? actor : 'user' };
    return { ok: true, phase: id, label: phaseLabel(id), forced: !chk.ok, missing: chk.missing, report: rep };
}

/**
 * 阶段看板：每阶段的现状 + 入场条件检查 + 最近一次 PhaseReport。
 * @returns {Array<{phase,label,order,status,current,entryOk,missing,report,at}>}
 */
export function phaseBoard(novel, facts = {}) {
    const current = canonicalPhase(novel?.stage) ?? PHASE_IDS[0];
    return PHASES.map((p) => {
        const rec = novel?.phases?.[p.id] ?? null;
        const chk = checkPhaseEntry(p.id, facts);
        const isCurrent = p.id === current;
        const status = rec?.status ?? (isCurrent ? 'in_progress' : 'locked');
        return {
            phase: p.id, label: p.label, order: p.order,
            status, current: isCurrent,
            entryOk: chk.ok, missing: chk.missing,
            report: rec?.report ?? null, at: rec?.at ?? null,
        };
    });
}

const STATUS_MARK = { approved: '✓', in_progress: '●', review: '◐', skipped: '↷', locked: '○' };

/** 阶段看板 → 终端文本（novel_project phase 的 render）。 */
export function renderPhaseBoard(board, { current } = {}) {
    const lines = board.map((p) => {
        const mark = STATUS_MARK[p.status] ?? '○';
        const head = `${mark} ${p.label.padEnd(4, '　')} ${p.status}${p.current ? '  ←当前' : ''}`;
        const miss = p.missing.length > 0 && (p.current || p.order <= (board.find((b) => b.current)?.order ?? 0) + 1)
            ? `\n    缺：${p.missing.join('；')}`
            : '';
        return head + miss;
    });
    return `阶段进度（当前 ${current ?? '—'}）\n${lines.join('\n')}`;
}
