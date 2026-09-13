// test/logic.test.mjs — 纯逻辑单测（无宿主依赖，node --test 直跑）。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sanitizeTitle, chapterFileName, parseChapterFileName, nextVersion, nextSuffixedId } from '../lib/versioning.js';
import { gateChapterWrite, advanceStage } from '../lib/gate.js';
import { applyFactUpdates, queryFacts, factsDigest, assertLedgerChapter, foreshadowSetup, foreshadowPayoff, openForeshadows, foreshadowDigest, overdueForeshadows } from '../lib/ledger.js';
import { computeAudit, auditVerdict } from '../lib/audit.js';
import { matchWorldEntries, buildContextPack, renderPack } from '../lib/contextpack.js';
import { pathsFor, defaultNovel, chapterRecord, normalizeWorldEntry, bookInSession, isUnclaimed, addBookSession } from '../lib/store.js';
import { scanAiFlavor } from '../lib/noai.js';
import { roughOutline, splitIntoChapters, isChapterHeading } from '../lib/import.js';
import { diagnoseIntro, computeChapterDiagnosis } from '../lib/diagnose.js';
import { parseFactLines, foreshadowView } from '../lib/tools/common.js';
import { parseWorldbookImport } from '../lib/worldbook-io.js';
import { splitSentences, measureStyleMetrics, measureMood, computeBaseline, judgeAgainstBaseline } from '../lib/style.js';

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

test('gate: advanceStage 只前进不后退', () => {
    const novel = defaultNovel({ title: 'x', genre: 'y' });
    advanceStage(novel, 'drafting');
    assert.equal(novel.stage, 'drafting');
    advanceStage(novel, 'planning');
    assert.equal(novel.stage, 'drafting');
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
