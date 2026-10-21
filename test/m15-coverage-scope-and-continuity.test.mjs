// test/m15-coverage-scope-and-continuity.test.mjs
// M15 回归钉（0.19.2）：
//   ① 要素词表只认「本章必写场景」段里的世界书关键词——禁止偏离项里的词被要求「必现」，
//      等于同一句话被读成相反要求（真机第 5–14 章：不解释条文来源 → 要素表要求出现「条文来源」）。
//   ② 上一章结尾必须排在弹性区块之前——否则保留额算得出来、兑现不了（真机第 9–11 章连丢三章）。
//   ③ 细纲写「末段以破折号收尾」，正文收平了要给提醒（真机第 8 章明写断在「——」，成稿句号收尾，零提示）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { declaredCoverageTerms, buildContextPack } from '../lib/contextpack.js';
import { dashEndingNote } from '../lib/gate-metrics.js';

const wb = [{ id: 'clause', keywords: ['借道', '条文来源', '代价'], content: '…', always: false }];

test('要素词表：只在禁止偏离项/任务段出现的关键词不算本章要素', () => {
    const outline = [
        '## 本章任务',
        '- 不解释条文来源；【偿】必须实付，不许写成无代价能力。',
        '## 本章必写场景',
        '- 六点整出厂：车从借道拐进去，声音一起断了。',
        '## 本章禁止偏离项',
        '- 不出现无代价能力：【偿】必须实付。',
    ].join('\n');
    const terms = declaredCoverageTerms({ outline, castNames: ['陈野'], worldEntries: wb });
    assert.ok(terms.includes('陈野'), 'cast 名照收');
    assert.ok(terms.includes('借道'), '必写场景段里出现的关键词仍是要素');
    assert.ok(!terms.includes('条文来源'), '禁止偏离项里的词不许进要素表');
    assert.ok(!terms.includes('代价'), '禁止偏离项里的词不许进要素表');
});

test('要素词表：场景段**存在但为空**时不许退化成空作用域（静默不报比误报更糟）', () => {
    // sectionOf 命中空段返回 ''（不是 undefined）——拿它当作用域会让要素表整表变空，
    // 覆盖率这条链整个消失且无任何提示。空段按「没写场景段」处理，退回全文。
    const outline = '## 本章必写场景\n\n## 本章任务\n- 走借道过去，别惊动人。';
    const terms = declaredCoverageTerms({ outline, castNames: ['陈野'], worldEntries: wb });
    assert.ok(terms.includes('陈野'), '人物名照收');
    assert.ok(terms.includes('借道'), '★ 空场景段不该把要素表整表清空——退回全文匹配');
});

test('要素词表：细纲没写场景段时退回全文匹配（老书口径不变）', () => {
    const outline = '## 本章任务\n- 走借道，讲清条文来源。';
    const terms = declaredCoverageTerms({ outline, castNames: [], worldEntries: wb });
    assert.deepEqual(terms.sort(), ['借道', '条文来源'].sort(), '没有场景段 → 全文匹配照旧');
});

test('上下文包：卡片与世界书装不下时，上一章结尾仍然在包里', () => {
    const pack = buildContextPack({
        chapter: 9,
        chapterOutline: '细'.repeat(1200),
        promise: '承'.repeat(400),
        sceneContract: '契'.repeat(500),
        castCards: [{ name: '陈野', card: '卡'.repeat(700) }, { name: '周传海', card: '卡'.repeat(700) }],
        factsDigest: ['账'.repeat(900)],
        foreshadowDigest: ['伏'.repeat(400)],
        worldEntries: [{ id: 'a', content: '世'.repeat(400) }, { id: 'b', content: '世'.repeat(400) }],
        prevTail: '尾'.repeat(600),
        budget: 4000,
    });
    const names = pack.sections.map((s) => s.name);
    assert.ok(names.some((n) => n.includes('上一章结尾')), `上一章结尾被挤掉了：${names.join('|')} / dropped=${pack.dropped.join(',')}`);
    assert.deepEqual(pack.recoveryNotes, [], '结尾在包里就不该再喊衔接找回');
});

test('格式提醒：细纲要求末段断在破折号上，正文收平要报', () => {
    const outline = '## 本章必写场景\n- 章末钩子：**末段必须收在未闭合的打断句上**：以破折号断在「线两头各有一个——」，不许用句号收平。';
    assert.equal(dashEndingNote('## 本章必写场景\n- 章末钩子：落在门板被拍上。', '甲。\n\n乙。'), null, '细纲没这要求 → 不提醒');
    assert.ok(dashEndingNote(outline, '甲。\n\n墙上有一道线。') !== null, '收平了要报');
    assert.equal(dashEndingNote(outline, '甲。\n\n线两头各有一个——'), null, '断在破折号上就不报');
});
