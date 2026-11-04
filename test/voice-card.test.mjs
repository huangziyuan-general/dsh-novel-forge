// test/voice-card.test.mjs — 语言基因卡数据卫生（纯函数，node --test 直测）。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    normalizeVoice, normalizeVoiceStored, validateVoice, migrateVoiceCard, repairVoiceCard,
    isBehaviorRule, matchableEntries, voiceConsistency, renderVoiceCard,
    voiceGateWarnings, missingVoiceCards, protagonistNameOf, narrativeWeights, rankVoiceNames,
    compactPhrase, compactVoiceCard, appendVoiceNotes, clauseHits,
} from '../lib/voice.js';
import { buildContextPack } from '../lib/contextpack.js';

const ticsOf = (input) => normalizeVoice({ 口头禅: input }).tics;

test('splitList：引号内的逗号不切分', () => {
    assert.deepEqual(ticsOf('「甲，乙」,丙'), ['甲，乙', '丙']);
    assert.deepEqual(ticsOf('"甲,乙",丙'), ['甲,乙', '丙'], 'ASCII 双引号成对开合');
});

test('splitList：中文括号内的分隔符不切分', () => {
    assert.deepEqual(normalizeVoice({ 禁忌: '（甲、乙）,丙' }).taboo, ['甲、乙', '丙']);
    assert.deepEqual(normalizeVoice({ 禁忌: '【甲；乙】,丙' }).taboo, ['甲；乙', '丙']);
});

test('splitList：嵌套引号/括号内层先闭合', () => {
    assert.deepEqual(ticsOf('「甲（乙，丙）」,丁'), ['甲（乙，丙）', '丁']);
});

test('splitList：紧邻的两个引号项无分隔符也断项，但句内引用不断项', () => {
    assert.deepEqual(ticsOf('「呵」「行吧」'), ['呵', '行吧']);
    assert.deepEqual(ticsOf('叫他「哥」'), ['叫他「哥」'], '引号只是词的一部分，不拆');
});

test('splitList：空项剥掉、普通逗号/顿号/分号列表行为不变', () => {
    assert.deepEqual(ticsOf(',，、;；呵,,行吧'), ['呵', '行吧']);
    assert.deepEqual(ticsOf('呵,行吧;嗯、算了'), ['呵', '行吧', '嗯', '算了']);
});

test('splitList：不配平的残片不吞后文（引号内分隔符仍不切）', () => {
    assert.deepEqual(ticsOf('甲,「乙，丙'), ['甲', '乙，丙']);
});

test('isBehaviorRule：行为规则与可匹配短语分流', () => {
    assert.equal(isBehaviorRule('不与人争辩第二句'), true);
    assert.equal(isBehaviorRule('只自称“我”'), true);
    assert.equal(isBehaviorRule('一个字不解释'), true);
    assert.equal(isBehaviorRule('不好意思'), false, '短口头禅不误判');
    assert.equal(isBehaviorRule('规矩是规矩。'), false, '带「规矩」的口癖不是规则');
    assert.deepEqual(matchableEntries(['呵', '不与人争辩第二句', '「残片']), ['呵']);
    assert.deepEqual(matchableEntries(['说「放火」']), ['说「放火」'], '配对的引文不是残片');
});

test('validateVoice：口头禅超 12 字或含引号括号＝可见错误（不静默丢弃）', () => {
    const tooLong = validateVoice({ tics: ['这是一个超过十二个字的口头禅啊'] });
    assert.equal(tooLong.ok, false);
    assert.ok(tooLong.errors.some((e) => e.code === 'tic-too-long'));

    const bracket = validateVoice({ tics: ['他说的"原话'] });
    assert.equal(bracket.ok, false);
    assert.ok(bracket.errors.some((e) => e.code === 'tic-bracket'));

    assert.equal(validateVoice({ tics: ['一二三四五六七八九十甲乙'] }).ok, true, '12 字是上限内');
});

test('migrateVoiceCard：taboo 一字不改，行为规则复制进 rules', () => {
    const src = { taboo: ['人家', '不与人争辩第二句'], tics: ['呵'] };
    const r = migrateVoiceCard(src);
    assert.deepEqual(r.voice.taboo, ['人家', '不与人争辩第二句'], '老 taboo 原样保留');
    assert.deepEqual(r.voice.rules, ['不与人争辩第二句'], '只新增 rules');
    assert.deepEqual(src, { taboo: ['人家', '不与人争辩第二句'], tics: ['呵'] }, '入参不被改写');
    assert.ok(validateVoice(src).warnings.some((w) => w.code === 'taboo-rule'), '未迁移时给出可见建议');
    assert.equal(validateVoice(r.voice).warnings.some((w) => w.code === 'taboo-rule'), false, '迁移后不再重复告警');
});

test('voiceConsistency：行为规则不参与命中，可匹配短语照旧', () => {
    const voice = migrateVoiceCard({ taboo: ['人家', '不与人争辩第二句'] }).voice;
    const ruleOnly = voiceConsistency({ content: '他说过，不与人争辩第二句。', voices: [{ name: '测试角色', voice }] });
    assert.equal(ruleOnly.stats.errors, 0, '规则永远 includes 不到，不许进命中');

    const phrase = voiceConsistency({ content: '测试角色说：「人家不去了。」', voices: [{ name: '测试角色', voice }] });
    assert.equal(phrase.stats.errors, 1, '真正的禁忌短语仍要抓');

    const legacy = voiceConsistency({
        content: '他说过，不与人争辩第二句。',
        voices: [{ name: '测试角色', voice: { taboo: ['不与人争辩第二句'] } }],
    });
    assert.equal(legacy.stats.errors, 0, '未迁移的老卡同样过滤规则');
});

test('clauseHits：词内嵌不算，子句首/行首/连续标点后算', () => {
    assert.equal(clauseHits('他坐在下手的位置。', '在下').length, 0, '嵌在更长词流里不算');
    assert.equal(clauseHits('在下失礼了。', '在下').length, 1, '句首');
    assert.equal(clauseHits('第一行\n在下先走。', '在下').length, 1, '换行后的行首');
    assert.equal(clauseHits('……在下先说一句。', '在下').length, 1, '连续标点后');
    assert.equal(clauseHits('——在下这就走。', '在下').length, 1, '破折号后');
    assert.equal(clauseHits('他说，在下失礼。', '在下').length, 1, '逗号后的子句起点');
    assert.equal(clauseHits('在下', '在下').length, 1, '文首');
});

test('clauseHits：引号台词内前面紧贴汉字也算命中（台词侧口径不变）', () => {
    assert.equal(clauseHits('“你给在下让开！”', '在下').length, 1);
    assert.equal(clauseHits('『别在本座面前造次』', '本座').length, 1);
    assert.equal(clauseHits('"让在下想想"', '在下').length, 1, 'ASCII 双引号');
    assert.equal(clauseHits('“我说\n在下先走。”', '在下').length, 1, '跨行台词');
});

test('clauseHits：叙述行里的词内嵌不因换行而误判', () => {
    assert.equal(clauseHits('第一行\n他坐在下手\n第三行', '在下').length, 0);
});

test('voiceConsistency：禁忌词词内嵌不再误报，台词内仍抓', () => {
    const voice = { taboo: ['在下'] };
    const embedded = voiceConsistency({
        content: '测试角色坐在下手的位置。',
        voices: [{ name: '测试角色', voice }],
    });
    assert.equal(embedded.stats.errors, 0, '「坐在下手」不再算说了「在下」');
    const spoken = voiceConsistency({
        content: '测试角色说：“你给在下让开。”',
        voices: [{ name: '测试角色', voice }],
    });
    assert.equal(spoken.stats.errors, 1, '真的说了就要抓');
});

test('voiceConsistency：规则型/残片口头禅不进命中，且给出可见的卡不可用提示', () => {
    const vc = voiceConsistency({
        content: '测试角色说：「一个字不解释。」',
        voices: [{ name: '测试角色', voice: { tics: ['一个字不解释'] } }],
    });
    assert.equal(vc.items[0].ticsHit.length, 0, '规则型口头禅不算命中');
    assert.ok(vc.issues.some((i) => i.code === 'voice-card-unusable'), '卡不可用要可见');
});

test('renderVoiceCard：迁移后行为规则只渲染一次', () => {
    const card = renderVoiceCard('测试角色', { taboo: ['人家', '不与人争辩第二句'], rules: ['不与人争辩第二句'] });
    assert.equal(card.split('不与人争辩第二句').length - 1, 1);
    assert.ok(card.includes('人家'));
});

test('repairVoiceCard：重切引号内逗号、迁移规则、残片只报问题不猜原句', () => {
    const before = { tics: ['「甲，乙」,丙'], taboo: ['脏话', '只自称“我'] };
    const r = repairVoiceCard(before);
    assert.deepEqual(r.voice.tics, ['甲，乙', '丙'], '引号内逗号保留、引号外照切');
    assert.deepEqual(r.voice.taboo, ['脏话', '只自称“我'], 'taboo 原文保留');
    assert.deepEqual(r.voice.rules, ['只自称“我'], '行为规则复制进 rules');
    assert.ok(r.changes.some((c) => c.field === 'tics' && c.kind === 'resplit'));
    assert.ok(r.changes.some((c) => c.field === 'rules' && c.kind === 'migrate'));
    assert.ok(r.issues.some((i) => i.code === 'entry-corrupt'), '不配平的残片要报出来等人工确认');
});

test('repairVoiceCard：只做结构性重切，句末标点保留（不放大命中面）', () => {
    const r = repairVoiceCard({ tics: ['哦。', '也配？', '这有啥好怕的！', '小烬啊——', '「甲，乙」,丙'] });
    assert.deepEqual(r.voice.tics, ['哦。', '也配？', '这有啥好怕的！', '小烬啊——', '甲，乙', '丙'], '句末标点/破折号留在值里，引号外照切');
});

test('normalizeVoiceStored：读落盘卡保留句末标点，写入口径仍旧剥边标点', () => {
    assert.deepEqual(normalizeVoice({ 口头禅: '哦。' }).tics, ['哦']);
    assert.deepEqual(normalizeVoiceStored({ 口头禅: '哦。' }).tics, ['哦。']);
});

test('voiceGateWarnings：每章最多 3 条，超出合并为「另有 N 项」', () => {
    const issues = Array.from({ length: 7 }, (_, i) => ({ message: `问题${i + 1}` }));
    const lines = voiceGateWarnings({ issues });
    assert.equal(lines.length, 3);
    assert.deepEqual(lines.slice(0, 2), ['问题1', '问题2']);
    assert.match(lines[2], /另有 5 项/);
    assert.deepEqual(voiceGateWarnings({ issues: issues.slice(0, 3) }), ['问题1', '问题2', '问题3']);
    assert.deepEqual(voiceGateWarnings({ issues: [] }), []);
});

test('missingVoiceCards：只点名本章真有台词且无卡的角色', () => {
    const content = [
        '测试角色说：“我走了。”',
        '旁观者站在门口，一句话没说。',
        '有卡角色：“嗯。”',
    ].join('\n');
    const missing = missingVoiceCards({
        content,
        names: ['测试角色', '旁观者', '有卡角色'],
        voiced: ['有卡角色'],
    });
    assert.deepEqual(missing, ['测试角色'], '没台词/已有卡的人不催建卡');
});

test('主角判定：优先 novel.json 字段，缺省数据驱动（绝不写死名字/下标）', () => {
    assert.equal(protagonistNameOf({ protagonist: '甲' }), '甲');
    assert.equal(protagonistNameOf({ pov: ['乙', '丙'] }), '乙');
    assert.equal(protagonistNameOf({ lead: { name: '丁' } }), '丁');
    assert.equal(protagonistNameOf({}), null, '没有字段时不猜');
    const weights = narrativeWeights({ texts: ['甲 乙 甲 甲', '乙'], names: ['甲', '乙', '丙'] });
    assert.deepEqual(weights, { 甲: 3, 乙: 2, 丙: 0 });
    assert.deepEqual(rankVoiceNames({ names: ['甲', '乙', '丙'], weights: { 甲: 3, 乙: 7, 丙: 1 } }), ['乙', '甲', '丙']);
    assert.deepEqual(rankVoiceNames({ names: ['甲', '乙', '丙'], weights: {}, lead: '丙' }), ['丙', '甲', '乙']);
});

test('buildContextPack：6 人同台时主角卡拿 320 独立配额（旧口径 166 会截断）', () => {
    const cards = ['主角', '配角1', '配角2', '配角3', '配角4', '配角5'].map((name, i) => ({
        name,
        card: (i === 0 ? '主' : '声').repeat(i === 0 ? 300 : 80),
    }));
    const leadShare = buildContextPack({ chapter: 1, voiceCards: cards, voiceLead: '主角', budget: 6000 })
        .sections.find((s) => s.name.startsWith('语言基因卡·主角')).content;
    assert.equal(leadShare.length, 300, '300 字的主角卡不再被 166 字上限截断');
    const oldShare = buildContextPack({ chapter: 1, voiceCards: cards, budget: 6000 })
        .sections.find((s) => s.name.startsWith('语言基因卡·主角')).content;
    assert.equal(oldShare.length, 166, '未声明主角时保持旧均摊口径（不改既有行为）');
});

test('compactPhrase：优先选正文真实出现过的 ≤8 字片段，没命中退回分句', () => {
    const corpus = '他说话前先擦手，然后又擦了一遍。';
    const hit = compactPhrase('说话前先擦手，诊病时手指总在药碾上搭着', corpus);
    assert.equal(hit.source, 'corpus');
    assert.equal(hit.phrase, '说话前先擦手', '命中且最长（6 字）优先');
    assert.ok([...hit.phrase].length <= 8);
    const miss = compactPhrase('望四下一圈再开口,按斗笠檐压情绪', '');
    assert.equal(miss.source, 'fallback');
    assert.ok([...miss.phrase].length <= 8);
});

test('compactVoiceCard：长描述原文进 migrated，短值不动，notes 不受影响', () => {
    const corpus = '拇指摩挲食指第二节';
    const r = compactVoiceCard({
        gesture: '拇指摩挲食指第二节（前世扣扳机扣出来的习惯）',
        register: '短句',
        notes: ['旧备注'],
        tics: ['哦。'],
    }, corpus);
    assert.equal(r.changed, true);
    assert.equal([...r.voice.gesture].length <= 8, true);
    assert.equal(r.voice.register, '短句');
    assert.deepEqual(r.voice.notes, ['旧备注']);
    assert.equal(r.migrated.length, 1);
    assert.equal(r.migrated[0].text, '拇指摩挲食指第二节（前世扣扳机扣出来的习惯）', '原文一字不丢');
});

test('renderVoiceCard：notes 是归档位，不进注入区块', () => {
    const card = renderVoiceCard('甲', { tics: ['呵'], notes: ['很长的动作描述'] });
    assert.ok(card.includes('「呵」'));
    assert.equal(card.includes('很长的动作描述'), false);
});

test('appendVoiceNotes：新建小节 / 追加到既有小节 / 幂等不重复', () => {
    const e = [{ field: 'gesture', text: '长动作原文' }, { field: 'register', text: '长语域原文' }];
    const a = appendVoiceNotes('# 甲\n\n外在底色。', e);
    assert.ok(a.text.includes('## 语言与外化习惯'));
    assert.ok(a.text.includes('- 动作：长动作原文'));
    assert.equal(a.added, 2);
    const again = appendVoiceNotes(a.text, e);
    assert.equal(again.added, 0, '同文再来一次不重复写');
    const b = appendVoiceNotes('# 乙\n\n## 语言与外化习惯\n\n- 已有：旧\n\n## 关系\n- 某\n', e);
    assert.ok(b.text.indexOf('长动作原文') < b.text.indexOf('## 关系'), '插在本节内、下一节之前');
});

test('repairVoiceCard：干净卡零差异', () => {
    const r = repairVoiceCard({ tics: ['呵'], taboo: ['人家'] });
    assert.equal(r.changed, false);
    assert.deepEqual(r.changes, []);
    assert.deepEqual(r.voice, { tics: ['呵'], taboo: ['人家'] });
});
