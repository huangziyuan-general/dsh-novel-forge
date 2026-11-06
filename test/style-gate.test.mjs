// test/style-gate.test.mjs — 写章链文风体检（0.21.x）。
//
// 口径：只报句法复杂度 / 抽象度两维，样本 < 5 章跳过；纯函数直测，不碰 io。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { styleGateIssues, STYLE_GATE_MIN_CHAPTERS, STYLE_GATE_DIMS } from '../lib/style.js';
import { capIssueWarnings } from '../lib/voice.js';

/** 造一份够用的基线：只给两维，其余维缺失（judgeAgainstBaseline 有兜底）。 */
function makeBaseline(chapters, syntax, abstract) {
    return {
        chapters,
        dims: {
            syntax: { mu: syntax.mu, sigma: syntax.sigma ?? 0.2, tolerance: syntax.tolerance },
            abstract: { mu: abstract.mu, sigma: abstract.sigma ?? 0.5, tolerance: abstract.tolerance },
        },
    };
}

/** 本章六维测量值（未参与判定的四维给 0，避免 undefined 混进结果）。 */
function makeMetrics(syntax, abstract) {
    return { syntax, abstract, modifier: 0, action: 0, hedging: 0, blank: 0 };
}

const FULL = makeBaseline(10, { mu: 2, tolerance: 15 }, { mu: 1, tolerance: 100 });

test('样本不足：基线 < 5 章时跳过判定并说明原因', () => {
    const gate = styleGateIssues({
        metrics: makeMetrics(2.6, 3),
        baselineRaw: { baseline: makeBaseline(3, { mu: 2, tolerance: 15 }, { mu: 1, tolerance: 100 }) },
        savedChapters: 10,
    });
    assert.equal(gate.status, 'thin');
    assert.equal(gate.chapters, 3);
    assert.deepEqual(gate.issues, []);
    assert.match(gate.reason, new RegExp(`少于 ${STYLE_GATE_MIN_CHAPTERS} 章`));
    assert.match(gate.reason, /novel_style build/);
});

test('没有基线：书还不够章数时不吭声，够了才提示一次性启用', () => {
    const early = styleGateIssues({ metrics: null, baselineRaw: null, savedChapters: STYLE_GATE_MIN_CHAPTERS - 1 });
    assert.equal(early.status, 'disabled');
    assert.equal(early.reason, null);
    assert.deepEqual(early.issues, []);

    const enough = styleGateIssues({ metrics: null, baselineRaw: null, savedChapters: 10 });
    assert.equal(enough.status, 'disabled');
    assert.match(enough.reason, /novel_style build/);
    assert.match(enough.reason, /已存 10 章/);
});

test('偏高告警：句法复杂度与抽象度各自出带，文案带方向、幅度与建议', () => {
    const gate = styleGateIssues({ metrics: makeMetrics(2.6, 3), baselineRaw: { baseline: FULL } });
    assert.equal(gate.status, 'ok');
    assert.equal(gate.issues.length, 2);
    assert.deepEqual(gate.issues.map((i) => i.dim), STYLE_GATE_DIMS);
    const [syntax, abstract] = gate.issues;
    assert.match(syntax.message, /高 30%/);
    assert.match(syntax.message, /μ=2/);
    assert.match(syntax.message, /拆成短句/);
    assert.match(abstract.message, /高 200%/);
    assert.match(abstract.message, /抽象名词/);
});

test('正常不告警：两维都在 μ±容差带内时不出条目', () => {
    const gate = styleGateIssues({ metrics: makeMetrics(2.05, 1.2), baselineRaw: { baseline: FULL } });
    assert.equal(gate.status, 'ok');
    assert.deepEqual(gate.issues, []);
});

test('偏低也报：句法复杂度低于基线与高于同一口径，建议方向相反', () => {
    const gate = styleGateIssues({ metrics: makeMetrics(1.4, 1.2), baselineRaw: { baseline: FULL } });
    assert.equal(gate.issues.length, 1);
    assert.equal(gate.issues[0].dim, 'syntax');
    assert.match(gate.issues[0].message, /低 30%/);
    assert.match(gate.issues[0].message, /并成一句/);
});

test('抽象度偏低不报：动作密集的章 0 命中是常态，不算 AI 腔', () => {
    const gate = styleGateIssues({
        metrics: makeMetrics(2.05, 0),
        baselineRaw: { baseline: makeBaseline(10, { mu: 2, tolerance: 15 }, { mu: 1, tolerance: 16 }) },
    });
    assert.equal(gate.status, 'ok');
    assert.deepEqual(gate.issues, []);
});

test('capIssueWarnings：语音与文风共用一份预算，对象条目保留债务代码', () => {
    const notes = Array.from({ length: 5 }, (_, i) => ({ code: `c${i}`, message: `问题${i + 1}` }));
    const capped = capIssueWarnings(notes, { max: 3, overflow: (n) => `另有 ${n} 项体检提示未展开` });
    assert.equal(capped.length, 3);
    assert.deepEqual(capped.slice(0, 2).map((n) => n.message), ['问题1', '问题2']);
    assert.equal(capped[2].code, 'c2');
    assert.match(capped[2].message, /另有 3 项/);

    // 字符串条目（voiceGateWarnings 旧口径）行为不变
    assert.deepEqual(capIssueWarnings(['a', 'b'], { max: 3 }), ['a', 'b']);
    assert.deepEqual(capIssueWarnings([]), []);
});
