// 卷结构解析的回归护栏（H6 / LEAD-16）。
//
// 两处缺陷同源：判「这一章属于哪一卷」的解析面一头太窄、一头太宽——
//   · lib/gate.js 的 volumeRange 只认闭合区间，长篇最后一卷常用的「第 N 章起」不认，
//     于是那一卷的「细纲与本卷规划重合度」方向闸整段跳过（每本书的最后一卷＝大揭示所在卷）；
//   · lib/phase-io.js 的 detectVolumePlan 强制「第X卷」，「卷一」这种简写被当成没有分卷，
//     而只要正文出现「分卷」二字又无条件放行——被拦下的人还看不出该写成什么样。
import test from 'node:test';
import assert from 'node:assert/strict';

import { volumeSection } from '../lib/gate.js';
import { detectVolumePlan } from '../lib/phase-io.js';

// 与真实长篇大纲同形：三卷，最后一卷写开区间。
const OUTLINE = [
    '## 分卷结构（三卷）',
    '- 第一卷《编外》：单元剧，收容案。',
    '',
    '## 第一卷《编外》第 1–30 章',
    '- 主线：编外上工。',
    '',
    '## 第二卷《在册》第 31–70 章',
    '- 主线：转入在册。',
    '',
    '## 第三卷《执笔》第 71 章起',
    '- 主线：执笔者的来历。',
].join('\n');

test('★ 卷区间认开区间「第 N 章起」：最后一卷不再整段失去方向闸', () => {
    assert.match(volumeSection(OUTLINE, 4) ?? '', /第一卷/);
    assert.match(volumeSection(OUTLINE, 25) ?? '', /第一卷/);
    assert.match(volumeSection(OUTLINE, 30) ?? '', /第一卷/);
    assert.match(volumeSection(OUTLINE, 40) ?? '', /第二卷/);
    assert.match(volumeSection(OUTLINE, 70) ?? '', /第二卷/);
    for (const n of [71, 96, 120, 400]) {
        assert.match(volumeSection(OUTLINE, n) ?? '', /第三卷/, '第 ' + n + ' 章必须落在第三卷');
    }
});

test('开区间只在行尾生效：正文语义的「第 N 章……」不被误当成区间', () => {
    const outline = [
        '## 第一卷《试》第 1 章 起手就死了人',
        '- 事件甲',
    ].join('\n');
    // 该行既不是闭合区间、起头标记也不在行尾 → 解析不出区间 → 静默跳过（不误判）
    assert.equal(volumeSection(outline, 1), null);
});

test('★ 卷结构判定认「卷一」这类无「第」写法', () => {
    assert.equal(detectVolumePlan('## 卷一《编外》\n- 事件甲'), true);
    assert.equal(detectVolumePlan('## 卷二《在册》\n- 事件乙'), true);
    assert.equal(detectVolumePlan('## 第一卷《编外》第 1–30 章'), true);
    assert.equal(detectVolumePlan('## 分卷结构（三卷）'), true);
});

test('没有卷结构时判定为 false（不误放行）', () => {
    assert.equal(detectVolumePlan('## 主线\n- 事件甲'), false);
    assert.equal(detectVolumePlan(''), false);
    assert.equal(detectVolumePlan('   '), false);
});

// 「卷一」这一支没有「第」当前缀，判据只剩 `[卷幕部篇] + 数字`——不锁在标题行里就会
// 把正文里的数量词当成结构信号：阶段闸（volume 入场条件）无条件放行，等于这道闸没了。
test('★ 无「第」的简写只在标题行内生效：正文里的「3 卷」不算分卷', () => {
    assert.equal(detectVolumePlan('这本设定集分 3 卷出版。'), false, '正文数量词不是结构信号');
    assert.equal(detectVolumePlan('这批书共 12 卷装订成册'), false);
    assert.equal(detectVolumePlan('卷一是废稿，正文另说'), false, '非标题行的「卷一」也不许放行');
    assert.equal(detectVolumePlan('## 卷一《编外》\n这本设定集分 3 卷出版。'), true, '标题行里有结构就认');
});

test('★ 卷区间重叠时后写的卷说了算（开区间不是只有排在最后才安全）', () => {
    // 作者改了卷规划、忘了给老卷头封顶：「卷一 1-100」+「卷二 71 章起」并存。
    // 取第一个命中会让 71-100 章落在卷一，方向闸拿错的规划段比没有闸更坏
    // （它会稳定地报「你拐线了」，而真相只是大纲没改干净）。
    const overlap = [
        '## 卷一（1-100）',
        '- 旧规划：编外上工。',
        '',
        '## 卷二 第 71 章起',
        '- 新规划：转入在册。',
    ].join('\n');
    assert.match(volumeSection(overlap, 40) ?? '', /卷一/, '区间外的章仍归卷一');
    for (const n of [71, 80, 100, 130]) {
        assert.match(volumeSection(overlap, n) ?? '', /卷二/, '第 ' + n + ' 章必须落在后写的卷二');
    }
});

test('标题形状与阶段闸对齐：`#` 后不带空格也认卷头', () => {
    const outline = ['##卷一《编外》（1-30章）', '- 主线：编外上工。'].join('\n');
    assert.equal(detectVolumePlan(outline), true, '阶段闸认这种写法');
    assert.match(volumeSection(outline, 5) ?? '', /卷一/, '方向闸也必须看得见（两处判据不许分家）');
});

// 阶段闸（这里）与方向闸（gate.js 的 volumeSection）的标题形状必须同形：
// CommonMark 的 ATX 标题上限就是 6 个 `#`，7 个以上是普通段落。阶段闸曾用
// `#{1,6}`（无负向断言）——`####### 卷一《编外》` 里前 6 个 `#` 被吞掉、多出的那个 `#`
// 交给 `[^\n]*?` 吃掉，于是普通段落被认成卷头：阶段闸放行而方向闸找不到卷头，
// 那一章的方向闸被整段跳过（两处判据分家的形状与 volumeRange 的漏判同源）。
test('★ 7 个 # 不算标题：阶段闸与方向闸同形状', () => {
    const outline = '- 事件甲';
    const parse7 = detectVolumePlan(`####### 卷一《编外》\n${outline}`);
    const parse2 = detectVolumePlan(`## 卷一《编外》\n${outline}`);
    assert.equal(parse7, false, '7 个 # 是段落不是标题（此前被判成卷头 → 方向闸整段被跳过）');
    assert.equal(parse2, true, '1–6 个 # 照旧认卷头');
    assert.equal(detectVolumePlan('####### 第一卷《编外》第 1-30 章\n- 事件甲'), true,
        '「第X卷」分支本来就不锁标题行（「第」是强结构前缀），本次收紧不影响它');
});
