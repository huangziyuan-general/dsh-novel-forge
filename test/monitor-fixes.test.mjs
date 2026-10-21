// test/monitor-fixes.test.mjs — 0.20.0 真机《夜半来客》监控轮修复的行为锁定：
// ① proximityHit 短别名同窗共现 ② sceneMatched 2 字别名 ③ detectHookKind foreshadow
// ④ computeGateMetrics chars/targetRatio ⑤ computeAudit metaNarrative
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proximityHit, sceneMatched, computeGateMetrics } from '../lib/gate-metrics.js';
import { detectHookKind } from '../lib/hook.js';
import { computeAudit, paragraphSpecRange } from '../lib/audit.js';

test('proximityHit：跨字拆写的 2 字别名（门闩…自己落了）命中', () => {
    assert.equal(proximityHit('门闩咔地一声，自己落了。', '落闩'), true);
});

test('proximityHit：紧邻 2 字词命中', () => {
    assert.equal(proximityHit('灯也亮了', '灯亮'), true);
});

test('proximityHit：叠字词（去重后不足 2 字）不判——单字共现过宽', () => {
    assert.equal(proximityHit('层层叠叠的山', '层层'), false);
});

test('proximityHit：两字相距超窗（>12）不命中', () => {
    assert.equal(proximityHit('灯灭了。他走了很远的路，路上亮起了星。', '灯亮'), false);
});

test('proximityHit：8 字内命中', () => {
    assert.equal(proximityHit('灯灭了。他走上前，把灯芯挑亮。', '灯亮'), true);
});

test('sceneMatched：主标题未出现、2 字别名跨字拆写也算场景落实', () => {
    const scene = { title: '开门迎客', aliases: ['落闩', '灯亮'], desc: '门板卸下客人进门' };
    assert.equal(sceneMatched('门闩咔地一声，自己落了。灯也亮了。', scene), true);
});

test('sceneMatched：3+ 字别名仍要连续词面（共现只放宽到 2 字）', () => {
    const scene = { title: '开门迎客', aliases: ['门闩落下'], desc: '门板卸下客人进门' };
    // 「门闩…自己落了」对 3 字别名「门闩落下」不构成连续命中；desc 词面也不在场 → 未命中
    const t = '门闩咔地一声，自己落了。灯也亮了。';
    assert.equal(sceneMatched(t, scene), false);
    // 3+ 字别名连续出现走正常 includes → 命中
    assert.equal(sceneMatched('夜里门闩落下了，客人们安歇。', scene), true);
});

test('detectHookKind：预告式收尾（真机《夜半来客》6/6 漏检样例）', () => {
    assert.equal(detectHookKind('明日，第三位客人的日子，就到了。'), 'foreshadow');
    assert.equal(detectHookKind('“他的账，”陈拾说，“簿子也在等。”'), 'foreshadow');
    assert.equal(detectHookKind('是簿子还没落笔。'), 'foreshadow');
    assert.equal(detectHookKind('一封旧账。他说，还没到还的日子。'), 'foreshadow');
    assert.equal(detectHookKind('明日一结的账，讨账的先到了。'), 'foreshadow');
});

test('detectHookKind：普通陈述句与感叹收尾仍不是钩子', () => {
    assert.equal(detectHookKind('他吃完了饭，把碗洗了。'), null);
    assert.equal(detectHookKind('外头有人敲门！'), null);
    // 「今日」不是时间锚（预告式只认未发生的明日/明早/天亮前）
    assert.equal(detectHookKind('他说今日活干完了就回家。'), null);
});

test('detectHookKind：原有语义钩不受影响', () => {
    assert.equal(detectHookKind('敲门声突然响了。'), 'suspense');
    assert.equal(detectHookKind('他到底去哪了？'), 'question');
});

test('computeGateMetrics：chars 与 targetRatio 留痕（非阻断）', () => {
    const outline = '## 本章必写场景\n- 开门迎客｜落闩/灯亮：日头落尽，门闩自落，灯自亮，第一位客人进店。\n\n## 本章禁止偏离项\n- 不得出现现代词汇';
    const content = '门闩咔地一声，自己落了。灯也亮了。';
    const m = computeGateMetrics({ content, outline });
    assert.equal(m.available, true);
    assert.equal(m.chars, content.replace(/\s/g, '').length);
    assert.equal(m.targetRatio, Math.round((m.chars / 3000) * 100));
    const m2 = computeGateMetrics({ content, outline, target: 100 });
    assert.equal(m2.targetRatio, m.chars);
});

test('computeAudit：元叙述（破墙）词计数', () => {
    const clean = computeAudit({ content: '他推门进来，把包袱放下。' });
    assert.equal(clean.metaNarrative, 0);
    const dirty = computeAudit({ content: '他推门进来。故事本该这么写：本章他该死，读者会喜欢的。' });
    assert.ok(dirty.metaNarrative >= 2);
});

test('paragraphSpecRange：长章书（下限 >4500）不许输出倒挂区间', () => {
    // 全项目唯一一份算式，三个消费方（简报/批量起草/驳回文案）都读它——
    // 修前 minChapterChars=5000 → 单段 170–150 字，上下限反着写给模型，比不给更糟。
    for (const n of [2000, 3000, 4500, 5000, 9000]) {
        const spec = paragraphSpecRange({ minChapterChars: n });
        assert.ok(spec.min <= spec.max, `${n} 字下限 → 单段 ${spec.min}–${spec.max} 倒挂了`);
    }
    assert.deepEqual(paragraphSpecRange({ minChapterChars: 3000 }), { min: 100, max: 150 });
    assert.deepEqual(paragraphSpecRange({ minChapterChars: 9000 }), { min: 150, max: 150 }, '长章书钳在上限，不再反向');
});
