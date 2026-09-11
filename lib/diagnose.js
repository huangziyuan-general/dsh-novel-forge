// lib/diagnose.js — 纯函数：黄金三章确定性诊断（相性检测，不是模型口味）。
// 产出数字证据：钩子强度 / 开场质量 / 冲突密度 / 信息灌输度。审阅者拿这些数字做判断。

import lexicon from './data/diagnose-lexicon.json' with { type: 'json' };
import { detectHookKind } from './hook.js';

// 词表外置在 lib/data/diagnose-lexicon.json（用户可调阈值改词库，不动算法）。
// conflictWords/infoTokens 用 g 标志统计全部命中（hits*12 加权才有意义）。
const CONFLICT_WORDS = new RegExp(lexicon.conflictWords, 'g');
const INFO_TOKENS = new RegExp(lexicon.infoTokens, 'g');
const OPENING_ACTION = new RegExp(lexicon.openingAction);
const OPENING_LAZY = new RegExp(lexicon.openingLazy.join('|'));

function hookScore(tail) {
    if (!tail) return 0;
    const kind = detectHookKind(tail);
    if (kind === 'question') return 88;
    if (kind === 'exclaim') return 70;
    if (kind === 'ellipsis') return 66;
    if (kind === 'suspense') return 78;
    // 无钩子：句号结尾=平淡，其他=中等
    if (/[。.]$/.test(tail.trim())) return 18;
    return 40;
}

function openingScore(front) {
    const chars = front.length;
    if (chars === 0) return 0;
    const hasDialogue = /「[^」]{1,40}」/.test(front);
    const actiony = OPENING_ACTION.test(front);
    // 开场越短、越动作/对话，越好；长环境铺陈降分
    let s = 60;
    if (chars <= 120 && (hasDialogue || actiony)) s = 90;
    else if (chars > 260) s -= 30;
    if (OPENING_LAZY.test(front)) s -= 15; // 抒情开场
    return Math.max(5, Math.min(95, s));
}

function conflictScore(text) {
    const t = (text ?? '').slice(0, 800);
    const hits = (t.match(CONFLICT_WORDS) ?? []).length;
    const dialogue = (t.match(/「[^」]{1,40}」/g) ?? []).length;
    let s = dialogue >= 2 ? 40 : 20;
    s += Math.min(50, hits * 12);
    return Math.max(5, Math.min(95, s));
}

function infodumpScore(text) {
    const t = (text ?? '').slice(0, 800);
    const tokens = (t.match(INFO_TOKENS) ?? []).length;
    const sentences = t.split(/[。！？\n]/).filter((s) => s.trim() !== '');
    const avgLen = sentences.length === 0 ? 0 : Math.round((t.length) / sentences.length);
    let s = 15;
    s += Math.min(60, tokens * 18);          // 设定口吻
    if (avgLen > 60) s += (avgLen - 60);     // 超长句=灌输
    return Math.max(5, Math.min(95, s));
}

/** 单章四维诊断。hook/opening/conflict 越高越好，infodump 越高越糟（越像说明书）。 */
export function computeChapterDiagnosis(content) {
    const text = String(content ?? '').trim();
    const paras = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
    const front = paras[0] ?? '';
    const tail = text.slice(-160);
    return {
        hook: hookScore(tail),
        opening: openingScore(front),
        conflict: conflictScore(text),
        infodump: infodumpScore(text),
    };
}

/** 黄金三章诊断：逐章四维 + 总评 + 可操作建议（字符串，供模型/用户引用）。 */
export function diagnoseIntro({ chapters, outline = '', logline = '' }) {
    const rows = (chapters ?? []).slice(0, 3).map((c) => ({
        chapter: c?.chapter, title: c?.title ?? '', ...computeChapterDiagnosis(c?.content ?? ''),
    }));
    const issues = [];
    if (rows.length === 0) issues.push('还没有任何章节——先导入或写第 1 章再来诊断');
    rows.forEach((r) => {
        if (r.hook < 60) issues.push(`第${r.chapter}章章末无强钩子（${r.hook}）——结尾补一问句式悬念/意外转折`);
        if (r.opening < 50) issues.push(`第${r.chapter}章开场偏冗（${r.opening}）——前 120 字内用动作/对话切入`);
        if (r.conflict < 50) issues.push(`第${r.chapter}章冲突密度低（${r.conflict}）——给主角一个立刻要处理的对抗目标`);
        if (r.infodump > 60) issues.push(`第${r.chapter}章信息灌输偏高（${r.infodump}）——把设定拆成行为/事件，别成段说明`);
    });
    if (!outline && rows.length > 0) issues.push('缺少全书大纲——建议先写大纲再铺黄金三章');
    if (!logline && rows.length > 0) issues.push('缺少 logline——一句话立意利于后续每章对齐目标');
    const overall = (() => {
        if (rows.length === 0) return '—';
        const avgHook = rows.reduce((a, r) => a + r.hook, 0) / rows.length;
        const avgConflict = rows.reduce((a, r) => a + r.conflict, 0) / rows.length;
        const worstInfodump = Math.max(...rows.map((r) => r.infodump));
        if (avgHook >= 70 && avgConflict >= 60 && worstInfodump < 60) return '良——黄金三章骨架成立，可继续铺新章';
        if (avgHook >= 55 && avgConflict >= 45) return '可——钩子够但冲突/灌输需回调';
        return '待打磨——建议按 issues 逐条修再推进';
    })();
    return { perChapter: rows, overall, issues };
}