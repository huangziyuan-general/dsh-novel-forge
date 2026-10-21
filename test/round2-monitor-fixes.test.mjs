// test/round2-monitor-fixes.test.mjs — 1.0.2 真机《深夜订单》监控轮修复的行为锁定：
// ① W2 sceneMatched desc 全 <3 字兜底 ② W3 许可触发词扩展 + 否定守卫
// ③ W4 预约/推送式收尾钩子 ④ W5 ledger schema 暴露 list 动作
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sceneMatched, parseBanRules, dashEndingNote } from '../lib/gate-metrics.js';
import { detectHookKind } from '../lib/hook.js';
import { defineLedgerTool } from '../lib/tools/ledger-tool.js';

test('W2：desc 全由 <3 字词组成时降级 ≥2 字互证命中（谢谢，兄弟）', () => {
    assert.equal(sceneMatched('他笑了笑。“谢谢，兄弟。”', { title: '交接', desc: '谢谢，兄弟' }), true);
});

test('W2：兜底词正文未出现仍判漏（互证不破）', () => {
    assert.equal(sceneMatched('屋里没人，只有风穿过门缝。', { title: '交接', desc: '谢谢，兄弟' }), false);
});

test('W2：≥3 字 token 在场时走原路径不受影响', () => {
    assert.equal(sceneMatched('打卡机吐出一张倒单，纸是热的。', { title: '倒单', desc: '打卡机吐出一张倒单' }), true);
});

test('W2 反例：兜底只抽出 1 个词时不启用（否则「谢谢」任意出现即算场景命中）', () => {
    // 注释承诺「两条短词须同时出现」，修前代码没这条保证：单 token 时判据退化成
    // 「正文任意处出现该词」——一个通用词随处可见，命中不携带「场景落实了」的信息，
    // 却会把「漏场景」的警告静默吞掉（假阳性，放行方向）。
    assert.equal(sceneMatched('他随口说了句谢谢就走了。', { title: '交接', desc: '谢谢' }), false,
        '★ desc 只有一个通用词时，不该因为正文里出现过就算命中');
    assert.equal(sceneMatched('甲谢谢乙，丙谢谢丁。', { title: '交接', desc: '谢谢，呀' }), false);
    // 两个词仍在：互证结构不受影响
    assert.equal(sceneMatched('他笑了笑。“谢谢，兄弟。”', { title: '交接', desc: '谢谢，兄弟' }), true);
});

test('破折号要求：禁令型细纲不许被读成要求（反向指令比漏提醒危险）', () => {
    // 细纲写「章末**不得**用破折号收尾」时形状与要求型完全一致，修前照单收下 →
    // 提醒文案反过来劝模型把末段收在破折号上，等于让它违反自己的细纲。
    assert.equal(dashEndingNote('## 本章禁止偏离项\n- 章末不得用破折号收尾，不许断在半句上。', '甲。\n\n乙。'), null,
        '★ 禁令不是要求：不许反过来要求模型加破折号');
    assert.equal(dashEndingNote('## 本章禁止偏离项\n- 末段不许以——收尾。', '甲。\n\n乙。'), null);
    // 只陈述、没祈使语气也不算硬要求
    assert.equal(dashEndingNote('## 本章任务\n- 这一章的末段讲到破折号为止。', '甲。\n\n乙。'), null);
    // 真要求照报；同一行里并列的「不许用句号收平」不该把要求误杀
    assert.ok(dashEndingNote('## 本章必写场景\n- 章末钩子：末段必须收在破折号上，断在半句。', '甲。\n\n乙。') !== null);
    assert.ok(dashEndingNote('## 本章必写场景\n- 章末钩子：**末段必须收在未闭合的打断句上**：以破折号断在「线两头各有一个——」，不许用句号收平。', '甲。\n\n乙。') !== null,
        '★ 否定守卫只查命中跨度，同行的并列禁令不误杀真要求');
});

test('W3：许可句「只称「老马」」归条件型，不入禁词表', () => {
    const r = parseBanRules('## 本章禁止偏离项\n- 老马只称「老马」，不得让其他称呼出现。');
    assert.ok(!r.banned.includes('老马'), 'banned 不应含 老马: ' + JSON.stringify(r.banned));
    assert.ok(r.conditional.includes('老马'), 'conditional 应含 老马: ' + JSON.stringify(r.conditional));
});

test('W3：否定守卫——「不得只写「大人」」仍是禁令', () => {
    const r = parseBanRules('## 本章禁止偏离项\n- 不得只写「大人」。');
    assert.ok(r.banned.includes('大人'), 'banned 应含 大人: ' + JSON.stringify(r.banned));
    assert.ok(!r.conditional.includes('大人'), 'conditional 不应含 大人: ' + JSON.stringify(r.conditional));
});

test('W3：普通禁令不受影响', () => {
    const r = parseBanRules('## 本章禁止偏离项\n- 不出现「系统」。');
    assert.ok(r.banned.includes('系统'), 'banned 应含 系统: ' + JSON.stringify(r.banned));
});

test('W4：【】推送标签收尾判 announce', () => {
    assert.equal(detectHookKind('雨停了。【配送完成】明晚十点整。'), 'announce');
});

test('W4：「配送时间：」冒号开场判 announce', () => {
    assert.equal(detectHookKind('他看了看单子。配送时间：明晚十点整。'), 'announce');
});

test('W4：普通时间陈述句不误判', () => {
    assert.equal(detectHookKind('他喝完粥，把碗洗了。'), null);
});

test('W4 反例：【】标签后接普通叙事不判 announce（首版假阳性）', () => {
    // 首版只要求「【】后跟 ≤20 个非句号字符」，这两句都会被打成 announce——
    // 把「无钩」报成「有钩」等于放行一次真正的断章，比漏检贵。
    assert.equal(detectHookKind('他退回屋里。【系统提示】他点了点头。'), null,
        '★ 【】标签后没有约定时点，不该算预约式收尾');
    assert.equal(detectHookKind('雨停了。【配送完成】他关掉面板。'), null,
        '★ 【配送完成】标签本身不说明章末钉了时点');
    assert.equal(detectHookKind('他走到门口时停下了。【第一章】'), null,
        '★ 单字「时」不构成约定时点（否则普通叙事全成钩子）');
});

test('W4 反例：冒号开场后接普通内容不判 announce', () => {
    assert.equal(detectHookKind('他看了看单子。配送时间：另行通知。'), null);
});

test('W4 正例（不得被取窄误伤）：标签/冒号后确有约定时点仍判 announce', () => {
    assert.equal(detectHookKind('雨停了。【配送完成】明晚十点整。'), 'announce');
    assert.equal(detectHookKind('他关掉面板。【系统提示】三分钟后送达。'), 'announce');
    assert.equal(detectHookKind('他看了看单子。配送时间：明晚十点整。'), 'announce');
    assert.equal(detectHookKind('单子压在碗下。取餐时间：十二点。'), 'announce');
});

test('W5：ledger schema 暴露 list 动作', () => {
    const anyObj = new Proxy({}, { get: () => ({}) });
    const tool = defineLedgerTool(anyObj, anyObj);
    assert.ok(tool.parameters.properties.action.enum.includes('list'),
        'enum 应含 list: ' + JSON.stringify(tool.parameters.properties.action.enum));
});
