// test/cognition.test.mjs — 认知账本（谁知道什么 / 不知道什么 / 读者已知什么）。
//
// 来源：竞品 QMAI character-cognition + readerKnows 信息差维。事实账本记「世界是
// 什么样」，管不了「人物以为世界是什么样」——身份保密、伏笔未揭这类桥段的崩法是
// 「不该知道的人知道了」。此前 DSH 没有任何一层守这个边界。
//
// 口径（代码强制 > 提示词自觉）：
//   · 输入走严格词表「知道 / 不知道」，不做同义词解析（自然语言猜错会静默记反）；
//   · 「读者|不知道」拒收：悬念是默认态，记账只记事件；
//   · 负向条款整条呈现、按条数封顶、绝不按字符截断（截断否定句会反转语义）；
//   · 倒退不拦但显形（失忆/装傻合法，不许静默）；
//   · 不声明不校验——批量起草/面板保存零影响（向后兼容）。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    parseCognitionLines, applyCognitionUpdates, cognitionView,
    cognitionSection, cognitionWarnings, cognitionFlatRows, COGNITION_VIEW_CAP,
} from '../lib/cognition.js';
import { bootPlugin, chapterOf } from './helpers/plugin.mjs';

const NOW = '2026-10-28T12:00:00.000Z';

// ── 纯函数：解析 ─────────────────────────────────────────────────────────────

test('parseCognitionLines：三种合法行 / 空入参 / 非字符串', () => {
    assert.deepEqual(parseCognitionLines(undefined), []);
    assert.deepEqual(parseCognitionLines(''), []);
    const rows = parseCognitionLines('张三|知道|师尊是凶手\n李四|不知道|宝藏位置\n读者|知道|张三身世');
    assert.deepEqual(rows, [
        { subject: '张三', verb: 'knows', info: '师尊是凶手' },
        { subject: '李四', verb: 'doesNotKnow', info: '宝藏位置' },
        { subject: '读者', verb: 'knows', info: '张三身世' },
    ]);
    assert.throws(() => parseCognitionLines(42), /多行文本/);
    assert.throws(() => parseCognitionLines('张三|知道'), /行格式错误/);
    assert.throws(() => parseCognitionLines('张三|知道|'), /行格式错误/);
});

test('parseCognitionLines：同义词不解析（严格词表，猜错就记反）', () => {
    assert.throws(() => parseCognitionLines('张三|得知|师尊是凶手'), /动词不认识.*知道/);
    assert.throws(() => parseCognitionLines('张三|察觉|有人跟梢'), /动词不认识/);
});

test('parseCognitionLines：「读者|不知道」拒收（悬念是默认态）', () => {
    assert.throws(() => parseCognitionLines('读者|不知道|真相'), /读者\|不知道.*不收/);
});

// ── 纯函数：追加与视图 ───────────────────────────────────────────────────────

test('applyCognitionUpdates：追加行带 chapter/ts；后声明胜（knows 顶掉 doesNotKnow）', () => {
    const first = applyCognitionUpdates([], [
        { subject: '张三', verb: 'doesNotKnow', info: '身世' },
    ], { chapter: 1, now: NOW });
    assert.equal(first.added.length, 1);
    assert.equal(first.rows[0].chapter, 1);
    assert.equal(first.rows[0].ts, NOW);
    assert.deepEqual(first.regressions, []);

    const second = applyCognitionUpdates(first.rows, [
        { subject: '张三', verb: 'knows', info: '身世' },
    ], { chapter: 3, now: NOW });
    const view = cognitionView(second.rows);
    const zs = view.characters.find((c) => c.name === '张三');
    assert.deepEqual(zs.knows, ['身世'], '第3章得知身世 → 进入 knows');
    assert.deepEqual(zs.doesNotKnow, [], '旧状态从「不知道」槽位移除');
});

test('applyCognitionUpdates：认知倒退不拦但显形（regressions）', () => {
    const base = applyCognitionUpdates([], [{ subject: '张三', verb: 'knows', info: '密道' }], { chapter: 1, now: NOW });
    const back = applyCognitionUpdates(base.rows, [{ subject: '张三', verb: 'doesNotKnow', info: '密道' }], { chapter: 2, now: NOW });
    assert.equal(back.added.length, 1, '倒退照常落账（失忆/装傻是合法桥段）');
    assert.equal(back.regressions.length, 1);
    assert.match(back.regressions[0], /张三.*已经知道.*密道/);
    assert.equal(applyCognitionUpdates(base.rows, [{ subject: '张三', verb: 'doesNotKnow', info: '新秘密' }], { chapter: 2, now: NOW }).regressions.length, 0);
});

test('applyCognitionUpdates：同一批里先知后忘不算倒退（基线取更新前）', () => {
    const r = applyCognitionUpdates([], [
        { subject: '张三', verb: 'knows', info: 'X' },
        { subject: '张三', verb: 'doesNotKnow', info: 'X' },
    ], { chapter: 5, now: NOW });
    assert.deepEqual(r.regressions, []);
    const view = cognitionView(r.rows);
    assert.deepEqual(view.characters[0].doesNotKnow, ['X'], '后声明胜');
});

test('applyCognitionUpdates：空 subject/info 与非法 verb 拒收', () => {
    assert.throws(() => applyCognitionUpdates([], [{ subject: ' ', verb: 'knows', info: 'X' }], { chapter: 1, now: NOW }), /不能为空/);
    assert.throws(() => applyCognitionUpdates([], [{ subject: '张三', verb: 'maybe', info: 'X' }], { chapter: 1, now: NOW }), /动词非法/);
    assert.throws(() => applyCognitionUpdates([], [{ subject: '张三', verb: 'knows', info: 'X' }], { chapter: 0, now: NOW }), /正整数/);
});

test('cognitionView：atChapter 时点推演 / subjects 过滤 / 读者不受 subjects 过滤', () => {
    const rows = [
        { subject: '张三', verb: 'doesNotKnow', info: '身世', chapter: 1 },
        { subject: '张三', verb: 'knows', info: '身世', chapter: 3 },
        { subject: '李四', verb: 'knows', info: '埋宝点', chapter: 2 },
        { subject: '读者', verb: 'knows', info: '身世', chapter: 3 },
    ];
    const at2 = cognitionView(rows, { atChapter: 2 });
    assert.deepEqual(at2.characters.find((c) => c.name === '张三').doesNotKnow, ['身世'], '第2章时点：张三还不知道');
    assert.equal(at2.characters.find((c) => c.name === '张三').knows.length, 0);
    assert.deepEqual(at2.readerKnows, [], '第2章时点：读者还不知道');

    const full = cognitionView(rows);
    assert.deepEqual(full.characters.find((c) => c.name === '张三').knows, ['身世']);
    assert.deepEqual(full.readerKnows, ['身世'], '读者已知不随章号过滤丢失');

    const onlyZs = cognitionView(rows, { subjects: ['张三'] });
    assert.equal(onlyZs.characters.length, 1);
    assert.deepEqual(onlyZs.readerKnows, ['身世'], 'subjects 过滤不影响读者维');
});

test('cognitionView：条目按 COGNITION_VIEW_CAP 封顶（截断按条数、不按字符）', () => {
    assert.equal(COGNITION_VIEW_CAP, 8);
    const rows = Array.from({ length: 12 }, (_, i) => ({ subject: '张三', verb: 'knows', info: `事${i}`, chapter: 1 }));
    const view = cognitionView(rows);
    assert.equal(view.characters[0].knows.length, COGNITION_VIEW_CAP);
});

// ── 纯函数：简报段与警戒 ─────────────────────────────────────────────────────

test('cognitionSection：空视图 null（不占预算）；负向条款排前；带边界纪律', () => {
    assert.equal(cognitionSection({ characters: [], readerKnows: [] }), null);
    const body = cognitionSection({
        characters: [
            { name: '张三', knows: ['身世'], doesNotKnow: ['宝藏位置'] },
        ],
        readerKnows: ['宝藏位置'],
    });
    const lines = body.split('\n');
    assert.match(lines[0], /^张三 不知道：宝藏位置$/, '负向条款必须排第一行');
    assert.match(lines[1], /^张三 知道：身世$/);
    assert.match(lines[2], /^读者已知：宝藏位置$/);
    assert.match(lines[3], /边界纪律/);
    assert.match(lines[3], /信息差/);
});

test('cognitionWarnings：只点本章出场人物的「不知道」清单', () => {
    const view = { characters: [
        { name: '张三', knows: [], doesNotKnow: ['宝藏位置', '身世'] },
        { name: '路人甲', knows: [], doesNotKnow: ['一切'] },
        { name: '王五', knows: ['天气'], doesNotKnow: [] },
    ], readerKnows: [] };
    const w = cognitionWarnings(view, ['张三']);
    assert.equal(w.length, 1);
    assert.match(w[0], /信息差警戒/);
    assert.match(w[0], /张三 不知道〔宝藏位置、身世〕/);
    assert.doesNotMatch(w[0], /路人甲/, '不出场的人物不点名');
    assert.deepEqual(cognitionWarnings(view, ['王五']), [], '出场的没有「不知道」项则不警戒');
    assert.deepEqual(cognitionWarnings(view, []), []);
});

test('cognitionFlatRows：与视图同源（后声明胜），行带 chapter 供对账', () => {
    const rows = [
        { subject: '张三', verb: 'doesNotKnow', info: '身世', chapter: 1 },
        { subject: '张三', verb: 'knows', info: '身世', chapter: 3 },
        { subject: '读者', verb: 'knows', info: '身世', chapter: 3 },
    ];
    const flat = cognitionFlatRows(rows);
    const zs = flat.find((r) => r.subject === '张三');
    assert.equal(zs.verb, 'knows');
    assert.equal(zs.chapter, 3, '最终声明的章号要带出来');
    const reader = flat.find((r) => r.subject === '读者');
    assert.equal(reader.info, '身世');
});

// ── 端到端（走真工具面）──────────────────────────────────────────────────────

async function bootBook(book) {
    const p = await bootPlugin({ config: { minChapterChars: 300, maxChapterChars: 5000 } });
    const { tool, exec } = p;
    await tool('novel_project').execute({ action: 'init', book, title: book }, exec);
    await tool('novel_outline').execute({
        action: 'save_chapter', book, chapter: 1,
        outline: '## 本章必写场景\n- 夜谈：张三与李四灯下对坐，说起师门旧事（对话 2 拍）\n- 望远：二人登崖望云海，各怀心事（动作 1 拍）',
    }, exec);
    await tool('novel_outline').execute({ action: 'approve', book, chapter: 1 }, exec);
    return p;
}

test('端到端：cognition_updates 随章落账（cognition.json + 回执 addedCognition）', async () => {
    const p = await bootBook('认知落账书');
    const { tool, exec, cleanup, readJson } = p;
    try {
        const v = await tool('novel_write_chapter').execute({
            book: '认知落账书', chapter: 1, title: '夜谈',
            content: chapterOf(400),
            summary: '张三李四夜谈师门旧事',
            cast: '张三、李四',
            cognition_updates: '张三|不知道|师尊是凶手\n读者|知道|师尊是凶手',
        }, exec);
        assert.equal(v.addedCognition.length, 2);
        assert.deepEqual(v.addedCognition[0], { subject: '张三', verb: 'doesNotKnow', info: '师尊是凶手', chapter: 1 });
        assert.deepEqual(v.cognitionRegressions, []);
        const rows = readJson('认知落账书/账本/cognition.json');
        assert.equal(rows.length, 2);
        assert.equal(rows[0].subject, '张三');
        assert.equal(typeof rows[0].ts, 'string', '行带时间戳（可对账）');
    } finally {
        cleanup();
    }
});

test('端到端：认知动词写错（得知）→ 整章不入库，错误指到行号与正确词表', async () => {
    const p = await bootBook('认知错词书');
    const { tool, exec, cleanup, readJson } = p;
    try {
        await assert.rejects(
            async () => tool('novel_write_chapter').execute({
                book: '认知错词书', chapter: 1, title: '夜谈',
                content: chapterOf(400),
                summary: 'x',
                cognition_updates: '张三|得知|师尊是凶手',
            }, exec),
            (err) => {
                assert.match(String(err?.message ?? err), /动词不认识/);
                assert.match(String(err?.message ?? err), /第 1 行/);
                return true;
            },
        );
        const novel = readJson('认知错词书/novel.json');
        assert.equal(novel.chapters?.['1'], undefined, '被拒的章不得入库');
    } finally {
        cleanup();
    }
});

test('端到端：不声明 cognition_updates → 行为不变（addedCognition 空占位、账本文件不落）', async () => {
    const p = await bootBook('无认知书');
    const { tool, exec, cleanup, readJson } = p;
    try {
        const v = await tool('novel_write_chapter').execute({
            book: '无认知书', chapter: 1, title: '夜谈',
            content: chapterOf(400),
            summary: 'x',
        }, exec);
        assert.deepEqual(v.addedCognition, []);
        assert.throws(() => readJson('无认知书/账本/cognition.json'), /ENOENT/, '没有声明就不造文件');
    } finally {
        cleanup();
    }
});

test('端到端：写前简报注入「人物认知边界」段 + 信息差警戒（按出场人物过滤）', async () => {
    const p = await bootBook('认知简报书');
    const { tool, exec, cleanup } = p;
    try {
        await tool('novel_write_chapter').execute({
            book: '认知简报书', chapter: 1, title: '夜谈',
            content: chapterOf(400),
            summary: 'x',
            cognition_updates: '张三|不知道|师尊是凶手\n张三|知道|云海奇观\n读者|知道|师尊是凶手',
        }, exec);
        await tool('novel_outline').execute({
            action: 'save_chapter', book: '认知简报书', chapter: 2,
            outline: '## 本章必写场景\n- 赶路：张三独自下山，途经市集（动作 1 拍）',
        }, exec);
        const brief = await tool('novel_briefing').execute({ book: '认知简报书', chapter: 2, cast: '张三、王五' }, exec);
        const cog = brief.sections.find((s) => s.name === '人物认知边界（信息差）');
        assert.ok(cog, '简报必须带认知边界段');
        assert.match(cog.content, /张三 不知道：师尊是凶手/);
        assert.match(cog.content, /张三 知道：云海奇观/);
        assert.match(cog.content, /读者已知：师尊是凶手/);
        const warn = brief.warnings.find((w) => w.includes('信息差警戒'));
        assert.ok(warn, '出场人物带着「不知道」清单要警戒');
        assert.match(warn, /张三 不知道〔师尊是凶手〕/);
        assert.doesNotMatch(warn, /王五/, '没有「不知道」清单的出场人物不点名');
    } finally {
        cleanup();
    }
});

test('端到端：认知行涉隐藏人物 → 洗白并告警（派生泄漏兜底覆盖到认知账本）', async () => {
    const p = await bootBook('认知洗白书');
    const { tool, exec, cleanup } = p;
    try {
        await tool('novel_write_chapter').execute({
            book: '认知洗白书', chapter: 1, title: '夜谈',
            content: chapterOf(400),
            summary: 'x',
            cognition_updates: '张三|知道|云海奇观\n读者|知道|蒙面人是师尊',
        }, exec);
        await tool('novel_scene').execute({
            action: 'save', book: '认知洗白书', chapter: 2,
            participants: '张三', hidden: '蒙面人',
        }, exec);
        await tool('novel_outline').execute({
            action: 'save_chapter', book: '认知洗白书', chapter: 2,
            outline: '## 本章必写场景\n- 赶路：张三独自下山（动作 1 拍）',
        }, exec);
        const brief = await tool('novel_briefing').execute({ book: '认知洗白书', chapter: 2, cast: '张三' }, exec);
        const cog = brief.sections.find((s) => s.name === '人物认知边界（信息差）');
        assert.ok(cog, '洗白后段落仍在');
        assert.doesNotMatch(cog.content, /蒙面人/, '涉隐藏人物的认知行必须被擦掉');
        assert.match(cog.content, /张三 知道：云海奇观/, '无关行保留');
        assert.ok(brief.warnings.some((w) => w.includes('认知账本里有')), '擦了几行要让模型知道');
    } finally {
        cleanup();
    }
});

test('端到端：简报只看动笔前的边界（本章自己落的账不掺进来）', async () => {
    const p = await bootBook('时点书');
    const { tool, exec, cleanup } = p;
    try {
        await tool('novel_write_chapter').execute({
            book: '时点书', chapter: 1, title: '夜谈',
            content: chapterOf(400),
            summary: 'x',
            cognition_updates: '张三|知道|旧秘密',
        }, exec);
        // 重写第 1 章的简报：旧版第 1 章落的认知行属于上一版正文的世界线，
        // 不该出现在「动笔前」的边界里
        const brief = await tool('novel_briefing').execute({ book: '时点书', chapter: 1, cast: '张三' }, exec);
        assert.equal(brief.sections.find((s) => s.name === '人物认知边界（信息差）'), undefined,
            'atChapter = n-1：第1章动笔前没有任何认知记录，不得出现认知段');
    } finally {
        cleanup();
    }
});

test('端到端：novel_ledger cognition 双模式（视图 / 补录），行带 chapter', async () => {
    const p = await bootBook('认知台账书');
    const { tool, exec, cleanup } = p;
    try {
        const empty = await tool('novel_ledger').execute({ action: 'cognition', book: '认知台账书' }, exec);
        assert.deepEqual(empty.cognition, [], '空书视图为空数组');

        const afterAppend = await tool('novel_ledger').execute({
            action: 'cognition', book: '认知台账书', chapter: 1,
            updates: '张三|知道|埋宝点\n读者|知道|埋宝点',
        }, exec);
        assert.equal(afterAppend.addedCount, 2);
        assert.equal(afterAppend.cognition.length, 2);
        assert.ok(afterAppend.cognition.every((r) => r.chapter === 1));

        // 时点视图：at 过滤
        const atView = await tool('novel_ledger').execute({
            action: 'cognition', book: '认知台账书', at: 1, entity: '张三',
        }, exec);
        assert.equal(atView.cognition.filter((r) => r.subject === '张三').length, 1);
        // chapter 超前拒收（与 update 同一守卫）：先落第 1 章，再试远超 max+1 的章号
        await tool('novel_write_chapter').execute({
            book: '认知台账书', chapter: 1, title: '夜谈',
            content: chapterOf(400),
            summary: 'x',
        }, exec);
        await assert.rejects(
            async () => tool('novel_ledger').execute({
                action: 'cognition', book: '认知台账书', chapter: 99,
                updates: '张三|知道|新事',
            }, exec),
            /chapter 超前/,
        );
    } finally {
        cleanup();
    }
});
