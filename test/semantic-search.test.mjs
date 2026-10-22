// test/semantic-search.test.mjs — G1 语义检索升级的两条回归面：
//   ① 查询扩写（查询侧语义桥）：弱结果 → 引擎改写多路候选 → 合并重排；失败/非弱各自降级；
//   ② 写后自动打标：落盘即给新块补语义标签（config 可关、引擎缺席跳过、同书在飞去重）。
// 走真引擎 + 假 llm（块形状对齐 batch5 的 fakeLlm——替身必须镜像真机，不镜像我们自己的实现）。

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ── 纯函数直测的导入（不依赖 SDK）────────────────────────────────────────────
const { parseExpandedQueries, buildExpandPrompt, isWeakResult, mergeExpandedHits }
    = await import('../lib/engine-tasks.js').then((m) => ({
        parseExpandedQueries: m.parseExpandedQueries,
        buildExpandPrompt: m.buildExpandPrompt,
    })).then(async (picked) => ({
        ...picked,
        ...(await import('../lib/retrieval.js')),
    }));

const hasSdk = fs.existsSync(path.join(import.meta.dirname, '..', 'node_modules', '@deepseek-ai', 'dsh-tools'));

const CFG = {
    minChapterChars: 300,
    maxChapterChars: 5000,
    contextBudgetChars: 4000,
    scanTopK: 8,
    repetitionWindow: 10,
    skipPresetDeploy: true, // 测试绝不碰 ~/.dsh
};

// 与 smoke 同款的码头夹具（覆盖场景「码头斗笠」、含乌篷船/斗笠身影等可扩写召回的词面）
const CH = [
    '周砚把斗笠的系带解开，随手搁在码头的石阶上。风灯在桅杆之间摇晃，把江面照成一条条抖动的碎金。他数着远处的更鼓，一声，两声，直到夜风把他的衣角掀起来，又落下。',
    '他等的人没有来。倒是江心有艘乌篷船悄悄靠了岸，船头立着个戴斗笠的身影，一动不动地望了他许久，像是在确认什么。岸上的纤夫收工了，绳索在石桩上勒出细响。',
    '「你是周砚？」那人终于开口。周砚没有应声，只是把袖中的短刃往里收了半寸。脚下的石阶被夜露浸得发滑，他退半步，靴底碾过一粒碎石。',
    '远处有狗吠，吠了两声，很快又停了。他忽然想起师父临走前那句没头没尾的话：这一带的水底下埋着不该埋的东西。那时他只当是醉话。',
    '如今站在码头上，他才觉出江风里那股散不去的腥气是从哪里来的——上游船坞新补的船板在滴桐油，而桐油底下压着的是别的什么。',
].join('\n\n');

let root;
let ctx;
let exec;
let apply;
const engineCalls = []; // 每次 llm.stream 调用留痕：{ system, prompt }

const EXPAND_PREFIX = '你是小说检索索引的查询扩写器';
const ANNOTATE_PREFIX = '你是小说检索索引的标注员';

/** 假 llm：按 system 前缀分流（扩写→候选词行；打标→标签行）。 */
function makeLlm() {
    return {
        stream(options) {
            const system = String(options.system ?? '');
            engineCalls.push({ system, prompt: String(options.messages?.[0]?.content ?? '') });
            const text = system.startsWith(EXPAND_PREFIX)
                ? '1. 乌篷船 江心靠岸\n2) 戴斗笠的身影\n坐化真人'
                : '码头 斗笠 夜会 江风';
            return (async function* () {
                yield { type: 'block-start', index: 0, blockType: 'text' };
                yield { type: 'text-delta', index: 0, text };
                yield { type: 'finish', reason: { kind: 'stop' } };
            })();
        },
    };
}

before(async () => {
    if (!hasSdk) return;
    ({ apply } = await import('../lib/index.js'));

    root = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-forge-semantic-'));
    const backend = {
        async resolve(p, opts) {
            const abs = path.isAbsolute(p) ? p : path.join(opts?.cwd ?? root, p);
            return { targetKey: `key:${abs}`, displayPath: path.relative(root, abs) };
        },
        async stat(target) {
            const abs = target.targetKey.slice(4);
            try {
                const s = fs.statSync(abs);
                return { version: `v:${abs}`, type: s.isDirectory() ? 'directory' : (s.isFile() ? 'file' : 'other'), size: s.size };
            } catch { return undefined; }
        },
        async readText(target) { return fs.readFileSync(target.targetKey.slice(4), 'utf8'); },
        async listDir(target) {
            const abs = target.targetKey.slice(4);
            return fs.readdirSync(abs, { withFileTypes: true }).map((d) => ({
                name: d.name,
                type: d.isDirectory() ? 'directory' : (d.isFile() ? 'file' : 'other'),
                target: { targetKey: `key:${path.join(abs, d.name)}` },
            }));
        },
        async writeText(target, content, intent) {
            const abs = target.targetKey.slice(4);
            const exists = fs.existsSync(abs);
            if (intent?.kind === 'createIfAbsent' && exists) {
                const error = new Error(`FS_NOT_OBSERVED: ${abs} 已存在`);
                error.code = 'FS_NOT_OBSERVED';
                throw error;
            }
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            const before = exists ? fs.readFileSync(abs, 'utf8') : null;
            fs.writeFileSync(abs, content);
            return { operation: exists ? 'update' : 'create', version: `v:${abs}:2`, before, after: content };
        },
    };

    ctx = {
        fs: backend,
        emit() {},
        logger: { info() {}, warn() {} },
        tools: { register: (t) => registered.push(t) },
        systemPrompt: { section: () => {} },
        inject: (deps, fn) => fn(ctx),
        effect: (fn) => fn(),
        webServer: { register: () => () => {} },
        // 真引擎消费的服务：假 llm + 默认路由（routeFor 的 default 来源）
        llm: makeLlm(),
        agentDefaultModel: { provider: 'test-provider', model: 'test-model' },
    };
    const registered = [];
    ctx._registered = registered;
    exec = { signal: new AbortController().signal, agent: { session: { header: { cwd: root, id: 'sess-S' } } } };

    apply(ctx, CFG);
});

after(() => {
    if (root !== undefined) fs.rmSync(root, { recursive: true, force: true });
});

const tool = (name) => ctx._registered.find((t) => t.name === name);

/** 建书三件套：init → 细纲（strict 契约段）→ approve。 */
async function setupBook(BOOK, outlineText = '## 本章必写场景\n1. 码头斗笠\n') {
    await tool('novel_project').execute({ action: 'init', book: BOOK, title: BOOK }, exec);
    await tool('novel_outline').execute({ action: 'save_chapter', book: BOOK, chapter: 1, outline: outlineText }, exec);
    await tool('novel_outline').execute({ action: 'approve', book: BOOK, chapter: 1 }, exec);
}

// ── 纯函数区 ────────────────────────────────────────────────────────────────

test('纯函数：parseExpandedQueries 剥编号、切分号、滤问句与超长、去重封顶', () => {
    const raw = '1. 乌篷船\n2) 江心靠岸\n戴斗笠的身影；坐化真人\n问句？不行\n这一条太长了必须被过滤掉因为超过了二十个字的上限啊\n码头';
    assert.deepEqual(parseExpandedQueries(raw), ['乌篷船', '江心靠岸', '戴斗笠的身影', '坐化真人', '码头']);
    // 封顶 5（候选最少 2 字是契约，单字进不来）；空输入安全
    assert.equal(parseExpandedQueries('甲乙\n丙丁\n戊己\n庚辛\n壬癸\n子丑\n寅卯').length, 5);
    assert.deepEqual(parseExpandedQueries(''), []);
    assert.deepEqual(parseExpandedQueries(null), []);
    assert.match(buildExpandPrompt('斗笠'), /斗笠/);
});

test('纯函数：isWeakResult——零命中必扩，命中够多或已有扎实命中就不扩', () => {
    assert.equal(isWeakResult([], { limit: 8 }), true, '零命中必扩');
    const hits8 = Array.from({ length: 8 }, () => ({ hitRatio: 0.1 }));
    assert.equal(isWeakResult(hits8, { limit: 8 }), false, '填满 limit 不扩');
    assert.equal(isWeakResult([{ hitRatio: 0.25 }, { hitRatio: 0.1 }], { limit: 8 }), true, '少且浅 → 扩');
    assert.equal(isWeakResult([{ hitRatio: 0.6 }, { hitRatio: 0.1 }], { limit: 8 }), false, '有一个扎实命中就不烧那次调用');
    assert.equal(isWeakResult(Array.from({ length: 5 }, () => ({ hitRatio: 0.2 })), { limit: 8 }), false, '命中过半就不扩');
});

test('纯函数：mergeExpandedHits——去重按证据重排、剥 evidence、取最好 bm25', () => {
    const A1 = { chapter: 1, seq: 0, score: -3, hitRatio: 0.25, snippet: '甲路摘录' };
    const A2 = { chapter: 1, seq: 0, score: -1, hitRatio: 0.5, snippet: '乙路摘录' };
    const B = { chapter: 2, seq: 1, score: -2, hitRatio: 1, snippet: '仅乙路', tags: '斗笠' };
    const merged = mergeExpandedHits([[A1], [A2, B]], { limit: 8 });
    // A 被两路命中（evidence 2）排前；B 一路在后
    assert.equal(merged.length, 2);
    assert.equal(merged[0].chapter, 1);
    assert.equal(merged[1].chapter, 2);
    assert.equal(merged[0].score, -3, '保留最好的 bm25 分');
    assert.equal(merged[0].snippet, '甲路摘录', '摘录跟着最好那路走');
    assert.equal(merged[0].hitRatio, 0.5, 'hitRatio 取各路最大');
    assert.equal(merged[1].tags, '斗笠');
    assert.ok(merged.every((h) => !('evidence' in h)), 'evidence 内部字段必须剥掉（schema additionalProperties:false）');
    // cap limit（many 本身就是 12 个列表，不再包一层）
    const many = Array.from({ length: 12 }, (_, i) => [{ chapter: i, seq: 0, score: -i, hitRatio: 1 }]);
    assert.equal(mergeExpandedHits(many, { limit: 8 }).length, 8);
    // 空输入安全
    assert.deepEqual(mergeExpandedHits([[], null, undefined]), []);
});

// ── 引擎通道注册 ────────────────────────────────────────────────────────────

test('expand 通道注册：CHANNEL_NAMES/DEFAULTS/LABELS 与 config schema 同步', async () => {
    const core = await import('../lib/engine-core.js');
    assert.ok(core.CHANNEL_NAMES.includes('expand'), 'CHANNEL_NAMES 缺 expand');
    assert.deepEqual(core.CHANNEL_DEFAULTS.expand, { maxTokens: 512, timeoutMs: 60000 }, '扩写是短任务预算');
    assert.match(core.CHANNEL_LABELS.expand, /查询扩写/);
});

// ── 端到端：查询扩写（真引擎 + 假 llm + 真 sqlite 索引）─────────────────────

test('★ 查询扩写：弱结果触发多路重查，合并召回原词捞不到的段；输出过宿主真校验器', async (t) => {
    const { validateJsonSchemaValue } = await import('@deepseek-ai/dsh-tools');
    const BOOK = '扩写书';
    await setupBook(BOOK);
    await tool('novel_write_chapter').execute({ book: BOOK, chapter: 1, title: '码头', content: CH, summary: '周砚夜会斗笠人', cast: '周砚' }, exec);
    const search = tool('novel_search');
    const built = await search.execute({ action: 'build', book: BOOK }, exec);
    if (built.degraded) { t.skip('本运行时无 sqlite'); return; }

    const expandCallsBefore = engineCalls.filter((c) => c.system.startsWith(EXPAND_PREFIX)).length;
    // 「坐化」在正文里不存在（正文写的是「坐化真人」以外的一切）——纯词法 0 命中
    const v = await search.execute({ action: 'query', book: BOOK, q: '坐化' }, exec);
    const expandCallsAfter = engineCalls.filter((c) => c.system.startsWith(EXPAND_PREFIX)).length;
    assert.equal(expandCallsAfter, expandCallsBefore + 1, '弱结果必须触发一次扩写调用');
    assert.ok(v.hits.length > 0, `扩写后必须召回（扩写词含乌篷船/斗笠身影），实得 ${JSON.stringify(v.hits)}`);
    assert.ok(v.mode.startsWith('expanded-'), `mode 要如实标注扩写，实得 ${v.mode}`);
    assert.deepEqual(v.expandedQueries, ['乌篷船 江心靠岸', '戴斗笠的身影', '坐化真人']);
    assert.ok(v.notes.some((n) => n.includes('查询扩写')), 'notes 要说明扩写词');
    assert.deepEqual(validateJsonSchemaValue(search.output.schema, v), [],
        `带 expandedQueries 的输出被宿主校验器判违规：${validateJsonSchemaValue(search.output.schema, v).join('；')}`);
});

test('查询扩写不越界：非弱结果不触发；扩写失败按原词结果返回且不谎报', async () => {
    const BOOK = '扩写书'; // 复用上一用例的书与索引
    const search = tool('novel_search');

    // 「戴斗笠的人」有扎实命中（hitRatio≥0.5）→ 不扩
    const before = engineCalls.filter((c) => c.system.startsWith(EXPAND_PREFIX)).length;
    const strong = await search.execute({ action: 'query', book: BOOK, q: '戴斗笠的人' }, exec);
    const after = engineCalls.filter((c) => c.system.startsWith(EXPAND_PREFIX)).length;
    assert.ok(strong.hits.length > 0, '前置：强查询应有命中');
    assert.equal(after, before, '非弱结果不得烧扩写调用');
    assert.equal(strong.expandedQueries, undefined);

    // 引擎失败（llm.stream 抛错）→ 扩写未生效，按原词结果返回，输出仍过 schema
    ctx.llm = { stream() { return (async function* () { throw new Error('boom'); })(); } };
    try {
        const failed = await search.execute({ action: 'query', book: BOOK, q: '坐化' }, exec);
        assert.equal(failed.expandedQueries, undefined, '扩写失败不得声称 expanded');
        assert.ok(failed.notes.some((n) => n.includes('扩写未生效')), `notes 要说明未生效，实得：${failed.notes.join('；')}`);
        assert.equal(failed.hits.length, 0, '原词本来就搜不到');
    } finally {
        ctx.llm = makeLlm(); // 还原，别污染后面的用例
    }
});

// ── 端到端：写后自动打标 ────────────────────────────────────────────────────

test('★ 自动打标：落盘即排队补标，查询结果带标签；审计留痕；indexNote 不沉默', async (t) => {
    const { validateJsonSchemaValue } = await import('@deepseek-ai/dsh-tools');
    const { pendingAutoAnnotate } = await import('../lib/chapter-commit.js');
    const BOOK = '打标书';
    await setupBook(BOOK);
    const saved = await tool('novel_write_chapter').execute({ book: BOOK, chapter: 1, title: '码头', content: CH, summary: '周砚夜会斗笠人', cast: '周砚' }, exec);
    assert.ok(saved.indexNote.includes('自动打标已排队'), `indexNote 要说实况，实得：${saved.indexNote}`);
    // 任务在飞就等它落定（已完成则 Map 里没有，直接过）
    const inflight = pendingAutoAnnotate(BOOK);
    if (inflight !== null) await inflight;

    const search = tool('novel_search');
    const built = await search.execute({ action: 'build', book: BOOK }, exec);
    if (built.degraded) { t.skip('本运行时无 sqlite'); return; }

    const v = await search.execute({ action: 'query', book: BOOK, q: '码头' }, exec);
    assert.deepEqual(validateJsonSchemaValue(search.output.schema, v), [], '带标签的输出必须过宿主真校验器');
    assert.ok(v.hits.some((h) => typeof h.tags === 'string' && h.tags !== ''), `打标后命中必须带标签，实得：${JSON.stringify(v.hits.map((h) => h.tags))}`);
    assert.equal(v.mode, 'hybrid', '有标签命中 → mode=hybrid');
    // 审计留痕（可见性：自动打标不是静默副作用）
    const auditPath = path.join(root, BOOK, '.novel', 'audit.jsonl');
    const auditText = fs.existsSync(auditPath) ? fs.readFileSync(auditPath, 'utf8') : '';
    assert.ok(auditText.includes('search/auto-annotate'), '自动打标必须在审计流留一行');
});

test('自动打标三闸：config 关掉不排队；引擎缺席跳过不谎报；同书在飞去重', async () => {
    const { commitChapter, pendingAutoAnnotate } = await import('../lib/chapter-commit.js');
    const { createFsio, sessionCwd } = await import('../lib/fsio.js');
    const { pathsFor } = await import('../lib/store.js');
    const { requireBook } = await import('../lib/tools/common.js');
    const search = tool('novel_search');
    const built = await search.execute({ action: 'build', book: '打标书' }, exec);
    if (built.degraded) { assert.ok(true, '无 sqlite 运行时：其余断言无处落脚，按通过处理'); return; }

    // ① config.search.autoAnnotate=false → 不排队、indexNote 不提、块不带标签
    const OFF = '关标书';
    await setupBook(OFF);
    {
        const io = createFsio(ctx, exec, sessionCwd(exec));
        const p = pathsFor(OFF);
        const { novel } = await requireBook(io, OFF);
        const r = await commitChapter({
            config: { ...CFG, search: { autoAnnotate: false } }, io, p, book: OFF, novel, n: 1,
            title: '码头', content: CH, summary: '周砚夜会斗笠人', castNames: ['周砚'],
            engine: { isAvailable: () => true, run: async () => { throw new Error('不该被调用'); } },
        });
        assert.ok(!r.indexNote.includes('自动打标已排队'), '关掉后 indexNote 不得谎报排队');
        assert.equal(pendingAutoAnnotate(OFF), null, '关掉后不得排队');
    }

    // ② 引擎缺席（isAvailable=false，MCP 独立模式同档）→ 静默跳过、不谎报
    const SKIP = '缺席书';
    await setupBook(SKIP);
    {
        const io = createFsio(ctx, exec, sessionCwd(exec));
        const p = pathsFor(SKIP);
        const { novel } = await requireBook(io, SKIP);
        const r = await commitChapter({
            config: CFG, io, p, book: SKIP, novel, n: 1,
            title: '码头', content: CH, summary: '周砚夜会斗笠人', castNames: ['周砚'],
            engine: { isAvailable: () => false, run: async () => { throw new Error('不该被调用'); } },
        });
        assert.ok(!r.indexNote.includes('自动打标已排队'), '引擎缺席不得谎报排队');
        assert.equal(pendingAutoAnnotate(SKIP), null);
    }

    // ③ 同书在飞去重：第一个任务被闸门挂起时，第二次提交不再排队第二个。
    // 引擎替身只对齐 commitChapter→autoAnnotateChapter→runAnnotateTask 消费的
    // run 契约（{ok,text,attempts}），闸门挂在 run 里；引擎的流式聚合已有 ★ 用例
    // 走真引擎+假 llm 覆盖——这里不重抄（抄出来的那份会在重试语义上漂移）。
    const INFLIGHT = '在飞书';
    await setupBook(INFLIGHT);
    let releaseAnnotate = null; // 非 null = 已放行（打标循环是串行 await，不会二次挂闸）
    const gatedEngine = {
        isAvailable: () => true,
        run(channel) {
            if (channel !== 'annotate') {
                return Promise.resolve({ ok: false, attempts: 0, error: { code: 'WRONG_CHANNEL', message: `不该被调用的通道：${channel}` } });
            }
            if (releaseAnnotate !== null) return Promise.resolve({ ok: true, text: '码头 斗笠 夜会 江风', attempts: 1 });
            return new Promise((resolve) => {
                releaseAnnotate = () => resolve({ ok: true, text: '码头 斗笠 夜会 江风', attempts: 1 });
            });
        },
    };
    let second;
    try {
        {
            const io = createFsio(ctx, exec, sessionCwd(exec));
            const p = pathsFor(INFLIGHT);
            const { novel } = await requireBook(io, INFLIGHT);
            await commitChapter({
                config: CFG, io, p, book: INFLIGHT, novel, n: 1,
                title: '码头', content: CH, summary: '周砚夜会斗笠人', castNames: ['周砚'],
                engine: gatedEngine,
            });
        }
        assert.ok(pendingAutoAnnotate(INFLIGHT) !== null, '前置：第一个任务应在飞（被闸门挂起）');
        {
            const io = createFsio(ctx, exec, sessionCwd(exec));
            const p = pathsFor(INFLIGHT);
            const { novel } = await requireBook(io, INFLIGHT);
            second = await commitChapter({
                config: CFG, io, p, book: INFLIGHT, novel, n: 1,
                title: '码头', content: CH, summary: '周砚夜会斗笠人', castNames: ['周砚'],
                engine: gatedEngine,
            });
        }
        assert.ok(!second.indexNote.includes('自动打标已排队'), '上一轮还在跑：本轮不得再排队');
    } finally {
        if (releaseAnnotate !== null) releaseAnnotate(); // 放行闸门，任务落定
    }
    const inflight = pendingAutoAnnotate(INFLIGHT);
    if (inflight !== null) await inflight;
    assert.equal(pendingAutoAnnotate(INFLIGHT), null, '任务落定后在飞表必须清空');
});
