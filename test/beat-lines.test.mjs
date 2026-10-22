// 拍行归巢 + 禁项驳回定位（《新万刃》1.0.2 复核轮实证的三个摩擦点）：
//
// ① 模型爱把拍写成场景行下方的「拍：…」独立行。旧 parseScenes 把每行拍当场景
//   （「拍」单字不满足标题冒号 {2,40}，整行成了标题）——3 真场景 + 10 拍行 →
//   覆盖率 3/19=15.8%，模型按警告字面去逐字复现拍短语，越追越低、白写两版正文。
// ② 禁项驳回只给「命中禁项：X」，模型要猜去哪改（该会话三轮才自愈）——
//   现在 bannedHitsDetail 带声明句 + 正文行号/片段。
// ③ ledger-conflict 文案的补救「或换新版本」对同章重写无效（冲突按章号记，
//   与版本无关）——文案指了条死路，还教不会「重写时省略已落账的键」。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseScenes, outlineScenesOf, outlineCapacityEstimate, computeGateMetrics } from '../lib/gate-metrics.js';
import { applyFactUpdates } from '../lib/ledger.js';

// 真机同款形态：场景行 + 裸「拍：」续行（无括号）。
const OUTLINE = [
    '## 本章必写场景',
    '',
    '- 渡口夜审：货单对不上，掌柜汗比话多。',
    '拍：船工当众发难，讥讽账目',
    '拍：账册摊开比对笔迹',
    '拍：一炷香内破绽自现',
    '- 巷口追击：有人比马队先到一步。',
    '拍：翻墙截巷换衣三段跑位',
    '拍：死巷扑空',
    '- 码头收网：真目标已出城。',
    '拍：令牌浮出水面',
    '',
    '## 本章禁止偏离项',
    '',
    '- 不得出现「玄铁令」——实物不入场，只闻其名',
].join('\n');

const CONTENT_OK = [
    '天没亮透，渡口的雾还压着水面。货单对不上，掌柜汗比话多。',
    '有个船工当众发难，讥讽账目记不清还想跑船。她不接话，只把账册摊开比对笔迹，一炷香内破绽自现——三笔运费都记在同一个名下，字迹却出自两个人。',
    '有人比马队先到一步。她翻墙截巷换衣三段跑位，死巷扑空。巷子尽头只有半截烧过的火把，雨水把灰烬糊在地上，来人至少比她早到了半个时辰。',
    '码头上真目标已出城，只有令牌浮出水面，随浪打了三个转。她捞起来掂了掂，分量比想象中轻，背面刻的字号被锉刀新锉过一遍，锉痕还很利。',
    '回到渡口，掌柜的已经吓得坐在门槛上。她没问话，先把那本账册塞回他怀里，看着他抖着手翻到最后一页，又停住。',
    '雾散了一些。远处的桅杆一根一根从灰白里立出来，像有人在纸面上补画线条。她数了数，比昨夜少了两根，走的那两根船板上还留着新鲜的缆绳勒痕。',
].join('\n\n');

test('★ 裸「拍：」续行归属上一场景，不再灌水覆盖率的分母', () => {
    const scenes = outlineScenesOf(OUTLINE);
    assert.equal(scenes.length, 3, `拍行不许立场景（旧解析会把 6 行拍算成 6 个场景，实际 ${scenes.length}）`);
    assert.deepEqual(scenes.map((s) => s.beatLines), [3, 2, 1]);
    assert.deepEqual(scenes.map((s) => s.title), ['渡口夜审', '巷口追击', '码头收网']);
    // 行内括号拍（（拍：…））路径不受影响：仍由 stripSceneMeta 清走、不立场景
    const paren = parseScenes('- 开柜取纸：柜面旧痕（拍：揭纸/别签）');
    assert.equal(paren.length, 1);
    assert.equal(paren[0].beatLines, undefined);
});

test('★ 容量估算认拍行：同款细纲不再被「3 拍 1380 字」驳回', () => {
    const est = outlineCapacityEstimate({ outline: OUTLINE, minChars: 1500 });
    assert.equal(est.sceneCount, 3);
    assert.equal(est.beats, 6, '拍数按显式拍行算（3+2+1），不是旧口径的 3');
    assert.equal(est.estimated, 3 * 300 + 6 * 160);
    assert.equal(est.neededBeats, 0, '1860 ≥ 1500，真机那次 1380<2000 的误驳不再发生');
    // 拍行封顶仍生效：单场景 7 行拍只算 5
    const capped = parseScenes('- 单场：描述。\n拍：一\n拍：二\n拍：三\n拍：四\n拍：五\n拍：六\n拍：七');
    assert.deepEqual(capped.map((s) => s.beatLines), [7]);
});

test('★ 覆盖率按场景算，missedScenes 只报场景标题', () => {
    const ok = computeGateMetrics({ content: CONTENT_OK, outline: OUTLINE, target: 3000 });
    assert.equal(ok.available, true);
    assert.equal(ok.coverage, 100, `三场景摘要都逐字在正文（实际 ${ok.coverage}%）`);
    assert.deepEqual(ok.missedScenes, []);

    const miss = computeGateMetrics({
        content: CONTENT_OK.replace('码头上真目标已出城，只有令牌浮出水面，随浪打了三个转。', '码头空无一人。'),
        outline: OUTLINE, target: 3000,
    });
    assert.equal(miss.coverage, 66.7);
    assert.deepEqual(miss.missedScenes, ['码头收网'], '漏的是场景，不是「拍：令牌浮出水面」这类拍行');
});

test('★ 禁项命中带声明句与正文定位（驳回文案自解释）', () => {
    const smallBody = [
        '天没亮透，渡口的雾还压着水面。货单对不上，掌柜汗比话多。',
        '有人比马队先到一步。她翻墙截巷换衣三段跑位，死巷扑空。',
        '码头上真目标已出城，只有令牌浮出水面，随浪打了三个转。',
        '他从怀里摸出玄铁令，压在账册上。',
    ].join('\n');
    const withBan = smallBody;
    const m = computeGateMetrics({ content: withBan, outline: OUTLINE, target: 3000 });
    assert.deepEqual(m.bannedHits, ['玄铁令']);
    assert.equal(m.bannedHitsDetail.length, 1);
    const d = m.bannedHitsDetail[0];
    assert.equal(d.term, '玄铁令');
    assert.match(d.declared, /不得出现「玄铁令」/, '声明句取自禁项段');
    assert.equal(d.lineNo, 4, '命中在第 4 行（smallBody 共 4 行，禁词在第 4 行）');
    assert.match(d.excerpt, /玄铁令/, '片段含命中词');
});

test('★ ledger-conflict 文案不再指「换新版本」死路，教重写时省略已落账的键', () => {
    const facts = [{ entity: '江州湾', key: '异象', value: '信号在增强', chapter: 1, note: '', ts: '2026-01-01T00:00:00Z' }];
    const r = applyFactUpdates(facts, [{ entity: '江州湾', key: '异象', value: '信号在增强、流动翻四倍' }], { chapter: 1, now: '2026-01-01T00:00:01Z' });
    assert.equal(r.conflicts.length, 1);
    const msg = r.conflicts[0].reason;
    assert.doesNotMatch(msg, /换新版本/, '「换新版本」对同章重写无效（冲突按章号记），不许再指这条路');
    assert.match(msg, /与版本无关/);
    assert.match(msg, /省略/);
    assert.match(msg, /novel_ledger update/, '给出合法修订通道：落到实际变化的章号');
});

// ── 端到端：真实 write_chapter 的驳回文案要带上定位 ─────────────────────────────

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
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-forge-beatlines-'));
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
    exec = { signal: new AbortController().signal, agent: { session: { header: { cwd: root, id: 'sess-B' } } } };
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

test('★ 端到端：novel_write_chapter 撞禁项，驳回文案带声明句与正文行号', async () => {
    const project = tool('novel_project');
    await project.execute({ action: 'init', book: '拍行书', title: '拍行书', logline: '细纲拍行格式的回归书。' }, exec);
    await tool('novel_outline').execute({ action: 'save_book', book: '拍行书', outline: '# 全书大纲\n\n卷一：渡口疑云。' }, exec);
    await tool('novel_outline').execute({ action: 'save_chapter', book: '拍行书', chapter: 1, outline: OUTLINE }, exec);
    await tool('novel_outline').execute({ action: 'approve', book: '拍行书', chapter: 1 }, exec);
    await assert.rejects(
        () => tool('novel_write_chapter').execute({
            book: '拍行书', chapter: 1, title: '渡口夜审', summary: '撞禁项的一章。',
            content: withBanBody(),
        }, exec),
        (err) => {
            const msg = String(err?.message ?? err);
            assert.match(msg, /细纲禁项被违反/);
            assert.match(msg, /细纲声明：「[^」]*玄铁令/, '带声明句');
            assert.match(msg, /正文第 \d+ 行「[^」]*玄铁令/, '带正文行号与片段');
            return true;
        },
    );
});

function withBanBody() {
    return CONTENT_OK + '\n\n他从怀里摸出玄铁令，压在账册上，掌柜的汗当场停了。';
}
