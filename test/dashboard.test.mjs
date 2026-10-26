import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDashboard } from '../lib/dashboard.js';

test('buildDashboard：进度、提案、诊断与下一步动作聚合', () => {
    const novel = {
        stage: 'writing',
        chapters: {
            1: { title: '一', chars: 2000, latest: 1, summary: 'a' },
            3: { title: '三', chars: 2400, latest: 2, summary: 'b' },
        },
        proposals: [
            { id: 'P1', chapter: 3, status: 'pending', reason: '补钩子' },
            { id: 'P2', chapter: 3, status: 'pending', missing: true, reason: '' },
        ],
    };
    const dash = buildDashboard({
        novel,
        bookOutline: '### 卷一（第 1-10 章）\n- 第 1-10 章：码头据点战、夺符。',
        chapterTexts: [{ n: 1, text: '他到了码头，夺下符牌。' }],
        continuity: { ok: true, stats: { errors: 0, warnings: 2 }, issues: [] },
        diagnosis: { overall: '可', issues: ['第1章章末无强钩子'] },
        proposals: [
            { id: 'P1', chapter: 3, status: 'pending', reason: '补钩子' },
            { id: 'P2', chapter: 3, status: 'pending', missing: true, reason: '' },
        ],
        charConfig: { platform: 'qidian', charMin: 2000, charMax: 4000, charSource: 'platform' },
    });
    assert.equal(dash.progress.chapterCount, 2);
    assert.equal(dash.progress.maxChapter, 3);
    assert.deepEqual(dash.progress.missingChapters, [2]);
    assert.equal(dash.proposals.pending, 2);
    assert.equal(dash.proposals.missing, 1);
    assert.equal(dash.quality.warnings, 2);
    assert.equal(dash.diagnosis.issueCount, 1);
    assert.ok(dash.actions.some((a) => a.action === 'proposals' && /提案索引缺文件/.test(a.text)));
    assert.ok(dash.actions.some((a) => a.action === 'repair' && /章号断档/.test(a.text)));
    assert.equal(dash.readiness, 'blocked');
});

test('buildDashboard：健康书给 ready，并仍要求下一章 align', () => {
    const dash = buildDashboard({
        novel: { chapters: { 1: { chars: 2200, latest: 1 } } },
        bookOutline: '### 卷一（第 1-20 章）\n- 第 1-20 章：码头据点战、夺符。',
        chapterTexts: [{ n: 1, text: '他到了码头，夺下符牌。' }],
        continuity: { ok: true, stats: { errors: 0, warnings: 0 }, issues: [] },
        diagnosis: { overall: '良', issues: [] },
        proposals: [],
    });
    assert.equal(dash.readiness, 'ready');
    assert.equal(dash.progress.nextChapter, 2);
    assert.ok(dash.actions.some((a) => a.action === 'write' && /novel_outline align/.test(a.text)));
});

test('buildDashboard：平台审稿抽样聚成一份下一步判断，不再只给章级散表', () => {
    const dash = buildDashboard({
        novel: { chapters: { 1: { chars: 2200, latest: 1 } } },
        platformReviews: [
            {
                platform: 'qidian', name: '起点', chapter: 1, score: 70,
                passed: false, errorCount: 1, warningCount: 1,
                checks: [
                    { key: 'ending-hook', label: '章末钩子', ok: false, level: 'error', value: '无', target: '钩子', advice: '补悬念' },
                    { key: 'dialogue-ratio', label: '对话占比', ok: false, level: 'warn', value: '5%', target: '15%-45%', advice: '补对话' },
                ],
            },
            { platform: 'qidian', name: '起点', chapter: 2, score: 90, passed: true, errorCount: 0, warningCount: 0, checks: [] },
        ],
    });
    assert.equal(dash.platformReview.available, true);
    assert.equal(dash.platformReview.scanned, 2);
    assert.equal(dash.platformReview.errors, 1);
    assert.equal(dash.platformReview.warnings, 1);
    assert.equal(dash.platformReview.passed, 1);
    assert.equal(dash.platformReview.avgScore, 80);
    assert.equal(dash.readiness, 'attention');
    assert.equal(dash.actions[0].action, 'review');
    assert.match(dash.actions[0].text, /起点审稿命中 1 条硬伤、1 条警告/);
    assert.deepEqual(dash.platformReview.topIssues.map((x) => x.key), ['ending-hook', 'dialogue-ratio']);
});
