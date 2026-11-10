// 局部句式聚集扫描（1.6.x）：过渡词重复 / 一句内缓冲词聚集 / 动作副词聚集。
// 只报不判、不改八维结构与分数；引号内台词不参与统计。

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    scanLocalStyleSignals, localStyleSignalMessage, scanAiFlavor,
    LOCAL_STYLE_DEFAULTS,
} from '../lib/noai.js';

/** 凑到章级样本长度：每句不同，避免触发别的判据。 */
function pad(target = '') {
    const filler = Array.from({ length: 30 }, (_, i) => `他沿着长街走到第${i + 1}个路口，看见檐下的灯还亮着。`).join('\n\n');
    return `${filler}\n\n${target}`;
}

test('过渡词：章内 ≥3 次才报，2 次不报（外部默认 2 过激进）', () => {
    assert.equal(LOCAL_STYLE_DEFAULTS.transitionRepeatCount, 3);
    const three = pad('与此同时，门外的脚步停了。\n\n与此同时，灯芯爆了一下。\n\n与此同时，她把手缩回袖子里。');
    const r = scanLocalStyleSignals(three);
    assert.equal(r.status, 'ok');
    const f = r.findings.find((x) => x.ruleId === 'template.transition');
    assert.ok(f !== undefined, '三次必须报');
    assert.equal(f.terms[0], '与此同时');
    assert.equal(f.hits, 3);
    assert.ok(localStyleSignalMessage(f).includes('与此同时'));

    const two = pad('与此同时，门外的脚步停了。\n\n与此同时，灯芯爆了一下。');
    assert.equal(scanLocalStyleSignals(two).findings.some((x) => x.ruleId === 'template.transition'), false, '两次不报');
});

test('句内缓冲词聚集：一句 ≥3 个才报；两个不报', () => {
    const three = pad('他似乎隐隐觉得，这背后有某种说不清的东西。');
    const f = scanLocalStyleSignals(three).findings.find((x) => x.ruleId === 'surface.repeated-softeners');
    assert.ok(f !== undefined, '似乎/隐隐/某种 = 3 个必须报');
    assert.deepEqual(new Set(f.terms), new Set(['似乎', '隐隐', '某种']));
    assert.ok(localStyleSignalMessage(f).includes('缓冲词'));

    const two = pad('他似乎隐隐觉得，这背后有说不清的东西。');
    assert.equal(scanLocalStyleSignals(two).findings.some((x) => x.ruleId === 'surface.repeated-softeners'), false, '两个不报');
});

test('动作副词聚集：一句 ≥3 个才报', () => {
    const three = pad('她缓缓地、微微地、轻轻地抬起手。');
    const f = scanLocalStyleSignals(three).findings.find((x) => x.ruleId === 'surface.action-adverb-stack');
    assert.ok(f !== undefined);
    assert.deepEqual(new Set(f.terms), new Set(['缓缓', '微微', '轻轻']));
    assert.ok(localStyleSignalMessage(f).includes('动作副词'));
});

test('引号内合法用法不误报：台词里的副词/过渡词不统计', () => {
    const dialogue = pad('“缓缓，微微，轻轻，你倒是说句话啊。”\n\n“与此同时，与此同时，与此同时。”');
    const r = scanLocalStyleSignals(dialogue);
    assert.deepEqual(r.findings, [], '引号内重复是角色说话，不算叙述聚集');
});

test('短样本返回 insufficient（polish 逐段调用不触发章级判据）', () => {
    const r = scanLocalStyleSignals('似乎隐隐某种东西。');
    assert.equal(r.status, 'insufficient');
    assert.deepEqual(r.findings, []);
});

test('不改八维：scanAiFlavor 返回结构与八维键不变', () => {
    const r = scanAiFlavor(pad('他推门进来，把灯挑亮。'));
    assert.deepEqual(Object.keys(r).sort(), ['categories', 'chars', 'level', 'score', 'topIssues']);
    assert.deepEqual(Object.keys(r.categories).sort(), [
        'cliche', 'defaultword', 'dilution', 'emotion', 'formula', 'stock', 'structure', 'template',
    ]);
});
