// test/char-limits-scope.test.mjs — 「本书每章字数区间」的回归护栏。
//
// 两件病，同一个根：字数口径没有单一真相。
// ① 平台档写进 novel.json 后，只有工具面两处消费它——批量起草、面板存章、提案、润色、
//    简报、细纲容量全都还按插件默认算，于是「写的时候按起点放行、审的时候按番茄判死」
//    换了个地方重演（本轮报告 P1）。
// ② 用户要的其实是**每本书自己定字数**（面板设 or 开书时收集）：没设才有默认档。
//    所以生效优先级是「本书自定义 > 投放平台 > 插件配置」，且只允许 lib/store.js 一处实现。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import {
    parseCharsSpec, charLimitsOf, charLimitsView, effectiveCharConfig,
    PLATFORM_PROFILES,
} from '../lib/store.js';
import { reviewForPlatform } from '../lib/platform-review.js';
import { bootPlugin, chapterOf, testConfig } from './helpers/plugin.mjs';

const CFG = testConfig();

let h;
before(async () => { h = await bootPlugin(); });
after(() => h.cleanup());

// ── 纯函数：解析与优先级 ──────────────────────────────────────────────
test('区间文本解析：认常见分隔符，半套/越界/倒挂都报错，空串＝清除', () => {
    assert.deepEqual(parseCharsSpec('2500-3500').limits, { min: 2500, max: 3500 });
    assert.deepEqual(parseCharsSpec(' 2500 ~ 3500 ').limits, { min: 2500, max: 3500 });
    assert.deepEqual(parseCharsSpec('2500–3500').limits, { min: 2500, max: 3500 });
    assert.deepEqual(parseCharsSpec('2500，3500').limits, { min: 2500, max: 3500 });
    assert.equal(parseCharsSpec('').limits, null, '空串＝清除自定义');
    assert.equal(parseCharsSpec(undefined).limits, undefined, '没给＝不动');
    for (const bad of ['2500', '2500-', 'abc-def', '2500-3500-4000', '3500-2500', '50-3500', '2500-99999', '2500.5-3500']) {
        const r = parseCharsSpec(bad);
        assert.equal(r.ok, false, `「${bad}」必须被拒`);
        assert.match(r.error, /\S/, '拒的原因要说人话');
    }
});

test('区间文本解析：空白也是合法分隔符（工具描述承诺过「空格分隔」，实现必须对上）', () => {
    // 工具面 chars 参数的描述与 CHANGELOG 都写了「也接受 ~ / – / 、/ 空格 分隔」，
    // 实现曾经只认标点——用户照文档写「2500 3500」会被拒，文档承诺与实现分家。
    // 分隔符收口在 store.parseCharsSpec 一份（工具面与 REST 面共用，防两处语法漂移）。
    assert.deepEqual(parseCharsSpec('2500 3500').limits, { min: 2500, max: 3500 });
    assert.deepEqual(parseCharsSpec('2500   3500').limits, { min: 2500, max: 3500 }, '连续空白算一个分隔');
    assert.deepEqual(parseCharsSpec('2500\t3500').limits, { min: 2500, max: 3500 });
    assert.equal(parseCharsSpec('2500 3500 4000').ok, false, '三个数仍是多套区间 → 拒');
    assert.equal(parseCharsSpec('2500 ').ok, false, '一个数＋空格仍拒（半套区间比没有区间更危险）');
});

test('读入口不 throw：手工改坏的 charLimits 一律按「没有自定义」回落', () => {
    for (const broken of [undefined, null, '2500-3500', {}, { min: 2500 }, { max: 3500 }, { min: 0, max: 3500 }, { min: 3500, max: 2500 }]) {
        assert.equal(charLimitsOf({ charLimits: broken }), null, `坏形状 ${JSON.stringify(broken)} 应按未设置处理`);
    }
    assert.deepEqual(charLimitsOf({ charLimits: { min: 2500, max: 3000 } }), { min: 2500, max: 3000 });
});

test('★ 优先级：自定义 > 平台 > 插件默认；三档都没动时原样返回同一个引用', () => {
    const none = effectiveCharConfig(CFG, {});
    assert.equal(none.config, CFG, '★ 未设任何档位必须返回**同一个对象引用**（默认行为不变是结构性保证）');
    assert.equal(none.source, 'config');

    const plat = effectiveCharConfig(CFG, { platform: 'fanqie' });
    assert.deepEqual([plat.config.minChapterChars, plat.config.maxChapterChars, plat.source], [1500, 3000, 'platform']);
    assert.equal(CFG.minChapterChars, 2000, '原始配置不许被就地改写');

    const both = effectiveCharConfig(CFG, { platform: 'fanqie', charLimits: { min: 2600, max: 3400 } });
    assert.deepEqual([both.config.minChapterChars, both.config.maxChapterChars, both.source], [2600, 3400, 'custom'],
        '★ 用户给这本书定的区间压过平台口径');

    // 坏自定义不许把平台档也一起吞掉
    const broken = effectiveCharConfig(CFG, { platform: 'fanqie', charLimits: { min: 9 } });
    assert.equal(broken.source, 'platform', '自定义非法 → 落平台档，而不是直接落插件默认');
});

test('输出视图：没设自定义就不带 charLimits 键（宿主严格校验会拒 null）', () => {
    assert.deepEqual(charLimitsView(CFG, {}), { charMin: 2000, charMax: 4000, charSource: 'config' });
    assert.deepEqual(charLimitsView(CFG, { charLimits: { min: 2500, max: 3500 } }),
        { charLimits: '2500-3500', charMin: 2500, charMax: 3500, charSource: 'custom' });
});

test('★ 平台数字只有一份：平台审稿的字数条目必须跟着 store 的档案表走', () => {
    // 番茄审稿的 chapter-length 判定值/文案都取自 PLATFORM_PROFILES——把表改了，
    // 审稿文案必须同步变（此前两边各抄一份字面量，就是「写审相反」的温床）。
    const f = reviewForPlatform({ content: chapterOf(PLATFORM_PROFILES.fanqie.maxChapterChars + 98), chapter: 4, platform: 'fanqie' });
    const c = f.checks.find((x) => x.key === 'chapter-length');
    assert.equal(c.ok, false);
    assert.equal(c.target, `${PLATFORM_PROFILES.fanqie.minChapterChars}–${PLATFORM_PROFILES.fanqie.maxChapterChars}`);
    assert.match(c.label, new RegExp(String(PLATFORM_PROFILES.fanqie.maxChapterChars)));
    const q = reviewForPlatform({ content: chapterOf(2400), chapter: 9, platform: 'qidian' }).checks.find((x) => x.key === 'chapter-length');
    assert.equal(q.target, `${PLATFORM_PROFILES.qidian.minChapterChars}–${PLATFORM_PROFILES.qidian.maxChapterChars}`);
});

test('★ 写审一致的另一半：平台审稿的字数条目必须按**本书自定义档**判', () => {
    // 修前：审稿只读静态平台档案。书设 3000–6000、投放平台是番茄（1500–3000）时，
    // 5000 字的正文在**写章门禁**按自定义档放行、在**平台审稿**按番茄档判 error
    // ——而漏的恰恰是优先级最高的那一档（自定义 > 平台 > 配置）。
    const custom = { minChapterChars: 3000, maxChapterChars: 6000 };
    const r = reviewForPlatform({
        content: chapterOf(5000), chapter: 30, platform: 'fanqie',
        charConfig: custom, charSource: 'custom',
    });
    const c = r.checks.find((x) => x.key === 'chapter-length');
    assert.equal(c.ok, true, `★ 本书自定义 3000–6000 时 5000 字必须判通过（实际 ${c.value} / target ${c.target}）`);
    assert.equal(c.target, '3000–6000');
    assert.match(c.label, /本书自定义/, '★ 文案要写明数字是本书口径，否则用户以为「设了没生效」');
    // 对照：不传自定义档时仍按平台档案表判（旧行为一字不变）
    const plain = reviewForPlatform({ content: chapterOf(5000), chapter: 30, platform: 'fanqie' });
    assert.equal(plain.checks.find((x) => x.key === 'chapter-length').ok, false, '没设自定义时番茄 1500–3000 照旧判超长');
});

test('★ 黄金三章只抬下限不压下限：自定义下限高于 2500 时不许被 2500 顶回去', () => {
    const custom = { minChapterChars: 3000, maxChapterChars: 6000 };
    const r = reviewForPlatform({
        content: chapterOf(2800), chapter: 1, platform: 'qidian',
        charConfig: custom, charSource: 'custom',
    });
    const c = r.checks.find((x) => x.key === 'chapter-length');
    assert.equal(c.target, '3000–6000', '★ 黄金三章的下限是 max(2500, 自定义下限)，不是写死的 2500');
    assert.equal(c.ok, false, '2800 字低于本书自定义的 3000 下限，该判不过');
    assert.equal(c.level, 'error');
});

// ── 工具面：开书收集 + 读写清 ─────────────────────────────────────────
test('★ init 时就收集每章字数：落库、回显、status 也带口径', async () => {
    const r = await h.tool('novel_project').execute({ action: 'init', book: '区间书', chars: '2500-3500' }, h.exec);
    assert.equal(r.charLimits, '2500-3500');
    assert.deepEqual([r.charMin, r.charMax, r.charSource], [2500, 3500, 'custom']);
    const meta = h.readJson('区间书/novel.json');
    assert.deepEqual(meta.charLimits, { min: 2500, max: 3500 }, '★ 是落库事实，不是每次调用手传的参数');

    const st = await h.tool('novel_project').execute({ action: 'status', book: '区间书' }, h.exec);
    assert.deepEqual([st.charMin, st.charMax, st.charSource], [2500, 3500, 'custom'], '概况要回显生效口径——藏在设置里等于没设');
});

test('init 的字数写坏了就响亮报错，且不留下半套的书', async () => {
    await assert.rejects(
        () => h.tool('novel_project').execute({ action: 'init', book: '坏区间', chars: '3500-2500' }, h.exec),
        /不合法|下限不能大于上限/,
    );
    assert.equal(h.exists('坏区间/novel.json'), false, '报错路径不该留下工程目录');
});

test('action=chars：不传只读、成对写、空串清除、非法值不落库', async () => {
    await h.tool('novel_project').execute({ action: 'init', book: '后设书' }, h.exec);
    const read0 = await h.tool('novel_project').execute({ action: 'chars', book: '后设书' }, h.exec);
    assert.equal('charLimits' in read0, false, '没设过就不带这个键');
    assert.equal(read0.charSource, 'config');

    const wrote = await h.tool('novel_project').execute({ action: 'chars', book: '后设书', chars: '1800-2600' }, h.exec);
    assert.deepEqual([wrote.charMin, wrote.charMax, wrote.charSource], [1800, 2600, 'custom']);
    assert.match(wrote.next, /本书自定义/);

    await assert.rejects(
        () => h.tool('novel_project').execute({ action: 'chars', book: '后设书', chars: '1800' }, h.exec),
        /不合法/,
    );
    const kept = h.readJson('后设书/novel.json');
    assert.deepEqual(kept.charLimits, { min: 1800, max: 2600 }, '★ 报错不得把已设好的值改坏');

    const cleared = await h.tool('novel_project').execute({ action: 'chars', book: '后设书', chars: '' }, h.exec);
    assert.equal('charLimits' in cleared, false);
    assert.equal(cleared.charSource, 'config');
    assert.equal('charLimits' in h.readJson('后设书/novel.json'), false, '清除是真删字段，不是留个空壳');
});

test('平台与自定义共存时回执说清是谁在生效（不让人猜）', async () => {
    await h.tool('novel_project').execute({ action: 'init', book: '双档书', platform: 'fanqie', chars: '2500-3500' }, h.exec);
    const p = await h.tool('novel_project').execute({ action: 'platform', book: '双档书' }, h.exec);
    assert.equal(p.platform, 'fanqie');
    assert.deepEqual([p.charMin, p.charMax, p.charSource], [2500, 3500, 'custom'], '设了平台也不许盖住用户的区间');
    assert.match(p.next, /自定义/, '平台回执要提示「区间为准」这件事');
});

// ── 消费面闭环：这才是本轮 P1 的真凭据 ────────────────────────────────
async function writable(book, extra = {}) {
    await h.tool('novel_project').execute({ action: 'init', book, ...extra }, h.exec);
}

test('★ 写章门禁按本书区间：番茄上限外的稿子必须被拒，同一稿在自定义区间内必须能落', async () => {
    const over = chapterOf(3098);   // 番茄(1500–3000) 之外、插件默认(2000–4000) 之内
    assert.ok(over.replace(/\s/g, '').length >= 3001, '造字口径必须真的超 3000');

    await writable('番茄本', { platform: 'fanqie' });
    await assert.rejects(
        () => h.tool('novel_write_chapter').execute({
            book: '番茄本', chapter: 1, title: '超长', content: over, summary: 'x', force: true,
        }, h.exec),
        /超过上限 3000/, '★ 门禁必须按本书平台上限判（此前恒按 4000 放行）',
    );

    await writable('自定义本', { platform: 'fanqie', chars: '2500-3500' });
    const ok = await h.tool('novel_write_chapter').execute({
        book: '自定义本', chapter: 1, title: '刚好', content: over, summary: 'x', force: true,
    }, h.exec);
    assert.ok(ok.chars >= 3001 && ok.chars <= 3500, `自定义区间内应落盘（实际 ${ok.chars} 字）`);
});

test('★ 简报的「本章字数目标」段与门禁同口径（描述说「以简报为准」，简报就不许报默认数）', async () => {
    await writable('简报本', { chars: '2400-3200' });
    const brief = await h.tool('novel_briefing').execute({ book: '简报本', chapter: 2 }, h.exec);
    const sec = brief.sections.find((s) => s.name.includes('本章字数目标'));
    assert.ok(sec, '简报必须带字数目标段');
    assert.match(sec.content, /2400–3200/, '★ 简报要报本书区间，不是插件默认 2000–4000');
    assert.doesNotMatch(sec.content, /单章 2000–4000/);
});

test('★ 提案与润色的上下限也按本书区间（改一版不许把书改到区间外）', async () => {
    await writable('提案本', { platform: 'fanqie' });
    const inside = chapterOf(2600);
    await h.tool('novel_write_chapter').execute({
        book: '提案本', chapter: 1, title: '初稿', content: inside, summary: 'x', force: true,
    }, h.exec);
    // 番茄上限 3000：3200 字的修订稿在默认口径(4000)下会被收下——那正是「应用后审计判死」的源头
    await assert.rejects(
        () => h.tool('novel_propose').execute({
            action: 'propose', book: '提案本', chapter: 1, content: chapterOf(3200), reason: '扩写',
        }, h.exec),
        /超出上下限（1500-3000）/,
    );
    await assert.rejects(
        () => h.tool('novel_polish').execute({
            action: 'submit', book: '提案本', chapter: 1, content: chapterOf(3200),
        }, h.exec),
        /超过上限 3000/,
    );
});

test('★ 审计按本书区间给结论（自定义压过平台档），并按落库平台默认审稿', async () => {
    const over = chapterOf(3098);
    await writable('审计本', { platform: 'fanqie', chars: '2500-3500' });
    await h.tool('novel_write_chapter').execute({
        book: '审计本', chapter: 1, title: '刚好', content: over, summary: 'x', force: true,
    }, h.exec);
    const r = await h.tool('novel_audit').execute({ book: '审计本', chapter: 1 }, h.exec);
    const problems = JSON.stringify(r.problems ?? r.verdict ?? '');
    assert.doesNotMatch(problems, /超过上限/,
        `★ 番茄上限是 3000，但本书自定义到 3500——审计不许拿平台档打写章放行过的稿子（实际 ${problems.slice(0, 160)}）`);
    assert.equal(r.platformReview?.platform, 'fanqie', '落库平台＝默认审稿平台，不再要求调用方每次手传');
    // A-1 的工具面落点：审稿里的字数条目也要按本书自定义档判（此前只读静态平台档案 →
    // 写章按 2500–3500 放行、审稿按番茄 1500–3000 判 3098 字超长，同一章两个结论）。
    const lenCheck = r.platformReview?.checks?.find((c) => c.key === 'chapter-length');
    assert.equal(lenCheck?.ok, true,
        `★ 审稿的字数条目必须跟着本书自定义 2500–3500 走（实际 target=${lenCheck?.target} value=${lenCheck?.value}）`);
    assert.equal(lenCheck?.target, '2500–3500');
});

test('★ 宿主 render 不许抛：chars / platform 回执走真渲染路径（面板事故回归）', async () => {
    // 真机事故：render 的分支链没有 chars/platform 两个 action，回执漏进 status 兜底行
    // 读 v.chapters.length → 「output.render failed: Cannot read properties of undefined
    // (reading 'length')」——execute 明明成功，宿主却把**整次输出判无效**，模型拿不到数据。
    // 这里用宿主同款路径（output.render(_args, value)）逐个回执真渲染。
    const t = h.tool('novel_project');
    // textBlock 返回内容块数组（[{type:'text',text}]）——拼回纯文本再断言
    const render = (args, v) => t.output.render(args, v).map((b) => b.text).join('\n');

    await h.tool('novel_project').execute({ action: 'init', book: '渲染书' }, h.exec);
    const read = await h.tool('novel_project').execute({ action: 'chars', book: '渲染书' }, h.exec);
    const readText = render({ action: 'chars', book: '渲染书' }, read);
    assert.match(readText, /每章字数口径：\d+–\d+ 字/);
    assert.doesNotMatch(readText, /undefined/);

    const wrote = await h.tool('novel_project').execute({ action: 'chars', book: '渲染书', chars: '1800-2600' }, h.exec);
    const wroteText = render({ action: 'chars', book: '渲染书' }, wrote);
    assert.match(wroteText, /自定义 1800-2600/);

    const plat = await h.tool('novel_project').execute({ action: 'platform', book: '渲染书' }, h.exec);
    const platText = render({ action: 'platform', book: '渲染书' }, plat);
    assert.match(platText, /本书平台：未设置/);

    const platSet = await h.tool('novel_project').execute({ action: 'platform', book: '渲染书', platform: 'qidian' }, h.exec);
    const platSetText = render({ action: 'platform', book: '渲染书' }, platSet);
    assert.match(platSetText, /本书平台：qidian/);
    assert.match(platSetText, /2000–4000/);

    // status 兜底行本身也要渲染得动（防御 ?.length —— 将来再漏 action 也不许毒死回执）
    const st = await h.tool('novel_project').execute({ action: 'status', book: '渲染书' }, h.exec);
    assert.match(render({ action: 'status', book: '渲染书' }, st), /章节 \d+/);
});
