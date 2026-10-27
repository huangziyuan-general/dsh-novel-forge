// test/noai-cross.test.mjs — 跨章 AI 味频次判据（lib/noai-cross.js）+ 词表并入。
//
// 本项目 noai 的八维**全是「本章内」判据**——单章干净、连着几十章同一个腔调，
// 八维一律满分。那是长篇最典型的 AI 味（同一个动作从头用到尾、每章都以总结收场、
// 反复演同一场戏），也是读者弃书的主要理由。这组测试钉住跨章判据能看见它们。
//
// 同时钉住词表并入（D 项目的 7 类词表）：并进去的是**互补语料**，
// 不得把八维权重或维度数改掉（WEIGHTS 合计恒为 1 是被钉死的红线）。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { crossChapterFlavor, isAphorismEnding, CROSS_DEFAULTS } from '../lib/noai-cross.js';
import { scanAiFlavor } from '../lib/noai.js';

// 垫底段落：**互不相同**（同一句垫十遍会自己造出「单一意象」，那是测试自造的噪声）。
const FILLER_PARTS = [
    '他把灯芯又捻短了一截，屋子里亮了一些。',
    '窗纸上的水痕慢慢往下走，走到一半停住了。',
    '院墙外有狗叫了两声，接着没了动静。',
    '桌上的茶凉了，杯口那圈水痕还在。',
    '门轴上的锈在转动时发出细响。',
    '檐下挂着的铜铃被风碰了一下。',
];

function chapter(text) {
    const head = FILLER_PARTS.slice(0, 3).join('\n\n');
    const tail = FILLER_PARTS.slice(3).join('\n\n');
    return `${head}\n\n${text}\n\n${tail}`;
}

test('格言式收尾判定：总结句算、对话收尾不算、太短不算', () => {
    assert.equal(isAphorismEnding('他走了。\n\n这就是命运。'), true);
    assert.equal(isAphorismEnding('他走了。\n\n“进来吧。”她说。'), false, '对话收尾不算格言');
    assert.equal(isAphorismEnding('他走了。\n\n原来是他。'), false, '太短的反转句不算');
    assert.equal(isAphorismEnding('他走了。\n\n窗外下着雨，街上没有人。'), false);
});

test('★ 标志小动作：同一动作反复出现要报（八维看不见的那类病）', () => {
    const history = [];
    for (let k = 1; k <= 8; k += 1) {
        history.push({ chapter: k, content: chapter('他摩挲着那块玉，指腹在纹路上来回。') });
    }
    const r = crossChapterFlavor({
        content: chapter('他摩挲着那块玉，指腹在纹路上来回。'),
        chapter: 9,
        history,
        options: { totalChapters: 9 },
    });
    assert.ok(r.issues.some((x) => x.includes('标志小动作') && x.includes('摩挲')),
        `必须点名反复出现的动作：${r.issues.join(' | ')}`);
});

test('标志小动作：只出现一两次不报（不制造噪声）', () => {
    const history = [{ chapter: 1, content: chapter('他摩挲着那块玉。') }];
    const r = crossChapterFlavor({
        content: chapter('他把灯芯捻短了一截。'), chapter: 2, history, options: { totalChapters: 2 },
    });
    assert.ok(!r.issues.some((x) => x.includes('标志小动作')), `不该报：${r.issues.join(' | ')}`);
});

test('★ 重复桥段：与前文撞场（8 字重合率高）要报，并点名章号', () => {
    const scene = '雨停的时候，屋檐的水一滴一滴砸在青石板上，把巷子敲得很空。';
    const history = [{ chapter: 3, content: chapter(scene) }];
    const r = crossChapterFlavor({
        content: chapter(scene), chapter: 4, history, options: { totalChapters: 4 },
    });
    assert.ok(r.issues.some((x) => x.includes('重复桥段') && x.includes('3')),
        `必须报出撞的是第几章：${r.issues.join(' | ')}`);
});

test('重复桥段：间隔过近要报（连着两章演同一场戏）', () => {
    const scene = '雨停的时候，屋檐的水一滴一滴砸在青石板上，把巷子敲得很空。';
    const history = [{ chapter: 3, content: chapter(scene) }, { chapter: 4, content: chapter(scene) }];
    const r = crossChapterFlavor({
        content: chapter(scene), chapter: 5, history, options: { totalChapters: 5 },
    });
    assert.ok(r.issues.some((x) => x.includes('间隔过近')), `必须报间隔：${r.issues.join(' | ')}`);
});

test('★ 格言式收尾：全书次数超限要报；相邻两章同型也要报', () => {
    const aphorism = '他合上书。\n\n原来人生不过如此。';
    const history = [
        { chapter: 1, content: aphorism },
        { chapter: 2, content: aphorism },
        { chapter: 3, content: aphorism },
    ];
    const r = crossChapterFlavor({
        content: aphorism, chapter: 4, history, options: { totalChapters: 4 },
    });
    assert.ok(r.issues.some((x) => x.includes('格言式收尾')), `必须报格言式收尾：${r.issues.join(' | ')}`);
    assert.ok(r.issues.some((x) => x.includes('连续两章')), `必须报连续同型：${r.issues.join(' | ')}`);
});

test('「不是A是B」句式：超过 2 处/章要报', () => {
    const many = '这不是愤怒，而是失望。这不是害怕，而是警惕。这不是结束，而是开始。';
    const r = crossChapterFlavor({ content: many, chapter: 1, history: [] });
    assert.ok(r.issues.some((x) => x.includes('不是A是B')), `必须报句式过多：${r.issues.join(' | ')}`);

    const few = '这不是愤怒，而是失望。';
    const r2 = crossChapterFlavor({ content: few, chapter: 1, history: [] });
    assert.ok(!r2.issues.some((x) => x.includes('不是AisB') && x.includes('不是A是B')));
});

test('单一意象：同一意象在一章里刷屏要报', () => {
    // 叙述太短（<60 字）时意象判据不启用——那是「样本不足不判」的纪律，不是缺陷。
    const r = crossChapterFlavor({
        content: '旧铜锣。\n\n'.repeat(30), chapter: 1, history: [],
    });
    assert.ok(r.issues.some((x) => x.includes('单一意象')), `必须报意象刷屏：${r.issues.join(' | ')}`);
});

test('干净章节不报跨章问题（不许制造噪声）', () => {
    const clean = '他把灯芯又捻短了一截，屋子里亮了一些。外头有人在敲门，一下，两下，三下。他没有应。';
    const r = crossChapterFlavor({ content: chapter(clean), chapter: 1, history: [], options: { totalChapters: 1 } });
    assert.deepEqual(r.issues, [], `不该报任何跨章问题：${r.issues.join(' | ')}`);
});

test('阈值可覆盖（调用方说了算，不是写死）', () => {
    assert.equal(CROSS_DEFAULTS.gestureMax, 8);
    const history = [{ chapter: 1, content: chapter('他摩挲着那块玉。') }];
    const r = crossChapterFlavor({
        content: chapter('他摩挲着那块玉。'), chapter: 2, history,
        options: { totalChapters: 2, gestureMax: 0 },
    });
    assert.ok(r.issues.some((x) => x.includes('标志小动作')), '上限调低就该报');
});

test('★ 词表并入（D 的 7 类）：词条在库里，且八维权重/维度数一字未动', async () => {
    const lexicon = (await import('../lib/data/noai-lexicon.json', { with: { type: 'json' } })).default;
    // ① AI 高频词 / ② 弱化副词 / ⑥ 正式语体 → stock（按密度计）
    for (const t of ['映入眼帘', '此时此刻', '心中暗道', '与此同时', '徐徐', '诚然']) {
        assert.ok(lexicon.stock.includes(t), `stock 缺词条：${t}`);
    }
    // ③ 意义膨胀 / ④ 通用结论套话 → cliche（出现即计）
    for (const t of ['叹为观止', '前所未有', '未来可期', '前程似锦', '不得不说']) {
        assert.ok(lexicon.cliche.includes(t), `cliche 缺词条：${t}`);
    }
    // ⑤ 段首总结句 → templates.summaryPatterns
    assert.ok(lexicon.templates.summaryPatterns.some((p) => p.name === '段首总结句'), '缺段首总结句判据');
    // ⑦ 排比三连 → templates.paired
    assert.ok(lexicon.templates.paired.some((p) => p.name === '排比三连'), '缺排比三连判据');
    // 跨章判据要的「标志小动作」词表
    assert.ok(Array.isArray(lexicon.gesture) && lexicon.gesture.includes('摩挲'), '缺 gesture 词表');

    // 八维权重合计仍为 1、仍是八维（不变量：并词表不许动权重与维度数）
    const src = await (await import('node:fs/promises')).readFile(new URL('../lib/noai.js', import.meta.url), 'utf8');
    const m = /const WEIGHTS = \{([^}]+)\}/.exec(src);
    const sum = [...m[1].matchAll(/(\w+):\s*([\d.]+)/g)].map((x) => Number(x[2])).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9, `八维权重合计必须为 1，实得 ${sum}`);
    assert.equal((m[1].match(/:/g) ?? []).length, 8, '应当仍是八维');
});

test('并入后：AI 味样本与干净样本的分数差仍然成立（词表扩充不许把好文本也判脏）', () => {
    const bad = '夜色如水，空气仿佛凝固了。眼底闪过一丝，嘴角勾起一抹弧度。心中暗道：不妙。与此同时，她不由自主地后退了一步。';
    const good = '他把最后一枚铜钱按进香炉，灰烬腾起来，呛得他直咳嗽。院门吱呀一声开了条缝，门外的人没有进来。';
    const b = scanAiFlavor(bad);
    const g = scanAiFlavor(good);
    assert.ok(b.score > g.score + 10, `bad=${b.score} good=${g.score}`);
    assert.ok(g.score < 40, `干净样本不该被判脏：${g.score}`);
});
