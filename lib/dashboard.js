// lib/dashboard.js — 创作驾驶舱的纯聚合层。
//
// 所有 io 都在 REST 路由完成；这里只把 novel、体检、诊断、里程碑、提案、字数口径
// 折叠成同一个“下一步该做什么”的视图。刻意不落盘、不算分词、不调用模型。

import { milestoneLedger } from './milestone.js';

const intOrNull = (v) => Number.isInteger(v) ? v : null;
const finiteOrZero = (v) => Number.isFinite(v) ? v : 0;

function chapterRows(novel) {
    return Object.entries(novel?.chapters ?? {})
        .filter(([k]) => Number.isInteger(Number(k)) && Number(k) >= 1)
        .map(([k, rec]) => ({
            no: Number(k),
            chars: intOrNull(rec?.chars),
            latest: intOrNull(rec?.latest),
            summary: typeof rec?.summary === 'string' ? rec.summary : '',
        }))
        .sort((a, b) => a.no - b.no);
}

function progressOf(novel) {
    const rows = chapterRows(novel);
    const maxChapter = rows.reduce((m, r) => Math.max(m, r.no), 0);
    const present = new Set(rows.map((r) => r.no));
    const missing = [];
    for (let n = 1; n < maxChapter; n += 1) {
        if (!present.has(n)) missing.push(n);
    }
    const chars = rows.reduce((sum, r) => sum + (r.chars ?? 0), 0);
    return {
        chapterCount: rows.length,
        maxChapter,
        nextChapter: maxChapter + 1,
        missingChapters: missing,
        totalChars: chars,
        avgChars: rows.length > 0 ? Math.round(chars / rows.length) : 0,
    };
}

function outlineOf({ bookOutline, chapterTexts, chapter }) {
    if (typeof bookOutline !== 'string' || bookOutline.trim() === '') {
        return { present: false, total: 0, active: 0, overdue: 0, upcoming: 0, missedTerms: [] };
    }
    const ledger = milestoneLedger({ bookOutline, chapter, chapters: chapterTexts });
    const missedTerms = [...new Set(ledger.overdue.flatMap((r) => r.missed ?? []))].slice(0, 10);
    return {
        present: true,
        total: ledger.total,
        active: ledger.active.length,
        overdue: ledger.overdue.length,
        upcoming: ledger.upcoming.length,
        missedTerms,
    };
}

function proposalsOf(proposals) {
    const rows = Array.isArray(proposals) ? proposals : [];
    const count = (status) => rows.filter((p) => p?.status === status).length;
    return {
        total: rows.length,
        pending: count('pending'),
        superseded: count('superseded'),
        missing: rows.filter((p) => p?.missing === true).length,
        top: rows.filter((p) => p?.status === 'pending' || p?.missing === true).slice(0, 5)
            .map((p) => ({ id: p.id, chapter: intOrNull(p.chapter), missing: p.missing === true, reason: p.reason ?? '' })),
    };
}

function actionsOf(d) {
    const out = [];
    if (d.quality.errors > 0) {
        out.push({ level: 'danger', action: 'repair', text: `全书体检有 ${d.quality.errors} 处硬伤——先跑 novel_project check/repair，再继续写。` });
    }
    if (d.proposals.missing > 0) {
        out.push({ level: 'danger', action: 'proposals', text: `${d.proposals.missing} 条提案索引缺文件——面板打开会失败，先对账。` });
    }
    if (d.progress.missingChapters.length > 0) {
        const head = d.progress.missingChapters.slice(0, 5).join('、');
        out.push({ level: 'warn', action: 'repair', text: `章号断档：第 ${head} 章缺失——先确认是有意删章还是文件漏落盘。` });
    }
    if (!d.outline.present) {
        out.push({ level: 'warn', action: 'outline', text: `全书大纲缺失——先 save_book，再对第 ${d.progress.nextChapter} 章 align。` });
    } else if (d.outline.total === 0) {
        out.push({ level: 'warn', action: 'outline', text: '全书大纲没有可解析的卷规划节点——检查卷头/条目章号格式。' });
    } else if (d.outline.overdue > 0) {
        out.push({ level: 'warn', action: 'align', text: `里程碑有 ${d.outline.overdue} 个欠账候选（${d.outline.missedTerms.slice(0, 4).join('、') || '详见台账'}）——写下一章前核对是否收账或改大纲。` });
    }
    if (d.quality.warnings > 0) {
        out.push({ level: 'warn', action: 'check', text: `全书体检有 ${d.quality.warnings} 条警告——写前扫一遍，避免旧账滚成硬伤。` });
    }
    if (d.proposals.pending > 0) {
        out.push({ level: 'info', action: 'proposals', text: `${d.proposals.pending} 条待批准提案——应用是用户主权动作，先看全文再决定。` });
    }
    if (d.diagnosis.issueCount > 0 && d.progress.chapterCount <= 3) {
        out.push({ level: 'info', action: 'diagnose', text: `黄金三章有 ${d.diagnosis.issueCount} 条结构建议——开篇期优先处理钩子/冲突。` });
    }
    if (out.length === 0) {
        out.push({ level: 'ok', action: 'write', text: `基础信号健康——写第 ${d.progress.nextChapter} 章前仍要 novel_outline align。` });
    }
    return out.slice(0, 6);
}

function platformReviewSummary(rows = []) {
    const reviews = rows.filter((r) => r && typeof r === 'object');
    if (reviews.length === 0) {
        return {
            available: false, platform: '', name: '', scanned: 0,
            errors: 0, warnings: 0, passed: 0, avgScore: 0, topIssues: [],
        };
    }
    const errors = reviews.reduce((n, r) => n + (r.errorCount ?? 0), 0);
    const warnings = reviews.reduce((n, r) => n + (r.warningCount ?? 0), 0);
    const passed = reviews.filter((r) => r.passed === true).length;
    const scored = reviews.filter((r) => Number.isFinite(r.score));
    const avgScore = scored.length > 0
        ? Math.round(scored.reduce((n, x) => n + x.score, 0) / scored.length)
        : 0;
    const topIssues = [];
    for (const level of ['error', 'warn']) {
        for (const r of reviews) {
            for (const c of r.checks ?? []) {
                if (c.ok !== false || c.level !== level) continue;
                topIssues.push({
                    chapter: r.chapter, key: c.key, label: c.label, level,
                    value: c.value, target: c.target, advice: c.advice,
                });
                if (topIssues.length >= 8) {
                    return {
                        available: true, platform: r.platform, name: r.name,
                        scanned: reviews.length, errors, warnings, passed, avgScore, topIssues,
                    };
                }
            }
        }
    }
    return {
        available: true, platform: reviews[0]?.platform ?? '', name: reviews[0]?.name ?? '',
        scanned: reviews.length, errors, warnings, passed, avgScore, topIssues,
    };
}

/**
 * @param {object} o
 * @param {object} o.novel novel.json
 * @param {string} [o.bookOutline] 全书大纲正文
 * @param {Array<{n:number,text:string}>} [o.chapterTexts] 已写正文
 * @param {object} [o.continuity] validateContinuity 结果
 * @param {Array} [o.healthIssues] 存储健康 issue
 * @param {object} [o.diagnosis] 黄金三章诊断
 * @param {Array} [o.proposals] listProposals().proposals
 * @param {{platform:string,charMin:number,charMax:number,charSource:string}} [o.charConfig]
 */
export function buildDashboard(o = {}) {
    const novel = o.novel ?? {};
    const progress = progressOf(novel);
    const continuity = o.continuity ?? { ok: true, stats: { errors: 0, warnings: 0 } };
    const healthRows = Array.isArray(o.healthIssues) ? o.healthIssues : [];
    const diagnosis = o.diagnosis ?? { issues: [], overall: '—' };
    const dash = {
        progress,
        quality: {
            errors: intOrNull(continuity?.stats?.errors) ?? 0,
            warnings: intOrNull(continuity?.stats?.warnings) ?? 0,
            storageIssues: healthRows.length,
            topIssues: (continuity?.issues ?? []).slice(0, 5).map((x) => ({
                severity: x.severity, code: x.code, where: x.where, message: x.message,
            })),
        },
        outline: outlineOf({
            bookOutline: o.bookOutline,
            chapterTexts: o.chapterTexts ?? [],
            chapter: progress.nextChapter,
        }),
        diagnosis: {
            overall: diagnosis?.overall ?? '—',
            issueCount: Array.isArray(diagnosis?.issues) ? diagnosis.issues.length : 0,
            issues: (diagnosis?.issues ?? []).slice(0, 5),
        },
        platform: {
            id: typeof o.charConfig?.platform === 'string' ? o.charConfig.platform : '',
            charMin: intOrNull(o.charConfig?.charMin),
            charMax: intOrNull(o.charConfig?.charMax),
            source: o.charConfig?.charSource ?? 'config',
        },
        proposals: proposalsOf(o.proposals),
    };
    dash.platformReview = platformReviewSummary(o.platformReviews);
    dash.actions = actionsOf(dash);
    if (dash.platformReview.available && (dash.platformReview.errors > 0 || dash.platformReview.warnings > 0)) {
        const label = [
            dash.platformReview.errors > 0 ? `${dash.platformReview.errors} 条硬伤` : '',
            dash.platformReview.warnings > 0 ? `${dash.platformReview.warnings} 条警告` : '',
        ].filter(Boolean).join('、');
        dash.actions.unshift({
            level: dash.platformReview.errors > 0 ? 'warn' : 'info',
            action: 'review',
            text: `${dash.platformReview.name}审稿命中 ${label}——先看抽样结果，再决定改稿还是继续写。`,
        });
    }
    dash.readiness = dash.quality.errors > 0 || dash.proposals.missing > 0
        ? 'blocked'
        : dash.quality.warnings > 0 || dash.outline.overdue > 0 || !dash.outline.present
            || (dash.platformReview.available && dash.platformReview.errors > 0)
            ? 'attention'
            : 'ready';
    return dash;
}
