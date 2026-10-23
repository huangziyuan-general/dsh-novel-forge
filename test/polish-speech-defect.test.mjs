// test/polish-speech-defect.test.mjs — 「语句不通顺」病灶：言说动词的宾语被物件顶替。
//
// 来源：用户实证。《某连载本》第 1 章「把自己家那口大黑铁锅喊了半条街」——
// 言说动词（喊）的宾语槽被物件（锅）顶了，读者按字面读会卡住。正常形态是
// 「他要觉醒那口大黑铁锅这件事，他跑着喊了半条街」。
//
// 这条规则的设计纪律是**宁可漏检，不制造假阳性**：三件同时成立才判定
// （把字句 + 言说动词 + 范围补语），且宾语含言说内容词一律放行。
// 141 章真机语料实测：命中 2/141（同一章的 v1/v2），零假阳性。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { findSpeechObjDefects, analyzeParagraphs } from '../lib/polish.js';

test('★ 病原型必须抓到（用户实证那句）', () => {
    const found = findSpeechObjDefects('陈铁柱一路小跑上殿，把自己家那口大黑铁锅喊了半条街。');
    assert.equal(found.length, 1, '漏了这句等于这条规则没写');
    assert.ok(found[0].includes('那口大黑铁锅'), `报出的片段必须指向病灶本身，实得：${found[0]}`);
});

test('同类变体也抓得到（一整条街 / 三条巷）', () => {
    assert.equal(findSpeechObjDefects('他把那口铁锅喊了一整条街。').length, 1);
    assert.equal(findSpeechObjDefects('他把账本喊了三条巷。').length, 1);
});

test('★ 说内容的是正常句，放行（假阳性闸门）', () => {
    // 言说动词的宾语是「被说的内容」——这是它的正常用法，一条都不许报
    for (const s of [
        '他把话说清楚，转身就走。',
        '她把名字喊了出来。',
        '他把秘密说了出来。',
        '他把整件事的原委说了。',
        '他把来意告诉了门房。',
    ]) {
        assert.equal(findSpeechObjDefects(s).length, 0, `误报：${s}`);
    }
});

test('★ 喊人是正常句，放行（不带范围补语的把字句一律不判）', () => {
    // 「把他喊了回来」——喊的是人，完全正常。范围补语是本规则的第二道闸门：
    // 没有它就不该判，否则「喊人」会被整片误伤。
    for (const s of ['他把他喊了回来。', '他把张三叫醒了。', '她把孩子喊回了屋。']) {
        assert.equal(findSpeechObjDefects(s).length, 0, `误报：${s}`);
    }
});

test('非言说动词（传/送/搬）不判：物件宾语本来就合法', () => {
    assert.equal(findSpeechObjDefects('他把消息传遍了全城。').length, 0);
    assert.equal(findSpeechObjDefects('他把铁锅搬了两条街。').length, 0, '搬是真能搬的，不是语病');
});

test('进入 analyzeParagraphs 的 issues，且改写建议指向正确形态', () => {
    const r = analyzeParagraphs('陈铁柱一路小跑上殿，把自己家那口大黑铁锅喊了半条街。');
    assert.equal(r.paragraphs.length, 1, '病灶段必须被列为待润色段');
    const issue = r.paragraphs[0].issues.find((i) => i.includes('语句不通顺'));
    assert.ok(issue, `必须给出语句不通顺的病灶说明，实得：${r.paragraphs[0].issues.join('|')}`);
    assert.ok(issue.includes('这件事'), '建议里要示范把内容补全的写法，光说「不通顺」模型改不对');
});

test('正常章不产生任何语句不通顺告警（整章级反证）', () => {
    const clean = '他把话说清楚，转身就走。\n\n沈砚掐住笔杆，笔尖在纸上顿了半拍，才落下去。\n\n他把账本搬到了西厢。';
    const r = analyzeParagraphs(clean);
    const bad = r.paragraphs.filter((p) => p.issues.some((i) => i.includes('语句不通顺')));
    assert.equal(bad.length, 0, `误报了：${JSON.stringify(r.paragraphs)}`);
});
