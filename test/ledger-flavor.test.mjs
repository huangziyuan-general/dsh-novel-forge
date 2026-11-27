// test/ledger-flavor.test.mjs — 账感/人感（lib/ledger-flavor.js 纯函数面 + P6 批次债判定）。
//
// 五条红线：
//   · 三条件同时成立才算记账体（面板词多+没人说话+数值没人接），单维高不误报；
//   · 处方跟着量出来：缺哪层人感（对话/反应/连弹）就开哪张药方；
//   · 短章（<minChars）整维静默；
//   · 批次债：近 3 章 ≥2 章记账体才落 minor，单章不落（报信号不判死刑，同 P2 档）；
//   · 对话占比口径同 audit.js（引号内字数占比）。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { measureLedgerFlavor, ledgerFlavorDebtItems, dialogueRatioOf } from '../lib/ledger-flavor.js';

// 记账体：面板逐行念账，没有活人接
const LEDGERISH = [
    '【叮】面板弹出：结算开始。师傅修为涨幅 +1，反馈系数二倍，翻倍收益到账，面板数值实时刷新。',
    '【叮】弟子修为涨幅 +2，双倍反馈入账，配额更新，倍率翻倍，奖励发放完毕。',
    '面板弹出：任务完成，倒计时归零，涨幅同步，收益翻倍，数值刷新完毕。',
    '【叮】结算完成，倍率翻倍，配额 +1，奖励到账，面板刷新出下一任务。',
    '光幕弹出，数值刷新：反馈倍率 +2，涨幅入账，结算完毕，倒计时结束。',
    '【叮】结算开始，涨幅同步，配额 +1，收益翻倍，面板数值更新完毕。',
    '面板刷新：任务完成，收益翻倍，倒计时归零，倍率翻倍，奖励发放。',
    '【叮】结算完成，倍率翻倍，奖励到账，涨幅入账，面板数值实时刷新。',
    '光幕弹出：涨幅入账，面板数值更新，结算完毕，配额刷新，收益翻倍到账。',
    '【叮】结算，收益翻倍，配额刷新，倍率翻倍，倒计时结束，奖励发放完毕。',
    '【叮】面板弹出：结算开始，师傅涨幅 +1，二倍反馈，收益翻倍，数值刷新完毕。',
    '【叮】弟子涨幅 +2，双倍入账，配额更新，倍率翻倍，任务奖励发放。',
    '【叮】光幕弹出：倒计时归零，结算完成，涨幅同步，面板数值实时刷新完毕。',
].join('\n');

// 人感章：同样的结算词，但有活人吵账
const HUMAN = [
    '“翻了倍还入账？”二婶把竹篮往地上一搁，扯住石玉袖子，眼皮直跳，',
    '“你倒是把面板给我看一眼——”她嗓门提起来，满堂哄笑。',
    '石玉咧嘴，把光幕往她眼前一横：“翻倍的就是这个。”',
    '二婶盯着看，又看儿子，唾沫星子横飞：“我们家那个混账要是能翻——”',
    '“翻你个头。”石峰在里屋闷声接了一句，二婶一个箭步冲进去揪衣领。',
    '堂上炸了锅，几个族老交头接耳，心头的账翻得哗哗。',
].join('\n');

test('★ 记账体：面板念账 + 无对话 + 无人接 → ledgerish=true，处方非空', () => {
    const m = measureLedgerFlavor(LEDGERISH);
    assert.equal(m.ledgerish, true, '三条件同时成立');
    assert.ok(m.dialogueRatio < 0.12, '无对话');
    assert.ok(m.ledgerPerK >= 6, '结算密度超线');
    assert.ok(m.humanPerK < 6, '人感不足');
    assert.ok(m.prescriptions.length > 0, '处方跟着量出来');
    assert.ok(m.prescriptions.join(' ').includes('对话'), '含对话处方');
});

test('★ 人感章：同样的结算词但有活人吵账 → 不判记账体', () => {
    const m = measureLedgerFlavor(HUMAN);
    assert.equal(m.ledgerish, false, '对话占比拉高即消');
    assert.ok(m.dialogueRatio >= 0.12, '对话占比达标');
});

test('★ 短章静默：低于 minChars 整维不打量', () => {
    const m = measureLedgerFlavor('面板弹出，结算完成。收益翻倍。');
    assert.equal(m.applicable, false);
    assert.equal(m.ledgerish, false);
});

test('★ dialogueRatioOf：引号内字数占比（同 audit 口径）', () => {
    const r = dialogueRatioOf('他说：“一二三。”然后走了。');
    assert.ok(r > 0 && r < 1, '比值落在 0-1');
    assert.equal(dialogueRatioOf(''), 0, '空文不炸');
});

test('★ 批次债：近 3 章 ≥2 章记账体 → 落 minor；单章不落', () => {
    // 单章记账体（前两章人感）→ 不落债
    const single = ledgerFlavorDebtItems({
        content: LEDGERISH, chapter: 5,
        history: [{ no: 3, content: HUMAN }, { no: 4, content: HUMAN }],
    });
    assert.equal(single.length, 0, '单章记账体只走 ⑫ 维 warning，不记账');
    // 近 3 章 2 章记账体 → 落债
    const batch = ledgerFlavorDebtItems({
        content: LEDGERISH, chapter: 5,
        history: [{ no: 3, content: HUMAN }, { no: 4, content: LEDGERISH }],
    });
    assert.equal(batch.length, 1);
    assert.equal(batch[0].code, 'ledger-flavor');
    assert.ok(batch[0].message.includes('食杂店'), '债目点名病因');
});

test('★ 章号非正整 / 空历史 → 全静默（零回归）', () => {
    assert.deepEqual(ledgerFlavorDebtItems({ content: LEDGERISH, chapter: 0, history: [] }), []);
    assert.deepEqual(ledgerFlavorDebtItems({ chapter: 4, history: [] }), []);
});
