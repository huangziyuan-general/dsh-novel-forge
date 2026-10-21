// test/continuity-clip.test.mjs — 上下文包「衔接两件套」的裁剪方向锁（DH2 / DH3）。
//
// 真机背景（102 章连载本）：衔接是包里唯一没有旁路获取路径的东西——卡片能 read、
// 世界书能 list、大纲能 read，上一章结尾与最近几章摘要只能整章 read 找回来。所以
// 0.19.2 给它们划了保留额。但保留额只解决了「有没有位子」，没解决「位子里装的是
// 不是要紧的那截」：
//   ① clip 一律截头 —— 「上一章结尾」被截掉的是**结尾本身**（钩子/最后一句），
//      留下的是它前面的背景（药方：去整章 read，上下文两万起跳）。
//   ② 截断标记不计入 cap —— 「按剩余预算现算 cap」的区块会静默超支，预算表对不上账。
//   ③ 结尾排在摘要前面先占位 —— 真机上结尾吃满 600，轮到摘要时 room 只剩十几字，
//      摘要整块进 dropped，模型失去「不用整章 read 也知道最近几章发生了什么」的闸。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildContextPack } from '../lib/contextpack.js';

const HEAD_MARK = '这里是结尾区块的最开头';   // 被截掉的部分留下的指纹
const HEAD_FILLER = '景'.repeat(2000);          // 结尾前面的背景（被截掉的部分）
const TAIL_END = '最后一句：他把账本翻到第七页，指腹压住那行字。';

test('DH2：上一章结尾装不下时保留的是**结尾**，不是开头', () => {
    const pack = buildContextPack({
        chapter: 60,
        chapterOutline: '细'.repeat(1200),
        prevTail: `${HEAD_MARK}${HEAD_FILLER}${TAIL_END}`,
        budget: 4000,
    });
    const sec = pack.sections.find((s) => s.name.includes('上一章结尾'));
    assert.ok(sec, `上一章结尾必须在包里：dropped=${pack.dropped.join(',')}`);
    assert.ok(sec.content.endsWith(TAIL_END),
        '★ 结尾区块的价值全在最后几百字（钩子/最后一句），截头等于把要保的那截扔了');
    assert.ok(!sec.content.includes(HEAD_MARK),
        '★ 装不下时该截的是**前文**，不是把结尾从末尾截掉、留一截开头');
    assert.ok(sec.content.startsWith('…（前文截断）'), '截掉前文时标记在前，别让模型以为是结尾被截');
});

test('DH3：截断标记计入 cap（不再静默超支）', () => {
    const pack = buildContextPack({
        chapter: 60,
        prevTail: '尾'.repeat(3000),
        bookOutline: '纲'.repeat(3000),
        budget: 4000,
    });
    const tail = pack.sections.find((s) => s.name.includes('上一章结尾'));
    const outline = pack.sections.find((s) => s.name === '全书大纲');
    assert.ok(tail.content.length <= 600 + 20, `结尾区块不得明显超出 CAPS.prevTail：${tail.content.length}`);
    assert.ok(outline.content.length <= 700, `大纲区块含标记不得超过 700：${outline.content.length}`);
    assert.ok(outline.content.endsWith('…（截断）'), '截尾部时标记在后');
});

test('DH3：预算紧时摘要不再被结尾整块挤掉（次级保留额）', () => {
    // 预算刻意卡在「结尾吃满 600 之后摘要只剩十几字」的位置：修前摘要整块进 dropped，
    // 模型只能整章 read 找回最近几章——0.16.3 之前「摘要只注入 1–10 章」的同源病根。
    const summaries = Array.from({ length: 12 }, (_, i) => `第${i + 1}章摘要：${'摘'.repeat(90)}`);
    const pack = buildContextPack({
        chapter: 60,
        chapterOutline: '细'.repeat(1200),
        promise: '承'.repeat(600),
        sceneContract: '契'.repeat(500),
        prevTail: '尾'.repeat(1200),
        summaries,
        budget: 3134,
    });
    const names = pack.sections.map((s) => s.name);
    assert.ok(names.some((n) => n.includes('上一章结尾')), `结尾不该被丢：dropped=${pack.dropped.join(',')}`);
    assert.ok(names.some((n) => n.includes('前文章节摘要')),
        `★ 摘要窗口不许被结尾整块挤掉——它是「不用整章 read」的那道闸（dropped=${pack.dropped.join(',')}）`);
    const sum = pack.sections.find((s) => s.name.includes('前文章节摘要'));
    assert.ok(sum.content.includes('第12章摘要'), '★ 淘汰从头部开始，最近一章绝不能掉队');
    assert.deepEqual(pack.recoveryNotes, [], '两件套都在包里就不该喊衔接找回');
});
