// test/outline-align.test.mjs — 细纲对齐行强制（lib/outline-align.js 纯函数面）。
//
// 四条红线：
//   · 对齐行机器形态识别（「对齐：卷X · …」/「本章定位：…」，列表符/序号前缀同认）；
//   · 命中判定：对齐行须含本章所在卷的卷序词或卷标题词——照抄前一卷的旧行不算对齐
//     （25→60 章事故断点的直接形态：对齐行消失或写错卷）；
//   · 卷界未覆盖本章（有卷头但区间够不到）→ 只要求「有对齐行」，不判命中（卷界是大纲自身质量问题）；
//   · 全书大纲无可解析卷结构 → applicable=false 静默跳过（无基准可比，同 divergence 口径，旧书零回归）。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { alignCheck, findAlignLine, volumeHeadingWords, volumeHeadingLines } from '../lib/outline-align.js';

const OUTLINE = [
    '## 卷一 · 凡界（第 1-60 章）',
    '- 第 1-20 章：穿越入世，拜师入门。',
    '## 卷二 · 灵州（第 61-130 章）',
    '- 第 61-80 章：灵州扬名。',
].join('\n');

test('★ 对齐行命中本章卷 → ok=true', () => {
    const r = alignCheck({ bookOutline: OUTLINE, chapter: 3, outline: '对齐：卷一 · 穿越入世\n\n## 本章必写场景\n- 场景A：x。' });
    assert.equal(r.applicable, true);
    assert.equal(r.ok, true, '对齐行含卷序词「卷一」→ 命中');
    // 卷标题词同认（不写卷序、写标题「凡界」也算对齐到本章卷）
    const r2 = alignCheck({ bookOutline: OUTLINE, chapter: 3, outline: '本章定位：凡界·拜师入门' });
    assert.equal(r2.ok, true, '卷标题词命中同认');
});

test('★ 缺对齐行 → ok=false + 指路 message（strict 档据此驳回）', () => {
    const r = alignCheck({ bookOutline: OUTLINE, chapter: 3, outline: '## 本章必写场景\n- 场景A：x。' });
    assert.equal(r.applicable, true);
    assert.equal(r.ok, false);
    assert.equal(r.alignLine, null);
    assert.match(r.message, /对齐/, 'message 指路补对齐行');
    assert.match(r.message, /卷一/, '点名本章所在卷');
});

test('★ 对齐行照抄前一卷（卷序词不匹配）→ ok=false（事故直接形态）', () => {
    // 第 61 章在卷二，细纲却写「对齐：卷一」（上一卷的对齐行没改）
    const r = alignCheck({ bookOutline: OUTLINE, chapter: 61, outline: '对齐：卷一 · 穿越入世' });
    assert.equal(r.ok, false, '卷序词「卷一」不在本章卷（卷二）→ 不算对齐');
    assert.match(r.message, /没有对齐到本章所在卷/, '点名错位');
    // 改对 → ok
    const ok = alignCheck({ bookOutline: OUTLINE, chapter: 61, outline: '对齐：卷二 · 灵州扬名' });
    assert.equal(ok.ok, true);
});

test('卷界未覆盖本章（有卷头但区间够不到）→ 只要求有对齐行', () => {
    const r = alignCheck({ bookOutline: OUTLINE, chapter: 500, outline: '对齐：尾卷 · 收束' });
    assert.equal(r.applicable, true);
    assert.equal(r.ok, true, '有对齐行即过（区间没覆盖到 500，卷界是大纲自身问题，不判命中）');
    const missing = alignCheck({ bookOutline: OUTLINE, chapter: 500, outline: '无对齐行' });
    assert.equal(missing.ok, false, '缺对齐行仍要报（顺带提示卷界缺漏）');
});

test('全书大纲无可解析卷结构 → applicable=false 静默跳过（旧书零回归）', () => {
    assert.equal(alignCheck({ bookOutline: null, chapter: 3, outline: 'x' }).applicable, false);
    assert.equal(alignCheck({ bookOutline: '', chapter: 3, outline: 'x' }).applicable, false);
    // 有标题但无章区间（volumeRange 解析不出）→ 同样无基准
    const noRange = '# 大纲\n第一章 起手\n第二章 布局';
    assert.equal(alignCheck({ bookOutline: noRange, chapter: 3, outline: 'x' }).applicable, false);
});

test('volumeHeadingWords：卷头行 → 卷序词 + 标题词；无区间 → null', () => {
    const w = volumeHeadingWords('## 卷二 · 灵州（第 61-130 章）');
    assert.equal(w.volumeNo, '卷二');
    assert.equal(w.title, '灵州');
    // 区间开区间「第 131 章起」
    const open = volumeHeadingWords('### 卷三（第 131 章起）');
    assert.equal(open.volumeNo, '卷三');
    assert.equal(open.title, '');
    // 无章区间 → null
    assert.equal(volumeHeadingWords('## 写作纪律'), null);
});

test('findAlignLine：多条取最后一条；列表符/序号前缀同认；无前缀行不认', () => {
    assert.equal(findAlignLine('对齐：卷一 · 起'), '卷一 · 起');
    assert.equal(findAlignLine('- 对齐：卷二 · 承'), '卷二 · 承');
    assert.equal(findAlignLine('1. 对齐：卷三 · 转'), '卷三 · 转');
    assert.equal(findAlignLine('（对齐）：卷一'), null, '「（对齐）」带括号的不是对齐行');
    assert.equal(findAlignLine('对齐是好的习惯'), null, '「对齐」后无冒号不算');
    // 多条取最后
    assert.equal(findAlignLine('对齐：卷一\n对齐：卷二 · 承'), '卷二 · 承');
    assert.equal(findAlignLine(''), null);
});

test('volumeHeadingLines：只收可解析区间的卷头行', () => {
    const heads = volumeHeadingLines(OUTLINE);
    assert.equal(heads.length, 2, '两个卷头行');
    assert.equal(volumeHeadingLines('').length, 0);
});

// ── 真书变体识别（某连载本 162 章实测的写法：行式变体 + 段标题式）────
test('findAlignLine：行式变体关键词 + 加粗/列表前缀 + 长行（>60 字不截）', () => {
    assert.equal(findAlignLine('对齐说明：本章落在卷二「县城扬名」区间内，取其对齐含义=石家凭官仓差事在县城立威。'), '本章落在卷二「县城扬名」区间内，取其对齐含义=石家凭官仓差事在县城立威。');
    assert.equal(findAlignLine('- 大纲对齐：卷二"县城扬名"正式起笔'), '卷二"县城扬名"正式起笔', '列表符前缀同认');
    assert.equal(findAlignLine('**本卷对齐**：卷一第6–12章「闭环跑通」段收官'), '卷一第6–12章「闭环跑通」段收官', '加粗前缀同认');
    assert.equal(findAlignLine('本章对齐：卷二第31–70章「县城扬名」——官仓验秤差事在县城立信'), '卷二第31–70章「县城扬名」——官仓验秤差事在县城立信', '「本章对齐」变体');
    assert.equal(findAlignLine('对齐声明：本章落在卷二「县城扬名」（31–70）区间内，欠账候选，本章不兑现'), '本章落在卷二「县城扬名」（31–70）区间内，欠账候选，本章不兑现');
    assert.equal(findAlignLine('卷段对齐（71–120 郡城风云）：本章推进'), '（71–120 郡城风云） 本章推进', '关键词后括注（常载卷标题/区间）保留进对齐文本');
    assert.equal(findAlignLine('对齐是好的习惯'), null, '「对齐」后无冒号不算');
    assert.equal(findAlignLine('  拍：油灯下两半纸对齐'), null, '场景拍里的「对齐」在行中，不算对齐行');
});

test('findAlignLine：段标题式（## 本章定位 / ## 全书大纲对齐）取标题尾注 + 节内正文', () => {
    // 段标题 + 节内首行（卷序词常落在正文首行）
    const sectioned = [
        '## 本章定位',
        '卷一第13–20章「首战黑风寨」段。正秤开市日：辰时校秤当众拆穿主秤新簧。',
        '',
        '## 本章必写场景',
        '- 辰时校秤开场：镇口青石案摆开',
    ].join('\n');
    assert.equal(findAlignLine(sectioned), '卷一第13–20章「首战黑风寨」段。正秤开市日：辰时校秤当众拆穿主秤新簧。', '段标题式：取节内正文行作对齐文本');
    // 尾注式（## 卷段对齐（71–120 郡城风云））
    const tailNote = [
        '## 卷段对齐（71–120 郡城风云）',
        '本章推进银线案收网观测',
        '节奏：势力经营',
    ].join('\n');
    assert.match(findAlignLine(tailNote), /郡城风云/, '尾注里的卷标题词进对齐文本');
    assert.match(findAlignLine(tailNote), /本章推进银线案收网观测/, '节内正文并入');
    // 标题本身带尾注（## 对齐：卷一 · 起）——行式正则先中，尾注即对齐文本
    assert.equal(findAlignLine('## 对齐：卷一 · 起'), '卷一 · 起');
});

test('alignCheck：段标题式对齐文本命中本章卷 → ok=true（存量书带小节不误杀）', () => {
    const outline = '## 全书大纲对齐\n卷一「凡界」1–60章：穿越入世，拜师入门。\n\n## 本章必写场景\n- 场景A：x。';
    const r = alignCheck({ bookOutline: OUTLINE, chapter: 3, outline });
    assert.equal(r.ok, true, '段标题式对齐文本含「卷一」→ 命中');
    // 写错卷（段标题式对齐到卷二、本章在卷一）→ 仍要报不命中（小节不豁免命中判定）
    const wrong = alignCheck({ bookOutline: OUTLINE, chapter: 3, outline: '## 全书大纲对齐\n卷二「灵州」61–130章：扬名。\n## 本章必写场景\n- 场景A：x。' });
    assert.equal(wrong.ok, false, '段标题式对齐文本卷序词不匹配 → 不命中');
    assert.match(wrong.message, /没有对齐到本章所在卷/);
});
