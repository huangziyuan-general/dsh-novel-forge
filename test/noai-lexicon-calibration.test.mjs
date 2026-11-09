// test/noai-lexicon-calibration.test.mjs — 词库条目身份 + 真机回放（must-fire / must-not-fire）。
//
// 这一步的目标：**把回放固化成测试**。以后谁调词库、阈值或正则，动了就过不了。
//
// 三组断言：
//   ① 数据形状：每条规则都带 {enabled, minHits, perKilo, evidence}，取值合法；
//   ② must-fire / must-not-fire：每条规则至少各有一条「应命中 / 不应命中」的样本；
//   ③ 真机回放：两段真书摘录（已脱敏）跑一遍扫描，干净维度不许报。
//
// fixture 来源与脱敏（发行面隐私铁律：不带书名、人物名，只用中性指代）：
//   fixtures/noai/long-form-excerpt.txt   —— 长篇正常本的一章（人物名/地名已换成中性词）
//   fixtures/noai/short-sentence-excerpt.txt —— 碎句本的一章（同上）
// 两段都是「真实正文」而不是为测试编的样本，因此它们能守住「正常中文不得被判脏」。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import lexicon from '../lib/data/noai-lexicon.json' with { type: 'json' };
import { scanAiFlavor, ruleText, entryQualifies } from '../lib/noai.js';
import { crossChapterFlavor } from '../lib/noai-cross.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/noai/${name}.txt`, import.meta.url), 'utf8');
const LONG_FORM = fixture('long-form-excerpt');
const SHORT_SENTENCE = fixture('short-sentence-excerpt');
const PARALLELISM = JSON.parse(readFileSync(new URL('./fixtures/noai/parallelism-cases.json', import.meta.url), 'utf8'));

/**
 * 中性底稿：不含词库任何词条的正常中文。
 * 用途是把单条规则单独放进一句正常叙述里——这样「命中」只可能来自那一条，
 * 不会因为底稿自己带脏词而误判。
 */
// 注意：刻意不写双逗号句——底稿若自带三个分句，测单条规则时就分不清是谁打中的。
const CLEAN = '院子里结了薄冰。他用木棍敲了敲。冰裂开一道口子。屋里传来翻纸的声音。他放下木棍走进屋。门在他身后掩上。';

const PLAIN_LISTS = [
    ['cliche', lexicon.cliche],
    ['stock', lexicon.stock],
    ['defaultword', lexicon.defaultword],
];

/** 把一条规则放进正常叙述里，看它是否被记进该维的 hits。 */
function firesIn(category, term) {
    const r = scanAiFlavor(`${CLEAN}${term}。${CLEAN}`, { topK: 999 });
    return r.categories[category].hits.some((h) => h.term === term);
}

// ── ① 数据形状 ────────────────────────────────────────────────────────────

test('★ 词库每条规则都带条目级身份（enabled/minHits/perKilo/evidence），且取值合法', () => {
    const lists = [
        ['cliche', lexicon.cliche],
        ['stock', lexicon.stock],
        ['defaultword', lexicon.defaultword],
        ['gesture', lexicon.gesture],
        ['emotion.patterns', lexicon.emotion.patterns],
        ['emotion.singles', lexicon.emotion.singles],
        ['templates.paired', lexicon.templates.paired],
        ['templates.summaryPatterns', lexicon.templates.summaryPatterns],
    ];
    const bad = [];
    for (const [name, list] of lists) {
        assert.ok(Array.isArray(list) && list.length > 0, `${name} 必须是非空数组`);
        for (const [i, entry] of list.entries()) {
            const at = `${name}[${i}]`;
            if (entry === null || typeof entry !== 'object') { bad.push(`${at} 不是对象（还停留在 v2 的裸字符串格式）`); continue; }
            if (typeof entry.enabled !== 'boolean') bad.push(`${at}.enabled 必须是布尔`);
            if (!Number.isInteger(entry.minHits) || entry.minHits < 1) bad.push(`${at}.minHits 必须是 ≥1 的整数`);
            if (typeof entry.perKilo !== 'number' || !Number.isFinite(entry.perKilo) || entry.perKilo < 0) bad.push(`${at}.perKilo 必须是 ≥0 的有限数`);
            if (typeof entry.evidence !== 'string' || entry.evidence.trim() === '') bad.push(`${at}.evidence 必须是非空字符串`);
        }
    }
    assert.deepEqual(bad, [], `词库有条目不合规：\n${bad.join('\n')}`);
});

test('词库各类条目数与 v2 一致（迁移只加字段，不许增删条目）', () => {
    assert.equal(lexicon.cliche.length, 149, 'cliche 条目数变了——迁移不该增删规则');
    assert.equal(lexicon.stock.length, 77, 'stock 条目数变了');
    assert.equal(lexicon.defaultword.length, 10, 'defaultword 条目数变了');
    assert.equal(lexicon.gesture.length, 12, 'gesture 条目数变了');
    assert.equal(lexicon.emotion.patterns.length, 8, 'emotion.patterns 条目数变了');
    assert.equal(lexicon.emotion.singles.length, 5, 'emotion.singles 条目数变了');
    assert.equal(lexicon.templates.paired.length, 7, 'templates.paired 条目数变了');
    assert.equal(lexicon.templates.summaryPatterns.length, 4, 'templates.summaryPatterns 条目数变了');
});

test('模板的 markers 仍是纯字符串常量，不参与条目约定', () => {
    assert.equal(lexicon.templates.markers.ellipsis, '……');
    assert.equal(lexicon.templates.markers.dash, '——');
    assert.equal(typeof lexicon.templates.markers.enabled, 'undefined', 'markers 不是规则条目，不该被迁移脚本塞身份字段');
});

// ── ② 条目级判定口径（纯函数）────────────────────────────────────────────

test('★ entryQualifies：默认口径等价于「命中即计」；字段缺失时回退默认值', () => {
    assert.equal(entryQualifies(1, 100, { pattern: 'x' }), true, '缺 minHits/perKilo 时按 1/0 回退');
    assert.equal(entryQualifies(0, 100, { pattern: 'x' }), false);
    assert.equal(entryQualifies(1, 100, 'x'), true, 'v2 裸字符串仍兼容');
    assert.equal(entryQualifies(0, 100, 'x'), false);
});

test('★ entryQualifies：命中数低于 minHits 不算命中', () => {
    const e = { pattern: 'x', minHits: 3, perKilo: 0 };
    assert.equal(entryQualifies(2, 10000, e), false);
    assert.equal(entryQualifies(3, 10000, e), true);
});

test('★ entryQualifies：千字密度低于 perKilo 不算命中', () => {
    const e = { pattern: 'x', minHits: 1, perKilo: 2 };
    assert.equal(entryQualifies(1, 1000, e), false, '1 次/千字 < 2，不该算');
    assert.equal(entryQualifies(2, 1000, e), true, '2 次/千字 = 2，算');
});

test('★ entryQualifies：enabled:false 的条目参与解析但不参与判定', () => {
    const e = { pattern: 'x', enabled: false, minHits: 1, perKilo: 0 };
    assert.equal(entryQualifies(1000, 10000, e), false, '关掉的条目命中再多也不许计分');
    assert.equal(ruleText(e), 'x', '关掉的条目仍能被解析出匹配串（留在文件里可见）');
});

// ── ③ must-fire：每条规则至少有一条会命中的样本 ───────────────────────────

test('★ must-fire：cliche 每条规则在正常叙述里出现一次就必须被记进 hits', () => {
    const missing = lexicon.cliche.filter((e) => e.enabled !== false && !firesIn('cliche', ruleText(e))).map(ruleText);
    assert.deepEqual(missing, [], `这些 cliche 条目出现一次却没被记进 hits（阈值被收紧或匹配逻辑坏了）：\n${missing.join(' / ')}`);
});

test('★ must-fire：stock 每条规则出现一次就必须被记进 hits', () => {
    const missing = lexicon.stock.filter((e) => e.enabled !== false && !firesIn('stock', ruleText(e))).map(ruleText);
    assert.deepEqual(missing, [], `这些 stock 条目出现一次却没被记进 hits：\n${missing.join(' / ')}`);
});

test('★ must-fire：defaultword 每条规则出现一次就必须被记进 hits', () => {
    const missing = lexicon.defaultword.filter((e) => e.enabled !== false && !firesIn('defaultword', ruleText(e))).map(ruleText);
    assert.deepEqual(missing, [], `这些 defaultword 条目出现一次却没被记进 hits：\n${missing.join(' / ')}`);
});

test('★ must-fire：gesture 每条规则出现一次就必须被跨章判据看见', () => {
    const missing = [];
    for (const entry of lexicon.gesture) {
        if (entry.enabled === false) continue;
        const term = ruleText(entry);
        // gestureMax 显式给 0：任何一次命中都该报（判据本身是「超过上限才报」，这里只要它看得见）
        const r = crossChapterFlavor({
            content: `${CLEAN}${term}。`, chapter: 1, history: [], options: { totalChapters: 1, gestureMax: 0 },
        });
        if (!r.issues.some((x) => x.includes('标志小动作') && x.includes(term))) missing.push(term);
    }
    assert.deepEqual(missing, [], `这些 gesture 条目没被跨章判据看见：\n${missing.join(' / ')}`);
});

test('★ must-fire：emotion.singles 每个词出现一次就必须被记进 hits', () => {
    const missing = [];
    for (const entry of lexicon.emotion.singles) {
        if (entry.enabled === false) continue;
        const word = ruleText(entry);
        const r = scanAiFlavor(`${CLEAN}${word}。`, { topK: 999 });
        if (!r.categories.emotion.hits.some((h) => h.match === word)) missing.push(word);
    }
    assert.deepEqual(missing, [], `这些 emotion.singles 没被记进 hits：\n${missing.join(' / ')}`);
});

// 正则类规则：只能给样本，不能拿 pattern 当字面串拼。每条都配一条正样本 + 一条负样本。
// kind：paired = 配对句式（计 paired），summary = 段尾/段首升华（计 summary）。
const TEMPLATE_CASES = [
    ['不是…而是…', 'paired', '这不是愤怒，而是失望。', '这不是愤怒。'],
    ['与其说…不如说', 'paired', '与其说他是犹豫，不如说他在等。', '与其说他是犹豫。'],
    ['与其…不如', 'paired', '与其坐着等，不如先走。', '与其坐着等。'],
    ['如果…那么…', 'paired', '如果雨再下，那么路就断了。', '如果雨再下。'],
    ['既…又…', 'paired', '他既怕冷，又嫌热。', '他既怕冷。'],
    ['一边…一边…', 'paired', '他一边走，一边回头。', '他一边走。'],
    ['排比三连', 'paired', '等他流血，等他腿软，等他倒下。', '他站起来，拍了拍手上的雪渣，只说了四个字。'],
    ['段尾升华', 'summary', '他走了。这让他想起很多。', '他走了。天黑了。'],
    ['或许这就是', 'summary', '或许这就是答案。', '也许还有别的说法。'],
    ['仿佛在告诉', 'summary', '风穿过窗缝，仿佛在告诉他什么。', '风穿过窗缝。'],
    ['段首总结句', 'summary', '总的来说，事情就是这样。', '事情就是这样。'],
];

const EMOTION_CASES = [
    ['(很|十分|非常|无比|极其|异常|说不出的)(愤怒|悲伤|高兴|开心|害怕|恐惧|紧张|激动|失望|绝望|欣慰|心痛|难过|委屈|兴奋|尴尬)', '他十分愤怒。', '他把杯子放下。'],
    ['感到(一阵)?(愤怒|悲伤|高兴|开心|害怕|恐惧|紧张|激动|失望|绝望|欣慰|心痛|难过|委屈|不安|温暖)', '他感到一阵不安。', '他往门口看了一眼。'],
    ['心中(涌起|升起|泛起|掠过|闪过)(一丝|一抹|一股|一阵)?(愤怒|悲伤|喜悦|酸楚|暖意|寒意|快意|苦涩|感动|失落)', '心中涌起一股寒意。', '他把灯吹灭了。'],
    ['(怒火|恨意|悔意|愧疚|委屈|悲伤)瞬间(涌上|爬上|占据)', '怒火瞬间涌上。', '火苗窜了一下。'],
    ['心如刀绞', '他心如刀绞。', '他把刀放下。'],
    ['心如死灰', '他心如死灰。', '灰烬凉了。'],
    ['喜极而泣', '她喜极而泣。', '她把碗放下。'],
    ['悲从中来', '他悲从中来。', '他坐了一夜。'],
];

test('★ must-fire：templates 每条正则都能命中自己的正样本', () => {
    const byName = new Map(lexicon.templates.paired.map((p) => [p.name, p]));
    for (const p of lexicon.templates.summaryPatterns) byName.set(p.name, p);
    const bad = [];
    for (const [name, kind, positive] of TEMPLATE_CASES) {
        const rule = byName.get(name);
        if (!rule) { bad.push(`${name}：词库里找不到这条规则`); continue; }
        if (rule.enabled === false) continue;
        // 段首总结句要求行首，所以正样本单独成段
        const r = scanAiFlavor(`${CLEAN}\n\n${positive}\n\n${CLEAN}`, { topK: 999 });
        if (r.categories.template[kind] < 1) bad.push(`${name}：正样本没命中（${kind}=0）`);
    }
    assert.deepEqual(bad, [], `模板规则 must-fire 失败：\n${bad.join('\n')}`);
});

test('must-not-fire：templates 每条正则都不许命中自己的负样本', () => {
    const byName = new Map(lexicon.templates.paired.map((p) => [p.name, p]));
    for (const p of lexicon.templates.summaryPatterns) byName.set(p.name, p);
    const bad = [];
    for (const [name, , , negative] of TEMPLATE_CASES) {
        const rule = byName.get(name);
        if (!rule) continue;
        if (new RegExp(rule.regex).test(negative)) bad.push(`${name}：负样本被误判为命中 → ${negative}`);
    }
    assert.deepEqual(bad, [], `模板规则 must-not-fire 失败：\n${bad.join('\n')}`);
});

test('★ must-fire：emotion.patterns 每条正则都能命中自己的正样本', () => {
    const bad = [];
    for (const [regex, positive] of EMOTION_CASES) {
        if (!new RegExp(regex).test(positive)) bad.push(`正样本没命中：${regex}`);
        const r = scanAiFlavor(`${CLEAN}${positive}`, { topK: 999 });
        if (r.categories.emotion.total < 1) bad.push(`扫描没记到情绪直写：${positive}`);
    }
    assert.deepEqual(bad, [], `情绪正则 must-fire 失败：\n${bad.join('\n')}`);
});

test('must-not-fire：emotion.patterns 每条正则都不许命中自己的负样本', () => {
    const bad = [];
    for (const [regex, , negative] of EMOTION_CASES) {
        if (new RegExp(regex).test(negative)) bad.push(`负样本被误判为命中：${regex} → ${negative}`);
    }
    assert.deepEqual(bad, [], `情绪正则 must-not-fire 失败：\n${bad.join('\n')}`);
});

// ── ④ must-not-fire：干净样本上一条都不许命中 ─────────────────────────────

for (const [category, list] of PLAIN_LISTS) {
    test(`★ must-not-fire：干净样本上 ${category} 一条都不许命中`, () => {
        const r = scanAiFlavor(CLEAN.repeat(2), { topK: 999 });
        const offenders = r.categories[category].hits.map((h) => h.term);
        assert.deepEqual(offenders, [], `${category} 在干净样本上误报：${offenders.join(' / ')}`);
    });
}

test('★ must-not-fire：干净样本不该产生词库维度的任何告警', () => {
    // 只核词库驱动的五维：structure/dilution 是统计量，短样本上本来就会报，
    // 那不是词库的问题（另有样本闸门，不在本用例范围）。
    const r = scanAiFlavor(CLEAN.repeat(4), { topK: 999 });
    const wrong = r.topIssues.filter((x) => /模板句|库存词|情绪直写|AI 默认值词|断章公式|配对句式|段尾升华/.test(x));
    assert.deepEqual(wrong, [], `干净样本被词库报脏：\n${wrong.join('\n')}`);
});

// ── ⑤ 真机回放 ────────────────────────────────────────────────────────────

test('★ 回放·长篇正常本：模板句/库存词/情绪直写/默认值词/断章公式都不许告警', () => {
    const r = scanAiFlavor(LONG_FORM);
    assert.ok(r.chars > 2500, `fixture 太短，统计噪声大：${r.chars}`);
    assert.equal(r.categories.cliche.score, 0, `模板句被误报：${JSON.stringify(r.categories.cliche.hits)}`);
    assert.ok(r.categories.stock.score < 20, `库存词被误报：${r.categories.stock.score}`);
    assert.equal(r.categories.emotion.score, 0, `情绪直写被误报：${JSON.stringify(r.categories.emotion.hits)}`);
    assert.ok(r.categories.defaultword.score < 20, `默认值词被误报：${r.categories.defaultword.score}`);
    assert.equal(r.categories.formula.score, 0, `断章公式被误报：${r.categories.formula.endFormula}`);
    const wrong = r.topIssues.filter((x) => /模板句|库存词|情绪直写|AI 默认值词|断章公式/.test(x));
    assert.deepEqual(wrong, [], `正常正文被报脏：\n${wrong.join('\n')}`);
});

test('★ 回放·碎句本：模板句/库存词/情绪直写/默认值词/断章公式都不许告警', () => {
    const r = scanAiFlavor(SHORT_SENTENCE);
    assert.ok(r.chars > 2000, `fixture 太短，统计噪声大：${r.chars}`);
    assert.equal(r.categories.cliche.score, 0, `模板句被误报：${JSON.stringify(r.categories.cliche.hits)}`);
    assert.ok(r.categories.stock.score < 20, `库存词被误报：${r.categories.stock.score}`);
    assert.equal(r.categories.emotion.score, 0, `情绪直写被误报：${JSON.stringify(r.categories.emotion.hits)}`);
    assert.ok(r.categories.defaultword.score < 20, `默认值词被误报：${r.categories.defaultword.score}`);
    assert.equal(r.categories.formula.score, 0, `断章公式被误报：${r.categories.formula.endFormula}`);
    const wrong = r.topIssues.filter((x) => /模板句|库存词|情绪直写|AI 默认值词|断章公式/.test(x));
    assert.deepEqual(wrong, [], `正常正文被报脏：\n${wrong.join('\n')}`);
});

test('★ 回放：正常章整体判「清爽」（两段真书摘录）', () => {
    for (const [name, text] of [['长篇正常本', LONG_FORM], ['碎句本', SHORT_SENTENCE]]) {
        const r = scanAiFlavor(text);
        assert.ok(r.score < 40, `${name} 被整体判脏：${r.score}（${r.level}）——${r.topIssues.join(' | ')}`);
    }
});

test('回放记录：「落定」在正常叙述里出现属正常用法，不得升级成模板句告警', () => {
    // 长篇本里「雷落定，谷里静下来」是地道的动词用法，不是模板句。
    // 这条钉的是「出现即计分」与「按千字密度计分」的边界：它会被记进 hits，
    // 但一章里出现一两次绝不能把 cliche 维推过告警线。
    const r = scanAiFlavor(LONG_FORM);
    const hit = r.categories.cliche.hits.find((h) => h.term === '落定');
    if (hit) assert.ok(hit.count <= 3, `「落定」在单章里命中 ${hit.count} 次，密度判据可能已失效`);
    assert.ok(r.categories.cliche.score < 20, `「落定」把模板句维度推过了告警线：${r.categories.cliche.score}`);
    assert.ok(!r.topIssues.some((x) => x.includes('模板句')), '正常用法不该出现在告警里');
});

test('★ 排比三连：真排比必须命中（同首词领起的三个并列分句）', () => {
    const rule = lexicon.templates.paired.find((p) => p.name === '排比三连');
    assert.ok(rule, '词库里应有「排比三连」');
    for (const c of PARALLELISM.mustFire) {
        const n = (c.text.match(new RegExp(rule.regex, 'g')) ?? []).length;
        assert.equal(n, 1, `真排比没被识别（${c.shape}）：${c.text}`);
    }
});

test('★ 排比三连：普通三逗号句一条都不许命中（旧正则的误报面）', () => {
    const rule = lexicon.templates.paired.find((p) => p.name === '排比三连');
    for (const c of PARALLELISM.mustNotFire) {
        const n = (c.text.match(new RegExp(rule.regex, 'g')) ?? []).length;
        assert.equal(n, 0, `普通句被误判成排比（${c.shape}）：${c.text}`);
    }
});

test('★ 回放·两段真书摘录：排比三连不再触发「配对句式」告警', () => {
    // 旧正则把「任何三个逗号分句」都当排比，真机 111/111 章恒真；
    // 新判据要求三个分句由同一个词领起、骨架相似，正常叙述不会再打中。
    for (const [name, text] of [['长篇正常本', LONG_FORM], ['碎句本', SHORT_SENTENCE]]) {
        const r = scanAiFlavor(text, { topK: 999 });
        assert.equal(r.categories.template.paired, 0, `${name}仍有排比命中：${JSON.stringify(r.categories.template.hits)}`);
        assert.ok(!r.topIssues.some((x) => x.includes('配对句式')), `${name}仍报「配对句式」：${r.topIssues.join(' | ')}`);
    }
});

test('回放发现（已知问题）：段尾升华的命中计数进了分数却没进 hits 明细', () => {
    // lib/noai.js 里 summaryHits 被构建出来后从未并入 templateHits，于是
    // categories.template.summary 有值、categories.template.hits 里却找不到「段尾升华」。
    // 影响面只有明细（分数与告警不受影响），修它会改变 scanAiFlavor 的输出内容，
    // 属于判定行为之外的输出变更，先由 owner 拍板；此处只记录现象，不锁定期望。
    const r = scanAiFlavor(`${CLEAN}\n\n他走了。这让他想起很多。\n\n${CLEAN}`, { topK: 999 });
    assert.equal(r.categories.template.summary, 1, '段尾升华应被计入 summary');
    assert.ok(
        !r.categories.template.hits.some((h) => h.term === '段尾升华'),
        'summaryHits 已并入 hits——若是修好了，请删掉本用例并同步上面的 must-fire 写法',
    );
});
