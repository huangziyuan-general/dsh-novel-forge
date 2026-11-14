// test/pledges.test.mjs — 叙事契约账本（lib/pledges.js，借鉴天命 Pledge/Deadline/SecretReveal
// + 火宝逻辑审计 schema）。三类契约的登记/改期/终态/超期/审计 + content-gate 第⑨维接入。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    PLEDGE_KINDS, PLEDGE_STATUS, validPledgeRow,
    pledgeSetup, pledgeReplan, pledgeResolve, detectExpiredPledges, pledgeAudit, MAX_PLEDGE_REPLANS, pledgeDigest,
} from '../lib/pledges.js';
import { contentGate } from '../lib/content-gate.js';
import { validateContinuity } from '../lib/continuity.js';

const NOW = '2026-11-14T00:00:00Z';

// ── 登记 ───────────────────────────────────────────────────────────────────

test('pledgeSetup：三类契约基本登记', () => {
    let list = [];
    list = pledgeSetup(list, { kind: 'pledge', subject: '沈墨', statement: '三天内必报仇', chapter: 12, deadlineChapter: 15, now: NOW });
    list = pledgeSetup(list, { kind: 'deadline', subject: '沈墨', statement: '月底前交出名单', chapter: 20, deadlineChapter: 30, now: NOW });
    list = pledgeSetup(list, { kind: 'secret', subject: '沈墨', statement: '假死真相', chapter: 5, deadlineChapter: 40, now: NOW });
    assert.equal(list.length, 3);
    assert.deepEqual(list.map((p) => p.id), ['P1', 'P2', 'P3']);
    assert.ok(list.every(validPledgeRow));
});

test('pledgeSetup：deadline/secret 必须给 deadlineChapter', () => {
    assert.throws(() => pledgeSetup([], { kind: 'deadline', statement: 'x', chapter: 1 }), /deadline/);
    assert.throws(() => pledgeSetup([], { kind: 'secret', statement: 'x', chapter: 1 }), /deadline/);
});

test('pledgeSetup：到期章早于立下章 = 时间线倒挂，拒绝', () => {
    assert.throws(() => pledgeSetup([], { kind: 'pledge', statement: 'x', chapter: 10, deadlineChapter: 5 }), /倒挂/);
});

test('pledgeSetup：重复 id 拒绝（改期走 pledgeReplan）', () => {
    const list = pledgeSetup([], { kind: 'pledge', statement: 'x', chapter: 1, now: NOW });
    assert.throws(() => pledgeSetup(list, { kind: 'pledge', statement: 'y', chapter: 2, id: 'P1', now: NOW }), /已存在/);
});

// ── 改期 / 终态 ─────────────────────────────────────────────────────────────

test('pledgeReplan：open 才允许改期；终态锁定', () => {
    let list = pledgeSetup([], { kind: 'pledge', statement: 'x', chapter: 1, deadlineChapter: 10, now: NOW });
    list = pledgeReplan(list, 'P1', { deadlineChapter: 20, now: NOW });
    assert.equal(list[0].deadlineChapter, 20);
    // 改期后仍 open，可以再次改期
    list = pledgeReplan(list, 'P1', { deadlineChapter: 30, now: NOW });
    assert.equal(list[0].deadlineChapter, 30);
    // 进终态后不能再改期
    list = pledgeResolve(list, 'P1', { status: 'kept', now: NOW });
    assert.equal(list[0].status, 'kept');
    assert.throws(() => pledgeReplan(list, 'P1', { deadlineChapter: 40, now: NOW }), /终态锁定/);
});

test('pledgeResolve：kind 与 status 的合法组合', () => {
    let list = pledgeSetup([], { kind: 'secret', statement: 'x', chapter: 1, deadlineChapter: 10, now: NOW });
    // secret 只能 revealed
    assert.throws(() => pledgeResolve(list, 'P1', { status: 'kept', now: NOW }), /legal/);
    list = pledgeResolve(list, 'P1', { status: 'revealed', now: NOW });
    assert.equal(list[0].status, 'revealed');

    list = pledgeSetup([], { kind: 'pledge', statement: 'x', chapter: 1, now: NOW });
    // pledge 不能 revealed
    assert.throws(() => pledgeResolve(list, 'P1', { status: 'revealed', now: NOW }), /legal/);
    list = pledgeResolve(list, 'P1', { status: 'broken', now: NOW });
    assert.equal(list[0].status, 'broken');
});

test('★ pledgeReplan：改期有上限（不能靠无限延期把到期告警永久静音）', () => {
    let list = pledgeSetup([], { kind: 'deadline', statement: 'x', chapter: 1, deadlineChapter: 10, now: NOW });
    for (let i = 1; i <= MAX_PLEDGE_REPLANS; i += 1) {
        list = pledgeReplan(list, 'P1', { deadlineChapter: 10 + i * 5, now: NOW });
        assert.equal(list[0].replans, i, `第 ${i} 次改期计数落账`);
    }
    assert.throws(
        () => pledgeReplan(list, 'P1', { deadlineChapter: 99, now: NOW }),
        /上限/,
        '超过上限必须拒绝（否则「到期」永远到不了）',
    );
    // 超上限后仍能正常结清
    list = pledgeResolve(list, 'P1', { status: 'kept', now: NOW });
    assert.equal(list[0].status, 'kept');
});

test('★ pledgeResolve：expired 是代码派生态，不许手工登记', () => {
    const list = pledgeSetup([], { kind: 'deadline', statement: '三天内报仇', chapter: 1, deadlineChapter: 5, now: NOW });
    assert.throws(() => pledgeResolve(list, 'P1', { status: 'expired', now: NOW }), /派生态/);
    // 派生态由 detectExpiredPledges 现算，落盘状态仍是 open（只报不写）
    const { expiredIds, list: derived } = detectExpiredPledges(list, 6);
    assert.deepEqual(expiredIds, ['P1']);
    assert.equal(list[0].status, 'open', '原数组不被改写（状态是派生的）');
    assert.equal(derived.find((p) => p.id === 'P1').status, 'expired');
});

test('★ pledgeDigest：显示代码判定的已到期未结条数（派生态不进落盘）', () => {
    const list = pledgeSetup([], { kind: 'pledge', statement: 'x', chapter: 1, deadlineChapter: 5, now: NOW });
    const digest = pledgeDigest(list, 6);
    assert.ok(digest.includes('已到期未结 1'), digest);
    assert.ok(digest.includes('P1'), digest);
});

test('★ 到期提醒不晚一章：写第 2 章时，「第 2 章到期」的契约当场点名', () => {
    const list = pledgeSetup([], { kind: 'deadline', statement: '天亮前交出账册', chapter: 1, deadlineChapter: 2, now: NOW });
    // 落库前 maxWritten=1（第 2 章还没写），门禁必须按 max(maxWritten, chapter) 判到期
    const gate = contentGate({ content: '他把账册推到桌上，没说话。', chapter: 2, pledges: list, maxWritten: 1 });
    assert.ok(gate.warnings.some((w) => w.code === 'pledge-expired'), '本章到期必须本章点名');
    // 未到期的章不虚报
    const early = contentGate({ content: '他把账册推到桌上，没说话。', chapter: 1, pledges: list, maxWritten: 0 });
    assert.ok(!early.warnings.some((w) => w.code === 'pledge-expired'), '未到期不告警');
});

// ── 超期检测（纯算术，代码硬判）────────────────────────────────────────────

test('detectExpiredPledges：maxWritten >= deadlineChapter 且仍 open → expired', () => {
    const list = [
        { id: 'P1', kind: 'pledge', subject: 'A', statement: 'x', chapter: 1, deadlineChapter: 10, status: 'open' },
        { id: 'P2', kind: 'secret', subject: 'B', statement: 'y', chapter: 1, deadlineChapter: 20, status: 'open' },
        { id: 'P3', kind: 'deadline', subject: 'C', statement: 'z', chapter: 1, deadlineChapter: 5, status: 'kept' },
    ];
    const { list: out, expiredIds } = detectExpiredPledges(list, 15);
    // P1 到期（15>=10）且 open → expired；P2 未到（15<20）保持 open；P3 已 kept 不受影响
    assert.deepEqual(expiredIds, ['P1']);
    assert.equal(out.find((p) => p.id === 'P1').status, 'expired');
    assert.equal(out.find((p) => p.id === 'P2').status, 'open');
    assert.equal(out.find((p) => p.id === 'P3').status, 'kept');
});

test('detectExpiredPledges：maxWritten 未达 → 全部保持 open', () => {
    const list = [
        { id: 'P1', kind: 'pledge', subject: 'A', statement: 'x', chapter: 1, deadlineChapter: 10, status: 'open' },
    ];
    const { expiredIds } = detectExpiredPledges(list, 5);
    assert.deepEqual(expiredIds, []);
});

// ── 结构化审计（对齐火宝五类逻辑审计 + 定位到实体/章节）─────────────────────

test('pledgeAudit：到期未兑现（warning）', () => {
    const list = [
        { id: 'P1', kind: 'pledge', subject: '沈墨', statement: '三天内必报仇', chapter: 12, deadlineChapter: 15, status: 'open' },
        { id: 'P2', kind: 'secret', subject: '沈墨', statement: '假死真相', chapter: 5, deadlineChapter: 10, status: 'open' },
    ];
    const issues = pledgeAudit(list, { maxWritten: 20 });
    assert.ok(issues.some((i) => i.code === 'pledge-expired' && i.nodeIds.includes('沈墨')));
    assert.ok(issues.some((i) => i.code === 'secret-overdue' && i.nodeIds.includes('沈墨')));
    // chapters 字段带定位信息
    const exp = issues.find((i) => i.code === 'pledge-expired');
    assert.deepEqual(exp.chapters, [12, 15]);
});

test('pledgeAudit：broken 契约 + 到期未还伏笔 = error（阻断）', () => {
    const list = [
        { id: 'P1', kind: 'pledge', subject: '沈墨', statement: '必护短', chapter: 1, status: 'broken' },
    ];
    const issues = pledgeAudit(list, { maxWritten: 50, dueDebts: [{ id: 'F1' }] });
    assert.ok(issues.some((i) => i.code === 'pledge-broken-later' && i.severity === 'error'));
});

test('pledgeAudit：空 dueDebts 时 broken 不报', () => {
    const list = [
        { id: 'P1', kind: 'pledge', subject: '沈墨', statement: '必护短', chapter: 1, status: 'broken' },
    ];
    const issues = pledgeAudit(list, { maxWritten: 50, dueDebts: [] });
    assert.ok(!issues.some((i) => i.code === 'pledge-broken-later'));
});

test('pledgeAudit：同 id 重复 = error', () => {
    const list = [
        { id: 'P1', kind: 'pledge', subject: 'A', statement: 'x', chapter: 1, status: 'open' },
        { id: 'P1', kind: 'pledge', subject: 'A', statement: 'x', chapter: 2, status: 'open' },
    ];
    const issues = pledgeAudit(list, { maxWritten: 0 });
    assert.ok(issues.some((i) => i.code === 'pledge-duplicate-id'));
});

// ── content-gate 第⑨维接入 ────────────────────────────────────────────────

test('contentGate：到期未兑现契约 → warning；broken + 欠账 → blocking', () => {
    const pledges = [
        { id: 'P1', kind: 'pledge', subject: '沈墨', statement: '三天内必报仇', chapter: 12, deadlineChapter: 15, status: 'open' },
    ];
    const g1 = contentGate({
        content: '他继续赶路。'.repeat(20),
        chapter: 20,
        facts: [], foreshadows: [], pledges,
        relations: [], arcs: [], maxWritten: 20,
    });
    // P1 到期（20>=15）且 open → warning
    assert.ok(g1.warnings.some((w) => w.code === 'pledge-expired'));
    assert.ok(g1.ok, '到期未兑现只 warning 不阻断');

    // broken + 欠账 → 阻断
    const g2 = contentGate({
        content: '他继续赶路。'.repeat(20),
        chapter: 30,
        facts: [],
        foreshadows: [{ id: 'F1', setup: '旧账', chapter: 5, plan: 25, payoffChapter: null }],
        pledges: [{ id: 'P2', kind: 'pledge', subject: '沈墨', statement: '必护短', chapter: 1, status: 'broken' }],
        relations: [], arcs: [], maxWritten: 30,
    });
    assert.ok(!g2.ok, 'broken + 到期未还 = 阻断');
    assert.ok(g2.blocking.some((b) => b.code === 'pledge-broken-later'));
});

// ── validateContinuity 新维度 ─────────────────────────────────────────────

test('validateContinuity：契约账本并入 issues（nodeIds/chapters 定位字段）', () => {
    const novel = {
        chapters: { '1': { path: 'b/第1章-a-v1.md', latest: 1 }, '15': { path: 'b/第15章-a-v1.md', latest: 1 } },
    };
    const pledges = [
        { id: 'P1', kind: 'pledge', subject: '沈墨', statement: '三天内必报仇', chapter: 12, deadlineChapter: 15, status: 'open' },
    ];
    const r = validateContinuity({ novel, facts: [], foreshadows: [], pledges, relations: [], arcs: [] });
    assert.equal(r.stats.pledges, 1);
    assert.ok(r.issues.some((i) => i.code === 'pledge-expired'));
    const exp = r.issues.find((i) => i.code === 'pledge-expired');
    assert.ok(Array.isArray(exp.nodeIds));
    assert.ok(Array.isArray(exp.chapters));
});
