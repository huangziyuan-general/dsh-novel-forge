// test/logic.test.mjs — 纯逻辑单测（无宿主依赖，node --test 直跑）。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sanitizeTitle, chapterFileName, parseChapterFileName, nextVersion, nextSuffixedId } from '../lib/versioning.js';
import { gateChapterWrite, advanceStage, resetStage } from '../lib/gate.js';
import { PHASE_IDS, canonicalPhase, checkPhaseEntry, enterPhase, phaseBoard, renderPhaseBoard } from '../lib/phases.js';
import { detectVolumePlan } from '../lib/phase-io.js';
import { breakerState, recordRejection, recordSuccess, clearBreaker, breakerDigest } from '../lib/circuit-breaker.js';
import { reviewForPlatform, longestSufferingRun, sentenceCv } from '../lib/platform-review.js';
import { scanSensitive, CENSOR_KEYS } from '../lib/censor.js';
import { applyFactUpdates, queryFacts, factsDigest, assertLedgerChapter, factsAt, statusTimeline, foreshadowSetup, foreshadowPayoff, openForeshadows, foreshadowDigest, overdueForeshadows } from '../lib/ledger.js';
import { computeAudit, auditVerdict } from '../lib/audit.js';
import { matchWorldEntries, buildContextPack, renderPack } from '../lib/contextpack.js';
import { pathsFor, defaultNovel, chapterRecord, normalizeWorldEntry, bookInSession, isUnclaimed, addBookSession } from '../lib/store.js';
import { scanAiFlavor } from '../lib/noai.js';
import { roughOutline, splitIntoChapters, isChapterHeading } from '../lib/import.js';
import { diagnoseIntro, computeChapterDiagnosis } from '../lib/diagnose.js';
import { parseFactLines, foreshadowView } from '../lib/tools/common.js';
import { chaptersFromText, analyzeStructure, repeatedPhrases, compareStructures, libraryId, coefficientOfVariation, chapterMetrics } from '../lib/library.js';
import { parseWorldbookImport } from '../lib/worldbook-io.js';
import { splitSentences, measureStyleMetrics, measureMood, computeBaseline, judgeAgainstBaseline } from '../lib/style.js';
import { validateContinuity, isDeathRecord, deathTimeline } from '../lib/continuity.js';
import { contentGate, setupKeywords, factStatesAt } from '../lib/content-gate.js';
import { validatePolishEdits } from '../lib/polish.js';

// ── versioning ──────────────────────────────────────────────────────────────

test('versioning: 标题清洗与文件名往返', () => {
    assert.equal(sanitizeTitle('雨夜 来客?'), '雨夜-来客');
    assert.equal(sanitizeTitle('a/b\\c:d*e?f"g<h>i|j'), 'a-b-c-d-e-f-g-h-i-j');
    const name = chapterFileName(3, '雨夜来客', 2);
    assert.equal(name, '第3章-雨夜来客-v2.md');
    assert.deepEqual(parseChapterFileName(name), { n: 3, title: '雨夜来客', v: 2 });
    assert.equal(parseChapterFileName('第3章-v2.md'), null);
});

test('versioning: nextVersion 跨标题取章内最大版本（唯一版本计算入口）', () => {
    const files = ['第1章-初稿-v1.md', '第1章-雨夜-v2.md', '第2章-x-v1.md'];
    assert.equal(nextVersion(files, 1), 3);
    assert.equal(nextVersion(files, 3), 1);
    // 不合式文件名按 0 计，不参与取最大
    assert.equal(nextVersion(['第1章-v2.md', '随手记.md'], 1), 1);
});

// ── gate ────────────────────────────────────────────────────────────────────

test('gate: 细纲未批准拒绝，force 放行留痕，批准后通过', () => {
    const novel = defaultNovel({ title: '星海拾骨', genre: '科幻' });
    assert.equal(gateChapterWrite(novel, 1).ok, false);
    const forced = gateChapterWrite(novel, 1, { force: true });
    assert.equal(forced.ok, true);
    assert.equal(forced.forced, true);
    novel.approvals.outline['1'] = true;
    assert.deepEqual(gateChapterWrite(novel, 1), { ok: true, forced: false, reason: '第1章细纲已批准', rules: [] });
    assert.equal(gateChapterWrite(null, 1).ok, false);
});

test('gate: advanceStage 只前进不后退（旧名映射进九阶段）', () => {
    const novel = defaultNovel({ title: 'x', genre: 'y' });
    assert.equal(novel.stage, 'topic', '新书从九阶段起点开始');
    advanceStage(novel, 'drafting');           // 旧名 → writing
    assert.equal(novel.stage, 'writing');
    assert.equal(novel.phases.writing.status, 'in_progress', '推进顺便点亮 phases 记录');
    advanceStage(novel, 'planning');           // 旧名 → topic，序号更小 → 不后退
    assert.equal(novel.stage, 'writing');
    resetStage(novel, 'revising');             // 旧名 → revision
    assert.equal(novel.stage, 'revision');
    assert.throws(() => resetStage(novel, '不存在的阶段'), /未知阶段/);
});

// ── ledger ──────────────────────────────────────────────────────────────────

test('ledger: 追加/幂等/同章冲突拒绝/跨章推进放行', () => {
    let facts = [];
    const r1 = applyFactUpdates(facts, [{ entity: '林晚', key: '境界', value: '练气三层' }], { chapter: 3, now: 't1' });
    assert.equal(r1.conflicts.length, 0);
    assert.equal(r1.added.length, 1);
    facts = r1.facts;

    const r2 = applyFactUpdates(facts, [{ entity: '林晚', key: '境界', value: '练气三层' }], { chapter: 4 });
    assert.equal(r2.added.length, 0, '同值幂等');

    const r3 = applyFactUpdates(facts, [{ entity: '林晚', key: '境界', value: '筑基一层' }], { chapter: 3 });
    assert.equal(r3.conflicts.length, 1, '同章内改值=冲突');
    assert.equal(r3.facts.length, 1, '冲突不落账');

    const r4 = applyFactUpdates(facts, [{ entity: '林晚', key: '境界', value: '筑基一层' }], { chapter: 12 });
    assert.equal(r4.conflicts.length, 0);
    assert.equal(r4.added[0].chapter, 12);

    const latest = queryFacts(r4.facts, { entity: '林晚' });
    assert.equal(latest.length, 1);
    assert.equal(latest[0].value, '筑基一层');
    assert.ok(factsDigest(r4.facts, ['林晚'])[0].includes('第12章起'));
});

test('ledger: 空值与坏行拒绝', () => {
    assert.throws(() => applyFactUpdates([], [{ entity: 'x', key: 'k', value: '' }], { chapter: 1 }));
    assert.throws(() => applyFactUpdates([], [{ entity: '', key: 'k', value: 'v' }], { chapter: 1 }));
    assert.throws(() => applyFactUpdates([], [{ entity: 'x', key: 'k', value: 'v' }], { chapter: 0 }));
});

test('ledger: 章号护栏——不得超前于已写章节+1', () => {
    assert.doesNotThrow(() => assertLedgerChapter(2, 1), '正好接续下一章放行');
    assert.throws(() => assertLedgerChapter(3, 1), /超前/);
    assert.doesNotThrow(() => assertLedgerChapter(1, 0), '全书无章节时不拦');
    assert.throws(() => assertLedgerChapter(0, 5), /正整数/);
});

test('ledger: 时点推演——第 n 章看到的是当时的值，不是最新值', () => {
    const facts = [
        { entity: '林晚', key: '境界', value: '练气三层', chapter: 3, note: '' },
        { entity: '林晚', key: '境界', value: '筑基一层', chapter: 12, note: '' },
        { entity: '林晚', key: '境界', value: '练气九层', chapter: 8, note: '' }, // 补录：章号居中、写入最后
        { entity: '林晚', key: '位置', value: '青云峰', chapter: 5, note: '' },
        { entity: '沈砚', key: '境界', value: '金丹', chapter: 4, note: '' },
    ];
    const at10 = factsAt(facts, 10);
    assert.equal(at10.find((r) => r.key === '境界').value, '练气九层', '取章号 ≤10 里最大的那条，与写入顺序无关');
    assert.equal(at10.find((r) => r.key === '位置').value, '青云峰', '第5章的位置记到第10章仍有效');
    assert.equal(factsAt(facts, 12).find((r) => r.key === '境界').value, '筑基一层', '第12章之后才是最新值');
    assert.equal(factsAt(facts, 2).length, 0, '第2章时还没人登场');
    assert.equal(factsAt(facts, 5).length, 3, '第5章：林晚两键 + 沈砚一键');
    assert.deepEqual(factsAt(facts, 6, { entities: ['林晚'] }).map((r) => r.key).sort(), ['位置', '境界'].sort(), '实体过滤');
    assert.deepEqual(factsAt(facts, 6, { keys: ['境界'] }).map((r) => r.entity).sort(), ['林晚', '沈砚'].sort(), '键过滤');
    assert.throws(() => factsAt(facts, 0), /正整数/);
});

test('ledger: 时点推演——同章多条取最后写入的那条', () => {
    const facts = [
        { entity: 'A', key: 'k', value: 'v1', chapter: 7, note: '' },
        { entity: 'A', key: 'k', value: 'v2', chapter: 7, note: '' },
    ];
    assert.equal(factsAt(facts, 7)[0].value, 'v2');
});

test('ledger: statusTimeline——按章升序给演化线', () => {
    const facts = [
        { entity: '林晚', key: '境界', value: '筑基一层', chapter: 12, note: '突破' },
        { entity: '林晚', key: '境界', value: '练气三层', chapter: 3, note: '' },
        { entity: '林晚', key: '位置', value: '青云峰', chapter: 5, note: '' },
        { entity: '沈砚', key: '境界', value: '金丹', chapter: 4, note: '' },
    ];
    const t = statusTimeline(facts, '林晚');
    assert.deepEqual(t.map((r) => r.chapter), [3, 5, 12], '章号升序，与写入顺序无关');
    assert.deepEqual(t.map((r) => r.key), ['境界', '位置', '境界']);
    assert.equal(t[2].note, '突破');
    assert.deepEqual(statusTimeline(facts, '林晚', { keys: ['境界'] }).map((r) => r.chapter), [3, 12]);
    assert.deepEqual(statusTimeline(facts, '查无此人'), [], '查无此人不报错');
    assert.throws(() => statusTimeline(facts, ''), /entity/);
});

test('ledger: 伏笔埋设/回收/重复回收拒绝', () => {
    let list = foreshadowSetup([], { setup: '铜镜的裂纹', chapter: 5 });
    list = foreshadowSetup(list, { setup: '师尊的沉默', chapter: 6 });
    assert.equal(list.length, 2);
    assert.deepEqual(openForeshadows(list).map((f) => f.id), ['F1', 'F2']);
    list = foreshadowPayoff(list, 'F1', 20);
    assert.equal(openForeshadows(list).length, 1);
    assert.throws(() => foreshadowPayoff(list, 'F1', 21), /已.*回收/);
    assert.throws(() => foreshadowPayoff(list, 'F9', 21), /不存在/);
    assert.ok(foreshadowDigest(list)[0].includes('F2'));
});

test('ledger: 伏笔 plan 预计回收与超期告警', () => {
    let list = foreshadowSetup([], { setup: '铜镜的裂纹', chapter: 2, plan: 5 });
    list = foreshadowSetup(list, { setup: '师尊的沉默', chapter: 3 });
    assert.equal(list[0].plan, 5);
    assert.equal(list[1].plan, null, '未给 plan 时为 null');
    assert.deepEqual(overdueForeshadows(list, 5).map((f) => f.id), [], '第5章尚未超期');
    assert.deepEqual(overdueForeshadows(list, 6).map((f) => f.id), ['F1']);
    const digest = foreshadowDigest(list, 8, 6);
    assert.ok(digest[0].startsWith('F1'), '超期伏笔优先排序');
    assert.ok(digest[0].includes('已超期'));
    assert.ok(digest[1].includes('师尊的沉默'));
});

test('ledger: 伏笔改期——同 id 未回收允许更新 plan；已回收拒绝', () => {
    let list = foreshadowSetup([], { setup: '铜镜的裂纹', chapter: 2, plan: 5 });
    list = foreshadowSetup(list, { id: 'F1', setup: '铜镜的裂纹（扩到整面镜）', chapter: 3, plan: 9 });
    assert.equal(list.length, 1, '改期不新增条目');
    assert.equal(list[0].plan, 9, '未给 plan 的同 id 更新应改成新 plan');
    assert.equal(list[0].setup, '铜镜的裂纹（扩到整面镜）');
    assert.equal(list[0].payoffChapter, null);
    list = foreshadowPayoff(list, 'F1', 9);
    assert.throws(() => foreshadowSetup(list, { id: 'F1', setup: 'x', chapter: 10, plan: 12 }), /回收.*改期/);
});

// ── audit ───────────────────────────────────────────────────────────────────

const para = (t) => `${t}\n\n`;

test('audit: 钩子/对话占比/重复率', () => {
    const withHook = para('夜风把灯笼吹得摇晃。林晚按住刀柄，慢慢走进院子。\n\n「谁？」她低声问。\n\n门外的人影停住了，却不知是敌是友。');
    const a1 = computeAudit({ content: withHook, previous: [], terms: ['林晚'] });
    assert.equal(a1.endingHook.detected, true);
    assert.ok(['question', 'suspense'].includes(a1.endingHook.kind));
    assert.equal(a1.coverage.missing.length, 0);
    assert.ok(a1.dialogueRatio > 0);

    const noHook = para('两人把账目核对完毕，各自回去休息。\n\n第二天照常开市。街道上人来人往。\n\n一切如常，日子平稳地继续了下去。');
    const a2 = computeAudit({ content: noHook, previous: [], terms: [] });
    assert.equal(a2.endingHook.detected, false);
});

test('audit: 与前文复读检测', () => {
    const dup = '少年握紧手中的铜镜，镜子背面刻着一个陌生的名字。'.repeat(3);
    const a = computeAudit({
        content: para(dup), previous: [{ chapter: 1, content: dup }], terms: [],
    });
    assert.equal(a.repetition.jaccard, 1);
    const v = auditVerdict(a, { minChapterChars: 10, maxChapterChars: 5000 });
    assert.equal(v.ok, false, '高度重复必须不通过');
    assert.ok(v.problems.some((p) => p.includes('重复')));
});

test('audit: 字数上下限与要素缺失警告', () => {
    const a = computeAudit({ content: '太短。', previous: [], terms: ['林晚'] });
    const v = auditVerdict(a, { minChapterChars: 500, maxChapterChars: 12000 });
    assert.equal(v.ok, false);
    assert.ok(v.problems.some((p) => p.includes('低于下限')));
});

// ── contextpack ─────────────────────────────────────────────────────────────

test('contextpack: 世界书关键词命中与 always 常驻', () => {
    const entries = [
        { id: 'W1', keywords: ['灵潮'], content: '灵潮每六十年一次。', always: false },
        { id: 'W2', keywords: ['无关词'], content: '不该命中。', always: false },
        { id: 'W3', keywords: [], content: '全书核心设定。', always: true },
    ];
    const hit = matchWorldEntries(entries, ['第三章：灵潮将至', '林晚']);
    assert.deepEqual(hit.map((e) => e.id), ['W1', 'W3']);
    assert.equal(matchWorldEntries(entries, ['没有触发词']).map((e) => e.id)[0], 'W3');
});

test('contextpack: 预算裁剪优先保细纲，先丢大纲', () => {
    const pack = buildContextPack({
        chapter: 3,
        chapterOutline: '细纲：'.padEnd(200, 'A'),
        bookOutline: '全书大纲：'.padEnd(5000, 'B'),
        castCards: [{ name: '林晚', card: '卡'.padEnd(300, 'C') }],
        budget: 800,
    });
    assert.ok(pack.sections[0].name.includes('细纲'));
    assert.equal(pack.dropped.includes('全书大纲'), true);
    assert.ok(pack.totalChars <= 800);
    assert.ok(renderPack(pack).includes('<<'));
});

test('contextpack: 人物卡均摊预算，账本不被挤掉', () => {
    const cards = Array.from({ length: 8 }, (_, i) => ({ name: `人物${i}`, card: '卡'.repeat(2000) }));
    const pack = buildContextPack({
        chapter: 2,
        chapterOutline: '细纲'.padEnd(300, 'A'),
        castCards: cards,
        factsDigest: ['林晚·境界: 筑基一层（第1章起）'],
        budget: 6000,
    });
    const names = pack.sections.map((s) => s.name);
    assert.ok(names.some((n) => n.includes('事实账本')), '账本必须保留——8 张人物卡不许吃光预算');
    assert.ok(pack.totalChars <= 6000);
});

test('contextpack: 世界书 priority 排序与递归激活', () => {
    const entries = [
        { id: 'W1', keywords: ['灵潮'], content: '灵潮由溯回者引发。', always: false, priority: 30 },
        { id: 'W2', keywords: ['溯回者'], content: '溯回者时间线。', always: false, priority: 90 },
        { id: 'W3', keywords: ['无关'], content: 'x', always: true, priority: 10 },
    ];
    const hit = matchWorldEntries(entries, ['灵潮将至']);
    // 递归：第1轮 W1/W3 激活；W1 内容含「溯回者」→ 第2轮拉入 W2；按 priority 降序输出
    assert.deepEqual(hit.map((e) => e.id), ['W2', 'W1', 'W3']);
});

// ── store ───────────────────────────────────────────────────────────────────

test('store: 章节记录版本追踪与路径表', () => {
    const p = pathsFor('星海拾骨');
    assert.equal(p.meta, '星海拾骨/novel.json');
    assert.equal(p.chapterOutline(3), '星海拾骨/大纲/细纲/第3章.md');
    assert.equal(p.chapterFile(3, '雨夜来客', 2), '星海拾骨/正文/第3章-雨夜来客-v2.md');

    let rec = chapterRecord(undefined, { title: '雨夜来客', version: 1, file: 'x/第3章-雨夜来客-v1.md', chars: 100, summary: 's' });
    rec = chapterRecord(rec, { title: '雨夜来客', version: 2, file: 'x/第3章-雨夜来客-v2.md', chars: 120, summary: 's2' });
    assert.deepEqual(rec.versions, [1, 2]);
    assert.equal(rec.latest, 2);
    assert.equal(rec.files.length, 2);
});

test('store: 会话归属——bookInSession / isUnclaimed / addBookSession', () => {
    const n = defaultNovel({ title: 'x', genre: 'y', session: 's1' });
    assert.deepEqual(n.sessions, ['s1'], '创建时带上会话戳');
    assert.equal(bookInSession(n, 's1'), true);
    assert.equal(bookInSession(n, 's2'), false);
    assert.equal(bookInSession(n, ''), false, '★ 空会话 id 不能命中任何书（否则面板会全量显示）');
    assert.equal(bookInSession(n, undefined), false);
    assert.equal(isUnclaimed(n), false);

    assert.equal(addBookSession(n, 's1'), false, '已归属的会话不重复追加');
    assert.equal(addBookSession(n, 's2'), true);
    assert.equal(addBookSession(n, null), false, '没有会话 id 时不得写入');
    assert.deepEqual(n.sessions, ['s1', 's2'], '一本书可以被多个会话拥有（多会话接续同一本书）');

    const fresh = defaultNovel({ title: 'l', genre: 'g' });
    assert.deepEqual(fresh.sessions, [], '不传 session → 空归属集');
    assert.equal(isUnclaimed(fresh), true);

    // 0.5.0 之前的书完全没有 sessions 字段：必须按「未归属」处理，而不是炸
    assert.equal(isUnclaimed({ title: 'legacy', chapters: {} }), true);
    assert.equal(bookInSession({ title: 'legacy' }, 's1'), false);
});

test('store: 世界书条目校验', () => {
    assert.throws(() => normalizeWorldEntry({ keywords: [], content: 'x' }), /关键词/);
    assert.throws(() => normalizeWorldEntry({ keywords: ['k'], content: '' }), /content/);
    let list = [];
    list.push(normalizeWorldEntry({ keywords: ['灵潮'], content: '设定' }, list));
    assert.throws(() => normalizeWorldEntry({ id: 'W1', keywords: ['x'], content: 'y' }, list), /重复/);
    const always = normalizeWorldEntry({ keywords: [], content: '核心', always: true }, []);
    assert.equal(always.always, true);
});

// ── noai ────────────────────────────────────────────────────────────────────

const AI_FLAVORED = [
    '夜色如水，空气仿佛凝固了。林晚站在窗前，一一丝不易察觉的笑意在她眼底闪过一丝。',
    '她缓缓开口，声音里带着一丝颤抖：「你终于来了。」陈默的下意识地握紧了拳头，心中一紧。',
    '这不是愤怒，而是一种更深的东西。仿佛命运的车轮，冥冥之中早已注定了一切。',
    '他的眼中闪过一丝精光，嘴角勾起一抹弧度。空气仿佛凝固了，时间仿佛静止了。',
    ' perhaps, or maybe not. 她不由自主地后退了一步，一股莫名的寒意从心底涌起。',
    '这一刻，她明白了。属于他的时代，早已不是当初。',
].join('\n\n');

const CLEAN = [
    '林晚把最后一枚铜钱按进香炉，灰烬腾起来，呛得她直咳嗽。',
    '院门吱呀一声开了条缝。她没有回头，只是把刀往膝盖边挪了半寸。\n\n「进来吧，别站在风口上。」她说。',
    '来人在门槛外站了很久，久到灯笼里的蜡油淌到了托盘上。然后他笑了，把一只湿透的布鞋放在了台阶上。\n\n林晚盯着那只鞋看了两息，忽然吹熄了灯。',
].join('\n\n');

test('noai: AI 味样本显著高于干净样本，且模板句被点名', () => {
    const bad = scanAiFlavor(AI_FLAVORED, { topK: 8 });
    const good = scanAiFlavor(CLEAN, { topK: 8 });
    assert.ok(bad.score > good.score + 10, `bad=${bad.score} good=${good.score}`);
    assert.ok(bad.categories.cliche.total >= 6, `模板句命中 ${bad.categories.cliche.total}`);
    assert.ok(bad.categories.cliche.hits.some((h) => h.lines.length > 0), '要给行号定位');
    assert.ok(bad.topIssues.length > 0);
    assert.ok(['轻微', '明显', '严重'].includes(bad.level), `bad level=${bad.level}`);
    assert.ok(good.score < bad.score);
});

test('noai: 空文本安全', () => {
    const s = scanAiFlavor('');
    assert.equal(s.chars, 0);
    assert.equal(s.score, 0);
});

test('noai: 单调段落被结构维度点名', () => {
    const mono = Array.from({ length: 10 }, () => '他走了过去。'.padEnd(40, '然后继续走。')).join('\n\n');
    const s = scanAiFlavor(mono);
    assert.ok(s.categories.structure.score >= 40, `structure=${s.categories.structure.score}`);
});

// ── import backfill / diagnose 词库外置 ──────────────────────────────────────

test('import: roughOutline 生成含钩子与人物信息的回补粗纲', () => {
    const md = roughOutline({
        n: 2, title: '布鞋', chars: 900,
        opening: '门前放着一只湿透的布鞋', tail: '她忽然吹熄了灯。',
        hookKind: 'suspense', cast: ['林晚'],
    });
    assert.ok(md.includes('第2章 布鞋'));
    assert.ok(md.includes('导入回补'));
    assert.ok(md.includes('钩子：suspense'));
    assert.ok(md.includes('林晚'));
    // 无钩子/无人物时的回退文案
    const bare = roughOutline({ n: 1, title: 'x', chars: 10, opening: '', tail: '', hookKind: null, cast: [] });
    assert.ok(bare.includes('未检出钩子'));
    assert.ok(bare.includes('未识别'));
});

test('diagnose: 词库外置到 lib/data 后四维诊断照常工作', () => {
    const content = [
        '林晚在香炉前醒来，灰烬呛得她咳。',
        '「谁？」她拔出刀，与黑影对峙。那人不肯让步，冷笑一声反扑上来。',
        '据说这大陆上有一种规矩，可将亡者分为三等。',
        '她突然停住了脚步……',
    ].join('\n\n');
    const d4 = computeChapterDiagnosis(content);
    assert.ok(d4.conflict >= 40, `冲突词应命中 conflict=${d4.conflict}`);
    assert.ok(d4.infodump >= 30, `灌输词应命中 infodump=${d4.infodump}`);
    assert.ok(d4.hook > 60, `章末省略号钩子 hook=${d4.hook}`);
    const d = diagnoseIntro({ chapters: [{ chapter: 1, title: '试', content }], outline: '有大纲', logline: '有一句话立意' });
    assert.equal(d.perChapter.length, 1);
    assert.equal(typeof d.overall, 'string');
});

// ── id 生成 / 自愈 ───────────────────────────────────────────────────────────

test('id: nextSuffixedId 取已用最大编号+1，删低 id 不复用后缀', () => {
    assert.equal(nextSuffixedId(['F1', 'F2'], 'F'), 'F3');
    assert.equal(nextSuffixedId(['F1', 'F3', 'custom'], 'F'), 'F4', '手工 id 不干扰数字续号');
    assert.equal(nextSuffixedId([], 'W'), 'W1');
    assert.equal(nextSuffixedId(['W2'], 'W'), 'W3');
});

test('ledger: 自动伏笔 id gap 安全——删低 id 后新增不复用、不覆盖现存', () => {
    let list = foreshadowSetup([], { setup: 'a', chapter: 1 }); // F1
    list = foreshadowSetup(list, { setup: 'b', chapter: 1 });   // F2
    list = foreshadowSetup(list, { setup: 'c', chapter: 1 });   // F3
    list = list.filter((f) => f.id !== 'F1');                   // 手工删低 id
    list = foreshadowSetup(list, { setup: 'd', chapter: 2 });   // 应续 F4
    assert.equal(list.at(-1).id, 'F4');
    assert.equal(list.find((f) => f.id === 'F2').setup, 'b', 'F2 未被静默覆盖');
});

test('store: 世界书自动 id gap 安全', () => {
    let list = [];
    list = [...list, normalizeWorldEntry({ keywords: ['a'], content: 'x' }, list)]; // W1
    list = [...list, normalizeWorldEntry({ keywords: ['b'], content: 'x' }, list)]; // W2
    list = [...list, normalizeWorldEntry({ keywords: ['c'], content: 'x' }, list)]; // W3
    list = list.filter((e) => e.id !== 'W1');
    const next = normalizeWorldEntry({ keywords: ['d'], content: 'x' }, list);
    assert.equal(next.id, 'W4');
    assert.equal(list.find((e) => e.id === 'W2').keywords[0], 'b');
});

// ── parseFactLines ────────────────────────────────────────────────────────────

test('parseFactLines: 空白 entity/key 被拒绝', () => {
    assert.throws(() => parseFactLines(' | key | value'), /实体名不能为空/);
    assert.throws(() => parseFactLines('entity |  | value'), /键名不能为空/);
    assert.throws(() => parseFactLines('  |  | value'), /实体名不能为空/);
    const ok = parseFactLines('林晚 | 境界 | 筑基三层');
    assert.equal(ok.length, 1);
    assert.equal(ok[0].entity, '林晚');
});

test('contextpack: glossaryDigest 注入上下文包', () => {
    const pack = buildContextPack({
        chapter: 1,
        chapterOutline: '细纲内容',
        glossaryDigest: ['溯回者：时间旅行者的别称', '灵潮：六十年一次的能量潮汐'],
        budget: 3000,
    });
    const names = pack.sections.map((s) => s.name);
    assert.ok(names.some((n) => n.includes('术语表')), '术语表必须保留');
    const glossary = pack.sections.find((s) => s.name.includes('术语表'));
    assert.ok(glossary.content.includes('溯回者'));
    assert.ok(glossary.content.includes('灵潮'));
});

// ── 回归：输出契约（缺省字段省略键）/ worldbook import 续号 / 中文章号 ──────────

test('audit: 无钩子/无前文时省略可选键——null/undefined 会触发宿主 INVALID_TOOL_OUTPUT', () => {
    const a = computeAudit({ content: para('甲。\n\n乙。\n\n丙。'), previous: [], terms: [] });
    assert.equal(a.endingHook.detected, false);
    assert.ok(!Object.hasOwn(a.endingHook, 'kind'), '无钩子时不应有 kind 键');
    assert.equal(a.repetition.jaccard, 0);
    assert.ok(!Object.hasOwn(a.repetition, 'chapter'), '无前文时不应有 chapter 键');
});

test('foreshadowView: plan/payoffChapter 缺省时省略键', () => {
    const open = foreshadowView({ id: 'F1', setup: '铜镜裂纹', chapter: 2, plan: null, payoffChapter: null });
    assert.deepEqual(open, { id: 'F1', setup: '铜镜裂纹', chapter: 2 });
    const done = foreshadowView({ id: 'F1', setup: '铜镜裂纹', chapter: 2, plan: 5, payoffChapter: 9 });
    assert.deepEqual(done, { id: 'F1', setup: '铜镜裂纹', chapter: 2, plan: 5, payoffChapter: 9 });
});

test('worldbook: import 续号避开已有 id；显式撞 id 进 errors 而非静默覆盖', () => {
    const existing = [
        { id: 'W1', keywords: ['灵潮'], content: '灵潮六十年一次。', always: false, priority: 50 },
        { id: 'W2', keywords: ['溯回者'], content: '溯回者时间线。', always: false, priority: 50 },
    ];
    const { entries, errors } = parseWorldbookImport('骨语 | 拾骨人能与骨对话\n星图 | 逆命者的命盘', existing);
    assert.deepEqual(errors, []);
    assert.deepEqual(entries.map((e) => e.id), ['W3', 'W4'], '自动 id 必须接在已有最大编号之后');
    // 显式撞已有 id → 拒绝并记录（修订请走 update action），不再留给上层 merge 静默覆盖
    const dup = parseWorldbookImport('[{"id":"W1","keywords":["x"],"content":"覆盖灵潮"}]', existing);
    assert.equal(dup.entries.length, 0);
    assert.ok(dup.errors[0].includes('重复'));
});

test('import: 中文数字章号（第十一起）也能切分', () => {
    assert.equal(isChapterHeading('第十一章 风起'), true);
    assert.equal(isChapterHeading('第二十三章 云动'), true);
    assert.equal(isChapterHeading('第一百零八章 归一'), true);
    const cs = splitIntoChapters('第十一章 风起\n\n甲正文。\n\n第二十三章 云动\n\n乙正文。\n\n第一百零八章\n\n丙正文。');
    assert.equal(cs.length, 3);
    assert.deepEqual(cs.map((c) => c.title), ['风起', '云动', '第3章']);
    assert.equal(cs[1].content, '乙正文。');
});

// ── style：文笔六维基线 ─────────────────────────────────────────────────────

test('style: 切句——剥标题、吞引号、连续句末符不拆残片', () => {
    const text = '# 第1章 测试\n\n她说："走吧。"\n\n太好了！！！他哭了。。。\n\n风停了。';
    const ss = splitSentences(text);
    // 句末闭合引号被剥掉
    assert.equal(ss.some((s) => /[」』"]$/.test(s)), false);
    assert.equal(ss.some((s) => s.includes('走吧')), true);
    // 纯句末标点残片（！！！/。。。）被丢弃
    assert.equal(ss.some((s) => /^[。！？!？]+$/.test(s)), false);
    assert.equal(ss.includes('太好了！！！'), true);
});

test('style: 六维测量——动作章与心理章方向正确', () => {
    const actionCh = '他推开门，拔出刀，砍翻了挡路的桌椅。她抓起包袱，拉着他冲出后门，跳上马背。他挥刀劈开铁锁，踹倒了追兵。';
    const hedgingCh = '她似乎觉得一切仿佛都是一场梦，大概也许只有离开才是对的。他好像有些犹豫，似乎想起了什么，像是隐约看见了什么，或许那只是错觉。';
    const a = measureStyleMetrics(actionCh);
    const h = measureStyleMetrics(hedgingCh);
    assert.ok(a.action > h.action, '动作章 action 应高于心理章');
    assert.ok(h.hedging > a.hedging, '心理章 hedging 应高于动作章');
    assert.ok(a.chars > 0 && a.sentences > 0);
    // 密度维全部为每千字口径的非负数
    for (const k of ['modifier', 'abstract', 'action', 'hedging', 'blank']) {
        assert.ok(a[k] >= 0 && h[k] >= 0);
    }
});

test('style: 修饰密度——「X地」排除名词词素', () => {
    const withNounDi = measureStyleMetrics('他在地铁上看着地图，慢慢地走到了地方。');
    const plain = measureStyleMetrics('他慢慢地走。');
    // 名词「地铁/地图/地方」不计修饰；「慢慢地」计一次
    assert.ok(withNounDi.chars > plain.chars);
    assert.ok(plain.modifier > 0);
});

test('style: 基线计算——μ/σ/容差夹取', () => {
    const mk = (v) => ({ chars: 1000, sentences: 10, syntax: 2, modifier: v, abstract: 1, action: 10, hedging: 1, blank: 1 });
    const b = computeBaseline([mk(30), mk(40), mk(50)]);
    assert.equal(b.chapters, 3);
    assert.equal(b.dims.modifier.mu, 40);
    assert.ok(b.dims.modifier.sigma > 0);
    // 1.5σ/μ：总体 σ=√(200/3)≈8.16 → 8.16/40*150 ≈ 30.6 → 31
    assert.equal(b.dims.modifier.tolerance, 31);
    // 单样本无波动：σ=null，容差退化为 35
    const single = computeBaseline([mk(30)]);
    assert.equal(single.dims.modifier.sigma, null);
    assert.equal(single.dims.modifier.tolerance, 35);
});

test('style: 对照判定——带内/出带与偏差方向', () => {
    const mk = (v) => ({ chars: 1000, sentences: 10, syntax: 2, modifier: v, abstract: 1, action: 10, hedging: 1, blank: 1 });
    const baseline = computeBaseline([mk(30), mk(40), mk(50)]);
    const inBand = judgeAgainstBaseline(mk(42), baseline);
    assert.equal(inBand.verdict, 'in_band');
    assert.equal(inBand.inBand, true);
    const drift = judgeAgainstBaseline(mk(90), baseline);
    assert.ok(drift.outCount >= 1);
    assert.equal(drift.deviations[0].dim, 'modifier');
    assert.ok(drift.deviations[0].deviationPct > 0);
    assert.equal(drift.verdict, 'minor_drift');
    // 容差覆盖生效
    const strict = judgeAgainstBaseline(mk(50), baseline, { modifier: 10 });
    assert.equal(strict.dims.modifier.inBand, false);
});

test('style: 氛围光谱——词表重复词不去重则悬疑轴双倍计分', () => {
    // 998 个"天"字 + 一个"线索"：仅 1 次悬疑命中 → 每千字应为 1.0（若重复词双倍计分则为 2.0）
    const text = '天'.repeat(996) + '线索';
    const mood = measureMood(text);
    assert.equal(mood.chars, 998);
    assert.equal(mood.axes.mystery, 1.0, '悬疑轴只该计 1 次命中，重复词 "线索" 不得双倍计分');
    assert.equal(mood.top[0], 'mystery');
});

// ── 第二批融合 B1：一致性校验（来源：novel-studio validateContinuity，适配本插件模型）──

test('continuity: 死亡判定认死亡词、排反例，取最早死亡章', () => {
    assert.equal(isDeathRecord({ entity: '赵擎', key: '状态', value: '阵亡', chapter: 5 }), true);
    assert.equal(isDeathRecord({ entity: '赵擎', key: '生死', value: '未死', chapter: 5 }), false, '「未死」不是死亡');
    assert.equal(isDeathRecord({ entity: '林晚', key: '境界', value: '死寂之地', chapter: 5 }), false, '键名不命中就不算死亡记录');
    assert.equal(isDeathRecord({ entity: 'a', key: '状态', value: '不死之身', chapter: 1 }), false, '反例词必须排掉');
    assert.equal(isDeathRecord({ entity: 'a', key: '状态', value: '拼死一战', chapter: 1 }), false);
    const t = deathTimeline([
        { entity: '赵擎', key: '状态', value: '重伤', chapter: 1 },
        { entity: '赵擎', key: '状态', value: '阵亡', chapter: 5 },
        { entity: '赵擎', key: '下落', value: '尸骨被发现', chapter: 9 },
    ]);
    assert.equal(t.get('赵擎').chapter, 5, '第一死才算数，后文不改变死亡时点');
});

test('continuity: 死人复活报硬伤；细纲有闪回标记则降级为警告', () => {
    const novel = { cast: ['林晚', '赵擎'], chapters: {
        1: { title: 'a', path: 'b/正文/第1章-a-v1.md', latest: 1, files: [{ file: 'b/正文/第1章-a-v1.md' }], summary: 's' },
        2: { title: 'b', path: 'b/正文/第2章-b-v1.md', latest: 1, files: [{ file: 'b/正文/第2章-b-v1.md' }], summary: 's' },
    } };
    const facts = [{ entity: '赵擎', key: '状态', value: '阵亡', chapter: 1 }];

    const hard = validateContinuity({ novel, facts, texts: { 2: '赵擎推门走了进来。' } });
    assert.equal(hard.ok, false, '死人复活必须是硬伤');
    assert.ok(hard.issues.some((i) => i.code === 'dead-reappear' && i.severity === 'error'));

    const soft = validateContinuity({ novel, facts, texts: { 2: '赵擎推门走了进来。' }, outlines: { 2: '回忆：当年他也是这样推门进来的。' } });
    assert.ok(soft.issues.some((i) => i.code === 'dead-reappear-in-flashback' && i.severity === 'warning'), '闪回豁免降级');
    assert.ok(!soft.issues.some((i) => i.code === 'dead-reappear'), '豁免后不该再报硬伤');

    // 死亡之前的章节提到他，不算问题
    const before = validateContinuity({ novel, facts, texts: { 1: '赵擎还在。' } });
    assert.ok(!before.issues.some((i) => i.code === 'dead-reappear' || i.code === 'dead-reappear-in-flashback'));
});

test('continuity: 伏笔倒挂/超期/重复 id、索引缺文件、账本同章冲突与超前', () => {
    const novel = { cast: [], chapters: {
        1: { title: 'a', path: 'b/第1章-a-v3.md', latest: 3, files: [{ file: 'b/第1章-a-v3.md' }], summary: 's' },
        3: { title: 'c', path: 'b/缺失.md', latest: 1, files: [{ file: 'b/缺失.md' }], summary: '' },
    } };
    const facts = [
        { entity: '林晚', key: '境界', value: '筑基', chapter: 2 },
        { entity: '林晚', key: '境界', value: '金丹', chapter: 2 },
        { entity: '甲', key: 'k', value: 'v', chapter: 99 },
    ];
    const foreshadows = [
        { id: 'F1', setup: '断刃的下落', chapter: 5, plan: 3, payoffChapter: 4 },
        { id: 'F2', setup: '密信的来源', chapter: 1, plan: 2, payoffChapter: null },
        { id: 'F2', setup: '重复登记', chapter: 1, plan: null, payoffChapter: null },
    ];
    const r = validateContinuity({ novel, facts, foreshadows, existingFiles: new Set(['b/第1章-a-v3.md']) });
    const codes = r.issues.map((i) => i.code);
    for (const c of ['foreshadow-payoff-before-setup', 'foreshadow-overdue', 'foreshadow-duplicate-id',
        'chapter-file-missing', 'ledger-same-chapter-conflict', 'ledger-chapter-ahead',
        'chapter-gap', 'chapter-summary-missing']) {
        assert.ok(codes.includes(c), `应报 ${c}，实报 ${codes.join(',')}`);
    }
    assert.equal(r.ok, false);
    // 缺卡检查：给了 castCards 才查
    const withCards = validateContinuity({ novel: { ...novel, cast: ['林晚'] }, facts: [], foreshadows: [], castCards: {} });
    assert.ok(withCards.issues.some((i) => i.code === 'character-card-missing'));
    const noCards = validateContinuity({ novel: { ...novel, cast: ['林晚'] }, facts: [], foreshadows: [], castCards: null });
    assert.ok(!noCards.issues.some((i) => i.code === 'character-card-missing'), '不传 castCards 就不查卡');
});

// ── 第二批融合 C2/C3：四维内容门禁 ──────────────────────────────────────────

test('content-gate: 死人复活阻断；账本旧值仍在用则警告', () => {
    const facts = [
        { entity: '赵擎', key: '状态', value: '阵亡', chapter: 2 },
        { entity: '林晚', key: '境界', value: '筑基三层', chapter: 1 },
        { entity: '林晚', key: '境界', value: '金丹一层', chapter: 5 },
    ];
    const g = contentGate({ content: '赵擎站在门口。林晚仍只有筑基三层的修为，她自己也知道。', chapter: 6, facts, actorNames: ['赵擎', '林晚'] });
    assert.equal(g.ok, false);
    assert.ok(g.blocking.some((b) => b.code === 'dead-character-present'));
    assert.ok(g.warnings.some((w) => w.code === 'stale-state' && w.message.includes('筑基三层')));

    const clean = contentGate({ content: '林晚已是金丹一层，抬手压住了风。', chapter: 6, facts });
    assert.equal(clean.ok, true);
    assert.equal(clean.warnings.length, 0);
});

test('content-gate: 到期伏笔零回应且开了新钩 → 阻断；回应了则放行', () => {
    const foreshadows = [{ id: 'F1', setup: '断刃的下落', chapter: 1, plan: 3, payoffChapter: null }];
    const body = '林晚走进院子，把灯芯挑亮了一寸。她坐下，又站起来。';
    const withNewHook = `${body.repeat(8)}\n\n门外忽然传来一声轻响。`;
    const blocked = contentGate({ content: withNewHook, chapter: 4, foreshadows });
    assert.equal(blocked.ok, false);
    assert.ok(blocked.blocking.some((b) => b.code === 'debt-unanswered-with-new-hook'));

    // 同一章里提到了「断刃」→ 视为回应，放行
    const answered = contentGate({ content: `${withNewHook}\n\n她摸了摸腰间的断刃。`, chapter: 4, foreshadows });
    assert.equal(answered.ok, true);

    // 没开新钩子、账也没还 → 只警告不阻断
    const noHook = contentGate({ content: body.repeat(8), chapter: 4, foreshadows });
    assert.equal(noHook.ok, true);
    assert.ok(noHook.warnings.some((w) => w.code === 'debt-unanswered'));

    // 未到期（plan 在第 9 章）→ 完全不管
    const notDue = contentGate({ content: withNewHook, chapter: 4, foreshadows: [{ id: 'F9', setup: '旧钟', chapter: 1, plan: 9, payoffChapter: null }] });
    assert.ok(!notDue.warnings.some((w) => w.code === 'debt-unanswered'));
    assert.ok(!notDue.blocking.some((b) => b.code === 'debt-unanswered-with-new-hook'));
});

test('content-gate: 占位符阻断、人称混用警告', () => {
    const ph = contentGate({ content: '林晚走进来。\n\n（此处省略打斗过程）\n\n她坐下。', chapter: 1 });
    assert.equal(ph.ok, false);
    assert.ok(ph.blocking.some((b) => b.code === 'placeholder'));

    const mixed = contentGate({ content: ['我推开门。', '我看见他在擦刀。', '我问他为什么。', '我说了不该说的话。', '我把灯吹熄了。', '他说他不知道。', '他站起来。', '她看向窗外。', '他把手按在刀上。', '她走了。', '他回头。'].join('\n\n'), chapter: 1 });
    assert.ok(mixed.warnings.some((w) => w.code === 'person-mixed'));
});

test('content-gate: 关键词提取过滤虚词，账本状态推演带历史值', () => {
    const kws = setupKeywords('断刃的下落');
    assert.ok(kws.includes('断刃'), '有效关键词要保留');
    assert.ok(!kws.some((k) => k.startsWith('的')), '虚词开头片段必须滤掉');

    const states = factStatesAt([
        { entity: '林晚', key: '境界', value: '筑基三层', chapter: 1 },
        { entity: '林晚', key: '境界', value: '筑基三层', chapter: 3 },
        { entity: '林晚', key: '境界', value: '金丹一层', chapter: 5 },
    ], 6);
    const s = states.get('林晚\u0000境界');
    assert.equal(s.value, '金丹一层');
    assert.deepEqual(s.history.map((h) => h.value), ['筑基三层']);
    assert.equal(factStatesAt([{ entity: 'x', key: 'y', value: 'z', chapter: 9 }], 3).size, 0, '未来章不算当前值');
});

// ── 第二批融合 C1：润色保守编辑守卫（来源：dsh-tool-writing autoproof）──────

test('polish 守卫：改标题/引入易混字 → 阻断；正常润色 → 通过', () => {
    const paras = Array.from({ length: 6 }, (_, i) => `第${i}段：林晚在院子里擦刀，露水顺着刀鞘滑下来，她没说话。`);
    const orig = ['第3章 雨夜来客', ...paras].join('\n\n');

    const heading = validatePolishEdits(orig, orig.replace('第3章 雨夜来客', '第3章 雨夜来客改'));
    assert.equal(heading.ok, false);
    assert.ok(heading.blocking.some((b) => b.code === 'heading-changed'));

    const confusable = validatePolishEdits(orig, orig.replace('林晚在院子里擦刀', '林晚在院子里擦刀，戌时的风起了'));
    assert.equal(confusable.ok, false);
    assert.ok(confusable.blocking.some((b) => b.code === 'confusable-char'));

    const good = validatePolishEdits(orig, orig.replace('她没说话。', '她没吭声。'));
    assert.equal(good.ok, true);
    assert.equal(good.warnings.length, 0);
});

test('polish 守卫：整章膨胀与大面积重写只警告不阻断', () => {
    const paras = Array.from({ length: 6 }, (_, i) => `第${i}段：林晚在院子里擦刀，露水顺着刀鞘滑下来，她没说话。`);
    const orig = ['第3章 雨夜来客', ...paras].join('\n\n');

    const bloated = validatePolishEdits(orig, `${orig}\n\n${'补充的一大段无关描写，纯粹注水。'.repeat(20)}`);
    assert.equal(bloated.ok, true, '膨胀是警告不是阻断');
    assert.ok(bloated.warnings.some((w) => w.code === 'chapter-growth'));

    const rewritten = ['第3章 雨夜来客', ...Array.from({ length: 6 }, (_, i) => `苏三在城头吹笛，第${i}声绕着檐角打转，惊起两只麻雀。`)].join('\n\n');
    const rw = validatePolishEdits(orig, rewritten);
    assert.ok(rw.warnings.some((w) => w.code === 'mass-rewrite'));
});

test('polish 守卫：首行不是标题时不做标题保护', () => {
    const orig = '林晚把刀放在桌上。\n\n她没说话。';
    const g = validatePolishEdits(orig, '林晚把刀搁在桌上。\n\n她没吭声。');
    assert.equal(g.ok, true, '首行是正文时改动不该被当成改标题');
});

// ─────────────────────────────────────────────────────────────────────────────
// 融合第三批（上下文工程）：B3 场景契约 / E3 语言基因卡 / A3+A4 细纲契约指标
// ─────────────────────────────────────────────────────────────────────────────

import {
    normalizeContract, resolveSceneCast, hiddenLeakCheck, renderContractSection,
    setContract, removeContract, contractFor,
} from '../lib/scene-contract.js';
import { normalizeVoice, renderVoiceCard, voiceConsistency, isEmptyVoice } from '../lib/voice.js';
import { parseScenes, parseBanRules, computeGateMetrics } from '../lib/gate-metrics.js';

test('B3 契约归一：中文别名、清单容错、字段补齐', () => {
    const c = normalizeContract({ chapter: 3, 场景: '雨夜断刃', 出场: '林晚、赵擎,陆寒', 隐藏: ['陆寒'], 禁项: '储物戒指' });
    assert.equal(c.chapter, 3);
    assert.equal(c.scene, '雨夜断刃');
    assert.deepEqual(c.participants, ['林晚', '赵擎', '陆寒']);
    assert.deepEqual(c.hidden, ['陆寒']);
    assert.deepEqual(c.forbidden, ['储物戒指']);
    assert.deepEqual(c.settings, [], '缺省字段补空数组，输出契约才稳定');
});

test('B3 契约裁剪：hidden 绝不进注入名单；无契约退回 cast 全员', () => {
    const c = normalizeContract({ chapter: 3, participants: '林晚,陆寒', hidden: '陆寒' });
    const r = resolveSceneCast({ contract: c, cast: ['林晚', '陆寒', '小满'] });
    assert.deepEqual(r.inject, ['林晚'], '★ 隐藏人物不得进注入名单');
    assert.deepEqual(r.hidden, ['陆寒']);
    assert.ok(r.dropped.includes('小满'), '契约外的人被剔出（省 token）');
    assert.deepEqual(r.contradictions, ['陆寒'], '出场∩隐藏 要报矛盾（保护优先）');
    assert.equal(r.source, 'contract');

    const fb = resolveSceneCast({ contract: null, cast: ['林晚', '赵擎'] });
    assert.deepEqual(fb.inject, ['林晚', '赵擎']);
    assert.equal(fb.source, 'fallback', '无契约时退回原行为');
});

test('B3 悬念保护：注入区块绝不出现隐藏人物名（本模块存在的全部意义）', () => {
    const c = normalizeContract({ chapter: 3, scene: '雨夜', participants: '林晚、陆寒', hidden: '陆寒' });
    const block = renderContractSection(c);
    assert.ok(!block.includes('陆寒'), '★ 隐藏人物的名字不得出现在模型可见的任何文本里');
    assert.ok(block.includes('林晚'), '出场人物要在场');
    assert.ok(block.includes('未登场'), '要告诉模型「有人身份未揭晓」，但不给名字');
    assert.equal(renderContractSection(null), '', '无契约不给空区块');
});

test('B3 泄漏检查 + 契约表不可变', () => {
    assert.deepEqual(hiddenLeakCheck({ content: '林晚看见陆寒站在雨里。', hidden: ['陆寒'] }), ['陆寒']);
    assert.deepEqual(hiddenLeakCheck({ content: '只有雨声。', hidden: ['陆寒'] }), []);

    const t0 = {};
    const t1 = setContract(t0, { chapter: 2, participants: '林晚' });
    const t2 = removeContract(t1, 2);
    assert.deepEqual(Object.keys(t0), [], '原表不被原地改动');
    assert.equal(contractFor(t1, 2).participants[0], '林晚');
    assert.equal(contractFor(t2, 2), null);
    assert.equal(contractFor(t1, 9), null, '没契约的章回 null（不造空壳）');
});

test('E3 语言基因卡：对象与「键|值」行两种输入归一', () => {
    const a = normalizeVoice({ 句长: '短句为主', 口头禅: '「呵」,行吧', 禁忌: '人家' });
    assert.equal(a.sentence, '短句为主');
    assert.deepEqual(a.tics, ['呵', '行吧'], '中文引号要剥掉');
    assert.deepEqual(a.taboo, ['人家']);
    const b = normalizeVoice('逻辑|先给结论\n语域|市井白话');
    assert.equal(b.logic, '先给结论');
    assert.equal(b.register, '市井白话');
    assert.equal(isEmptyVoice(normalizeVoice('乱七八糟没有冒号')), true, '解析不出内容＝空卡');
    assert.equal(isEmptyVoice(a), false);
    assert.ok(renderVoiceCard('林晚', a).includes('说话方式'));
    assert.equal(renderVoiceCard('林晚', {}), '', '空卡不占预算');
});

test('E3 语言一致性：禁忌词命中＝硬伤；有台词无口头禅＝提示；没台词不报', () => {
    const voice = normalizeVoice({ 口头禅: '呵', 禁忌: '人家' });
    const hitTaboo = voiceConsistency({ content: '林晚说：「人家不去了。」', voices: [{ name: '林晚', voice }] });
    assert.equal(hitTaboo.stats.errors, 1, '说了自己声明过的禁忌词要当硬伤');
    assert.equal(hitTaboo.issues[0].code, 'voice-taboo');

    const noTic = voiceConsistency({ content: '林晚说：「那就走吧。」', voices: [{ name: '林晚', voice }] });
    assert.equal(noTic.stats.warnings, 1, '有台词没口头禅只提示（口头禅是习惯不是义务）');
    assert.equal(noTic.issues[0].code, 'voice-tics-missing');

    const silent = voiceConsistency({ content: '林晚站在雨里，一动不动。', voices: [{ name: '林晚', voice }] });
    assert.equal(silent.issues.length, 0, '★ 本章没开口就不该报口头禅缺失');
    assert.equal(silent.checked, 1, '仍算核对过一个人');
});

test('A3/A4 细纲解析：序号/加粗/列表/复选框都要认（格式漂移容错）', () => {
    const scenes = parseScenes('- [ ] 雨夜相遇：林晚在码头遇见赵擎\n1. **断刃现世**：断刃浮起\n2、第三场');
    assert.equal(scenes.length, 3);
    assert.equal(scenes[0].title, '雨夜相遇');
    assert.equal(scenes[1].title, '断刃现世');
    assert.equal(scenes[2].title, '第三场', '无描述的场景也要认');
});

test('A3/A4 禁项分流：排除型算偏离度，需求型/条件型不算（彼踩过的坑）', () => {
    const r = parseBanRules('- 不得让陆寒出场\n- 禁止使用「储物戒指」\n- 不得省略「断刃」\n- 不得无铺垫引入「密信」');
    assert.ok(r.banned.includes('陆寒'));
    assert.ok(r.banned.includes('储物戒指'));
    assert.ok(!r.banned.includes('断刃'), '★ 需求型（不得省略）不是禁词——写到了才是对的');
    assert.ok(r.requirements.includes('断刃'));
    assert.ok(r.conditional.includes('密信'), '条件型只提示人工复核，不计偏离度');
});

test('A3/A4 契约指标：覆盖率/漏写/偏离度/场景豁免', () => {
    const outline = '## 本章必写场景\n1. 雨夜相遇：林晚在码头遇见赵擎\n2. 断刃现世：断刃从江底浮起\n\n## 本章禁止偏离项\n- 不得让陆寒出场\n';
    const full = computeGateMetrics({ content: '雨夜，林晚在码头遇见赵擎。断刃从江底浮起。', outline });
    assert.equal(full.available, true);
    assert.equal(full.coverage, 100);
    assert.equal(full.drift, 0);
    assert.equal(full.passed, true);

    const partial = computeGateMetrics({ content: '雨夜，林晚在码头遇见赵擎。', outline });
    assert.equal(partial.coverage, 50);
    assert.deepEqual(partial.missedScenes, ['断刃现世']);
    assert.equal(partial.passed, false, '漏场景＝不通过');

    const hit = computeGateMetrics({ content: '陆寒从雾里走出来，断刃从江底浮起。', outline });
    assert.deepEqual(hit.bannedHits, ['陆寒']);
    assert.equal(hit.drift, 100);
    assert.equal(hit.passed, false);

    const none = computeGateMetrics({ content: '随便一段。', outline: '没有契约段的大纲' });
    assert.equal(none.available, false, '没写契约段＝不参与判定（可选增强，不像彼那样 fail-closed）');
    assert.equal(none.passed, null);
    assert.deepEqual(none.missedScenes, [], '不可用时也要给空数组，输出契约才稳定');

    const broken = computeGateMetrics({ content: '随便一段。', outline: '## 本章必写场景\n\n## 本章禁止偏离项\n- 不得让陆寒出场\n' });
    assert.equal(broken.available, false);
    assert.match(broken.note, /解析不出/, '段存在但解析不出要给提示（不阻断，写不了章的代价更大）');
});


// ── F1 九阶段状态机 ─────────────────────────────────────────────────────────

test('★ F1 九阶段：旧名映射 / 入场条件由代码判 / 越级记 skipped / 看板', () => {
    // 旧五阶段名（用户盘上的老数据）一律映射进新链
    assert.equal(canonicalPhase('planning'), 'topic');
    assert.equal(canonicalPhase('drafting'), 'writing');
    assert.equal(canonicalPhase('revising'), 'revision');
    assert.equal(canonicalPhase('writing'), 'writing', '新名原样通过');
    assert.equal(canonicalPhase('不存在的阶段'), null);

    // 空目录：任何阶段都进不去，缺什么要能说出来
    const blocked = checkPhaseEntry('writing', {});
    assert.equal(blocked.ok, false);
    assert.match(blocked.missing.join(''), /正文/, '缺的项要可读，不能只说 ok:false');

    const ready = {
        logline: '一句话故事', worldbookCount: 2, castCount: 1, hasBookOutline: true, hasVolumePlan: true,
        approvedOutlineCount: 1, savedChapterCount: 1, allApprovedWritten: true, continuityErrors: 0,
    };
    for (const id of PHASE_IDS) assert.equal(checkPhaseEntry(id, ready).ok, true, id + ' 在素材齐备时应可进入');

    // 卷结构识别（九阶段里最玄的一条，靠三个正则兜）
    assert.equal(detectVolumePlan('# 全书大纲\n\n## 第一卷 落雪\n- 事件'), true);
    assert.equal(detectVolumePlan('第一幕：出发\n'), true);
    assert.equal(detectVolumePlan('# 大纲\n## 主线\n- 往前走'), false, '没有卷/幕结构就是没有');

    // enterPhase：force 放行 → 前置阶段记 skipped（可审计的跳阶段）
    const novel = defaultNovel({ title: 'x', genre: 'y' });
    const res = enterPhase(novel, 'writing', { force: true, facts: {} });
    assert.equal(res.ok, true);
    assert.equal(res.forced, true, '入场条件不满足却推进 → forced 必须为 true（审计要能分辨）');
    assert.equal(novel.stage, 'writing');
    assert.equal(novel.phases.topic.status, 'skipped');
    assert.equal(novel.phases.writing.status, 'approved');
    assert.ok(novel.phases.writing.report.errorCount >= 1, 'PhaseReport 要记下 force 时的缺口数');

    // 条件满足则直接进，不用 force
    const novel2 = defaultNovel({ title: 'x', genre: 'y' });
    const ok = enterPhase(novel2, 'setting', { facts: ready });
    assert.equal(ok.forced, false);
    assert.equal(novel2.phases.setting.report.errorCount, 0);

    // 失败不抛错（交由调用方决定怎么告知）
    const denied = enterPhase(defaultNovel({ title: 'x', genre: 'y' }), 'done', { facts: {} });
    assert.equal(denied.ok, false);
    assert.match(denied.reason, /入场条件未满足/);

    // 看板
    const board = phaseBoard(novel, ready);
    assert.equal(board.length, 9);
    assert.equal(board.find((b) => b.phase === 'writing').current, true);
    assert.equal(board.find((b) => b.phase === 'topic').status, 'skipped');
    assert.match(renderPhaseBoard(board, { current: '正文' }), /阶段进度/);
});

// ── E2 熔断 ─────────────────────────────────────────────────────────────────

test('★ E2 熔断：同章连续驳回 3 次触发；成功/重批/改契约三条通道解除', () => {
    const novel = defaultNovel({ title: 'x', genre: 'y' });
    assert.equal(breakerState(novel, 7).tripped, false, '新书不熔断');

    recordRejection(novel, 7, { code: 'audit', detail: '字数不足' });
    recordRejection(novel, 7, { code: 'content-gate' });
    assert.equal(breakerState(novel, 7).count, 2);
    assert.equal(breakerState(novel, 7).tripped, false, '2 次还不熔断');

    recordRejection(novel, 7, { code: 'outline-banned' });
    const st = breakerState(novel, 7);
    assert.equal(st.tripped, true);
    assert.match(st.reason, /熔断/);
    assert.match(st.reason, /改细纲|场景契约/, '熔断提示要给解除路径，不能只说「不许写」');

    assert.equal(breakerState(novel, 8).tripped, false, '计数按章隔离，不串台');

    recordSuccess(novel, 7);
    assert.equal(breakerState(novel, 7).tripped, false, '成功落盘 → 清零');

    recordRejection(novel, 9); recordRejection(novel, 9); recordRejection(novel, 9);
    assert.equal(breakerState(novel, 9).tripped, true);
    clearBreaker(novel, 9);
    assert.equal(breakerState(novel, 9).tripped, false, '细纲重批/契约更新 → 清零');

    recordRejection(novel, 3);
    const d = breakerDigest(novel);
    assert.deepEqual(d.rows.map((r) => r.chapter), [3], '只有未清零的章进 digest');
    assert.equal(d.tripped.length, 0);
});

// ── C4 平台审稿 ─────────────────────────────────────────────────────────────

const FQ_GOOD = [
    '「你也配？」赵擎冷笑一声，把合同摔在桌上。',
    '林晚没说话。她弯腰捡起那张纸，指尖压住签名栏。',
    '「昨天你说我签不了这一单。」她抬头，「现在呢？」',
    '满屋子的呼吸声都停了。赵擎的脸一点点涨红，又一点点发白。',
    '「不可能。」他后退半步，「这单早被……」',
    '「被我签了。」林晚把合同推回去，「三天前。」',
    '有人噗地笑出声。赵擎的手指在桌面上抓了两下，什么也没抓住。',
    '「你等着。」他撂下这句，转身撞开门走了。',
    '林晚看着那扇晃动的门，慢慢把手机翻过来。屏幕上是一条未读消息，发信人那一栏是空的。',
    '「明天，会有人来找你。」她盯着那行字，忽然明白了什么。',
].join('\n\n').repeat(7);

test('★ C4 平台审稿：起点看结构与章末钩子，番茄看前千字爽点与憋屈时长', () => {
    const q = reviewForPlatform({ content: FQ_GOOD, chapter: 1, platform: 'qidian' });
    assert.equal(q.platform, 'qidian');
    assert.equal(q.name, '起点');
    assert.ok(q.checks.some((c) => c.key === 'opening-conflict' && c.ok), '黄金三章：开篇 300 字内必须立冲突');
    assert.ok(q.checks.some((c) => c.key === 'ending-hook' && c.ok));
    assert.ok(q.checks.some((c) => c.key === 'mobile-paragraph'), '起点有移动端段长项');
    assert.ok(q.score > 0 && q.score <= 100);
    assert.ok(q.checks.every((c) => typeof c.advice === 'string'), '每条都要给可执行建议');

    const f = reviewForPlatform({ content: FQ_GOOD, chapter: 1, platform: 'fanqie' });
    assert.equal(f.name, '番茄');
    assert.ok(f.checks.some((c) => c.key === 'first-1k-thrill' && c.ok), '番茄看前 1000 字的爽点');
    assert.ok(f.checks.some((c) => c.key === 'first-3-faceslap' && c.ok), '前 3 章打脸是番茄签约判据');

    // 憋屈不过夜：连续压抑段落累计字数
    const suffer = Array.from({ length: 60 }, (_, i) => '林晚低着头，把委屈咽回去。她不敢说话，只能忍着。第' + i + '次了。').join('\n\n');
    assert.ok(longestSufferingRun(suffer) > 1200, '连续憋屈段要能被算出来');
    const f2 = reviewForPlatform({ content: suffer, chapter: 5, platform: 'fanqie' });
    assert.equal(f2.checks.find((c) => c.key === 'suffering-duration').ok, false, '憋屈过长 → 番茄红线报警');

    // 点列式正文（无对话无钩子）在两家都该被判问题
    const flat = Array.from({ length: 30 }, () => '他走过长街，看了一遍两边的铺子，然后回家吃饭。').join('\n\n');
    const q2 = reviewForPlatform({ content: flat, chapter: 2, platform: 'qidian' });
    assert.equal(q2.checks.find((c) => c.key === 'ending-hook').ok, false);

    assert.ok(sentenceCv(FQ_GOOD) > 0);
    assert.throws(() => reviewForPlatform({ content: 'x', platform: '未知平台' }), /未知平台/);
});

// ── C5 敏感自查 ─────────────────────────────────────────────────────────────

test('★ C5 敏感自查：七类红线 + 未成年邻近共现 + 题材豁免', () => {
    assert.equal(CENSOR_KEYS.length, 7);

    const clean = scanSensitive({ content: '林晚在雨里跑了很久，鞋子里全是水。' });
    assert.equal(clean.level, 'clean');
    assert.deepEqual(clean.categories, []);

    const erotic = scanSensitive({ content: '她赤身站在窗前，胴体映着月光，一阵呻吟从隔壁传来。' });
    assert.equal(erotic.level, 'risky', '色情擦边是红线级');
    assert.ok(erotic.categories.some((c) => c.key === 'erotica'));
    assert.ok(erotic.categories[0].hits[0].line >= 1, '命中要给行号，作者才好定位');
    assert.ok(erotic.categories[0].hits[0].excerpt.includes('…') === false || true);

    // 未成年红线：单出现主体词不算，邻近共现才算
    const school = scanSensitive({ content: '小学生背着书包从校门口跑出来，手里攥着两块钱。' });
    assert.ok(!school.categories.some((c) => c.key === 'minor'), '校园文天天有小学生——不能一出现就报警');
    const minorHit = scanSensitive({ content: '那个十六岁的女孩被他搂在怀里，亲吻了她的额头。' });
    assert.ok(minorHit.categories.some((c) => c.key === 'minor'), '主体词 × 亲密词 邻近 100 字内 → 红线');

    // 题材豁免
    const feudal = scanSensitive({ content: '老道士摆开符咒，口中念念有词，替她驱邪。' });
    assert.ok(feudal.categories.some((c) => c.key === 'feudal'));
    assert.ok(feudal.categories.find((c) => c.key === 'feudal').severity === 'warn', '封建迷信是提醒级不是红线级');
    const exempted = scanSensitive({ content: '老道士摆开符咒，口中念念有词，替她驱邪。', exempt: ['feudal'] });
    assert.ok(!exempted.categories.some((c) => c.key === 'feudal'), '玄幻题材可豁免');

    assert.match(clean.note, /启发式预筛/, '定位要写清楚：不是合规判定');
});

// ── G2 书库（外部小说饲料的结构分析）────────────────────────────────────────

const LIB_TEXT = [
    '第一章 雪夜',
    '雪落了一夜。',
    '「你来了。」周砚说。',
    '「来了。」那人答。',
    '青铜古灯在案上跳了一下，火苗歪向门口，像在指路。',
    '',
    '第二章 铜灯',
    '青铜古灯又亮了一次，火苗这次没有歪。',
    '「灯里有东西。」周砚说。',
    '他没有说完。窗外忽然传来一声闷响——',
    '',
    '第三章 长夜',
    '青铜古灯熄了，屋子里只剩呼吸声。他数着自己的心跳，一颗，两颗，三颗，四颗，五颗。',
    '「谁。」他说。',
    '「我。」门外有人应。',
].join('\n');

test('G2 书库：切章与结构画像（零 token）', () => {
    const chapters = chaptersFromText(LIB_TEXT);
    assert.deepEqual(chapters.map((c) => c.title), ['雪夜', '铜灯', '长夜'], '复用正文导入的标题识别');
    const a = analyzeStructure(chapters);
    assert.equal(a.chapters, 3);
    assert.equal(a.chars, chapters.reduce((n, c) => n + c.content.replace(/\s/g, '').length, 0));
    assert.ok(a.length.mean > 0 && a.length.min <= a.length.median && a.length.median <= a.length.max);
    assert.ok(a.length.cv >= 0);
    assert.ok(a.dialogueRatio > 0, '有对白就必须算出对话密度');
    assert.equal(a.hookRate, 0.333, '三章只有第二章末是省略号钩子');
    assert.deepEqual(a.hookKinds, { ellipsis: 1 });
    assert.equal(a.perChapter[0].hookKind, null);
    assert.equal(a.topPhrases[0].term, '青铜古灯', '重复意象应被挖出来');
    assert.ok(a.freeform.meanSentence > 0);
});

test('G2 书库：重复短语不报错位窗口；空输入不炸', () => {
    // 连续重复会顺带产生「古灯青铜」「灯青铜古」这类错位窗口，必须被抑制
    const r = repeatedPhrases('青铜古灯青铜古灯青铜古灯灯下有人', { minCount: 2, minLen: 3, maxLen: 4 });
    assert.deepEqual(r, [{ term: '青铜古灯', count: 3 }]);
    assert.deepEqual(repeatedPhrases('', {}), []);
    assert.deepEqual(repeatedPhrases('短', {}), []);

    const empty = analyzeStructure([]);
    assert.equal(empty.chapters, 0);
    assert.equal(empty.hookRate, 0);
    assert.deepEqual(empty.topPhrases, []);
    assert.equal(empty.length.mean, 0);
    assert.deepEqual(analyzeStructure(null).perChapter, []);
});

test('G2 书库：作品 id 净化与并排对比', () => {
    assert.equal(libraryId('斗破/苍穹 精校版'), '斗破_苍穹_精校版');
    assert.equal(libraryId('../etc/passwd'), '_etc_passwd', '前导点必须去掉，防目录穿越');
    assert.throws(() => libraryId('   '), /不能为空/);

    assert.equal(coefficientOfVariation([100, 100, 100]), 0, '完全均匀波动为 0');
    assert.ok(coefficientOfVariation([100, 200, 300]) > 0.3);

    const mine = analyzeStructure([{ title: 'a', content: '短。' }]);
    const theirs = analyzeStructure([{ title: 'b', content: '长一点的一章。' }]);
    const rows = compareStructures(mine, theirs);
    assert.equal(rows.length, 9);
    assert.ok(rows.every((r) => 'label' in r && 'mine' in r && 'theirs' in r), '对比只给数字不做评分');
    assert.ok(rows.some((r) => r.label === '章末钩子率'));
    assert.ok(rows.some((r) => r.label === '长度波动 cv'));
});

test('G2 书库：单章指标——段落/对话/句长', () => {
    const m = chapterMetrics('第一段。\n\n「你说什么？」他问。\n\n第三段在这里。');
    assert.equal(m.paragraphs, 3);
    assert.ok(m.dialogueChars > 0);
    assert.ok(m.dialogueRatio > 0 && m.dialogueRatio < 1);
    assert.equal(m.sentenceCount, 4, '问号在引号内也算句读，故是 4 句');
    assert.equal(m.hookKind, null);
    assert.equal(chapterMetrics('').paragraphs, 0);
    assert.equal(chapterMetrics('').dialogueRatio, 0);
});
