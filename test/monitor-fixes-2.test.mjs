// E5 / E14 / E15——真机 40 章监控日志「19 编号总账」里仅剩的三个未修编号：
//
// · E14 细纲自引禁词：必写场景条目里出现本章禁项（真机第 22 章：禁项「三十年」与
//   场景自述原文互撞）——场景摘要短语要逐字进正文，含禁词的条目逼正文同时「含」与
//   「不含」同一个词，写章端必烧一整轮。修法：save_chapter 阶段拦下（改一条目 vs
//   烧一轮写章），拍行不查（拍不要求逐字），精确豁免词不报（写章链已能自愈）。
// · E15 同回合重发锚定：同一回合逐段修补基本不长个儿（第 27 章 8 发 1613→1906、
//   两发 1982 同文）——对策此前只活在监控日志的 persona 纪律里。修法：`:last` 记
//   本次被驳稿字数，机审连驳且净增 <100 字时驳回文案硬指引「换新回合全文重写」。
// · E5 模型字数估短 30–40%：首稿均长 1881±10 稳定贴线下（简报抽象目标拦不住）。
//   修法：rejected 审计行带显式 chars（不再靠 reason 正则反提），简报的「本章字数
//   目标」段注入本书首稿实测（健康书/样本不足静默），配方给到段数与单段量级。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { outlineSelfConflicts } from '../lib/gate-metrics.js';
import { recordRejection } from '../lib/circuit-breaker.js';
import { firstDraftByChapter } from '../lib/health.js';
import { charTargetSection } from '../lib/briefing.js';

// ── E14 纯函数层 ────────────────────────────────────────────────────────────────

const OUTLINE_CONFLICT = [
    '## 本章必写场景',
    '',
    '- 隔世旧账：翻出三十年前的旧账核对笔迹。',
    '- 巷口追击：有人比马队先到一步。',
    '',
    '## 本章禁止偏离项',
    '',
    '- 不得出现「三十年」——时间线以账簿为准',
].join('\n');

test('★ E14：必写场景条目自引禁词 → 报矛盾（带场景定位与禁项声明句）', () => {
    const hits = outlineSelfConflicts(OUTLINE_CONFLICT);
    assert.equal(hits.length, 1, `只报自引的那一条（实际 ${hits.length}）`);
    const h = hits[0];
    assert.equal(h.term, '三十年');
    assert.equal(h.sceneNo, 1);
    assert.equal(h.sceneTitle, '隔世旧账');
    assert.equal(h.where, '描述');
    assert.match(h.excerpt, /三十年/);
    assert.match(h.declared, /不得出现「三十年」/, '声明句取自禁项段，驳回文案要自解释');
});

test('★ E14：精确豁免词不报（写章链按「以场景为准」放行的那条路，save 不再拦）', () => {
    const outline = [
        '## 本章必写场景',
        '',
        '- 三十年：旧账重开，核对笔迹。',
        '',
        '## 本章禁止偏离项',
        '',
        '- 不得出现「三十年」——时间线以账簿为准',
    ].join('\n');
    assert.deepEqual(outlineSelfConflicts(outline), [], '标题精确等于豁免词（sceneTermSet 含它）');
});

test('★ E14：拍行含禁词不报（拍不要求逐字复现，写手绕得开——报了就是误伤）', () => {
    const outline = [
        '## 本章必写场景',
        '',
        '- 渡口夜审：货单对不上，掌柜汗比话多。',
        '拍：出示玄铁令压场',
        '',
        '## 本章禁止偏离项',
        '',
        '- 不得出现玄铁令——实物不入场',
    ].join('\n');
    assert.deepEqual(outlineSelfConflicts(outline), []);
});

test('★ E14：无禁项段或无场景段 → []（不判）', () => {
    assert.deepEqual(outlineSelfConflicts('- 场景：描述。'), [], '没有禁项段');
    assert.deepEqual(outlineSelfConflicts('## 本章禁止偏离项\n\n- 不得出现X词'), [], '没有场景段');
});

test('★ E15：recordRejection 记录本次被驳稿字数（`:last` 带 chars，缺省不写）', () => {
    const novel = {};
    recordRejection(novel, 7, { code: 'audit', detail: '字数不足', chars: 1880.6 });
    assert.equal(novel.gateFailures['7:last'].chars, 1881, '取整存盘');
    assert.equal(novel.gateFailures['7'], 1);
    recordRejection(novel, 8, { code: 'content-gate' });
    assert.equal('chars' in novel.gateFailures['8:last'], false, '缺省不写该字段（与旧记录同形）');
});

// ── E5 纯函数层 ────────────────────────────────────────────────────────────────

test('★ E5：firstDraftByChapter 显式 chars 优先；非成稿探针不占首稿槽位；历史行正则兜底', () => {
    const lines = [
        // 新行（1.0.4 起）：reason 不含旧正则模式，显式 chars 兜住
        JSON.stringify({ action: 'write_chapter/rejected', chapter: 1, chars: 1880, reason: '别的驳回理由' }),
        // 非成稿探针：即使带 chars 也不占槽（后续行才算首稿）
        JSON.stringify({ action: 'write_chapter/rejected', chapter: 2, chars: 9, nonDraft: true, reason: '这不是一章' }),
        JSON.stringify({ action: 'write_chapter/rejected', chapter: 2, chars: 1950, reason: '正文 1950 字，低于下限' }),
        // 历史行（无 chars 字段）：正则兜底照旧
        JSON.stringify({ action: 'write_chapter/rejected', chapter: 3, reason: '正文 1900 字，低于下限 2000' }),
    ].join('\n');
    const m = firstDraftByChapter(lines);
    assert.equal(m.get(1).chars, 1880, '显式 chars 优先（文案一改，正则就静默失灵）');
    assert.equal(m.get(2).chars, 1950, 'nonDraft 探针跳过，第二行才是首稿');
    assert.equal(m.get(3).chars, 1900, '历史行正则兜底不变');
});

test('★ E5：charTargetSection 带首稿实况（差额与段数配方到数字）；健康书静默', () => {
    const config = { minChapterChars: 2000, maxChapterChars: 4000 };
    const withFd = charTargetSection({
        config, charsTarget: 3000, firstDraft: { avg: 1881, count: 40 },
    });
    assert.match(withFd, /首稿实况（本书审计 40 章实测，均长 1881 字）/);
    assert.match(withFd, /还差 219 字/, '差额按「下限+余量」算（2100-1881）');
    assert.match(withFd, /至少 14 段/, '段数配方 = ceil(2100/150)（PARAGRAPH_SPEC_MAX 同源）');
    assert.match(withFd, /不要「先交一版再补」/);

    const healthy = charTargetSection({ config, charsTarget: 3000 });
    assert.doesNotMatch(healthy, /首稿实况/, '没给 firstDraft 就不出现（健康书/样本不足静默）');
});

// ── 端到端（真跑工具链，不 grep 源码）─────────────────────────────────────────

const CFG = {
    minChapterChars: 300,
    maxChapterChars: 5000,
    contextBudgetChars: 4000,
    scanTopK: 8,
    repetitionWindow: 10,
    skipPresetDeploy: true, // 测试绝不碰 ~/.dsh
};

let root;
let ctx;
let exec;

before(async () => {
    const { apply } = await import('../lib/index.js');
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-forge-e51415-'));
    const backend = {
        async resolve(p, opts) {
            const abs = path.isAbsolute(p) ? p : path.join(opts?.cwd ?? root, p);
            return { targetKey: 'key:' + abs, displayPath: path.relative(root, abs) };
        },
        async stat(target) {
            const abs = target.targetKey.slice(4);
            try {
                const s = fs.statSync(abs);
                return { version: 'v:' + abs, type: s.isDirectory() ? 'directory' : (s.isFile() ? 'file' : 'other'), size: s.size };
            } catch { return undefined; }
        },
        async readText(target) { return fs.readFileSync(target.targetKey.slice(4), 'utf8'); },
        async listDir(target) {
            const abs = target.targetKey.slice(4);
            return fs.readdirSync(abs, { withFileTypes: true }).map((d) => ({
                name: d.name, type: d.isDirectory() ? 'directory' : (d.isFile() ? 'file' : 'other'),
                target: { targetKey: 'key:' + path.join(abs, d.name) },
            }));
        },
        async writeText(target, text, intent) {
            const abs = target.targetKey.slice(4);
            const exists = fs.existsSync(abs);
            if (intent?.kind === 'createIfAbsent' && exists) {
                const error = new Error('FS_NOT_OBSERVED: ' + abs);
                error.code = 'FS_NOT_OBSERVED';
                throw error;
            }
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            fs.writeFileSync(abs, text);
            return { operation: exists ? 'update' : 'create', version: 'v:' + abs + ':2', before: null, after: text };
        },
    };
    const registered = [];
    ctx = {
        fs: backend,
        emit() {},
        logger: { info() {} },
        tools: { register: (t) => registered.push(t) },
        systemPrompt: { section: () => {} },
        inject: (_deps, fn) => fn(ctx),
        effect: (fn) => fn(),
        webServer: { register: () => () => {} },
        _registered: registered,
    };
    exec = { signal: new AbortController().signal, agent: { session: { header: { cwd: root, id: 'sess-E51415' } } } };
    apply(ctx, CFG);
});

after(() => {
    if (root !== undefined) fs.rmSync(root, { recursive: true, force: true });
});

function tool(name) {
    const t = ctx._registered.find((x) => x.name === name);
    if (t === undefined) throw new Error('工具未注册：' + name);
    return t;
}

async function initBook(book) {
    await tool('novel_project').execute({ action: 'init', book, title: book, logline: 'E5/E14/E15 回归书。' }, exec);
    await tool('novel_outline').execute({ action: 'save_book', book, outline: '# 全书大纲\n\n卷一：回归线。' }, exec);
}

test('★ E14 端到端：自引禁词的细纲 save_chapter 拒收，改写条目后过；未保存的矛盾细纲不落盘', async () => {
    await initBook('自引书');
    await assert.rejects(
        () => tool('novel_outline').execute({ action: 'save_chapter', book: '自引书', chapter: 1, outline: OUTLINE_CONFLICT }, exec),
        (err) => {
            const msg = String(err?.message ?? err);
            assert.match(msg, /细纲自相矛盾，未保存/);
            assert.match(msg, /禁项「三十年」出现在第1个场景「隔世旧账」的描述/);
            assert.match(msg, /不得出现「三十年」/, '带禁项声明句');
            assert.match(msg, /两条修法任选/, '给出可执行修法');
            return true;
        },
    );
    assert.equal(
        fs.existsSync(path.join(root, '自引书', '大纲', '细纲', '第1章.md')),
        false,
        '被拒的矛盾细纲不落盘（拦在 writeText 之前）',
    );
    // 改写场景条目绕开禁词后重新保存成功
    const fixed = OUTLINE_CONFLICT.replace('翻出三十年前的旧账核对笔迹。', '翻出旧账核对笔迹，年份以账簿封面为准。');
    const saved = await tool('novel_outline').execute({ action: 'save_chapter', book: '自引书', chapter: 1, outline: fixed }, exec);
    assert.equal(saved.chapter, 1);
    assert.equal(fs.existsSync(path.join(root, '自引书', '大纲', '细纲', '第1章.md')), true, '修好的细纲正常落盘');
    // 审计留痕（驳回必须可见）
    const auditText = fs.readFileSync(path.join(root, '自引书', '.novel', 'audit.jsonl'), 'utf8');
    assert.match(auditText, /outline\/rejected_selfconflict/);
});

const OUTLINE_OK = [
    '## 本章必写场景',
    '',
    '- 渡口夜审：货单对不上，掌柜汗比话多。',
    '拍：账册摊开比对笔迹',
    '拍：一炷香内破绽自现',
    '',
    '## 本章禁止偏离项',
    '',
    '- 不得出现玄铁令——实物不入场',
].join('\n');

test('★ E15 端到端：机审连驳且净增 <100 字 → 驳回文案硬指引换新回合；净增够就不误报', async () => {
    await initBook('锚定书');
    await tool('novel_outline').execute({ action: 'save_chapter', book: '锚定书', chapter: 1, outline: OUTLINE_OK }, exec);
    await tool('novel_outline').execute({ action: 'approve', book: '锚定书', chapter: 1 }, exec);
    const write = (content) => tool('novel_write_chapter').execute({
        book: '锚定书', chapter: 1, title: '渡口夜审', summary: '锚定回归章。', content,
    }, exec);

    // 首驳（200 字 ≥ 非成稿线 75、< 下限 300）：无上一稿可比，不给锚定文案
    await assert.rejects(() => write('整'.repeat(200)), (err) => {
        assert.match(String(err.message), /机审未通过/);
        assert.doesNotMatch(String(err.message), /同回合重发锚定/, '第一次驳回没有可比对的上一稿');
        return true;
    });
    const novel1 = JSON.parse(fs.readFileSync(path.join(root, '锚定书', 'novel.json'), 'utf8'));
    assert.equal(novel1.gateFailures['1:last'].chars, 200, '被驳稿字数已落盘（E15 判据的数据源）');

    // 二驳（250 字，净增 +50 < 100）：锚定文案 + 换回合硬指引
    await assert.rejects(() => write('整'.repeat(248) + '补字'), (err) => {
        const msg = String(err.message);
        assert.match(msg, /同回合重发锚定/);
        assert.match(msg, /本稿 250 字，比上次驳回稿（200 字）只多 50 字/);
        assert.match(msg, /换一个新回合/, '对策从 persona 纪律前移到工具文案');
        assert.match(msg, /novel_outline save_chapter/, '同时给出重批通道');
        return true;
    });
    const auditText = fs.readFileSync(path.join(root, '锚定书', '.novel', 'audit.jsonl'), 'utf8');
    const rows = auditText.trim().split('\n').map((l) => JSON.parse(l));
    const second = rows.filter((r) => r.action === 'write_chapter/rejected').at(-1);
    assert.equal(second.anchorStalled, true, '锚定态进审计留痕（监控可统计）');
    assert.equal(second.chars, 250, '审计行带显式 chars（E5：不再靠 reason 正则反提）');

    // 三驳后（这里直接走正例）：够下限 + 段数达标（≥3 段，机审另有段落数规则）→ 正常落盘、无锚定文案
    const ok = await write(['整'.repeat(120), '整'.repeat(120), '整'.repeat(100)].join('\n\n'));
    assert.equal(ok.chars, 340, '够下限正常落盘');
});

test('★ E15 端到端：净增 ≥100 字的推进不误报锚定', async () => {
    await initBook('推进书');
    await tool('novel_outline').execute({ action: 'save_chapter', book: '推进书', chapter: 1, outline: OUTLINE_OK }, exec);
    await tool('novel_outline').execute({ action: 'approve', book: '推进书', chapter: 1 }, exec);
    const write = (content) => tool('novel_write_chapter').execute({
        book: '推进书', chapter: 1, title: '渡口夜审', summary: '推进回归章。', content,
    }, exec);

    await assert.rejects(() => write('整'.repeat(90)), (err) => {
        assert.match(String(err.message), /机审未通过/);
        return true;
    });
    // 净增 +160（≥100）：仍在下限之下（250 < 300）但属于有效推进，不许喊「锚定」
    await assert.rejects(() => write('整'.repeat(250)), (err) => {
        const msg = String(err.message);
        assert.match(msg, /机审未通过/);
        assert.doesNotMatch(msg, /同回合重发锚定/, '净增 160 ≥ 阈值，是推进不是锚定');
        return true;
    });
});

test('★ E5 端到端：简报注入本书首稿实况（审计现算），健康/无审计时静默', async () => {
    await initBook('首稿书');
    await tool('novel_outline').execute({ action: 'save_chapter', book: '首稿书', chapter: 1, outline: OUTLINE_OK }, exec);
    // 无审计行 → 简报不带首稿实况（静默）
    const clean = await tool('novel_briefing').execute({ book: '首稿书', chapter: 1 }, exec);
    const cleanSection = clean.sections.find((s) => s.name === '本章字数目标');
    assert.doesNotMatch(cleanSection.content, /首稿实况/, '没有审计实测就不给数字');

    // 造 3 行首稿审计（均长 350 < 下限 300+余量 100）→ 简报带上实测与配方
    const rows = [340, 350, 360].map((chars, i) => JSON.stringify({
        action: 'write_chapter/rejected', chapter: i + 1, chars, reason: `正文 ${chars} 字，低于下限`,
    })).join('\n') + '\n';
    fs.appendFileSync(path.join(root, '首稿书', '.novel', 'audit.jsonl'), rows);
    const brief = await tool('novel_briefing').execute({ book: '首稿书', chapter: 1 }, exec);
    const section = brief.sections.find((s) => s.name === '本章字数目标');
    assert.match(section.content, /首稿实况（本书审计 3 章实测，均长 350 字）/);
    assert.match(section.content, /还差 50 字/, '300+100-350');
    assert.match(section.content, /至少 3 段/, 'ceil(400/150)');
});
