// test/diagnose-quotes.test.mjs — T1 回归护栏：诊断的对白统计必须认**弯引号**。
//
// 背景：lib/punctuation.js 在所有正文入库口把直角引号「」栈式转成弯引号“”（GB/T 15834
// 横排规范），novel_write_chapter 的工具描述也要求「正文一律用弯引号」。而 diagnose.js
// 此前只匹配「」⇒ 守规范的书 hasDialogue 恒假、对白计数恒 0：开场分恒走 60 档、
// 冲突分恒从地板 20 起跳、总评恒「待打磨」（真机 3 本书 6 章「开场」全部 = 60）。
// 修法：抽一份共享对白正则（DIALOGUE_PATTERNS / countDialogue），两处判定共用。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeChapterDiagnosis, countDialogue, diagnoseIntro } from '../lib/diagnose.js';

// 弯引号正文：守规范的书写出来就是这样（本插件落盘口的规范形）
const CURLY = [
    '“你迟到了。”老周把伞收起来，水顺着伞骨往下淌。',
    '“路上有点事。”我没有解释更多。',
    '“三号车厢。”他压着嗓子说，“他已经在里面了。”',
    '我跟着他往前走，鞋底在铁皮上敲出两声响。',
].join('\n\n');

// 同一段内容改成直角引号（导入/粘贴进来的稿子可能还没走规范化）
const CORNER = CURLY.replace(/“/g, '「').replace(/”/g, '」');

// 直引号：老稿与导入稿的第三种形态
const STRAIGHT = CURLY.replace(/“/g, '"').replace(/”/g, '"');

// 无对白正文（全程叙述）
const PLAIN = [
    '雪落在屋檐上，一层叠着一层。',
    '我把炉子拨旺，等壶里的水开。',
    '外面的风敲了敲窗，就没再说话。',
].join('\n\n');

test('T1(a) 弯引号对白必须被识别（旧实现只认「」，这条必挂）', () => {
    assert.ok(countDialogue(CURLY) >= 2, '弯引号对白计数 = ' + countDialogue(CURLY) + '，必须 >=2');
    const d = computeChapterDiagnosis(CURLY);
    assert.ok(d.conflict >= 40, '有对白时冲突分不该停在 20 地板（实得 ' + d.conflict + '）');
    assert.equal(d.opening, 90, '首段是短对白，开场分必须进 90 档而不是 60 档');
});

test('T1(b) 直角引号与弯引号结果必须一致（兼容口径，不改判据）', () => {
    assert.equal(countDialogue(CORNER), countDialogue(CURLY));
    assert.deepEqual(computeChapterDiagnosis(CORNER), computeChapterDiagnosis(CURLY));
});

test('T1(b2) 直引号（老稿/导入稿）同样计入对白', () => {
    assert.ok(countDialogue(STRAIGHT) >= 2, '直引号对白计数 = ' + countDialogue(STRAIGHT));
    assert.deepEqual(computeChapterDiagnosis(STRAIGHT), computeChapterDiagnosis(CURLY));
});

test('T1(c) 无对白正文对白计数必须为 0，冲突分留在 20 地板', () => {
    assert.equal(countDialogue(PLAIN), 0);
    const d = computeChapterDiagnosis(PLAIN);
    assert.equal(d.conflict, 20, '无对白也无冲突词 → 20（旧行为不许被改坏）');
    assert.equal(d.opening, 60, '无对白开场停在 60 档（90 档只给动作/对白切入）');
});

test('T1(d) 端到端：守规范的书第 1 章开场分不再恒 60', () => {
    const chapters = [1, 2, 3].map((n) => ({ chapter: n, title: '第' + n + '章', content: CURLY }));
    const d = diagnoseIntro({ chapters, outline: '有大纲', logline: '一句话立意' });
    assert.equal(d.perChapter.length, 3);
    assert.ok(d.perChapter.every((r) => r.opening === 90), '三章开场分都该进 90 档');
    assert.ok(!d.issues.some((s) => s.includes('开场偏冗')), '不该再报「开场偏冗」');
});
