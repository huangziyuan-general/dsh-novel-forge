import { test } from 'node:test';
import assert from 'node:assert/strict';

import { detectOutlineOverlap, outlineOverlapExemptions } from '../lib/outline-overlap.js';

const copied = '守夜人把旧灯放在石门前面然后拆开那封没有署名的信仔细阅读每一行字';

test('细纲照搬：跨标点的长连续中文重合会返回正文证据', () => {
    const result = detectOutlineOverlap({
        outline: `## 本章必写场景\n- 夜访：${copied}，随后离开。`,
        content: `雨还在下。守夜人把旧灯，放在石门前面；然后拆开那封没有署名的信，仔细阅读每一行字。天亮前他离开。`,
    });
    assert.equal(result.hit, true);
    assert.ok(result.hits[0].hanChars >= 16);
    assert.match(result.hits[0].excerpt, /守夜人把旧灯/);
    assert.ok(result.ratio > 0);
});

test('细纲照搬：短公共词与各自展开的细节不误报', () => {
    const result = detectOutlineOverlap({
        outline: '## 本章必写场景\n- 夜访旧宅：发现密信\n- 雨中告别：人物关系改变',
        content: '他夜访旧宅，在夹层里找到一封密信。雨停之后，两人在巷口告别，没有再提白天的争执。',
    });
    assert.equal(result.hit, false);
    assert.deepEqual(result.hits, []);
});

test('细纲照搬：必写场景标题与别名豁免', () => {
    const title = '守夜人在石门前面拆开那封没有署名的信';
    const outline = `## 本章必写场景\n- ${title}：动作必须完整呈现`;
    assert.ok(outlineOverlapExemptions(outline).includes(title));
    const result = detectOutlineOverlap({ outline, content: `${title}，随后把信收进袖中。` });
    assert.equal(result.hit, false);
    assert.ok(result.exempted > 0);
});

test('细纲照搬：显式登记的系统面板与案卷原话豁免', () => {
    const original = '任务完成之前不得离开封城否则收回全部通行权限';
    const outline = `## 允许逐字引用\n- 系统面板：「${original}」`;
    const result = detectOutlineOverlap({ outline, content: `眼前浮出提示：“${original}”。他看完后继续前行。` });
    assert.equal(result.hit, false);
    assert.ok(result.exempted > 0);
});

test('细纲照搬：原话附近的非豁免长段仍然报告', () => {
    const original = '任务完成之前不得离开封城否则收回全部通行权限';
    const result = detectOutlineOverlap({
        outline: `## 本章必写场景\n- 夜访：${copied}\n\n## 允许逐字引用\n- 「${original}」`,
        content: `${original}。${copied}。`,
    });
    assert.equal(result.hit, true);
    assert.match(result.hits[0].excerpt, /守夜人/);
});

test('细纲照搬：周期文本的重叠命中合并，比例不超过正文', () => {
    const result = detectOutlineOverlap({ outline: '甲甲甲甲', content: '甲甲甲甲甲', minHanChars: 4 });
    assert.equal(result.hitCount, 2);
    assert.equal(result.overlappedHanChars, 5);
    assert.equal(result.ratio, 100);
});
