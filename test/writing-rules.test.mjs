// test/writing-rules.test.mjs — 书级写法规则台账（lib/writing-rules.js 纯函数面 + 工具面接线）。
//
// 四条红线：
//   · 解析逐行校验坏行进 errors 不炸整批（静默吞行 = 作者以为登记了其实没有）；
//   · reconcile 按 name upsert + id 续号 gap 安全（nextSuffixedId，删过 R5 不回编 R5）；
//   · 确定性计数阈值：forbidden ≥1 即报 / risk ≥2 成片才报 / encourage 只计数不罚缺；
//   · 工具面：rules_add 落 设定/写法规则.json（updateJson 版本重放），noai 扫描 book 路径
//     出 bookRules 段（report-only 不进八维分），空台账省略该键（宿主 lossless 拒 null）。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    parseWritingRulesText, reconcileWritingRules, scanWritingRules, renderWritingRulesSection,
    RULE_TYPES, validRuleRow,
} from '../lib/writing-rules.js';

const GOOD_TEXT = '他嘴角勾起，眼神深邃地望着远方。她宛如一轮明月。';

// ── 解析 ─────────────────────────────────────────────────────────────

test('parseWritingRulesText：五段行式 + 缺省段 + 注释行 + 坏行不炸整批', () => {
    const raw = [
        '禁嘴角|forbidden|high|嘴角勾起,眼神深邃|改用具体动作',
        '比喻成片|risk|medium|仿佛,宛如,如同|成片时换直写',
        '鼓励短句|encourage|low||句长控制在15字内',   // 鼓励类可不填检测词
        '# 注释行',
        '',
        '',
        '坏类型|xxx|low|词|方向',                      // 类型无效 → errors
    ].join('\n');
    const { rules, errors } = parseWritingRulesText(raw);
    assert.equal(rules.length, 3, '三条合法行进台账');
    assert.deepEqual(rules[0], { name: '禁嘴角', type: 'forbidden', severity: 'high', patterns: ['嘴角勾起', '眼神深邃'], instruction: '改用具体动作' });
    assert.deepEqual(rules[2].patterns, [], '鼓励类无检测词合法');
    assert.equal(errors.length, 1, '坏行进 errors 不炸整批');
    assert.match(errors[0], /类型「xxx」无效/, '坏行错误点名无效类型');
    assert.deepEqual(parseWritingRulesText(''), { rules: [], errors: [] }, '空输入零行零错');
});

test('reconcileWritingRules：name upsert + 新行 id 取现存最大+1 + remove 按名删', () => {
    let rules = reconcileWritingRules([], [
        { name: 'A', type: 'forbidden', severity: 'high', patterns: ['x'], instruction: '' },
        { name: 'B', type: 'risk', severity: 'medium', patterns: ['y'], instruction: '' },
    ]).rules;
    assert.deepEqual(rules.map((r) => r.id), ['R1', 'R2']);
    // 删 B 后现存最大 = R1 → 新行取 R2（id 只在台账内唯一，空位可重用，无跨文档引用）
    rules = reconcileWritingRules(rules, [], ['B']).rules;
    assert.deepEqual(rules.map((r) => r.id), ['R1']);
    const after = reconcileWritingRules(rules, [{ name: 'C', type: 'encourage', severity: 'low', patterns: [], instruction: '短句' }]);
    assert.equal(after.rules.find((r) => r.name === 'C').id, 'R2', '新行 id = 现存最大+1（空位可重用）');
    // 同名 upsert 改检测词，不并影子行
    const up = reconcileWritingRules(after.rules, [{ name: 'C', type: 'encourage', severity: 'high', patterns: ['新词'], instruction: '新方向' }]);
    assert.equal(up.rules.filter((r) => r.name === 'C').length, 1, '同名覆盖不并影子行');
    assert.deepEqual(up.rules.find((r) => r.name === 'C').patterns, ['新词']);
});

test('validRuleRow：畸形行被滤出（台账读坏/手工编辑不炸判定面）', () => {
    assert.ok(validRuleRow({ id: 'R1', name: 'x', type: 'forbidden', severity: 'high', patterns: ['a'] }));
    assert.ok(!validRuleRow(null));
    assert.ok(!validRuleRow({ id: 'R1', name: 'x', type: 'forbidden', severity: 'high', patterns: 'a' }));
    assert.ok(!validRuleRow({ id: 'R1', name: 'x', type: 'xxx', severity: 'high', patterns: ['a'] }), '非法类型滤出');
    assert.deepEqual(RULE_TYPES, ['forbidden', 'risk', 'encourage']);
});

test('★ rules 读动作过滤口径：items 只含 validRuleRow 行（schema items 全 required，坏行不出工具面）', () => {
    // 模拟 style-tool rules 读动作的 base 过滤：手编坏行（缺字段）被滤出，好行原样保留
    const good = { id: 'R1', name: '禁开头', type: 'forbidden', severity: 'high', patterns: ['话说'], instruction: '改具体场景切入' };
    const bad = { id: 'R2', name: '坏行' };
    assert.deepEqual([good, bad].filter(validRuleRow), [good]);
});

// ── 确定性计数 ───────────────────────────────────────────────────────

test('★ scanWritingRules 阈值：forbidden≥1 即报 / risk≥2 成片才报 / encourage 只计数', () => {
    const rules = reconcileWritingRules([], [
        { name: '禁嘴角', type: 'forbidden', severity: 'high', patterns: ['嘴角勾起', '眼神深邃'], instruction: '改用具体动作' },
        { name: '比喻成片', type: 'risk', severity: 'medium', patterns: ['仿佛', '宛如', '如同'], instruction: '成片时换直写' },
        { name: '鼓励短句', type: 'encourage', severity: 'low', patterns: [], instruction: '句长控制在15字内' },
    ]).rules;
    const r = scanWritingRules(GOOD_TEXT, rules);
    // 禁嘴角：「嘴角勾起」「眼神深邃」各 1 次 = 2 命中 → forbidden 报
    assert.equal(r.counts.find((c) => c.name === '禁嘴角').hits, 2);
    // 比喻成片：只有「宛如」1 处（仿佛/如同缺席）→ 未达 2 的成片阈，不报
    assert.equal(r.counts.find((c) => c.name === '比喻成片').hits, 1);
    assert.ok(!r.issues.some((s) => s.includes('比喻成片')), 'risk 单词不报');
    // 鼓励项命中 0 也不罚（不报缺失）
    assert.ok(!r.issues.some((s) => s.includes('鼓励短句')));
    assert.match(r.issues[0], /禁嘴角/, 'forbidden 命中进 issues');
    assert.match(r.issues[0], /改用具体动作/, '修正方向随问题进 issues');
    // 成片才报：堆到 2 处「宛如」
    const r2 = scanWritingRules('她宛如明月，又宛如晨雾。', rules);
    assert.ok(r2.issues.some((s) => s.includes('比喻成片')), 'risk 成片（≥2）触发');
});

test('scanWritingRules：空台账/空文本零命中不炸', () => {
    assert.deepEqual(scanWritingRules('任意正文', []).issues, []);
    assert.deepEqual(scanWritingRules('任意正文', []).counts, []);
    const one = [{ id: 'R1', name: 'x', type: 'forbidden', severity: 'high', patterns: ['无'], instruction: '' }];
    assert.equal(scanWritingRules('', one).counts[0].hits, 0, '空文本 0 命中');
    assert.deepEqual(scanWritingRules('', one).issues, [], '空文本零 issues');
    // 畸形行被 validRuleRow 滤出（台账读坏/手工编辑不炸判定面）
    assert.deepEqual(scanWritingRules('无', [{ type: 'forbidden', patterns: ['无'] }]), { counts: [], issues: [] });
});

// ── 注入渲染 ─────────────────────────────────────────────────────────

test('renderWritingRulesSection：三类标注 + 封顶 + 空台账返回空串', () => {
    const rules = reconcileWritingRules([], [
        { name: '禁嘴角', type: 'forbidden', severity: 'high', patterns: ['嘴角'], instruction: '改用具体动作' },
        { name: '鼓励短句', type: 'encourage', severity: 'low', patterns: [], instruction: '短句' },
        { name: '比喻成片', type: 'risk', severity: 'medium', patterns: ['仿佛'], instruction: '直写' },
    ]).rules;
    const body = renderWritingRulesSection(rules);
    assert.match(body, /【禁用】禁嘴角/);
    assert.match(body, /【推荐】鼓励短句/);
    assert.match(body, /【留意】比喻成片/);
    assert.ok(!/改剧情/.test(body), '渲染只带台账内容');
    assert.equal(renderWritingRulesSection([]), '', '空台账 → 空串（调用方跳过该段）');
});

// ── 工具面接线（真走 bootPlugin：台账落盘 + noai bookRules + 简报段）─────

test('★ 工具面：rules_add 落台账 / noai bookRules 段 / 空台账省略该键 / 简报注入段', async () => {
    const { bootPlugin } = await import('./helpers/plugin.mjs');
    const p = await bootPlugin({ config: { minChapterChars: 300, maxChapterChars: 20000 } });
    const { tool, exec, cleanup } = p;
    try {
        await tool('novel_project').execute({ action: 'init', book: '规则书', title: '规则书' }, exec);
        // rules_add：合法行进台账，坏行进 errors 不炸整批
        const add = await tool('novel_style').execute({
            action: 'rules_add', book: '规则书',
            text: '禁嘴角|forbidden|high|嘴角勾起,眼神深邃|改用具体动作\n坏行|xxx\n鼓励短句|encourage|low||短句',
        }, exec);
        assert.equal(add.rules.count, 2, '两条合法行落台账');
        assert.equal(add.rules.errors.length, 1, '坏行进 errors');
        assert.match(add.rules.errors[0], /类型「xxx」无效/, '坏行点名无效类型');
        // 台账真的落盘（机器状态 JSON，与 facts 同构）
        const onDisk = JSON.parse(p.read(`规则书/设定/写法规则.json`));
        assert.equal(onDisk.length, 2);
        assert.equal(onDisk[0].id, 'R1');
        // rules list 回执
        const list = await tool('novel_style').execute({ action: 'rules', book: '规则书' }, exec);
        assert.equal(list.rules.count, 2);
        // rules_remove 按名删
        const rm = await tool('novel_style').execute({ action: 'rules_remove', book: '规则书', text: '鼓励短句' }, exec);
        assert.equal(rm.rules.count, 1);
        assert.deepEqual(rm.rules.removed, ['鼓励短句']);

        // noai 扫描 book 路径出 bookRules（先落一章：save_chapter → approve → 写章）
        await tool('novel_outline').execute({
            action: 'save_chapter', book: '规则书', chapter: 1,
            outline: '第1章：夜访。出场：守夜人。事件：守夜人夜访祠堂。\n\n## 本章必写场景\n- 祠堂：守夜人夜访，见旧影。',
        }, exec);
        await tool('novel_outline').execute({ action: 'approve', book: '规则书', chapter: 1 }, exec);
        const { chapterOf } = await import('./helpers/plugin.mjs');
        await tool('novel_write_chapter').execute({
            book: '规则书', chapter: 1, title: '夜访',
            content: `${GOOD_TEXT}\n\n${chapterOf(400)}`,
            summary: '守夜人夜访',
        }, exec);
        const scan = await tool('novel_noai_scan').execute({ book: '规则书', chapter: 1 }, exec);
        assert.ok(scan.bookRules !== undefined, '非空台账出 bookRules 段');
        const hit = scan.bookRules.counts.find((c) => c.name === '禁嘴角');
        assert.equal(hit.hits, 2, '「嘴角勾起」+「眼神深邃」各 1 次');
        assert.ok(scan.bookRules.issues.some((s) => s.includes('禁嘴角')));
        // 八维分与 phrases 段不受 bookRules 影响（report-only 不碰加权）
        assert.equal(typeof scan.score, 'number');

        // 删除全部规则 → 空台账：bookRules 键必须**省略**（宿主 lossless 拒 null，缺键合法）
        await tool('novel_style').execute({ action: 'rules_remove', book: '规则书', text: '禁嘴角' }, exec);
        const scan2 = await tool('novel_noai_scan').execute({ book: '规则书', chapter: 1 }, exec);
        assert.ok(scan2.bookRules === undefined, '空台账省略 bookRules 键');

        // 简报注入段：登记规则后写前简报带「写法规则（本书纪律）」段
        await tool('novel_style').execute({
            action: 'rules_add', book: '规则书', text: '禁嘴角|forbidden|high|嘴角勾起,眼神深邃|改用具体动作',
        }, exec);
        const brief = await tool('novel_briefing').execute({ book: '规则书', chapter: 1 }, exec);
        const ruleSec = brief.sections.find((s) => s.name === '写法规则（本书纪律）');
        assert.ok(ruleSec !== undefined, '简报带写法规则段');
        assert.match(ruleSec.content, /【禁用】禁嘴角/);
        // 删规则后简报段消失
        await tool('novel_style').execute({ action: 'rules_remove', book: '规则书', text: '禁嘴角' }, exec);
        const brief2 = await tool('novel_briefing').execute({ book: '规则书', chapter: 1 }, exec);
        assert.ok(brief2.sections.find((s) => s.name === '写法规则（本书纪律）') === undefined, '无规则不注入');
    } finally {
        cleanup();
    }
});
