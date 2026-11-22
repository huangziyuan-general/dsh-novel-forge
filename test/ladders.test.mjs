// test/ladders.test.mjs — 进度阶梯台账（lib/ladders.js 纯函数面 + 工具面接线 + 简报段）。
//
// 四条红线：
//   · 行式解析「线名|级别|第N章前应到|验证法」坏行进 errors 不炸整批（缺线名/章号非整数）；
//   · reconcile 线按 name upsert（同章级覆盖、reached 实绩保留），新线 id 走 nextSuffixedId
//     gap 安全；remove 删整线；
//   · ladderStatusAt 判据分离：逾期（计划章已过而未登记实绩）与停滞（达到过但 ≥N 章没再推进）
//     是两条独立信号——「从未达到」不算停滞（拿没有证据当有反证是误报源，S2 同款纪律）；
//   · 工具面：ladder_add 落 账本/阶梯.json（updateJson 同档纪律），ladder_reach 实绩必须落
//     在已写章节上，ladder_check 报告不拦；简报「进度阶梯」段空台账整段省略（旧书零回归）。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    parseLadderLines, reconcileLadders, removeLadders, markReached,
    ladderStatusAt, renderLadderSection, validLadderRow,
} from '../lib/ladders.js';

const LINES = [
    '力量线|筑基|10|突破场景后登账',
    '力量线|金丹|30|渡劫后登账',
    '力量线|元婴|80|',
    '支线·山门线|山门立足|15|近30章有出场',
];

test('★ parse：行式可省验证法 + 坏行进 errors + 同线多级归组', () => {
    const { lines, errors } = parseLadderLines(LINES.join('\n'));
    assert.equal(lines.length, 2, '两条线（同线名归组）');
    assert.equal(lines[0].name, '力量线');
    assert.equal(lines[0].rungs.length, 3, '力量线 3 级');
    assert.deepEqual(lines[0].rungs[0], { chapter: 10, label: '筑基', check: '突破场景后登账' });
    assert.equal(lines[0].rungs[2].check, '', '验证法可省');
    assert.equal(errors.length, 0);
    // 坏行：缺线名 / 章号非正整数
    const bad = parseLadderLines(' |某级|10|x\n线A|某级|abc|验证');
    assert.equal(bad.lines.length, 0);
    assert.equal(bad.errors.length, 2, '坏行进 errors 不炸整批');
    assert.match(bad.errors[0], /缺线名/);
    assert.match(bad.errors[1], /章号/);
    assert.deepEqual(parseLadderLines(''), { lines: [], errors: [] }, '空输入零线零错');
});

test('★ reconcile：线按 name upsert + 同章级覆盖保留 reached + id gap 安全 + remove 删整线', () => {
    const first = reconcileLadders([], [
        { name: '力量线', rungs: [{ chapter: 10, label: '筑基', check: '' }, { chapter: 30, label: '金丹', check: '' }] },
        { name: '爽点线', rungs: [{ chapter: 5, label: '小胜', check: '' }] },
    ]);
    assert.equal(first.lines.length, 2);
    assert.deepEqual(first.added, ['力量线', '爽点线']);
    const ids = first.lines.map((l) => l.id).sort();
    assert.deepEqual(ids, ['L1', 'L2'], '新线 id 续号');
    // 改计划走**整线覆盖**（同名 upsert 替换整条线的级表；reached 实绩保留在
    // 仍存活的同章号格子上——章节号是实绩与计划对齐的锚）
    let base = first.lines;
    const withReached = markReached(base, '力量线', 10, 9).lines; // 第 9 章达标筑基
    const merged = reconcileLadders(withReached, [
        { name: '力量线', rungs: [{ chapter: 10, label: '筑基·证道', check: '新验证' }, { chapter: 30, label: '金丹', check: '' }] },
    ]);
    const power = merged.lines.find((l) => l.name === '力量线');
    assert.equal(power.rungs.length, 2, '整线覆盖不并影子级');
    assert.equal(power.rungs.find((r) => r.chapter === 10).label, '筑基·证道', '新计划字段生效');
    assert.equal(power.rungs.find((r) => r.chapter === 10).reached, 9, '幸存同章号级的实绩保留');
    // 删 L1（力量线）后现存 [L2] → 新线取现存最大+1 = L3（id 只在台账内唯一、
    // 无跨文档引用，不回编已删的 L1 也无历史包袱）
    const removed = removeLadders(merged.lines, ['力量线']);
    assert.equal(removed.lines.length, 1);
    const after = reconcileLadders(removed.lines, [{ name: '支线', rungs: [{ chapter: 20, label: 'x', check: '' }] }]);
    assert.equal(after.lines.find((l) => l.name === '支线').id, 'L3', '新线 id = 现存最大+1');
});

test('★ ladderStatusAt：逾期/停滞判据以计划线为钟——「刚达标下一格在窗口内」不误报', () => {
    const lines = [
        {
            id: 'L1', name: '力量线',
            rungs: [
                { chapter: 10, label: '筑基', check: '', reached: 12 },
                { chapter: 30, label: '金丹', check: '', reached: 40 },
                { chapter: 80, label: '元婴', check: '', reached: null },
            ],
        },
        {
            id: 'L2', name: '支线·山门线',
            rungs: [{ chapter: 15, label: '山门立足', check: '', reached: 15 }],
        },
    ];
    // 第 90 章：力量线元婴（80 章前该到）逾期 + 金丹已达标后元婴逾期 → 停滞对
    const st90 = ladderStatusAt(lines, 90);
    const power = st90.find((s) => s.name === '力量线');
    assert.ok(power.overdue !== null, '元婴逾期（80 章前该到、90 章未到）');
    assert.ok(power.stalled, '力量线停滞（金丹 40 章达标后，元婴 80 章前该到仍未到）');
    assert.equal(power.at?.label, '元婴', '现在应处元婴（≤90 的最高级）');
    assert.equal(power.next, null, '无下一级');
    // 支线单级已达标、无下一步计划 → 不算停滞（没有「下一格」可等；计划要加级才报）
    const side = st90.find((s) => s.name === '支线·山门线');
    assert.equal(side.overdue, null, '支线无逾期（15 章级已达成）');
    assert.equal(side.stalled, false, '单级线无下一步 → 不判停滞（避免把「没计划」当「停了」）');
    assert.equal(side.issues.length, 0);
    // 第 10 章：力量线筑基刚过、无逾期无停滞；支线第 15 章级未到期
    const st10 = ladderStatusAt(lines, 10);
    assert.equal(st10.find((s) => s.name === '力量线').issues.length, 0, '刚达标无问题');
    assert.equal(st10.find((s) => s.name === '支线·山门线').issues.length, 0, '未到计划章不报逾期');
    // 关键回归：第 25 章时点力量线「筑基 12 章达标、金丹计划 30 章才到」→ 窗口内，
    // 既不算逾期也不算停滞（lastReached 判据在这里会误报「停 13 章」）
    const st25 = ladderStatusAt(lines, 25);
    const p25 = st25.find((s) => s.name === '力量线');
    assert.equal(p25.overdue, null, '金丹 30 章前才该到 → 不逾期');
    assert.equal(p25.stalled, false, '下一格在计划窗口内 → 不算停滞');
    assert.equal(p25.issues.length, 0);
    // 「从未达到」不算停滞：全 null reached 的线 → 无停滞对，但逾期照报
    const fresh = ladderStatusAt([
        { id: 'L3', name: '新线', rungs: [{ chapter: 5, label: 'a', check: '', reached: null }] },
    ], 50);
    assert.equal(fresh[0].stalled, false, '从未登记实绩 ≠ 停滞（拿没有证据当有反证是误报源）');
    assert.ok(fresh[0].overdue !== null, '但逾期要报（计划早过了）');
});


test('★ markReached：线/级不存在响亮失败；reached 可回退（同一格实测修正）', () => {
    // 线不存在 → 抛（实绩记在计划外的线 = 台账与计划脱钩，不许静默落盘）
    assert.throws(() => markReached([], '力量线', 10, 9), /阶梯线不存在/);
    // 级不存在 → 抛（级号对不上 ladder_add 的计划章号）
    const lines = [
        { id: 'L1', name: '力量线', rungs: [{ chapter: 10, label: '筑基', check: '', reached: null }] },
    ];
    assert.throws(() => markReached(lines, '力量线', 999, 12), /没有第 999 章这一级/);
    // 正常登记 + 回退（同一格的实测修正，不是时间线追加）
    const ok = markReached(lines, '力量线', 10, 12);
    assert.equal(ok.lines[0].rungs[0].reached, 12);
    const back = markReached(ok.lines, '力量线', 10, 11);
    assert.equal(back.lines[0].rungs[0].reached, 11, '回退实绩合法（判错了就改）');
});

test('renderLadderSection：空台账返回空串；有台账逐线列位置 + 封顶', () => {
    assert.equal(renderLadderSection([], 50), '');
    const lines = [
        { id: 'L1', name: '力量线', rungs: [
            { chapter: 10, label: '筑基', check: '', reached: 12 },
            { chapter: 30, label: '金丹', check: '', reached: null },
        ] },
    ];
    const body = renderLadderSection(lines, 50);
    assert.match(body, /力量线/);
    assert.match(body, /金丹/, '报「下一格」');
    assert.match(body, /逾期/, '第 30 章级 50 章时点未达 → 点名');
    // 封顶
    const many = Array.from({ length: 20 }, (_, i) => ({
        id: `L${i}`, name: `线${i}`, rungs: [{ chapter: 1, label: 'a', check: '', reached: null }],
    }));
    assert.equal(renderLadderSection(many, 50).split('\n').filter((l) => l.startsWith('- ')).length, 8, '封顶 8 线');
});

test('validLadderRow：畸形行滤出', () => {
    assert.ok(validLadderRow({ id: 'L1', name: 'x', rungs: [{ chapter: 1, label: '', check: '', reached: null }] }));
    assert.ok(!validLadderRow(null));
    assert.ok(!validLadderRow({ id: 'L1', name: '', rungs: [] }), '空线名滤出');
    assert.ok(!validLadderRow({ id: 'L1', name: 'x', rungs: [{ chapter: 'a', label: '', check: '', reached: null }] }), '章号非整数滤出');
});

// ── 工具面 + 简报接线（真走 bootPlugin）────
test('★ 工具面：ladder_add 落台账 / ladder_reach 实绩必须已写章 / ladder_check 报告 / 简报段出现与省略', async () => {
    const { bootPlugin, chapterOf } = await import('./helpers/plugin.mjs');
    const p = await bootPlugin({ config: { minChapterChars: 300, maxChapterChars: 20000 } });
    const { tool, exec, cleanup } = p;
    try {
        await tool('novel_project').execute({ action: 'init', book: '阶梯书', title: '阶梯书' }, exec);

        // 无台账 → 简报无「进度阶梯」段（旧书零回归）
        const brief0 = await tool('novel_briefing').execute({ book: '阶梯书', chapter: 1 }, exec);
        assert.equal(brief0.sections.find((s) => s.name === '进度阶梯（该走没走）'), undefined, '空台账整段省略');

        // ladder_add 两条线
        const add = await tool('novel_ledger').execute({
            action: 'ladder_add', book: '阶梯书',
            ladder: '力量线|筑基|10|突破场景后登账\n力量线|金丹|30|渡劫后登账\n支线·山门线|立足|15|近30章有出场',
        }, exec);
        assert.equal(add.ladders.length, 2, '两条线落台账');
        const onDisk = JSON.parse(p.read('阶梯书/账本/阶梯.json'));
        assert.equal(onDisk.length, 2, '台账落盘 账本/阶梯.json');

        // ladder_check（时点=已写 0 章）：无逾期无停滞（都没到计划章）
        let chk = await tool('novel_ledger').execute({ action: 'ladder_check', book: '阶梯书' }, exec);
        assert.equal(chk.ladder.issues.length, 0, '开书时点无问题');

        // 落 1 章 → 实绩登记筑基（ladder_reach 实绩必须落在已写章节）
        await tool('novel_outline').execute({
            action: 'save_chapter', book: '阶梯书', chapter: 1,
            outline: '第1章：突破。出场：主角。\n\n## 本章必写场景\n- 洞府：主角闭关，突破筑基。',
        }, exec);
        await tool('novel_outline').execute({ action: 'approve', book: '阶梯书', chapter: 1 }, exec);
        await tool('novel_write_chapter').execute({
            book: '阶梯书', chapter: 1, title: '突破', content: chapterOf(400), summary: '主角突破筑基', cast: '主角',
        }, exec);
        await tool('novel_ledger').execute({
            action: 'ladder_reach', book: '阶梯书', ladderLine: '力量线', ladderRung: 10, chapter: 1,
        }, exec);
        // 实绩章未写 → 拒绝（静默豁免是绕过路径，不给）
        let reachErr;
        try {
            await tool('novel_ledger').execute({
                action: 'ladder_reach', book: '阶梯书', ladderLine: '支线·山门线', ladderRung: 15, chapter: 9,
            }, exec);
        } catch (e) { reachErr = e; }
        assert.ok(reachErr !== undefined, '实绩章未写被拒');
        assert.match(String(reachErr), /尚未写/);
        // 线不存在 → 响亮失败
        let lineErr;
        try {
            await tool('novel_ledger').execute({
                action: 'ladder_reach', book: '阶梯书', ladderLine: '不存在的线', ladderRung: 10, chapter: 1,
            }, exec);
        } catch (e) { lineErr = e; }
        assert.match(String(lineErr), /阶梯线不存在/);

        // ladder_check 时点 25 章（at 参数）：山门线（15 章级）逾期 + 力量线（10 章级）已达标 1 章、无逾期
        chk = await tool('novel_ledger').execute({ action: 'ladder_check', book: '阶梯书', at: 25 }, exec);
        assert.ok(chk.ladder.lines.find((l) => l.name === '支线·山门线').issues.some((i) => i.includes('逾期') || i.includes('该到')), '山门线逾期点名');
        assert.equal(chk.ladder.lines.find((l) => l.name === '力量线').issues.length, 0, '力量线无问题（10 章级已达标）');

        // 简报带出「进度阶梯」段
        const brief = await tool('novel_briefing').execute({ book: '阶梯书', chapter: 2 }, exec);
        const sec = brief.sections.find((s) => s.name === '进度阶梯（该走没走）');
        assert.ok(sec !== undefined, '有台账 → 简报出进度阶梯段');
        assert.match(sec.content, /力量线/, '逐线列位置');

        // ladder_remove 删整线 → 空台账 → 简报段消失
        await tool('novel_ledger').execute({ action: 'ladder_remove', book: '阶梯书', ladder: '力量线\n支线·山门线' }, exec);
        const brief2 = await tool('novel_briefing').execute({ book: '阶梯书', chapter: 2 }, exec);
        assert.equal(brief2.sections.find((s) => s.name === '进度阶梯（该走没走）'), undefined, '无台账整段省略');
    } finally {
        cleanup();
    }
});
