// test/proposal-guardrails.test.mjs — 提案制四条护栏的回归钉。
//
// 这四条都是**本轮新加的行为却没有一条用例**（报告里的 P2）：
//   ① apply 前的陈旧守卫：提案基于 v1、正文已走到 v2 → 应用会把正文改回旧版。
//      这是真机那个「点应用把正文回退」的事故点，也是本轮唯一的数据安全类新增逻辑。
//      两个分支都要钉：有 baseVersion 直接比；存量提案（没这个字段）退回时间戳兜底。
//   ② 同章 pending 去重：两条互相矛盾的待批提案一起摆在面板上，用户无从选择。
//   ③ discard 的 id 形状守卫：它和 apply 一样把 id 拼进**写路径**，缺守卫就能越出提案目录。
//   ④ 已知称谓（老/小/大/阿 + 姓）只在**有出处**时才放宽覆盖率判定。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { computeAudit, chapterCharTarget } from '../lib/audit.js';
import { applyProposal, discardProposal } from '../lib/proposals.js';
import { pathsFor, effectiveCharConfig } from '../lib/store.js';
import { bootPlugin, chapterOf, testConfig } from './helpers/plugin.mjs';

const CFG = testConfig();
let h;
before(async () => { h = await bootPlugin(); });
after(() => h.cleanup());

/** 建一本写过第 1 章的书（提案要求「章已存在」）。 */
async function bookWithChapter1(book, extra = {}) {
    await h.tool('novel_project').execute({ action: 'init', book, ...extra }, h.exec);
    await h.tool('novel_write_chapter').execute({
        book, chapter: 1, title: '初稿', content: chapterOf(2400), summary: '第一版', force: true,
    }, h.exec);
}

const propose = (book, content, reason = '改稿') => h.tool('novel_propose').execute(
    { action: 'propose', book, chapter: 1, content, reason }, h.exec,
);

test('提案登记时预留基线：回执与索引都带 baseVersion', async () => {
    await bookWithChapter1('基线本');
    const created = await propose('基线本', chapterOf(2500));
    assert.equal(created.baseVersion, 1, '★ 基线＝登记那一刻的 latest');
    const meta = h.readJson('基线本/novel.json');
    const entry = meta.proposals.find((x) => x.id === created.id);
    assert.equal(entry.baseVersion, 1, '索引与提案文件两处都要写，否则 apply 无从判断');
    const file = h.readJson(`基线本/.novel/proposals/${created.id}.json`);
    assert.equal(file.baseVersion, 1);
});

test('★ 陈旧提案被拒并当场标 superseded（文件与索引双写），正文不许回退', async () => {
    await bookWithChapter1('陈旧本');
    const old = await propose('陈旧本', chapterOf(2600), '旧稿修订');
    // 模型又写了一版 → 正文走到 v2，那份提案的依据已经不成立
    await h.tool('novel_write_chapter').execute({
        book: '陈旧本', chapter: 1, title: '初稿', content: chapterOf(2700), summary: '第二版', force: true,
    }, h.exec);
    assert.equal(h.readJson('陈旧本/novel.json').chapters['1'].latest, 2);

    await assert.rejects(
        () => applyProposal(h.io(), '陈旧本', old.id, CFG, 'user'),
        /基于 v1.*当前已是 v2.*回退/s,
    );
    const meta = h.readJson('陈旧本/novel.json');
    const entry = meta.proposals.find((x) => x.id === old.id);
    assert.equal(entry.status, 'superseded', '★ 不许留在 pending：否则面板下次还能点');
    assert.equal(h.readJson(`陈旧本/.novel/proposals/${old.id}.json`).status, 'superseded',
        '文件与索引必须同状态（留个过期 status 就是双源分裂）');
    assert.equal(meta.chapters['1'].latest, 2, '正文版本号不许被回退');
    assert.ok(meta.chapters['1'].files.some((f) => f.version === 2), 'v2 文件还在');

    const auditLog = h.read('陈旧本/.novel/audit.jsonl').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
    assert.ok(auditLog.some((r) => r.action === 'propose/superseded'), '拒绝要留审计');
});

test('★ 陈旧提案必须能按提示丢弃（错误文案让用户丢弃，丢弃却只收 pending = 死锁）', async () => {
    // 拒下 apply 的文案是「请丢弃后基于最新版重提」。discardProposal 此前只收
    // pending → 照提示操作必撞 400；面板又把队列过滤成「只显示 pending」，用户连
    // 这条提案都看不见。两处合起来就是一条永远清不掉的提案（它再也不会变回 pending）。
    await bookWithChapter1('待清本');
    const old = await propose('待清本', chapterOf(2600), '旧稿修订');
    await h.tool('novel_write_chapter').execute({
        book: '待清本', chapter: 1, title: '初稿', content: chapterOf(2700), summary: '第二版', force: true,
    }, h.exec);
    await assert.rejects(() => applyProposal(h.io(), '待清本', old.id, CFG, 'user'), /回退/s);

    const r = await discardProposal(h.io(), '待清本', old.id, 'user');
    assert.equal(r.status, 'discarded', '★ superseded 提案必须可丢弃——提示里让用户做的动作得真能做');
    const meta = h.readJson('待清本/novel.json');
    assert.equal(meta.proposals.find((x) => x.id === old.id).status, 'discarded');
    // 已应用的/已丢弃的仍不许再丢（终态不反复翻转）
    await assert.rejects(() => discardProposal(h.io(), '待清本', old.id, 'user'), /不可丢弃/);
});

test('★ 存量提案没有 baseVersion：靠时间戳兜底照样拦得住（少这一支等于没修）', async () => {
    await bookWithChapter1('存量本');
    const created = await propose('存量本', chapterOf(2500));
    // 手工抹掉 baseVersion，模拟 0.21 之前登记在盘上的老提案
    const p = pathsFor('存量本');
    const io = h.io();
    const meta = h.readJson('存量本/novel.json');
    const drop = async (obj, rel) => io.writeJson(rel, obj);
    const entry = meta.proposals.find((x) => x.id === created.id);
    delete entry.baseVersion;
    await drop(meta, p.meta);
    const file = h.readJson(`存量本/.novel/proposals/${created.id}.json`);
    // 登记时间往前挪：存量提案本来就是「很久以前提的」。不留这个痕，
    // 提案时间与下一次落盘时间可能同毫秒，`createdAt >= updatedAt` 会让本用例偶发变绿。
    file.createdAt = '2020-01-01T00:00:00.000Z';
    const createdAt = file.createdAt;
    delete file.baseVersion;
    await drop(file, p.proposal(created.id));

    // 本章最后落盘时间晚于提案登记时间 → 判陈旧
    await h.tool('novel_write_chapter').execute({
        book: '存量本', chapter: 1, title: '初稿', content: chapterOf(2650), summary: '又改一版', force: true,
    }, h.exec);
    await assert.rejects(
        () => applyProposal(io, '存量本', created.id, CFG, 'user'),
        /基于旧版正文（登记于 2020-01-01T00:00:00\.000Z，本章最后落盘于 .+，当前 v2）/,
    );
    assert.equal(h.readJson('存量本/novel.json').proposals.find((x) => x.id === created.id).status, 'superseded');
    assert.ok(createdAt, '前置：登记时间取到了');
});

test('基线一致的提案正常应用（守卫不许把活路一起堵死）', async () => {
    await bookWithChapter1('正常本');
    const created = await propose('正常本', chapterOf(2550));
    const applied = await applyProposal(h.io(), '正常本', created.id, CFG, 'user');
    assert.equal(applied.status, 'applied');
    assert.equal(applied.version, 2);
    assert.equal(h.readJson('正常本/novel.json').chapters['1'].latest, 2);
});

test('★ 同章已有待批提案就拒绝再提（面板上不许摆两条互相矛盾的修订）', async () => {
    await bookWithChapter1('去重本');
    const first = await propose('去重本', chapterOf(2500), '第一版修订');
    await assert.rejects(() => propose('去重本', chapterOf(2800), '第二版修订'), new RegExp(`已有待处理提案 ${first.id}`));
    // 应用掉之后才允许提新的
    await applyProposal(h.io(), '去重本', first.id, CFG, 'user');
    const again = await propose('去重本', chapterOf(2800), '第三版修订');
    assert.equal(again.status, 'pending', '前一条进了终态，就不该被陈旧记录卡死');
});

test('discard 也要过 id 形状守卫（它同样把 id 拼进写路径）', async () => {
    await bookWithChapter1('丢弃本');
    const created = await propose('丢弃本', chapterOf(2500));
    for (const bad of ['../evil', 'P1/../../x', '', 'nope']) {
        await assert.rejects(
            () => discardProposal(h.io(), '丢弃本', bad, 'user'),
            /提案 id 不合式|提案不存在/,
            `坏 id「${bad}」必须在拼路径之前就被拒`,
        );
    }
    const ok = await discardProposal(h.io(), '丢弃本', created.id, 'user');
    assert.equal(ok.status, 'discarded');
});

// ── ④ 已知称谓：构词候选 + 有出处才放宽 ──────────────────────────────
test('★ 称谓证据：全名没出现但「老周」有出处 → 不算缺失；没出处照报', () => {
    const content = '老周把门拉开一条缝，侧身让他进去。';
    const withEvidence = computeAudit({
        content, previous: [], terms: ['周传海'], castNames: ['周传海'],
        castAliasSources: { 周传海: ['周传海（老周），班里资历最老的人'] },
    });
    assert.deepEqual(withEvidence.coverage.missing, [], '卡上有「老周」出处 → 覆盖判定要认这个称呼');

    const without = computeAudit({
        content, previous: [], terms: ['周传海'], castNames: ['周传海'],
        castAliasSources: { 周传海: ['周传海，班里资历最老的人'] },
    });
    assert.deepEqual(without.coverage.missing, ['周传海'], '★ 候选没有出处就不许白放宽一次判定');

    // 既往正文也是证据（「老周」上一章就这么叫）
    const fromPrevious = computeAudit({
        content, previous: [{ chapter: 1, content: '大家都管周传海叫老周。' }], terms: ['周传海'], castNames: ['周传海'],
    });
    assert.deepEqual(fromPrevious.coverage.missing, [], '既往章节里的称呼同样算出处');

    // 去姓短称（E4 老放宽）仍不需要出处
    const short = computeAudit({ content: '传海推门进来。', previous: [], terms: ['周传海'], castNames: ['周传海'] });
    assert.deepEqual(short.coverage.missing, [], '去姓短称照旧免证据');
});

test('★ 同姓两人不共享档案证据：别人的卡里写「老周」不能替这个人交卷', () => {
    // 周涛的档案明确「人称老周」；周传海本章没写到、也没有自己的证据。
    // 拼一锅证据的写法会让「老周」这个候选同时满足两个人 → 漏写被吞掉。
    const r = computeAudit({
        content: '周涛坐下喝水。',
        previous: [],
        terms: ['周传海', '周涛'],
        castNames: ['周传海', '周涛'],
        castAliasSources: { 周传海: ['周传海，班里资历最老的人'], 周涛: ['周涛，人称老周'] },
    });
    assert.deepEqual(r.coverage.missing, ['周传海'], '★ 只有本人的档案能放宽本人的判定');
});

test('既往正文是共享证据（上一章就这么叫，这一章不必再要求出处）', () => {
    const r = computeAudit({
        content: '老周点了根烟。',
        previous: [{ chapter: 1, content: '大家都管周传海叫老周。' }],
        terms: ['周传海'],
        castNames: ['周传海'],
    });
    assert.deepEqual(r.coverage.missing, [], '没有卡也没关系：既往正文里的称呼同样是出处');
});

// ── 共享证据层的两道收紧：常用名/子串不许把真漏写洗成没漏 ──────────────
//
// 真机病根：本章根本没写到「陆尘」，前章却有「这片大陆很大」——单纯的
// `sharedEvidence.includes('大陆')` 把**常用名词**当成称呼出处，missing 被吞掉，
// 真漏写被洗成没漏（覆盖率是 warning 档，但假阴性掩盖真缺失）。「王铁」遇前章
// 「大王在此」是同一形状：大＋姓 与常用名词高频碰撞。
// 收紧只在**共享层**（既往正文，语料大、噪声多）：① 大前缀不进共享证据；
// ② 候选须落在称呼位置（lib/audit.js 的 appearsAtBoundary）。本人档案层是人工
// 写死的短文本，保持宽松——不许一起收窄（那条护栏见上方两个用例）。
test('★ 常用名词不许替人名交卷：共享证据里的「大陆」「大王」不算称呼出处', () => {
    const dalu = computeAudit({
        content: '他望着大陆出神。',
        previous: [{ chapter: 1, content: '这片大陆很大' }],
        terms: ['陆尘'], castNames: ['陆尘'],
    });
    assert.deepEqual(dalu.coverage.missing, ['陆尘'], '★「大陆」是名词不是称呼（大前缀不进共享证据）');

    const dawang = computeAudit({
        content: '他默不作声。',
        previous: [{ chapter: 1, content: '大王在此' }],
        terms: ['王铁'], castNames: ['王铁'],
    });
    assert.deepEqual(dawang.coverage.missing, ['王铁'], '★「大王」不许替「王铁」交卷');

    // 收紧不许误伤真称呼：称呼位置上的「老陆」（前有「叫」、后有「。」）仍算出处
    const lao = computeAudit({
        content: '老陆推门进来。',
        previous: [{ chapter: 1, content: '众人都叫他老陆。' }],
        terms: ['陆尘'], castNames: ['陆尘'],
    });
    assert.deepEqual(lao.coverage.missing, [], '称呼位置上的「老陆」仍是有效出处');
});

// ── 提案应用后 gate.targetRatio 必须与写章链口径同形 ────────────────────────
//
// 根因：recomputeGateFor 漏传 target，computeGateMetrics 退回默认 3000，而写章链按本书
// 自定义区间（2500-3500 → target 3000 是个巧合；但 2000-3000 → target 2500 就分家了）。
// targetRatio 是落盘留痕数字——修订后读就是一条错的达成率，下游面板/诊断据此给模型的
// 数字就打架。
test('★ applyProposal 重算 gate.targetRatio 对齐本书自定义区间（2000-3000 → target 2500，不是默认 3000）', async () => {
    await h.tool('novel_project').execute({ action: 'init', book: '目标本', chars: '2000-3000' }, h.exec);
    // 细纲必须带「## 本章必写场景」段，否则 computeGateMetrics.available=false → gate=null，
    // 重算降级为 null 直接退出。
    await h.tool('novel_outline').execute({
        action: 'save_chapter', book: '目标本', chapter: 1,
        outline: [
            '# 第 1 章',
            '',
            '## 本章必写场景',
            '- 开场：主角推开门，屋里没人；桌上茶还热着，留了字条；窗外雨下得很大。',
            '- 发现：字条字迹潦草，写着"别追了"；落款是三个月前失踪的人；主角的手在抖。',
            '- 回忆：三个月前的雨夜，他也是这样推门；那碗茶还冒着热气；她说自己出去一下就回来。',
            '- 悬念：字条是谁送的？她为什么回来过？那碗热茶说明她刚走不久。',
            '',
            '## 本章禁止偏离项',
            '- 不许出现 致命',
        ].join('\n'),
    }, h.exec);
    await h.tool('novel_outline').execute({ action: 'approve', book: '目标本', chapter: 1 }, h.exec);
    await h.tool('novel_write_chapter').execute({
        book: '目标本', chapter: 1, title: '初稿', content: chapterOf(2400), summary: '第一版', force: true,
    }, h.exec);

    const v2Content = chapterOf(2600);
    const p = await propose('目标本', v2Content, '扩容修订');
    await applyProposal(h.io(), '目标本', p.id, CFG, 'user');

    const novel = h.readJson('目标本/novel.json');
    const eff = effectiveCharConfig(CFG, novel).config;
    const expectedTarget = chapterCharTarget({ minChapterChars: eff.minChapterChars, maxChapterChars: eff.maxChapterChars });
    // 自定义 2000-3000 → expectedTarget 必须是 2500（与默认 3000 不同，这才是断言的成立条件）
    assert.equal(expectedTarget, 2500, '★ 断言前提：自定义区间 target=2500（不等于默认 3000）');
    const v2Chars = v2Content.replace(/\s/g, '').length;
    const expectedRatio = Math.round((v2Chars / expectedTarget) * 100);

    const gate = novel.chapters['1'].gate;
    assert.ok(gate, '应用后必须有 gate 记录（重算应成功）');
    assert.equal(gate.targetRatio, expectedRatio,
        `★ gate.targetRatio 必须对齐本书自定义区间（expected ${expectedRatio}，actual ${gate.targetRatio}）`);
});
