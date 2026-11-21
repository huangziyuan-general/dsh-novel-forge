// test/world-rules.test.mjs — 世界规则台账（lib/world-rules.js 纯函数面 + 工具面接线）。
//
// 四条红线：
//   · 行式「域|子类|史实锚点|架空改造|冲突优先级」可省段、坏行（缺域/优先级非法）进 errors 不炸整批；
//   · reconcile 按「域·子类」upsert（同名覆盖不并影子行），remove 按域删整域 / 按「域·子类」删单行；
//   · 确定性扫描只在「史实优先」域上扫架空改造成语（均衡/架空优先域写进架空是正常行为不报）；
//   · 工具面：rules_add 落 设定/世界规则.json（updateJson 版本重放），rules_check 对正文
//     报告不拦（report-only），简报带「世界设定纪律」段 / 空台账整段省略。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    parseWorldRulesText, reconcileWorldRules, worldRuleScan, renderWorldRulesSection,
    validWorldRuleRow, RULE_PRIORITIES,
} from '../lib/world-rules.js';

test('★ parse：行式可省段 + 缺域/优先级非法进 errors + 重复域点名', () => {
    const raw = [
        '地理|行政区划|郡县制|无改动|史实优先',
        '力量体系|修炼等级|无|凡/灵/仙九阶|架空优先',      // 子类 + 架空域
        '历史|',                                              // 只声明域、后四段省
        '坏域|坏类|x|y|不存在的优先级',                       // 优先级非法 → errors
        '地理|行政区划|郡县制|改动|架空优先',                  // 重复域（后行覆盖，点名）
        '',
        '# 注释',
    ].join('\n');
    const { rules, errors } = parseWorldRulesText(raw);
    assert.equal(rules.length, 3, '三条合法行');
    assert.equal(rules[0].domain, '地理');
    assert.equal(rules[0].subdomain, '行政区划');
    assert.equal(rules[0].priority, 'fictional', '重复行：后行覆盖前行（架空优先胜出）');
    assert.equal(rules[1].priority, 'fictional');
    assert.equal(rules[2].subdomain, '', '只声明域的子类为空');
    assert.equal(rules[2].priority, 'balanced', '优先级缺省 均衡');
    assert.equal(errors.length, 2, '优先级非法行 + 重复域行各进一条 error（不炸整批）');
    assert.match(errors[0], /冲突优先级/, '坏行点名无效优先级');
    assert.match(errors[1], /重复登记/, '重复域点名（后行覆盖）');
    // 英文优先级同认
    assert.equal(parseWorldRulesText('域|a|b|c|historical').rules[0].priority, 'historical');
    assert.equal(parseWorldRulesText('域|a|b|c|balanced').rules[0].priority, 'balanced');
    assert.deepEqual(parseWorldRulesText(''), { rules: [], errors: [] }, '空输入零行零错');
});

test('★ reconcile：域·子类 upsert + remove 按域删整域 / 按子类删单行', () => {
    let rules = reconcileWorldRules([], [
        { domain: '地理', subdomain: '行政区划', historicalAnchors: '郡县制', fictionalAdaptations: '', priority: 'historical' },
        { domain: '地理', subdomain: '水系', historicalAnchors: '长江', fictionalAdaptations: '', priority: 'historical' },
        { domain: '力量', subdomain: '', historicalAnchors: '', fictionalAdaptations: '九阶', priority: 'fictional' },
    ]).rules;
    assert.equal(rules.length, 3);
    // 同名 upsert 改优先级（不并影子行）
    rules = reconcileWorldRules(rules, [{ domain: '地理', subdomain: '水系', historicalAnchors: '长江改', fictionalAdaptations: '', priority: 'balanced' }]).rules;
    assert.equal(rules.length, 3, 'upsert 不增行');
    assert.equal(rules.find((r) => r.domain === '地理' && r.subdomain === '水系').priority, 'balanced');
    // 按「域·子类」删单行
    let out = reconcileWorldRules(rules, [], ['地理·水系']);
    assert.equal(out.rules.length, 2);
    assert.deepEqual(out.removed, ['地理·水系']);
    // 按域删整域（地理剩一行 + 力量一行 → 删「地理」全清）
    out = reconcileWorldRules(out.rules, [], ['地理']);
    assert.equal(out.rules.length, 1, '域删掉该域全部子行');
    assert.equal(out.rules[0].domain, '力量');
    // 删不存在的域不报错、不计入 removed
    out = reconcileWorldRules(out.rules, [], ['不存在']);
    assert.deepEqual(out.removed, []);
});

test('★ scan：只在史实优先域扫架空改造成语；均衡/架空域不扫；短改造句不扫', () => {
    const rules = reconcileWorldRules([], [
        { domain: '历史', subdomain: '官制', historicalAnchors: '三省', fictionalAdaptations: '都察院统辖百官', priority: 'historical' },
        { domain: '力量', subdomain: '', historicalAnchors: '', fictionalAdaptations: '灵珠认主', priority: 'fictional' },   // 架空优先 → 不扫
        { domain: '地理', subdomain: '', historicalAnchors: '', fictionalAdaptations: '短', priority: 'historical' },       // <4 字 → 不扫
    ]).rules;
    // 正文命中史实域的架空改造成语
    const hit = worldRuleScan('朝堂之上，都察院统辖百官，无人敢言。', rules);
    assert.equal(hit.counts.length, 1);
    assert.equal(hit.counts[0].domain, '历史·官制');
    assert.ok(hit.issues[0].includes('都察院统'), '点名命中的 4 字滑窗成文语');
    assert.ok(hit.issues[0].includes('report-only'), '口径明示不拦');
    // 无命中 → 零 issues
    const clean = worldRuleScan('他推门进屋。', rules);
    assert.deepEqual(clean.issues, []);
    assert.deepEqual(clean.counts, []);
    // 架空优先域写进架空 = 正常行为（不扫）
    const fiction = worldRuleScan('灵珠认主的那一刻，他握紧了剑。', rules);
    assert.deepEqual(fiction.issues, [], '架空优先域不扫');
    // 空台账/空文本零命中不炸
    assert.deepEqual(worldRuleScan('x', []).issues, []);
    assert.deepEqual(worldRuleScan('', rules).issues, []);
});

test('validWorldRuleRow + RULE_PRIORITIES 枚举面', () => {
    assert.deepEqual(RULE_PRIORITIES, ['historical', 'fictional', 'balanced']);
    assert.ok(validWorldRuleRow({ domain: 'x', subdomain: '', historicalAnchors: '', fictionalAdaptations: '', priority: 'balanced' }));
    assert.ok(!validWorldRuleRow({ domain: '', subdomain: '' }), '空域滤出');
    assert.ok(!validWorldRuleRow({ domain: 'x', priority: 'xxx' }), '非法优先级滤出');
    assert.ok(!validWorldRuleRow(null));
    assert.ok(!validWorldRuleRow({ domain: 'x', historicalAnchors: 1 }), '非字符串格滤出');
});

test('★ renderWorldRulesSection：域分组 + 冲突口径标注 + 封顶 + 空台账返回空串', () => {
    const rules = reconcileWorldRules([], [
        { domain: '历史', subdomain: '官制', historicalAnchors: '三省六部', fictionalAdaptations: '都察院', priority: 'historical' },
        { domain: '历史', subdomain: '历法', historicalAnchors: '', fictionalAdaptations: '阴阳月', priority: 'balanced' },
        { domain: '力量', subdomain: '', historicalAnchors: '', fictionalAdaptations: '九阶', priority: 'fictional' },
    ]).rules;
    const body = renderWorldRulesSection(rules);
    assert.match(body, /【历史】/);
    assert.match(body, /史实优先/);
    assert.match(body, /架空优先/);
    assert.match(body, /【力量】/);
    assert.ok(renderWorldRulesSection([]) === '', '空台账 → 空串（调用方跳过该段）');
});

// ── 工具面接线（真走 bootPlugin：台账落盘 + rules_check + 简报段）────
test('★ 工具面：rules_add 落台账 / rules_check 报告不拦 / 简报「世界设定纪律」段出现与消失', async () => {
    const { bootPlugin, chapterOf } = await import('./helpers/plugin.mjs');
    const p = await bootPlugin({ config: { minChapterChars: 300, maxChapterChars: 20000 } });
    const { tool, exec, cleanup } = p;
    try {
        await tool('novel_project').execute({ action: 'init', book: '规则书', title: '规则书' }, exec);

        // rules_add：合法行落台账，坏行进 errors 不炸整批
        const add = await tool('novel_worldbook').execute({
            action: 'rules_add', book: '规则书',
            payload: '历史|官制|三省六部|都察院统辖百官|史实优先\n坏行|x|y|z|不存在\n力量|||九阶|架空优先',
        }, exec);
        assert.equal(add.rules.count, 2, '两条合法行落台账');
        assert.equal(add.rules.errors.length, 1, '坏行进 errors');
        // 台账真的落盘（按书隔离的机器状态 JSON）
        const onDisk = JSON.parse(p.read('规则书/设定/世界规则.json'));
        assert.equal(onDisk.length, 2);
        assert.equal(onDisk[0].domain, '历史');
        assert.equal(onDisk[0].priority, 'historical');
        // rules list 回执
        const list = await tool('novel_worldbook').execute({ action: 'rules', book: '规则书' }, exec);
        assert.equal(list.rules.count, 2);

        // 简报带「世界设定纪律」段
        let brief = await tool('novel_briefing').execute({ book: '规则书', chapter: 1 }, exec);
        let sec = brief.sections.find((s) => s.name === '世界设定纪律');
        assert.ok(sec !== undefined, '非空台账出世界设定纪律段');
        assert.match(sec.content, /史实优先/);

        // rules_check：先落一章（正文含架空改造成语）→ 史实域被点名（report-only 不拦）
        await tool('novel_outline').execute({
            action: 'save_chapter', book: '规则书', chapter: 1,
            outline: '第1章：朝堂。出场：史官。\n\n## 本章必写场景\n- 朝堂：史官上朝，见都察院统辖百官。',
        }, exec);
        await tool('novel_outline').execute({ action: 'approve', book: '规则书', chapter: 1 }, exec);
        await tool('novel_write_chapter').execute({
            book: '规则书', chapter: 1, title: '朝堂',
            content: `朝堂之上，${chapterOf(400)}`, summary: '史官上朝',
        }, exec);
        const check = await tool('novel_worldbook').execute({ action: 'rules_check', book: '规则书', chapter: 1 }, exec);
        assert.ok(check.ruleCheck.chapter === 1);
        assert.ok(Array.isArray(check.ruleCheck.issues), 'issues 为数组（report-only）');
        assert.ok(Array.isArray(check.ruleCheck.counts));

        // rules_remove 按域删整域 → 空台账：简报段消失
        const rm = await tool('novel_worldbook').execute({
            action: 'rules_remove', book: '规则书', payload: '历史\n力量',
        }, exec);
        assert.equal(rm.rules.count, 0);
        assert.deepEqual(rm.rules.removed, ['历史', '力量']);
        brief = await tool('novel_briefing').execute({ book: '规则书', chapter: 1 }, exec);
        assert.equal(brief.sections.find((s) => s.name === '世界设定纪律'), undefined, '空台账整段省略');
    } finally {
        cleanup();
    }
});
