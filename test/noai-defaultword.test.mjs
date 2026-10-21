// test/noai-defaultword.test.mjs — 第八维 defaultword：AI 默认值词。
//
// 这些是**实词**，不像 cliche 那样「出现即计」——谁都会写「他屏住气息」。
// 只有成片出现才说明模型在套默认动作/默认身体部位。所以这一维的全部设计难点
// 在**两道假阳性闸门**，测试也就钉这两道闸。
//
// 实测反例（不加闸门的样子）：「他屏住气息，转身出了门。」12 字里 1 次命中
// → 每千字 83 次 → 直接打满 100 分。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { scanAiFlavor } from '../lib/noai.js';

/** 造一段约 3000 字的文本，把 payload 放在中间（模拟章级扫描）。 */
function chapterWith(payload, times = 1) {
    const filler = '他沿着河岸走了很久，天色一点点暗下来。'.repeat(45);
    return filler + payload.repeat(times) + filler;
}

test('★ 闸门①：单个默认值词孤立出现，绝不计分', () => {
    // 「屏住气息」是正常写法。单词偶然出现就报 = 满屏假阳性。
    const r = scanAiFlavor('他屏住气息，转身出了门。');
    assert.equal(r.categories.defaultword.score, 0, `误报了：${r.categories.defaultword.score}`);
    assert.equal(r.categories.defaultword.total, 1, '命中数要如实记录（报不报分是另一回事）');
});

test('★ 闸门②：样本不足 800 字，密度类指标归 0', () => {
    // polish 是逐段扫描的，每段只有几百字——此时必须归 0，判据留给章级扫描。
    const short = '他摩挲着那块玉，指节发白，心口发闷，喉结滚了一下。'.repeat(3);
    const r = scanAiFlavor(short);
    assert.ok(r.chars < 800, `构造的短文本应 <800 字，实得 ${r.chars}`);
    assert.equal(r.categories.defaultword.score, 0, '短样本上密度必然失真，不许计分');
});

test('章级：默认值词成片出现才报，且报得出是哪些词', () => {
    const r = scanAiFlavor(chapterWith('他摩挲着那块玉，轻笑一声，眼底浮起笑意。', 8));
    const c = r.categories.defaultword;
    assert.ok(c.score >= 20, `成片出现必须报（每千字约 8 次），实得 ${c.score}`);
    const issue = r.topIssues.find((i) => i.includes('AI 默认值词'));
    assert.ok(issue, '必须给出可操作的提示');
    assert.ok(issue.includes('摩挲'), `提示要点名具体词条，实得：${issue}`);
});

test('章级：正常用量不报（3000 字 3 处仍在容差内）', () => {
    const r = scanAiFlavor(chapterWith('他摩挲着那块玉。', 3));
    assert.ok(r.categories.defaultword.score < 20, `3 处属于正常用法，不该触发提示，实得 ${r.categories.defaultword.score}`);
});

test('★ 用户点名的「摩挲」在词库里（原点：语言基因卡里混进了禁用词）', async () => {
    const lexicon = (await import('../lib/data/noai-lexicon.json', { with: { type: 'json' } })).default;
    assert.ok(lexicon.defaultword.includes('摩挲'), '摩挲是用户明令禁用的 AI 默认动作，必须在库');
    assert.ok(lexicon.defaultword.includes('喉结'), '喉结是跨书素材库实证的默认值词');
    // 词库里已有 cliche 的「眼底闪过一丝」与这里的「眼底」是两个维度，不冲突
    assert.ok(lexicon.cliche.includes('眼底闪过一丝'), 'cliche 侧的长短语仍在（两维互补，不是替代）');
});

test('权重表八维合计为 1（新增一维必须从其余匀出，不许把总分放大）', async () => {
    // WEIGHTS 刻意不导出（它是内部常量），从源码文本核：这比导出一个只为测试的符号干净。
    const src = await (await import('node:fs/promises')).readFile(new URL('../lib/noai.js', import.meta.url), 'utf8');
    const m = /const WEIGHTS = \{([^}]+)\}/.exec(src);
    assert.ok(m, '源码里应有 WEIGHTS 表');
    const sum = [...m[1].matchAll(/(\w+):\s*([\d.]+)/g)]
        .map((x) => Number(x[2]))
        .reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9, `八维权重合计必须恰好为 1，实得 ${sum}——少一分总分被压低，多一分总分被放大`);
    assert.equal((m[1].match(/:/g) ?? []).length, 8, '应当是八维');
});
