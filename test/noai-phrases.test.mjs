// test/noai-phrases.test.mjs — 句式腔调判据 + 文风白名单 + 质量趋势 + 派生面漂移（纯函数面）。
//
// 四条红线钉住：
//   · 白名单掩码等长、幂等、长串优先（多字串 indexOf 必须真的能命中——数组单字元素坑）；
//   · scanNoaiPhrases 不进八维（scanAiFlavor 键结构测试在 noai-short-paragraph.test.mjs，这里
//     只钉 report-only 语义：白名单掩掉的句式不再被数）；
//   · qualityTrend 数据全读现成落盘（noaiScore/gate.coverage/quality.debts），判不出方向时键省略；
//   · 漂移三判据（索引缺口/基线落后/台账脏行）纯函数可直测。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    parseWhitelistLines, reconcileWhitelist, maskWhitelistSpans, maskedCharCount, MASK_CHAR,
} from '../lib/style-whitelist.js';
import { scanAiFlavor, scanNoaiPhrases } from '../lib/noai.js';
import { qualityTrend, savedNoaiSeries } from '../lib/quality-trend.js';
import { indexMissingChapters, styleBaselineLag, ledgerStructuralIssues } from '../lib/health.js';

// ── 白名单：解析与合并 ─────────────────────────────────────────────────────

test('parseWhitelistLines：去空白/去注释/去重保序', () => {
    assert.deepEqual(parseWhitelistLines('  他抬了抬眼皮  \n# 注释行\n他抬了抬眼皮\n\n她掀了掀帐帘'), [
        '他抬了抬眼皮', '她掀了掀帐帘',
    ]);
    assert.deepEqual(parseWhitelistLines(''), []);
    assert.deepEqual(parseWhitelistLines(undefined), []);
});

test('reconcileWhitelist：增删并集 + 长串在前排序（掩码长串优先）', () => {
    const next = reconcileWhitelist(['他抬了抬眼皮', '旧串'], '新串\n他抬了抬眼皮', '旧串');
    assert.deepEqual(next, ['他抬了抬眼皮', '新串'], '重复的 add 不产生新条目；被删的移除');
    // 排序：长的在前（「他抬了抬眼皮」6 字 > 「新串」2 字）
    assert.ok(next[0].length >= next[1].length, '长串在前——掩码先长后短，短串不切长串中间');
});

// ── 白名单：等长掩码 ─────────────────────────────────────────────────────

test('★ maskWhitelistSpans：多字串命中 + 等长 + 幂等 + 重叠区不重复记', () => {
    const text = '他抬了抬眼皮。她掀了掀帐帘，他抬了抬眼皮又放下了。';
    const r = maskWhitelistSpans(text, ['她掀了掀帐帘', '他抬了抬眼皮']);
    // 等长：掩码后长度与原文一致（MASK_CHAR 不是空白，chars 口径不变）
    assert.equal(r.text.length, text.length, '等长掩码——字数/行号/句位全口径不变');
    // 掩掉的字面串全部变成 MASK_CHAR（「他抬了抬眼皮」出现 2 次，共 12 字被掩）
    assert.ok(!r.text.includes('他抬了抬眼皮'));
    assert.ok(!r.text.includes('她掀了掀帐帘'));
    // 「他抬了抬眼皮」命中 2 次（各 6 字=12）+「她掀了掀帐帘」1 次（6 字）= 18 字被掩
    assert.equal(maskedCharCount(r.text, text), 18, '掩码字数 = 全部命中长度之和（6+6+6）');
    // 幂等：已掩的 \u0000 区不会再命中字面串
    const again = maskWhitelistSpans(r.text, ['他抬了抬眼皮', '她掀了掀帐帘']);
    assert.equal(again.maskedSpans.length, 0, '二次掩码零命中（幂等）');
    // 重叠区：长串已盖住的位置，短串不再重复记 span
    const ov = maskWhitelistSpans('他抬了抬眼皮', ['他抬了抬眼皮', '他抬了']);
    assert.equal(ov.maskedSpans.length, 1, '重叠区只记一次（长串优先）');
    assert.equal(ov.maskedSpans[0].literal, '他抬了抬眼皮');
});

test('★ 白名单接进八维：登记的写法不再被任何维度计入，分数下降、结构不变', () => {
    // 堆 6 处「他抬了抬眼皮」：defaultword/stock 维度会记；登记白名单后归零
    const body = Array.from({ length: 6 }, (_, i) => `他抬了抬眼皮。${'夜色把屋檐压得很低，' * 3}`)
        .join('\n\n');
    const noWl = scanAiFlavor(body, { whitelist: [] });
    const withWl = scanAiFlavor(body, { whitelist: ['他抬了抬眼皮'] });
    assert.ok(withWl.score <= noWl.score, '掩掉登记写法后分数不升反降（至少持平）');
    // 输出键结构一字不动（八维 schema 红线——noai-short-paragraph 另钉，这里交叉钉一次）
    assert.deepEqual(Object.keys(withWl), Object.keys(noWl));
    assert.deepEqual(Object.keys(withWl.categories), Object.keys(noWl.categories));
    // chars 口径不变（MASK_CHAR 非空白）
    assert.equal(withWl.chars, noWl.chars);
});

// ── 句式腔调判据（report-only）──────────────────────────────────────────

const PHRASES_CLEAN = '他走进屋子，把门带上，从怀里摸出一张纸，就着灯光看了半日。窗外雨落得很慢，檐水一线。';

test('scanNoaiPhrases：干净叙述零命中', () => {
    const r = scanNoaiPhrases(PHRASES_CLEAN, {});
    assert.deepEqual(r.issues, []);
    assert.equal(r.counts.microTic, 0);
});

test('★ scanNoaiPhrases：微动作补语成片才报（单次正常，≥5 处报）', () => {
    // 6 处「V了下/两下/半圈/声」式轻量补语——电报体指纹（实测 microTic=6，过 5 的成片阈）
    const heavy = '他扶了下门，按了下铃，拍了两下桌，松了半圈绳，叹了声气，又咳了声。';
    const r = scanNoaiPhrases(heavy, {});
    assert.ok(r.counts.microTic >= 5, `微动作补语命中 ${r.counts.microTic} 处`);
    assert.ok(r.issues.some((s) => s.includes('微动作补语')));
});

test('★ scanNoaiPhrases：白名单掩掉后不再计数（「这是我，别拦」生效）', () => {
    const heavy = '他扶了下门，按了下铃，拍了两下桌，松了半圈绳，叹了声气，又咳了声。';
    const plain = scanNoaiPhrases(heavy, {});
    assert.ok(plain.counts.microTic >= 5, '前置：无白名单时微动作补语成片命中');
    // 整句登记白名单 = 全掩 → 零计数、零 issue
    const all = scanNoaiPhrases(heavy, { whitelist: [heavy] });
    assert.equal(all.counts.microTic, 0, '整句登记白名单后零计数');
    assert.deepEqual(all.issues, []);
});

test('scanNoaiPhrases：对话行不判（角色台词里的反差/否定是正常台词）', () => {
    const dialogue = '「声音不大，却压过了满堂。」他说，「没有一个人站出来，也没有人躲开。」';
    const r = scanNoaiPhrases(dialogue, {});
    // 全对话行 → 叙述为零 → 各判据零命中
    assert.equal(r.narrationChars, 0, '无叙述行');
    assert.deepEqual(r.issues, []);
});

// ── 质量趋势（数据全读现成落盘）──────────────────────────────────────────

function auditLines(rows) {
    return rows.map((r) => JSON.stringify({ ts: 't', action: 'write_chapter/saved', ...r })).join('\n');
}

test('★ savedNoaiSeries：只认 saved 行、章号去重取最新、历史行无 noaiScore 跳过', () => {
    const audit = auditLines([
        { chapter: 1, noaiScore: 40 },
        { action: 'write_chapter/rejected', chapter: 2, noaiScore: 99 }, // rejected 不算
        { chapter: 2, noaiScore: 30 },
        { chapter: 2, noaiScore: 20 }, // 同章两次 saved → 取最后一次
        { chapter: 3 }, // 历史行无 noaiScore → 跳过
    ]);
    const series = savedNoaiSeries(audit);
    assert.deepEqual(series.map((s) => s.chapter), [1, 2]);
    assert.deepEqual(series.map((s) => s.noaiScore), [40, 20]);
});

test('★ qualityTrend：方向判读 + 风险旗标 + 样本不足不硬判', () => {
    // 近段走高（noai 分 20→20→60→80）+ 最近 5 章有 hard 债 + 最近 3 章覆盖率 <80
    const audit = auditLines([
        { chapter: 1, noaiScore: 20 }, { chapter: 2, noaiScore: 20 },
        { chapter: 3, noaiScore: 60 }, { chapter: 4, noaiScore: 80 },
    ]);
    const novel = {
        chapters: {
            1: { gate: { coverage: 95 } }, 2: { gate: { coverage: 70 } },
            3: { gate: { coverage: 60 } }, 4: { gate: { coverage: 50 } },
        },
        quality: { debts: { 4: [{ code: 'content-gate-forced', level: 'hard' }] } },
    };
    const t = qualityTrend(audit, novel);
    assert.equal(t.noaiTrend, 'rising', '后段均值高于前段 → rising');
    assert.ok(t.riskFlags.includes('hard-debt-recent'));
    assert.ok(t.riskFlags.includes('coverage-drop'), '最近 3 章覆盖率 <80');
    assert.ok(t.riskFlags.includes('noai-rising'));
    assert.equal(t.series.length, 4);
    // 缺契约段的章：gateCoverage 键省略（宿主拒 null）
    assert.equal('gateCoverage' in t.series[0], true);
    const t2 = qualityTrend(audit, { chapters: { 1: {}, 2: {}, 3: {}, 4: {} }, quality: {} });
    assert.ok(!('gateCoverage' in t2.series[0]), '无 gate 记录的章省略 gateCoverage 键');
});

test('★ qualityTrend：样本 <4 章判不出方向（noaiTrend 为 null，调用方须省略该键）', () => {
    const audit = auditLines([{ chapter: 1, noaiScore: 10 }, { chapter: 2, noaiScore: 90 }]);
    const t = qualityTrend(audit, { chapters: {}, quality: {} });
    assert.equal(t.noaiTrend, null, '只有 2 个有效点，不判方向');
    assert.match(t.note, /不足 4 章/);
});

// ── 派生面漂移（纯函数）──────────────────────────────────────────────────

test('★ indexMissingChapters：未建索引=全部算缺口（不谎报无缺口）；部分索引=差集', () => {
    const novel = { chapters: { 1: {}, 2: {}, 3: {} } };
    assert.deepEqual(indexMissingChapters(novel, []), [1, 2, 3]);
    assert.deepEqual(indexMissingChapters(novel, [1, 3]), [2]);
    assert.deepEqual(indexMissingChapters(novel, [1, 2, 3]), []);
    // 索引里的幽灵章（书里已删）不算缺口（那是 ghostIndexChapters 的口径）
    assert.deepEqual(indexMissingChapters({ chapters: { 1: {} } }, [1, 9]), []);
});

test('★ styleBaselineLag：基线落后=已写章数−建基线时章数；无基线/领先=0', () => {
    const novel = { chapters: { 1: {}, 2: {}, 3: {}, 4: {} } };
    assert.equal(styleBaselineLag(novel, null), 0, '无基线不算漂移');
    assert.equal(styleBaselineLag(novel, { baseline: {}, chapters: 4 }), 0, '基线覆盖全部');
    assert.equal(styleBaselineLag(novel, { baseline: {}, chapters: 2 }), 2, '写了 4 章基线只到 2 → 落后 2');
    assert.equal(styleBaselineLag(novel, { baseline: {}, chapters: 9 }), 0, '基线领先（旧书删章）不算落后');
});

test('★ ledgerStructuralIssues：缺章号/非对象行点名，有效行零报', () => {
    const clean = ledgerStructuralIssues({ facts: [{ entity: '甲', key: 'k', chapter: 1 }] });
    assert.deepEqual(clean, []);
    const dirty = ledgerStructuralIssues({
        facts: [{ entity: '甲', key: 'k' }],          // 缺 chapter
        relations: [{ a: 'A', b: 'B', relation: 'r', chapter: 2 }, null],
        cognition: [{ subject: '甲', verb: 'knows', info: 'x', chapter: 3 }, { subject: '甲' }],
    });
    const codes = dirty.map((i) => i.code).sort();
    assert.deepEqual(codes, ['ledger-row-bad-chapter', 'ledger-row-bad-chapter', 'ledger-row-null']);
});
