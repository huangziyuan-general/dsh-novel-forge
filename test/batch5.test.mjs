// test/batch5.test.mjs — 第五批（D1 旁路引擎 / D2 并发起草 / G1 检索）的纯逻辑与集成测试。
//
// 这一批碰的是模型调用与并发，所以测试的重点不是「功能通不通」，而是**边界行为对不对**：
//   引擎：截断不许重试、鉴权失败不许重试、限流要退避重试、用户取消立刻停、无宿主要降级；
//   批量：并发生成但串行提交、失败不整批回滚、没有场景契约就不许提速；
//   检索：中文二元切分、指纹增量、标签增强、命中比例闸门。
//
// 全程不打真网络：llm 服务是假的，io 是内存盘。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    createEngine, classifyFinish, retryDelayMs, buildUserMessage, describeEngineError,
    StreamCollector, deadline, CHANNEL_DEFAULTS, DEFAULT_RETRIES, MAX_TIMER_DELAY_MS,
} from '../lib/engine.js';
import {
    buildPolishPrompt, buildProofreadPrompt, extractChapterText, parseTags,
    GUARD_PROFILES, POLISH_SYSTEM, PROOFREAD_SYSTEM, runRevisionTask, runAnnotateTask,
} from '../lib/engine-tasks.js';
import {
    bigrams, ftsQuery, chunkChapter, hashChunk, makeSnippet, hitRatio,
    normalizeForIndex, parseChapterSpec, INDEX_RELATIVE,
} from '../lib/retrieval.js';
import {
    planDraftBatch, deriveTitleSummary, mapWithConcurrency, buildDraftPrompt,
    runDraftBatch, MAX_CONCURRENCY, DRAFT_SYSTEM,
} from '../lib/batch-draft.js';
import { pathsFor } from '../lib/store.js';

// ── 测试脚手架：假 llm 服务 + 内存 io ────────────────────────────────────────

/** 假 llm：按 chunk 脚本产出流；记录调用次数与最后一次 options。 */
function fakeLlm(chunks, { fail = null } = {}) {
    const state = { count: 0, last: null };
    return {
        get count() { return state.count; },
        get last() { return state.last; },
        stream(options) {
            state.count += 1;
            state.last = options;
            return (async function* () {
                if (fail !== null) throw fail;
                for (const c of chunks) yield c;
            })();
        },
    };
}

const textChunks = (text, finish = { kind: 'stop' }) => [
    { type: 'block-start', index: 0, blockType: 'text' },
    ...(text === '' ? [] : [{ type: 'text-delta', index: 0, text }]),
    { type: 'finish', reason: finish },
];

const ctxWith = (llm, route = { provider: 'test-provider', model: 'test-model' }) => ({ llm, agentDefaultModel: route });
const noSleep = () => Promise.resolve();

/** 内存盘 io：够 chapter-commit / briefing / proposals 用。 */
function memIo(initial = {}) {
    const files = new Map(Object.entries(initial));
    const api = {
        cwd: '/mem',
        files,
        async stat(p) {
            return files.has(p) ? { target: p, info: { type: 'file', version: String(files.get(p)).length } } : null;
        },
        async abs(p) { return `/mem/${p}`; },
        async readText(p) { return files.has(p) ? files.get(p) : null; },
        async readJson(p) {
            const t = await api.readText(p);
            return t === null ? null : JSON.parse(t);
        },
        async writeText(p, text, mode) {
            if (mode === 'create' && files.has(p)) {
                const error = new Error(`FS_NOT_OBSERVED: ${p} 已存在`);
                error.code = 'FS_NOT_OBSERVED';
                throw error;
            }
            files.set(p, text);
            return { version: String(text).length };
        },
        async writeJson(p, value) { return api.writeText(p, `${JSON.stringify(value, null, 2)}\n`); },
        async appendLine(p, line) { return api.writeText(p, `${files.get(p) ?? ''}${line}\n`); },
        async listNames() { return []; },
    };
    return api;
}

const TEST_CFG = {
    minChapterChars: 60, maxChapterChars: 20000, contextBudgetChars: 4000,
    scanTopK: 8, repetitionWindow: 10,
};

/** 三段互不重复的第三人称正文（机审的跨章重复检测是真的会比对的）。 */
const CHAPTER_TEXTS = {
    1: '雪落了一夜。林晚把刀横在膝上，听着码头方向的橹声。那盏风灯在雾里晃，晃到第三次的时候，她站了起来。她认得那个节奏——三长两短，是义庄的暗号。\n\n她推开门，风把檐下的灯笼吹得直转。台阶上摆着一只湿透的布鞋，鞋尖朝着屋里，像是有人站在门外，把鞋脱了才进来。\n\n她没有捡那只鞋。她只是把刀换到了左手。',
    2: '来客把斗笠摘下来，放在门槛上，露出半张被火燎过的脸。林晚没有让开，手还搭在刀柄上。两人就那么僵着，谁也没先开口。\n\n远处传来更夫的梆子声，敲了四下。她数错了，却没人纠正她。斗笠上的雪化成水，一滴一滴落在门槛里侧，积成一小片深色。\n\n她终于侧过身，让出了半扇门。来客却没有动。',
    3: '供桌底下压着一张湿透的纸，墨迹晕开，只剩半个「寒」字。她把纸凑近烛火，纸角立刻卷了起来，焦味钻进鼻子。\n\nTODO 待补：这一段还没想好怎么写。\n\n她把纸按回供桌底下，站起来的时候，膝盖上的旧伤又开始响。',
};

// ── D1：引擎纯函数 ─────────────────────────────────────────────────────────

test('engine: classifyFinish 按 finish.kind 分流——截断/工具调用/取消一律不重试', () => {
    assert.equal(classifyFinish({ kind: 'stop' }).ok, true);

    const truncated = classifyFinish({ kind: 'max-tokens' });
    assert.equal(truncated.code, 'TRUNCATED');
    assert.equal(truncated.retryable, false, '输出被截断时重试同样截断——必须交给调用方拆批');

    assert.equal(classifyFinish({ kind: 'aborted' }).code, 'ABORTED');
    assert.equal(classifyFinish({ kind: 'tool-calls' }).code, 'TOOL_CALLS');
    assert.equal(classifyFinish({ kind: 'tool-calls' }).retryable, false);

    // error 的可重试性由 failure.code 决定，不是一律重试
    assert.equal(classifyFinish({ kind: 'error', failure: { code: 'RATE_LIMIT' } }).retryable, true);
    assert.equal(classifyFinish({ kind: 'error', failure: { code: 'AUTH' } }).retryable, false);
    assert.equal(classifyFinish({ kind: 'error', failure: { code: 'AUTH' } }).message, '模型服务返回错误');
    assert.equal(classifyFinish({ kind: 'error', failure: { message: '明细', code: 'AUTH' } }).message, '明细');
    assert.equal(classifyFinish({ kind: '什么鬼' }).code, 'UNKNOWN_FINISH');
});

test('engine: retryDelayMs 指数退避、带抖动、封顶', () => {
    assert.equal(retryDelayMs(1, { rand: () => 0 }), 200, 'base 400 的一半是下界');
    assert.equal(retryDelayMs(1, { rand: () => 1 }), 400);
    assert.equal(retryDelayMs(2, { rand: () => 1 }), 800);
    assert.ok(retryDelayMs(20, { rand: () => 1 }) <= 6000, '必须封顶，否则重试间隔会失控');
    assert.ok(retryDelayMs(1, { rand: () => 0.5 }) > retryDelayMs(1, { rand: () => 0 }));
});

test('engine: buildUserMessage 带插件归因（消息级 source）', () => {
    const m = buildUserMessage('正文', 'my-plugin');
    assert.equal(m.role, 'user');
    assert.equal(m.content[0].type, 'text');
    assert.equal(m.content[0].text, '正文');
    assert.deepEqual(m.source, { kind: 'plugin', plugin: 'my-plugin' });
    assert.equal(typeof m.id, 'string');
    assert.notEqual(buildUserMessage('a').id, buildUserMessage('b').id, 'id 必须唯一，否则宿主会判重复消息');
});

test('engine: StreamCollector 只拼正文块，推理块与工具调用分开计数', () => {
    const c = new StreamCollector();
    c.push({ type: 'block-start', index: 0, blockType: 'text' });
    c.push({ type: 'text-delta', index: 0, text: '正文' });
    c.push({ type: 'reasoning-delta', index: 1, text: '内心戏' });
    c.push({ type: 'text-delta', index: 2, text: '后续' });
    c.push({ type: 'tool-call-delta', index: 3, id: 'x', argumentsDelta: '{}' });
    c.push({ type: 'usage', usage: { inputTokens: 1, outputTokens: 2 } });
    c.push({ type: 'finish', reason: { kind: 'stop' } });
    assert.equal(c.text, '正文后续');
    assert.equal(c.reasoning, '内心戏');
    assert.equal(c.toolCallCount, 1);
    assert.equal(c.usage.outputTokens, 2);
    assert.equal(c.finish.kind, 'stop');

    // 流没给 finish 时按 stop 兜底（对齐宿主 BlockAssembler）
    assert.equal(new StreamCollector().finish.kind, 'stop');
    // 脏 chunk 不许把收集器打崩
    const dirty = new StreamCollector();
    dirty.push(null); dirty.push(42); dirty.push({ type: '未知' });
    assert.equal(dirty.text, '');
});

test('engine: deadline 超时以 code 中断，可释放；超上限直接拒绝', async () => {
    const d = deadline(undefined, 10, 'MY_TIMEOUT');
    assert.equal(d.signal.aborted, false);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(d.signal.aborted, true);
    assert.equal(d.signal.reason.code, 'MY_TIMEOUT', '要能分清「用户取消」与「超时」');
    d.dispose();
    assert.throws(() => deadline(undefined, MAX_TIMER_DELAY_MS + 1, 'X'), /不能超过/);
    const off = deadline(undefined, 0, 'X');
    assert.equal(off.signal.aborted, false);
});

test('engine: describeEngineError 给人话（面板要能直接展示）', () => {
    assert.equal(describeEngineError({ code: 'AUTH', message: 'x' }).message, '凭证无效');
    assert.match(describeEngineError({ code: 'AUTH', message: 'x' }).advice, /key|登录/);
    const unknown = describeEngineError({ code: 'WEIRD', message: '原始信息' });
    assert.equal(unknown.code, 'WEIRD');
    assert.equal(unknown.message, '原始信息');
});

// ── D1：引擎行为（假 llm）──────────────────────────────────────────────────

test('engine: 默认继承会话路由，通道可覆写；带 sessionId 的归因默认关闭', async () => {
    const llm = fakeLlm(textChunks('结果'));
    const engine = createEngine({
        ctx: ctxWith(llm),
        config: { engine: { channels: { polish: { provider: 'cheap', model: 'cheap-model', maxTokens: 100 } } } },
        sleep: noSleep,
    });
    assert.equal(engine.isAvailable(), true);

    assert.deepEqual(engine.routeFor('polish'), { provider: 'cheap', model: 'cheap-model', source: 'channel' });
    assert.deepEqual(engine.routeFor('draft'), { provider: 'test-provider', model: 'test-model', source: 'default' });
    assert.equal(engine.budgetFor('polish').maxTokens, 100);
    assert.equal(engine.budgetFor('polish').timeoutMs, CHANNEL_DEFAULTS.polish.timeoutMs);
    assert.equal(engine.budgetFor('draft').retries, DEFAULT_RETRIES);

    await engine.run('draft', { system: 's', prompt: 'p' });
    assert.equal(llm.last.provider, 'test-provider');
    assert.equal(llm.last.sessionId, undefined, '默认不带 sessionId——正是为了不污染会话历史');

    const attributed = createEngine({ ctx: ctxWith(llm), config: { engine: { attachSession: true } }, sleep: noSleep });
    await attributed.run('draft', { prompt: 'p', sessionId: 'sess-1' });
    assert.equal(llm.last.sessionId, 'sess-1');
});

test('engine: 无宿主 llm / 无路由 / 预先取消 各自返回可读错误，不抛', async () => {
    const noHost = createEngine({ ctx: {}, config: {} });
    const r1 = await noHost.run('polish', {});
    assert.equal(r1.ok, false);
    assert.equal(r1.error.code, 'ENGINE_UNAVAILABLE');
    assert.equal(noHost.isAvailable(), false);
    assert.match(noHost.unavailableReason(), /模型服务/);

    const noRoute = createEngine({ ctx: { llm: fakeLlm([]) }, config: {}, sleep: noSleep });
    assert.equal((await noRoute.run('polish', {})).error.code, 'NO_ROUTE');

    const ac = new AbortController();
    ac.abort();
    const llm = fakeLlm(textChunks('x'));
    const engine = createEngine({ ctx: ctxWith(llm), config: {}, sleep: noSleep });
    const r2 = await engine.run('polish', { signal: ac.signal });
    assert.equal(r2.error.code, 'ABORTED');
    assert.equal(llm.count, 0, '已经取消就别再发请求');

    const unknown = await engine.run('不存在的通道', {});
    assert.equal(unknown.error.code, 'UNKNOWN_CHANNEL');
});

test('engine: cordis 风格 ctx——未注册服务的属性访问会抛，装配与调用都不得炸（0.13.1 真机事故回归）', async () => {
    // 真机 cordis 的 ctx 是 proxy：访问未注册（未进 fiber store）的属性**直接 throw**。
    // boot 时宿主服务大多还没注册 → 装配期探测 isAvailable() 曾把整个 boot 炸掉
    // （"cannot get property 'llm' without inject"）。修法：readService 全程捕获。
    const throwingCtx = new Proxy({}, {
        get(_t, prop) {
            if (prop === 'logger') return { info() {}, warn() {} }; // logger 由宿主 mixin，已注册
            throw new Error(`cannot get property "${String(prop)}" without inject`);
        },
    });
    const engine = createEngine({ ctx: throwingCtx, config: {}, sleep: noSleep });
    assert.equal(engine.isAvailable(), false, '装配期 llm 未注册 → 不可用，但不抛');
    assert.match(engine.unavailableReason(), /模型服务/);
    const r = await engine.run('polish', { prompt: 'p' });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'ENGINE_UNAVAILABLE', '拿不到服务给可读错误，不是异常');
});

test('engine: 重试策略——限流退避重试、鉴权不重试、空输出算失败', async () => {
    const rate = fakeLlm([], { fail: Object.assign(new Error('429'), { code: 'RATE_LIMIT' }) });
    const e1 = createEngine({ ctx: ctxWith(rate), config: { engine: { retries: 2 } }, sleep: noSleep });
    const r1 = await e1.run('polish', {});
    assert.equal(r1.ok, false);
    assert.equal(r1.error.code, 'RATE_LIMIT');
    assert.equal(rate.count, 3, '1 次首发 + 2 次重试');

    const auth = fakeLlm([], { fail: Object.assign(new Error('bad key'), { code: 'AUTH' }) });
    const e2 = createEngine({ ctx: ctxWith(auth), config: {}, sleep: noSleep });
    assert.equal((await e2.run('polish', {})).error.code, 'AUTH');
    assert.equal(auth.count, 1, '鉴权失败重试无意义');

    const empty = fakeLlm(textChunks(''));
    const e3 = createEngine({ ctx: ctxWith(empty), config: { engine: { retries: 1 } }, sleep: noSleep });
    assert.equal((await e3.run('polish', {})).error.code, 'EMPTY_RESPONSE');
    assert.equal(empty.count, 2);

    const cut = fakeLlm(textChunks('半截', { kind: 'max-tokens' }));
    const e4 = createEngine({ ctx: ctxWith(cut), config: {}, sleep: noSleep });
    const r4 = await e4.run('polish', {});
    assert.equal(r4.error.code, 'TRUNCATED');
    assert.equal(cut.count, 1, '截断重试也会截断——一次就够，交回调用方拆批');
});

test('engine: 超时真的中断（不理会 signal 的适配器也拖不住我们）', async () => {
    const stubborn = {
        stream: () => (async function* () {
            await new Promise((r) => setTimeout(r, 400));
            yield { type: 'finish', reason: { kind: 'stop' } };
        })(),
    };
    const engine = createEngine({ ctx: ctxWith(stubborn), config: { engine: { retries: 0 } }, sleep: noSleep });
    const t0 = Date.now();
    const r = await engine.run('polish', { timeoutMs: 40 });
    const spent = Date.now() - t0;
    assert.equal(r.error.code, 'ENGINE_TIMEOUT');
    assert.ok(spent < 250, `应当在超时后立刻返回，实际花了 ${spent}ms`);
});

// ── D1：内部工序（润色/校对/打标）────────────────────────────────────────

test('engine-tasks: extractChapterText 只做保守清理（围栏 + 短前言）', () => {
    assert.equal(extractChapterText('```markdown\n第一段。\n第二段。\n```'), '第一段。\n第二段。');
    assert.equal(extractChapterText('以下是润色后的正文：\n\n第一段。'), '第一段。');
    assert.equal(extractChapterText('第一段。\n\n第二段。'), '第一段。\n\n第二段。');
    assert.equal(extractChapterText(''), '');
    // 多围栏时取最长的那块（模型偶尔会先给一小段示例）
    assert.equal(extractChapterText('```\n短\n```\n```\n长得多的正文内容在这里\n```'), '长得多的正文内容在这里');
});

test('engine-tasks: parseTags 清洗编号与标点、去重、限量', () => {
    assert.deepEqual(parseTags('飞刀 雪夜 码头'), ['飞刀', '雪夜', '码头']);
    assert.deepEqual(parseTags('1. 飞刀，2. 雪夜、3. 码头'), ['飞刀', '雪夜', '码头']);
    assert.deepEqual(parseTags('飞刀 飞刀 雪夜'), ['飞刀', '雪夜']);
    assert.equal(parseTags('飞刀 雪夜 码头 义庄 白事 灯笼 供桌').length, 5, '最多 5 个');
    assert.deepEqual(parseTags('一 俩'), [], '单字标签没有检索价值');
});

test('engine-tasks: 提示词带病灶与禁项；校对档守卫比润色档严', () => {
    const p = buildPolishPrompt({
        chapter: 7, title: '雪夜',
        content: '原文。',
        issues: [{ paragraph: 2, chars: 260, aiScore: 55, issues: ['段落过长（260 字）'] }],
        forbidden: ['香炉', '陆寒'],
    });
    assert.match(p, /第 7 章/);
    assert.match(p, /¶2/);
    assert.match(p, /段落过长/);
    assert.match(p, /本章禁项/);
    assert.match(p, /香炉/);
    assert.match(p, /原文。/);

    const q = buildProofreadPrompt({ chapter: 1, title: 'T', content: '正文' });
    assert.match(q, /正文/);
    assert.doesNotMatch(q, /病灶/);

    assert.ok(GUARD_PROFILES.proofread.growthLimit < GUARD_PROFILES.polish.growthLimit, '校对不该让篇幅涨');
    assert.ok(GUARD_PROFILES.proofread.minSim > GUARD_PROFILES.polish.minSim, '校对的「同源」要求更严');
    assert.match(POLISH_SYSTEM, /标题原样保留/);
    assert.match(PROOFREAD_SYSTEM, /不许改动句式/);
});

test('engine-tasks: 润色端到端落提案；改标题被保守守卫拦下（不落提案）', async () => {
    const original = '第一章 雪夜\n\n她坐在灯下，把刀横在膝上，听着外面的橹声一遍遍地响，像是有人在水里走路。';
    const book = '引擎测试书';
    const io = memIo({
        [`${book}/novel.json`]: JSON.stringify({ title: book, chapters: { 1: { title: '雪夜', version: 1, path: `${book}/正文/第1章-雪夜-v1.md`, latest: 1, files: [{ file: `${book}/正文/第1章-雪夜-v1.md`, version: 1 }] } }, proposals: [] }),
        [`${book}/正文/第1章-雪夜-v1.md`]: original,
    });

    // ① 正常润色 → 出提案
    const engine = createEngine({
        ctx: ctxWith(fakeLlm(textChunks('第一章 雪夜\n\n她坐在灯下，把刀横在膝上，听外面橹声一遍遍地响，像有人在水中走路。'))),
        config: {}, sleep: noSleep,
    });
    const ok = await runRevisionTask(engine, io, book, { mode: 'polish', chapter: 1, title: '雪夜', content: original });
    assert.equal(ok.ok, true);
    assert.match(ok.proposalId, /^P1-/);
    assert.equal(ok.mode, 'polish');
    assert.ok(io.files.has(`${book}/.novel/proposals/${ok.proposalId}.json`), '提案必须落盘');
    const novel = JSON.parse(io.files.get(`${book}/novel.json`));
    assert.equal(novel.proposals.length, 1);
    assert.equal(novel.proposals[0].status, 'pending');
    assert.equal(io.files.get(`${book}/正文/第1章-雪夜-v1.md`), original, '引擎永远不许改正文');

    // ② 模型把标题改了 → 守卫拦下，不落提案
    const bad = createEngine({
        ctx: ctxWith(fakeLlm(textChunks('第一章 雪夜（润色版）\n\n她坐在灯下，把刀横在膝上。'))),
        config: {}, sleep: noSleep,
    });
    const blocked = await runRevisionTask(bad, io, book, { mode: 'proofread', chapter: 1, title: '雪夜', content: original });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.error.code, 'GUARD_BLOCKED');
    assert.ok(blocked.blocked.some((b) => b.code === 'heading-changed'));
    assert.equal(JSON.parse(io.files.get(`${book}/novel.json`)).proposals.length, 1, '被拦下就不该多出提案');

    // ③ 引擎失败 → 人话错误，不抛
    const down = createEngine({ ctx: {}, config: {} });
    const failed = await runRevisionTask(down, io, book, { mode: 'polish', chapter: 1, title: '雪夜', content: original });
    assert.equal(failed.ok, false);
    assert.equal(failed.error.code, 'ENGINE_UNAVAILABLE');
});

test('engine-tasks: 打标产出标签；模型不给标签时报错而不是塞空标签', async () => {
    const engine = createEngine({ ctx: ctxWith(fakeLlm(textChunks('码头 斗笠 雪夜 送别'))), config: {}, sleep: noSleep });
    const ok = await runAnnotateTask(engine, '他戴着斗笠站在码头。');
    assert.equal(ok.ok, true);
    assert.ok(ok.tags.includes('斗笠'));

    const silent = createEngine({ ctx: ctxWith(fakeLlm(textChunks('   '))), config: {}, sleep: noSleep });
    const r = await runAnnotateTask(silent, '正文');
    assert.equal(r.ok, false);
});

// ── G1：检索纯函数 ─────────────────────────────────────────────────────────

test('retrieval: bigrams 中文二元切分；ftsQuery 加引号防注入语法', () => {
    assert.deepEqual(bigrams('斗笠人'), ['斗笠', '笠人']);
    assert.deepEqual(bigrams('a b'), ['ab'], '空白不参与切分');
    assert.deepEqual(bigrams('刀'), []);
    assert.equal(ftsQuery('斗笠'), '"斗笠"');
    // 空白不参与切分：'斗笠 码头' 的片段是 斗笠/笠码/码头（索引侧同样处理，因此查询侧一致）
    assert.equal(ftsQuery('斗笠 码头'), '"斗笠" OR "笠码" OR "码头"');
    assert.equal(ftsQuery('刀'), '"刀"', '单字查询退化为整词');
    assert.equal(ftsQuery(''), '');
    // 查询里的引号必须转义（FTS5 双引号内用 "" 表示字面引号），否则语法会炸
    const nasty = ftsQuery('a"b');
    assert.ok(nasty.includes('""'), '引号要转义');
    assert.ok(!/^"[^"]*"$/.test(nasty) || nasty.includes('""'));
    assert.equal(normalizeForIndex('  多   空格  '), '多 空格');
});

test('retrieval: chunkChapter 按段聚块、序号递增、指纹随标签变化', () => {
    const body = ['第一段内容。'.repeat(10), '第二段内容。'.repeat(10), '第三段内容。'.repeat(3)].join('\n\n');
    const chunks = chunkChapter(body, { chapter: 5, target: 60 });
    assert.ok(chunks.length >= 2, '超过目标字数要切块');
    assert.deepEqual(chunks.map((c) => c.seq), chunks.map((_, i) => i));
    assert.ok(chunks.every((c) => c.chapter === 5));
    assert.ok(chunks.every((c) => c.text.length > 0), '不该产出空块');
    assert.equal(chunkChapter('', { chapter: 1 }).length, 0);

    const plain = chunkChapter('同一段正文。', { chapter: 1 })[0];
    const tagged = chunkChapter('同一段正文。', { chapter: 1, tags: '飞刀 雪夜' })[0];
    assert.notEqual(plain.hash, tagged.hash, '标签变了指纹要变，否则增量索引会跳过它');
    assert.match(plain.hash, /^[0-9a-f]{16}$/);
    assert.equal(plain.hash, hashChunk(plain.text + '\u0000'), '指纹 = hash(正文\0标签)，标签空也要有分隔符');
});

test('retrieval: makeSnippet 定位命中；hitRatio 反映片段命中比例；parseChapterSpec 解析范围', () => {
    const text = '他戴着斗笠站在码头等人，雪落在斗笠上。';
    assert.match(makeSnippet(text, '斗笠', { width: 10 }), /斗笠/);
    assert.equal(makeSnippet(text, '不存在', { width: 6 }), text.slice(0, 6), '没命中就退回开头片段');
    assert.equal(hitRatio('他戴着斗笠站在码头', '斗笠'), 1);
    assert.equal(hitRatio('完全无关的内容', '斗笠'), 0);
    assert.ok(hitRatio('戴斗笠的人', '戴斗笠的人') === 1);

    assert.deepEqual(parseChapterSpec('1-3', [1, 2, 3, 4]), [1, 2, 3]);
    assert.deepEqual(parseChapterSpec('3,5,7', [1, 2, 3, 4, 5, 6, 7]), [3, 5, 7]);
    assert.deepEqual(parseChapterSpec('3-', [1, 2, 3, 4, 5]), [3, 4, 5], '开口区间到最后一章');
    assert.deepEqual(parseChapterSpec('6-9', [1, 2, 3]), [], '不存在的章要滤掉');
    assert.equal(parseChapterSpec('', [1]), null, 'null = 全部');
    assert.equal(INDEX_RELATIVE, '.novel/index.db', '索引跟书走，删书即删索引');
});

// ── D2：批量起草 ───────────────────────────────────────────────────────────

test('batch-draft: planDraftBatch 逐类拦截（已写/无细纲/未批/熔断）且 force 可放行', () => {
    const novel = {
        chapters: { 1: { path: 'x', title: 't' } },
        approvals: { outline: { 2: true, 3: true } },
        gateFailures: { 4: 3 },
    };
    const plan = planDraftBatch({ novel, from: 1, count: 4, availableOutlines: [1, 2, 3, 4], approvedOutlines: [2, 3, 4] });
    const byChapter = Object.fromEntries(plan.items.map((i) => [i.chapter, i]));
    assert.match(byChapter[1].reason, /已有正文/);
    assert.equal(byChapter[2].blocked, false);
    assert.equal(byChapter[3].blocked, false);
    assert.match(byChapter[4].reason, /熔断/);
    assert.deepEqual(plan.ready, [2, 3]);
    assert.equal(plan.blocked.length, 2);

    // 细纲缺失
    const p2 = planDraftBatch({ novel, from: 5, count: 1, availableOutlines: [], approvedOutlines: [] });
    assert.match(p2.items[0].reason, /细纲不存在/);

    // 未批准
    const p3 = planDraftBatch({ novel: { chapters: {}, approvals: { outline: {} }, gateFailures: {} }, from: 2, count: 1, availableOutlines: [2], approvedOutlines: [] });
    assert.match(p3.items[0].reason, /未批准/);

    // force 放行未批准与熔断（但「已有正文」永远不放行——那是修订，走提案）
    const p4 = planDraftBatch({
        novel, from: 1, count: 4, availableOutlines: [1, 2, 3, 4], approvedOutlines: [], force: true,
    });
    assert.equal(p4.items.find((i) => i.chapter === 1).blocked, true);
    assert.equal(p4.items.find((i) => i.chapter === 4).blocked, false);
    assert.deepEqual(p4.ready, [2, 3, 4]);

    // 章号不连续要提醒（衔接只能靠细纲）
    const p5 = planDraftBatch({ novel: { chapters: {}, approvals: { outline: { 1: true, 3: true } }, gateFailures: {} }, from: 1, count: 3, availableOutlines: [1, 3], approvedOutlines: [1, 3] });
    assert.deepEqual(p5.ready, [1, 3]);
    assert.ok(p5.warnings.some((w) => w.includes('不连续')));
});

test('batch-draft: deriveTitleSummary 从细纲取标题与梗概', () => {
    const a = deriveTitleSummary('# 第3章 雪夜的来客\n\n- 码头相遇：她在雾里认出义庄的暗号。', 3);
    assert.equal(a.title, '第3章 雪夜的来客');
    assert.match(a.summary, /码头相遇/);

    const b = deriveTitleSummary('第 5 章 空棺\n\n供桌下有张湿透的纸。', 5);
    assert.equal(b.title, '第 5 章 空棺');

    const c = deriveTitleSummary('', 9);
    assert.equal(c.title, '第 9 章');
    assert.match(c.summary, /细纲未提供梗概/);
});

test('batch-draft: mapWithConcurrency 保序、限并发、可取消', async () => {
    let inFlight = 0;
    let peak = 0;
    const items = [1, 2, 3, 4, 5, 6];
    const out = await mapWithConcurrency(items, 2, async (n) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        return n * 10;
    });
    assert.deepEqual(out, [10, 20, 30, 40, 50, 60], '结果必须与输入同序（提交阶段要靠这个顺序）');
    assert.ok(peak <= 2, `并发不得超过上限，实际峰值 ${peak}`);

    // 单个失败不影响其它项
    const mixed = await mapWithConcurrency([1, 2, 3], 3, async (n) => {
        if (n === 2) throw new Error('boom');
        return n;
    }).catch(() => 'threw');
    assert.equal(mixed, 'threw', 'mapWithConcurrency 本身不吞异常（吞异常是调用方的责任）');

    // 取消：不再启动新任务
    const ac = new AbortController();
    const started = [];
    const r = await mapWithConcurrency([1, 2, 3, 4, 5], 1, async (n) => {
        started.push(n);
        if (n === 2) ac.abort();
        return n;
    }, { signal: ac.signal });
    assert.deepEqual(started, [1, 2]);
    assert.equal(r[4], undefined);
});

test('batch-draft: runDraftBatch 并发生成、串行提交；失败不整批回滚', async () => {
    const book = '批量测试书';
    const files = {
        [`${book}/novel.json`]: JSON.stringify({
            title: book, genre: '仙侠', logline: '', stage: 'chapter', phases: {},
            approvals: { outline: { 1: true, 2: true, 3: true } },
            chapters: {}, cast: [], proposals: [], gateFailures: {},
        }),
        // 场景契约在场才会放开并发（D2 的上下文预算刹车）——这里给足三章
        [`${book}/设定/场景契约.json`]: JSON.stringify({
            1: { scene: '码头', participants: [], hidden: [], settings: [], forbidden: [], notes: '' },
            2: { scene: '义庄', participants: [], hidden: [], settings: [], forbidden: [], notes: '' },
            3: { scene: '供桌', participants: [], hidden: [], settings: [], forbidden: [], notes: '' },
        }),
        [`${book}/大纲/细纲/第1章.md`]: '# 第1章 雪夜\n\n- 码头相遇：她在雾里认出暗号。',
        [`${book}/大纲/细纲/第2章.md`]: '# 第2章 斗笠\n\n- 摘斗笠：露出被火燎过的脸。',
        [`${book}/大纲/细纲/第3章.md`]: '# 第3章 湿纸\n\n- 供桌下：半张纸只剩一个寒字。',
    };
    const io = memIo(files);
    const p = pathsFor(book);

    /** 假引擎：按提示词里的章号回不同正文；第 3 章故意回占位符（会被内容门禁拦下）。 */
    const generation = [];
    let inFlight = 0; let peak = 0;
    const engine = {
        async run(channel, { prompt }) {
            assert.equal(channel, 'draft', '批量起草走 draft 通道');
            const n = Number(prompt.match(/【第 (\d+) 章/)[1]);
            generation.push(n);
            inFlight += 1;
            peak = Math.max(peak, inFlight);
            await new Promise((r) => setTimeout(r, 8));
            inFlight -= 1;
            return {
                ok: true, finishKind: 'stop', attempts: 1,
                route: { provider: 'p', model: 'm', source: 'default' },
                text: CHAPTER_TEXTS[n],
            };
        },
    };

    const novel = JSON.parse(files[`${book}/novel.json`]);
    const result = await runDraftBatch({
        engine, config: TEST_CFG, io, p, book, novel, from: 1, count: 3, concurrency: 2,
    });

    // ① 并发确实发生了（2 章同时在飞）
    assert.equal(result.concurrency, 2);
    assert.ok(peak >= 2, `并发生成没生效，峰值 ${peak}`);
    assert.deepEqual([...generation].sort(), [1, 2, 3]);

    // ② 1、2 章落盘，第 3 章被内容门禁拦下 —— 失败不整批回滚
    assert.equal(result.stats.planned, 3);
    assert.equal(result.stats.committed, 2);
    assert.equal(result.stats.failed, 1);
    const ch3 = result.results.find((r) => r.chapter === 3);
    assert.equal(ch3.ok, false);
    assert.equal(ch3.stage, 'commit', '是在提交阶段被硬约束拦下的，不是生成失败');
    assert.match(ch3.reason, /内容门禁|占位/);

    // ③ 章节文件与索引真的落盘了，标题来自细纲
    const saved = JSON.parse(io.files.get(`${book}/novel.json`));
    assert.equal(Object.keys(saved.chapters).sort().join(','), '1,2');
    assert.equal(saved.chapters['1'].title, '第1章 雪夜');
    assert.equal(saved.chapters['1'].summary, '码头相遇：她在雾里认出暗号。');
    assert.ok(io.files.has(saved.chapters['1'].path), '正文文件必须存在');
    assert.ok(result.results.find((r) => r.chapter === 1).path.includes('第1章'));

    // ④ 提交是串行的：第 2 章的重复检测能看见第 1 章（并发生成不代表并发落账）
    assert.equal(saved.chapters['2'].chars, CHAPTER_TEXTS[2].replace(/\s/g, '').length);
    assert.equal(saved.stage, 'writing', '写章顺带推进阶段');

    // ⑤ 每一章都留了审计
    const auditText = io.files.get(`${book}/.novel/audit.jsonl`) ?? '';
    assert.match(auditText, /write_chapter\/saved/);
});

test('batch-draft: 没有场景契约时把并发压回 1（上下文预算 ×N 的刹车）', async () => {
    const book = '无契约书';
    const files = {
        [`${book}/novel.json`]: JSON.stringify({
            title: book, stage: 'chapter', phases: {},
            approvals: { outline: { 1: true, 2: true } },
            chapters: {}, cast: [], proposals: [], gateFailures: {},
        }),
        [`${book}/大纲/细纲/第1章.md`]: '# 第1章\n\n- 场景一。',
        [`${book}/大纲/细纲/第2章.md`]: '# 第2章\n\n- 场景二。',
    };
    const io = memIo(files);
    const engine = {
        async run(_c, { prompt }) {
            const n = Number(prompt.match(/【第 (\d+) 章/)[1]);
            return { ok: true, finishKind: 'stop', attempts: 1, route: { provider: 'p', model: 'm', source: 'default' }, text: CHAPTER_TEXTS[n] };
        },
    };
    const result = await runDraftBatch({
        engine, config: TEST_CFG, io, p: pathsFor(book), book,
        novel: JSON.parse(files[`${book}/novel.json`]), from: 1, count: 2, concurrency: 4,
    });
    assert.equal(result.concurrency, 1, '没有场景契约就不许提速');
    assert.ok(result.warnings.some((w) => w.includes('并发降到 1')));

    // 有契约的章节数足够时才放开
    const withContracts = memIo({
        ...files,
        [`${book}/设定/场景契约.json`]: JSON.stringify({
            1: { scene: '码头', participants: [], hidden: [], settings: [], forbidden: [], notes: '' },
            2: { scene: '义庄', participants: [], hidden: [], settings: [], forbidden: [], notes: '' },
        }),
    });
    const faster = await runDraftBatch({
        engine, config: TEST_CFG, io: withContracts, p: pathsFor(book), book,
        novel: JSON.parse(files[`${book}/novel.json`]), from: 1, count: 2, concurrency: 2,
    });
    assert.equal(faster.concurrency, 2, '有契约就该按用户要的并发跑');
    assert.ok(faster.stats.committed === 2);
});
