// test/gate-alias.test.mjs — 0.20.0 契约判定增强直测：
// ① 场景标题别名（splitTitleAliases/parseScenes/sceneMatched——治「词面偏严」漏判）；
// ② 禁项声明「X不出场」时 resolveSceneCast 自动剔出出场名单（治机审要素噪声）。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { splitTitleAliases, parseScenes, computeGateMetrics } from '../lib/gate-metrics.js';
import { resolveSceneCast } from '../lib/scene-contract.js';

test('splitTitleAliases：括号别名', () => {
    const r = splitTitleAliases('残牌对火（膳庖同源）');
    assert.equal(r.title, '残牌对火');
    assert.deepEqual(r.aliases, ['膳庖同源']);
});

test('splitTitleAliases：竖线别名（多枚，/ 分隔）', () => {
    const r = splitTitleAliases('章末收束｜内心独白/两本账隐喻');
    assert.equal(r.title, '章末收束');
    assert.deepEqual(r.aliases, ['内心独白', '两本账隐喻']);
});

test('splitTitleAliases：拍/字数括号不被当别名（stripSceneMeta 先行）', () => {
    const scenes = parseScenes('- 开柜取纸（拍：洇条/逐字核）：柜面旧痕\n');
    assert.equal(scenes[0].title, '开柜取纸');
    assert.deepEqual(scenes[0].aliases, []);
});

test('parseScenes：无别名条目 aliases 为空数组', () => {
    const scenes = parseScenes('- 名字：卖炭翁问名\n');
    assert.deepEqual(scenes[0].aliases, []);
});

test('sceneMatched/computeGateMetrics：别名命中即算覆盖', () => {
    const outline = '## 本章必写场景\n- 残牌对火（膳庖同源）：残牌揭示同一火头\n- 真题：正文写了这个\n';
    const content = '她把残牌凑近灯下——膳与庖，同一火头、同一道令。真题已写。';
    const m = computeGateMetrics({ content, outline });
    assert.equal(m.available, true);
    assert.equal(m.coverage, 100);
    assert.deepEqual(m.missedScenes, []);
});

test('computeGateMetrics：别名也豁免禁项', () => {
    const outline = '## 本章必写场景\n- 对火（残牌）：揭示\n\n## 本章禁止偏离项\n- 不得使用「残牌」一词\n';
    const m = computeGateMetrics({ content: '对火完成。', outline });
    // 「残牌」是别名 → 禁词被豁免，不判命中
    assert.deepEqual(m.bannedHits, []);
});

test('resolveSceneCast：禁项声明不出场的人被剔出名单', () => {
    const r = resolveSceneCast({
        contract: { participants: '江离、阿萝、汤执事', forbidden: ['阿萝不出场', '现代词汇'], hidden: [] },
        cast: ['江离', '阿萝', '汤执事'],
    });
    assert.deepEqual(r.inject, ['江离', '汤执事']);
    assert.ok(r.dropped.includes('阿萝'));
});

test('resolveSceneCast：禁项非人名（误抓）不影响名单', () => {
    const r = resolveSceneCast({
        contract: { participants: '江离', forbidden: ['储物戒指不出场'], hidden: [] },
        cast: ['江离'],
    });
    assert.deepEqual(r.inject, ['江离']);
});
