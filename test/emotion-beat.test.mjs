// test/emotion-beat.test.mjs — 情感节拍卡（lib/emotion-beat.js 纯函数面 + 工具面接线）。
//
// 四条红线：
//   · 行式解析「场景目标|情感基调|读者感受|角色变化」可省段、空拍滤出、坏行进 errors；
//   · 一章一张卡：beat_set 同章覆盖（改弧线改那张，不并影子卡），空卡删除不留空壳；
//   · 简报追加段渲染：无卡返回 ''（调用方整段省略，旧书零回归），有卡逐拍列四格且自封顶；
//   · 工具面：beat_set 落 设定/情感节拍.json、写前简报带出「本章情感弧线」段、beat_list 可查。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    parseEmotionBeatsText, setEmotionBeatCard, emotionBeatFor, renderEmotionBeatSection, validBeatRow,
} from '../lib/emotion-beat.js';

test('★ parse：四段行式可省段 + 注释/空行跳过 + 全空格拍进 errors', () => {
    const raw = [
        '祠堂对峙|压抑|读者紧绷|主角隐忍',
        '# 注释行',
        '',
        '  ',                                   // 全空格 → 静默跳空行
        '|',                                     // 只有分隔符、四格全空 → 空拍进 errors
        '爆发|释然',                              // 只填两格（其余补空，合法）
    ].join('\n');
    const { beats, errors } = parseEmotionBeatsText(raw);
    assert.equal(beats.length, 2, '两条有效拍');
    assert.deepEqual(beats[0], { sceneGoal: '祠堂对峙', emotionTone: '压抑', readerFeeling: '读者紧绷', characterGrowth: '主角隐忍' });
    assert.equal(beats[1].sceneGoal, '爆发', '第二段起填其余补空');
    assert.equal(beats[1].emotionTone, '释然', '第二段填第 2 格（情感基调）');
    assert.equal(errors.length, 1, '全空格拍进 errors 不炸整批');
    assert.deepEqual(parseEmotionBeatsText(''), { beats: [], errors: [] }, '空输入零拍零错');
});

test('★ reconcile：一章一张卡，同章覆盖 + 空卡删除 + 多章共存', () => {
    let cards = setEmotionBeatCard({}, 3, { overallArc: '压抑→爆发', beats: [{ sceneGoal: 'A', emotionTone: 'x', readerFeeling: '', characterGrowth: '' }], now: 't0' }).cards;
    assert.equal(cards['3'], undefined === undefined ? cards['3'] : cards['3']);
    assert.ok(cards['3'] !== undefined, '第3章卡已存');
    // 同章覆盖（改弧线改那张，不并影子卡）
    cards = setEmotionBeatCard(cards, 3, { overallArc: '改过的弧线', beats: [], now: 't1' }).cards;
    assert.equal(cards['3'].overallArc, '改过的弧线');
    assert.equal(cards['3'].beats.length, 0);
    assert.equal(Object.keys(cards).length, 1, '同章不新增键');
    // 多章共存
    cards = setEmotionBeatCard(cards, 7, { overallArc: '另一章', beats: [{ sceneGoal: 'B', emotionTone: 'y', readerFeeling: '', characterGrowth: '' }], now: 't2' }).cards;
    assert.equal(Object.keys(cards).length, 2);
    // 空卡（无弧线无拍）删除该章，不留空壳
    const cleared = setEmotionBeatCard(cards, 7, { overallArc: '', beats: [], now: 't3' });
    assert.equal(cleared.changed, 'cleared');
    assert.equal(cleared.cards['7'], undefined);
    assert.ok(cleared.cards['3'] !== undefined, '其它章不受影响');
});

test('★ render：无卡/全空格 → 空串（整段省略）；有卡逐拍列四格且截断封顶', () => {
    assert.equal(renderEmotionBeatSection(null), '');
    assert.equal(renderEmotionBeatSection({ chapter: 3, overallArc: '', beats: [] }), '', '全空格卡 → 空串');
    const card = {
        chapter: 3, overallArc: '压抑→爆发→释然',
        beats: [
            { sceneGoal: '对峙', emotionTone: '紧绷', readerFeeling: '揪心', characterGrowth: '从隐忍到开口' },
            { sceneGoal: '', emotionTone: '爆发', readerFeeling: '', characterGrowth: '' }, // 半空格，只渲染非空格
        ],
    };
    const body = renderEmotionBeatSection(card);
    assert.match(body, /压抑→爆发→释然/);
    assert.match(body, /目标 对峙｜基调 紧绷｜读者 揪心｜变化 从隐忍到开口/, '格带标签前缀');
    assert.match(body, /情感弧线是写前规划位/, '带节奏提示');
    // 截断封顶：超长的格被 clip
    const long = { chapter: 3, overallArc: 'x'.repeat(200), beats: [{ sceneGoal: 'a'.repeat(200), emotionTone: '', readerFeeling: '', characterGrowth: '' }] };
    const clipped = renderEmotionBeatSection(long);
    assert.ok(clipped.length < 300, '封顶生效');
    assert.ok(!clipped.includes('x'.repeat(100)), '超长格被截断');
});

test('validBeatRow：畸形行滤出', () => {
    assert.ok(validBeatRow({ sceneGoal: 'x', emotionTone: '', readerFeeling: '', characterGrowth: '' }));
    assert.ok(!validBeatRow({ sceneGoal: '', emotionTone: '', readerFeeling: '', characterGrowth: '' }), '四格全空滤出');
    assert.ok(!validBeatRow(null));
    assert.ok(!validBeatRow({ sceneGoal: 'x', emotionTone: 1, readerFeeling: '', characterGrowth: '' }), '非字符串格滤出');
});

// ── 工具面接线（真走 bootPlugin：落盘 + 简报段 + beat_list）────
test('★ 工具面：beat_set 落台账 / 简报带「本章情感弧线」段 / 空卡整段省略 / beat_list', async () => {
    const { bootPlugin } = await import('./helpers/plugin.mjs');
    const p = await bootPlugin({ config: { minChapterChars: 300, maxChapterChars: 20000 } });
    const { tool, exec, cleanup } = p;
    try {
        await tool('novel_project').execute({ action: 'init', book: '节拍书', title: '节拍书' }, exec);

        // 未登记节拍 → 简报无「本章情感弧线」段（旧书零回归）
        const brief0 = await tool('novel_briefing').execute({ book: '节拍书', chapter: 1 }, exec);
        assert.equal(brief0.sections.find((s) => s.name === '本章情感弧线'), undefined, '无卡整段省略');

        // beat_set 登记第 1 章卡
        const set = await tool('novel_ledger').execute({
            action: 'beat_set', book: '节拍书', chapter: 1,
            beatOverallArc: '压抑→爆发→释然',
            beatBeats: '祠堂对峙|压抑|读者紧绷|主角隐忍\n爆发|释然|读者畅快|开口反击',
        }, exec);
        assert.equal(set.beat.chapter, 1);
        assert.equal(set.beat.beats.length, 2);
        assert.equal(set.beat.overallArc, '压抑→爆发→释然');
        // 台账真的落盘（机器状态 JSON，按书隔离）
        const onDisk = JSON.parse(p.read('节拍书/设定/情感节拍.json'));
        assert.ok(onDisk['1'] !== undefined, '第1章卡落盘');
        assert.equal(onDisk['1'].beats.length, 2);

        // 写前简报带出「本章情感弧线」段
        const brief = await tool('novel_briefing').execute({ book: '节拍书', chapter: 1 }, exec);
        const sec = brief.sections.find((s) => s.name === '本章情感弧线');
        assert.ok(sec !== undefined, '有卡 → 简报出情感弧线段');
        assert.match(sec.content, /压抑→爆发→释然/);
        assert.match(sec.content, /对峙/, '逐拍列出');

        // beat_list：单章视图 + 全量视图
        const one = await tool('novel_ledger').execute({ action: 'beat_list', book: '节拍书', chapter: 1 }, exec);
        assert.equal(one.beats.length, 1);
        const all = await tool('novel_ledger').execute({ action: 'beat_list', book: '节拍书' }, exec);
        assert.equal(all.beats.length, 1, '全量 1 张');
    } finally {
        cleanup();
    }
});
