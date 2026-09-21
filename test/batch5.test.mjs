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
import { updateJson, isVersionConflict } from '../lib/fsio.js';

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
        // ↓ 与 lib/fsio.js 的两个适配器同名同义：版本来自读的那一刻，写时不符即冲突。
        //   替身必须镜像真机，否则 updateJson 的重放路径压根测不到。
        async readTextWithVersion(p) {
            return files.has(p) ? { text: files.get(p), version: String(files.get(p)).length } : { text: null, version: null };
        },
        async readJsonWithVersion(p) {
            const { text, version } = await api.readTextWithVersion(p);
            return { value: text === null ? null : JSON.parse(text), version };
        },
        async writeTextAtVersion(p, text, version) {
            if (version === null || version === undefined) return api.writeText(p, text, 'create');
            if (!files.has(p) || String(files.get(p)).length !== version) {
                const error = new Error(`FS_STALE_VERSION: ${p}（期望 ${version}，实际 ${files.has(p) ? String(files.get(p)).length : '不存在'}）`);
                error.code = 'FS_STALE_VERSION';
                throw error;
            }
            files.set(p, text);
            return { version: String(text).length };
        },
        async writeJsonAtVersion(p, value, version) {
            return api.writeTextAtVersion(p, `${JSON.stringify(value, null, 2)}\n`, version);
        },
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

test('engine-tasks: extractChapterText 健全性闸——无围栏的原始模型输出（英文推理链+正文）绝不当正文入库（真机 2026-09-21 P1 实锤）', () => {
    const original = '雨是酉时下起来的。先细，后密。沈十六挑着油担走西三街。'.repeat(60); // ~2000 中文字
    // 真机事故形状：英文推理开头 + 中文正文混在 59KB 原始输出里，无围栏
    const blob = 'Let me analyze this task carefully. I am asked to rewrite Chapter 1 of a Chinese novel. '
        + 'The task is a revision/editing task with a specific list of issues to address.\n\n'
        + (original + '\n\n').repeat(8); // 8 倍长度、中文占比被英文稀释
    assert.equal(extractChapterText(blob, original), '', '长度超 3 倍 + 中文占比 <50% 必须判抽取失败，返回空串走 EMPTY_AFTER_EXTRACT');
    // 单独命中任一条也拦
    const mostlyEnglish = 'x'.repeat(6000) + '一点中文。';
    assert.equal(extractChapterText(mostlyEnglish, original), '', '中文占比过低的原始输出不得入库');
    // 合法形态不受影响：无围栏的纯中文整章输出（≤3 倍长度）照旧放行
    const plain = '这是没有围栏的纯中文润色结果，模型直接给了正文。' + original;
    assert.equal(extractChapterText(plain, original), plain, '合法无围栏输出必须原样放行（fallback 是给干净输出用的）');
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

// ── 0.13.1 补六：web profile 模型传输（llm 不在根 fiber → subagents 备用通道）────────

/** 活父 agent 替身：宿主 start 请求的 parent 必填（agent id 与 session id 同源）。 */
const fakeParent = (id = 'sess-1') => ({ id, options: {}, session: { header: {} } });
const fakeAgents = (parent) => ({ get: (id) => (id === parent.id ? parent : undefined) });

test('engine: 无 ctx.llm 时经 subagents 跑通——web profile 主路径（真机 ctx.llm 解析不到）', async () => {
    const calls = [];
    const subagents = {
        start(provider, opts) {
            calls.push({ provider, opts });
            return { result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: '润色后的正文' }] }) };
        },
    };
    const parent = fakeParent();
    const engine = createEngine({
        ctx: { subagents, agents: fakeAgents(parent), agentDefaultModel: { provider: 'p1', model: 'm1' } },
        config: {}, sleep: noSleep,
    });
    assert.equal(engine.isAvailable(), true, 'subagents 可用即视为具备模型能力');
    const r = await engine.run('polish', { system: '系统提示', prompt: '正文', sessionId: parent.id });
    assert.equal(r.ok, true);
    assert.equal(r.text, '润色后的正文');
    assert.equal(r.finishKind, 'stop');
    assert.deepEqual(r.route, { provider: 'p1', model: 'm1', source: 'default' }, 'agentDefaultModel 继承路由来源如实标 default');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].provider, 'spawn', 'mnemon 同款 spawn provider');
    assert.equal(calls[0].opts.parent, parent, 'parent 必填（缺了宿主 resolveChildDepth 直接 TypeError 炸进程）');
    assert.equal(calls[0].opts.persona, '系统提示', 'system 走 persona');
    // 0.13.2 第三轮：默认不设限（tokenCap=0 → agentOptions 不带 maxTokens，继承宿主默认）
    assert.deepEqual(calls[0].opts.agentOptions, { provider: 'p1', model: 'm1' });
    assert.ok(!('maxTokens' in calls[0].opts.agentOptions), '不设限时不该传 maxTokens');
    assert.deepEqual(calls[0].opts.toolFilter, { allow: [] }, '纯文本任务不带工具');
});

test('engine: 显式配置 channels.polish.maxTokens=0 也走继承宿主默认（0=不设限），不回落 base 值', async () => {
    // 旧 budgetFor 的 positive(0, base) 会把 0 误规约回 base.maxTokens(8192)——
    // 用户显式写 0 想「继承宿主」却仍被套上限。新逻辑 capOf 保持 0 → agentOptions
    // 不带 maxTokens。覆盖「默认分支」之外的这条显式配置分支。
    const calls = [];
    const subagents = {
        start(_p, opts) { calls.push(opts); return { result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'ok' }] }) }; },
    };
    const parent = fakeParent();
    const engine = createEngine({
        ctx: { subagents, agents: fakeAgents(parent) },
        config: { engine: { channels: { polish: { maxTokens: 0 } } } },
        sleep: noSleep,
    });
    const r = await engine.run('polish', { prompt: '正文', sessionId: parent.id });
    assert.equal(r.ok, true);
    assert.ok(!('maxTokens' in calls[0].agentOptions), '显式 0 → 继承宿主默认，agentOptions 不带 maxTokens');
});

test('engine: 子代理 stopReason 非 completed / 空内容 / output 字符串形态 → 各自可读结果', async () => {
    const parent = fakeParent();
    const mk = (start) => createEngine({
        ctx: { subagents: { start }, agents: fakeAgents(parent) },
        config: {}, sleep: noSleep,
    });
    const fail = mk(() => ({ result: Promise.resolve({ stopReason: 'error' }) }));
    const r = await fail.run('proofread', { prompt: 'x', sessionId: parent.id });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'SUBAGENT_FAILED');
    // 无 agentDefaultModel：路由继承，不报 NO_ROUTE（直连路径才要求显式路由）
    assert.deepEqual(r.route, { provider: '(inherited)', model: '(inherited)', source: 'subagent' });

    const empty = mk(() => ({ result: Promise.resolve({ stopReason: 'completed', output: [] }) }));
    const r2 = await empty.run('polish', { prompt: 'x', sessionId: parent.id });
    assert.equal(r2.ok, false);
    assert.equal(r2.error.code, 'EMPTY_RESPONSE');

    // output 直接给字符串（API 变形防御）
    const str = mk(() => ({ result: Promise.resolve({ stopReason: 'completed', output: '字符串形态' }) }));
    const r3 = await str.run('polish', { prompt: 'x', sessionId: parent.id });
    assert.equal(r3.ok, true);
    assert.equal(r3.text, '字符串形态');
});

test('engine: ★ start() 缺 parent 的历史病灶三连——不传 session / 会话无活 agent / start 被拒 → 全部结构化失败，绝不炸进程', async () => {
    // 0.13.2 真机事故回归：start 返回 rejected promise 且调用方不 await →
    // unhandled rejection 把整个 dsh web 进程打挂（"fatal load failure"）。
    const parent = fakeParent();
    const boom = createEngine({
        ctx: {
            subagents: { start: () => Promise.reject(new TypeError("Cannot read properties of undefined (reading 'options'))")) },
            agents: fakeAgents(parent),
        },
        config: {}, sleep: noSleep,
    });
    const r = await boom.run('polish', { prompt: 'x', sessionId: parent.id });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'ENGINE_FAILURE', 'start 的 rejection 必须被收编成结构化失败');

    // 没穿 sessionId（旧客户端/旧端点）→ 人话指引，不碰 start
    let touched = false;
    const noSession = createEngine({
        ctx: { subagents: { start: () => { touched = true; return { result: Promise.resolve({ stopReason: 'completed', output: [] }) }; } }, agents: fakeAgents(parent) },
        config: {}, sleep: noSleep,
    });
    const r2 = await noSession.run('polish', { prompt: 'x' });
    assert.equal(r2.ok, false);
    assert.equal(r2.error.code, 'NO_PARENT_AGENT');
    assert.equal(touched, false, '拿不到父 agent 就不该发起 start');

    // 会话没有活 agent（历史会话已关）→ 同样 NO_PARENT_AGENT
    const deadSession = createEngine({
        ctx: { subagents: { start: () => { touched = true; return { result: Promise.resolve({ stopReason: 'completed', output: [] }) }; } }, agents: { get: () => undefined } },
        config: {}, sleep: noSleep,
    });
    const r3 = await deadSession.run('polish', { prompt: 'x', sessionId: 'gone' });
    assert.equal(r3.ok, false);
    assert.equal(r3.error.code, 'NO_PARENT_AGENT');
    assert.equal(touched, false);
});

test('engine: subagents 只能经 ctx.get() 解析时也可用（cordis 作用域链形态，补六真机复诊）', async () => {
    // 真机复诊：novel-forge 未在顶层 inject 声明 subagents 时，cordis 不会把服务
    // 物化到插件 ctx 的 fiber store——属性访问落空，但作用域链 ctx.get() 仍能解析。
    // 探测必须双路都试，否则「服务在进程里存在（mnemon 能用）我却拿不到」。
    const calls = [];
    const subagents = {
        start(provider, opts) {
            calls.push({ provider, opts });
            return { result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: '校对结果' }] }) };
        },
    };
    const parent = fakeParent('sess-9');
    const ctx = new Proxy({}, {
        get(_t, prop) {
            if (prop === 'get') return (name) => (name === 'subagents' ? subagents : name === 'agents' ? fakeAgents(parent) : undefined);
            if (prop === 'agentDefaultModel') return { provider: 'p9', model: 'm9' };
            if (prop === 'logger') return { info() {}, warn() {} };
            return undefined;
        },
    });
    const engine = createEngine({ ctx, config: {}, sleep: noSleep });
    assert.equal(engine.isAvailable(), true, 'get() 能解析 subagents → 视为具备模型能力');
    const r = await engine.run('proofread', { prompt: '正文', sessionId: parent.id });
    assert.equal(r.ok, true);
    assert.equal(r.text, '校对结果');
    assert.equal(calls[0].provider, 'spawn');
    assert.equal(calls[0].opts.parent, parent, 'get() 解析到的 agents 服务同样要给出活父 agent');
    assert.equal(calls[0].opts.agentOptions.provider, 'p9', '继承路由照带给子代理');
});

test('engine: 无 sessionId 时回退 currentInitiator——会话内工具路径（打标/检索）不识字也能锚到父会话', async () => {
    const calls = [];
    const parent = fakeParent('live-agent');
    const subagents = {
        start(provider, opts) {
            calls.push({ provider, opts });
            return { result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: '标签' }] }) };
        },
    };
    const engine = createEngine({
        ctx: { subagents, agents: { get: () => undefined, currentInitiator: () => parent } },
        config: {}, sleep: noSleep,
    });
    const r = await engine.run('annotate', { prompt: '正文片段' });
    assert.equal(r.ok, true);
    assert.equal(calls[0].opts.parent, parent, '发起边界里的 agent 兜底当父');
});

test('plugin inject: 顶层必须声明 subagents（声明是 cordis 物化服务的唯一开关——漏声明 = 真机静默 ENGINE_UNAVAILABLE 且全测试仍绿）', async () => {
    const mod = await import('../lib/index.js');
    assert.ok(Array.isArray(mod.inject) && mod.inject.includes('subagents'),
        `inject = [${(mod.inject ?? []).join(', ')}]——缺 subagents 声明，润色/校对在 web profile 必挂`);
});

// ── parent 候选链（0.13.2 真机复诊升级）：显式会话没锚到 → 试书的归属会话
//    （创建它的会话 agent 大概率活着、工作区必然是书所在工作区）──

test('★ sessionIds 候选链：显式 sessionId 锚不到时，书的归属会话兜住 parent', async () => {
    const bookParent = fakeParent('session-book-owner');
    const started = [];
    const engine = createEngine({
        ctx: {
            subagents: { start: (p, opts) => { started.push(opts); return { result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: '校对稿' }] }) }; } },
            agents: fakeAgents(bookParent),
        },
        config: {}, sleep: noSleep,
    });
    // 面板传来的会话（slot 旧 id）在注册表里没有活 agent；书的归属会话有
    const r = await engine.run('proofread', { prompt: 'x', sessionId: 'session-slot-stale', sessionIds: ['session-book-owner'] });
    assert.equal(r.ok, true, '候选链第二个 id 应锚定成功');
    assert.equal(r.text, '校对稿');
    assert.equal(started.length, 1);
    assert.equal(started[0].parent, bookParent, 'parent 用的是书归属会话的活 agent');
});

test('★ 候选全空 + currentInitiator 无 → NO_PARENT_AGENT，报错列出试过的 id', async () => {
    const engine = createEngine({
        ctx: {
            subagents: { start: () => { throw new Error('不应 start'); } },
            agents: { get: () => undefined, currentInitiator: () => undefined },
        },
        config: {}, sleep: noSleep,
    });
    const r = await engine.run('polish', { prompt: 'x', sessionId: 'session-stale', sessionIds: ['session-dead'] });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'NO_PARENT_AGENT');
    assert.ok(r.error.message.includes('session-stale'), '报错要列出试过的 id 便于分清哪头丢的');
    assert.ok(r.error.message.includes('session-dead'));
});

// ── parent 解析等待重试（真机实锤：agent 注册表懒注册——重启后逐个出现、
//    会话关闭即消失。第一轮全落空等 2 秒再试，跨过注册窗口期）──

test('★ 第一轮锚不到、agent 随后注册出现 → 等待重试后锚定成功', async () => {
    const parent = fakeParent('session-late');
    let getCalls = 0;
    const waited = [];
    const engine = createEngine({
        ctx: {
            subagents: { start: (p, opts) => ({ result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: '成了' }] }) }) },
            agents: { get: (id) => { getCalls += 1; return getCalls >= 2 ? parent : undefined; } },
        },
        config: {}, sleep: (ms) => { waited.push(ms); return Promise.resolve(); },
    });
    const r = await engine.run('polish', { prompt: 'x', sessionId: 'session-late' });
    assert.equal(r.ok, true, '第二轮应锚定成功');
    assert.equal(r.text, '成了');
    assert.ok(waited.includes(2000), '重试前要等 PARENT_RETRY_DELAY_MS（实际等待：' + JSON.stringify(waited) + '）');
    assert.ok(getCalls >= 2, '至少解析两轮（实际 ' + getCalls + ' 次）');
});

// ── 0.13.2 补七：父 agent 按需物化（agents.resume 兜底）─────────────────────
// 真机复诊：孙宇测试会话存在，但其 agent 不在注册表（会话没开着就不驻留）——
// 只查 get 的候选链对「面板旁路调用」结构性不可用，必须能按需把会话 agent 拉起来。

test('engine: 候选会话未驻留时经 agents.resume 按需物化 parent——面板旁路的正路', async () => {
    const parent = fakeParent('sess-9');
    const resumeCalls = [];
    const agents = {
        get: () => undefined,
        resume: async (opts) => { resumeCalls.push(opts); return parent; },
    };
    let gotParent;
    const engine = createEngine({
        ctx: {
            subagents: { start: (_p, opts) => { gotParent = opts.parent; return { result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: '润色稿' }] }) }; } },
            agents,
            agentDefaultModel: { provider: 'p1', model: 'm1' },
        },
        config: {}, sleep: noSleep,
    });
    const r = await engine.run('polish', { prompt: '正文', sessionId: 'sess-9' });
    assert.equal(r.ok, true, 'resume 物化成功 → 调用放行');
    assert.equal(r.text, '润色稿');
    assert.deepEqual(resumeCalls[0], { resumeSessionId: 'sess-9' }, '按 resumeSessionId 拉起持久化会话');
    assert.equal(gotParent, parent, '物化出的 handle 直接当 parent');
});

test('engine: resume 故障（缺 persistence 等）回退 currentInitiator，不炸', async () => {
    const parent = fakeParent('init-1');
    const engine = createEngine({
        ctx: {
            subagents: { start: () => ({ result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'ok' }] }) }) },
            agents: { get: () => undefined, resume: async () => { throw new Error('session persistence is not configured'); }, currentInitiator: () => parent },
            agentDefaultModel: { provider: 'p1', model: 'm1' },
        },
        config: {}, sleep: noSleep,
    });
    const r = await engine.run('polish', { prompt: 'x', sessionId: 'sess-x' });
    assert.equal(r.ok, true, 'resume 抛错 → 落到发起边界，整体仍成功');
});

test('engine: 候选会话已驻留（get 命中）时绝不触发 resume——零副作用路径优先', async () => {
    const parent = fakeParent('sess-1');
    let resumeCalled = false;
    const engine = createEngine({
        ctx: {
            subagents: { start: () => ({ result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'ok' }] }) }) },
            agents: { get: (id) => (id === 'sess-1' ? parent : undefined), resume: async () => { resumeCalled = true; return parent; } },
            agentDefaultModel: { provider: 'p1', model: 'm1' },
        },
        config: {}, sleep: noSleep,
    });
    const r = await engine.run('polish', { prompt: 'x', sessionId: 'sess-1' });
    assert.equal(r.ok, true);
    assert.equal(resumeCalled, false, 'get 已命中就不该去物化');
});

test('engine: NO_PARENT_AGENT 自带诊断——agents 服务整个不可解析时点名 inject 缺声明', async () => {
    // 0.13.2 真机复诊：inject 漏声明 agents → readService('agents') 落空 →
    // get/resume/currentInitiator 三路全空。报错必须自己说出这一层，不许让下轮排查再猜。
    const engine = createEngine({ ctx: { subagents: { start: () => { throw new Error('不应走到 start'); } } }, config: {}, sleep: noSleep });
    const r = await engine.run('polish', { prompt: 'x', sessionId: 'sess-1' });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'NO_PARENT_AGENT');
    assert.match(r.error.message, /agents 服务不可解析/);
    assert.match(r.error.message, /inject/);
});

test('engine: NO_PARENT_AGENT 自带诊断——resume 抛错时把宿主拒绝原因带出来', async () => {
    const engine = createEngine({
        ctx: {
            subagents: { start: () => { throw new Error('不应走到 start'); } },
            agents: { get: () => undefined, resume: async () => { throw new Error('session persistence is not configured'); } },
        },
        config: {}, sleep: noSleep,
    });
    const r = await engine.run('polish', { prompt: 'x', sessionId: 'sess-1' });
    assert.equal(r.error.code, 'NO_PARENT_AGENT');
    assert.match(r.error.message, /resume 失败：session persistence is not configured/);
});

test('engine: stopReason=max-tokens → OUTPUT_TRUNCATED 专门错误（当前上限进报错，重试无意义）', async () => {
    const engine = createEngine({
        ctx: {
            subagents: { start: () => ({ result: Promise.resolve({ stopReason: 'max-tokens' }) }) },
            agents: { get: () => fakeParent('sess-1') },
            agentDefaultModel: { provider: 'p1', model: 'm1' },
        },
        config: {}, sleep: noSleep,
    });
    const r = await engine.run('polish', { prompt: 'x', sessionId: 'sess-1' });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'OUTPUT_TRUNCATED', 'max-tokens 不该落在笼统的 SUBAGENT_FAILED 里');
    assert.match(r.error.message, /继承宿主默认上限/, '默认不设限时报错要如实说明继承语义');
    assert.match(r.error.advice, /engine\.channels\.polish\.maxTokens/);
});

test('engine: 通道显式配置 maxTokens 时传给子代理，截断报错带具体数字', async () => {
    const engine = createEngine({
        ctx: {
            subagents: { start: (_p, opts) => { seen = opts.agentOptions; return { result: Promise.resolve({ stopReason: 'max-tokens' }) }; } },
            agents: { get: () => fakeParent('sess-1') },
            agentDefaultModel: { provider: 'p1', model: 'm1' },
        },
        config: { engine: { channels: { polish: { maxTokens: 8192 } } } }, sleep: noSleep,
    });
    let seen;
    const r = await engine.run('polish', { prompt: 'x', sessionId: 'sess-1' });
    assert.equal(r.error.code, 'OUTPUT_TRUNCATED');
    assert.equal(seen.maxTokens, 8192, '显式配置要生效');
    assert.match(r.error.message, /8192/);
});

// ── 0.13.3 补八：父锚定收敛——批量起草并发前只锚定一次 ──────────────────────
// 复盘：并发>1 时每章各自走 anchorChain，多章并发 agents.resume 同一持久化
// 会话有撞宿主持久化写锁的风险。收敛面：engine.anchor() 解析一次 →
// run({ parent }) 把预解析的父 agent 传给每一章。

test('engine: anchor() 独立可用——get 命中直接返回活父 agent，不碰 start', async () => {
    const parent = fakeParent('sess-3');
    const engine = createEngine({
        ctx: {
            subagents: { start: () => { throw new Error('anchor 不该 start'); } },
            agents: { get: (id) => (id === 'sess-3' ? parent : undefined) },
        },
        config: {}, sleep: noSleep,
    });
    const a = await engine.anchor({ sessionId: 'sess-3' });
    assert.equal(a.ok, true);
    assert.equal(a.parent, parent);
});

test('engine: run({ parent }) 用预解析的父 agent，全程不再碰 agents 注册表', async () => {
    let getCalls = 0;
    const parent = fakeParent('sess-7');
    let gotParent;
    const engine = createEngine({
        ctx: {
            subagents: { start: (_p, opts) => { gotParent = opts.parent; return { result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'ok' }] }) }; } },
            agents: {
                get: (id) => { getCalls += 1; return id === 'sess-7' ? parent : undefined; },
                resume: async () => { throw new Error('预解析后不该再 resume'); },
            },
            agentDefaultModel: { provider: 'p1', model: 'm1' },
        },
        config: {}, sleep: noSleep,
    });
    const a = await engine.anchor({ sessionId: 'sess-7' });
    assert.equal(a.ok, true);
    const afterAnchor = getCalls;
    const r = await engine.run('polish', { prompt: 'x', sessionId: 'sess-7', parent: a.parent });
    assert.equal(r.ok, true);
    assert.equal(getCalls, afterAnchor, '预解析 parent 后 run 不该再查注册表');
    assert.equal(gotParent, parent, '预解析的 parent 原样传给宿主 start');
});

test('batch-draft: 并发>1 时父锚定只发生一次（防多章并发 resume 同一会话）', async () => {
    const book = '锚定收敛书';
    const files = {
        [`${book}/novel.json`]: JSON.stringify({
            title: book, stage: 'chapter', phases: {},
            approvals: { outline: { 1: true, 2: true } },
            chapters: {}, cast: [], proposals: [], gateFailures: {},
        }),
        // 契约给足两章，并发不被上下文预算刹车压回 1
        [`${book}/设定/场景契约.json`]: JSON.stringify({
            1: { scene: '码头', participants: [], hidden: [], settings: [], forbidden: [], notes: '' },
            2: { scene: '义庄', participants: [], hidden: [], settings: [], forbidden: [], notes: '' },
        }),
        [`${book}/大纲/细纲/第1章.md`]: '# 第1章 雪夜\n\n- 码头相遇：她在雾里认出暗号。',
        [`${book}/大纲/细纲/第2章.md`]: '# 第2章 斗笠\n\n- 摘斗笠：露出被火燎过的脸。',
    };
    const io = memIo(files);
    const parent = fakeParent('sess-anchor');
    let anchorCalls = 0;
    const seenParents = [];
    const engine = {
        // 收敛面替身：anchor 一次；run 必须收到预解析的 parent
        async anchor(_opts) { anchorCalls += 1; return { ok: true, parent }; },
        async run(_channel, { prompt, parent: p }) {
            seenParents.push(p);
            const n = Number(prompt.match(/【第 (\d+) 章/)[1]);
            return { ok: true, finishKind: 'stop', attempts: 1, route: { provider: 'p', model: 'm', source: 'default' }, text: CHAPTER_TEXTS[n] };
        },
    };
    const result = await runDraftBatch({
        engine, config: TEST_CFG, io, p: pathsFor(book), book,
        novel: JSON.parse(files[`${book}/novel.json`]), from: 1, count: 2, concurrency: 2,
        sessionId: 'sess-anchor',
    });
    assert.equal(result.concurrency, 2);
    assert.equal(anchorCalls, 1, '锚定必须只发生一次');
    assert.equal(seenParents.length, 2);
    assert.ok(seenParents.every((p) => p === parent), '每一章都拿到同一个预解析 parent');
    assert.ok(result.stats.committed === 2, '收敛不改变批量起草的功能结果');
});

test('batch-draft: 引擎无 anchor（旧替身/降级）时不炸——并发照跑，行为与旧版一致', async () => {
    const book = '无锚面书';
    const files = {
        [`${book}/novel.json`]: JSON.stringify({
            title: book, stage: 'chapter', phases: {},
            approvals: { outline: { 1: true, 2: true } },
            chapters: {}, cast: [], proposals: [], gateFailures: {},
        }),
        [`${book}/设定/场景契约.json`]: JSON.stringify({
            1: { scene: '码头', participants: [], hidden: [], settings: [], forbidden: [], notes: '' },
            2: { scene: '义庄', participants: [], hidden: [], settings: [], forbidden: [], notes: '' },
        }),
        [`${book}/大纲/细纲/第1章.md`]: '# 第1章 雪夜\n\n- 码头相遇。',
        [`${book}/大纲/细纲/第2章.md`]: '# 第2章 斗笠\n\n- 摘斗笠。',
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
        novel: JSON.parse(files[`${book}/novel.json`]), from: 1, count: 2, concurrency: 2,
    });
    assert.equal(result.concurrency, 2, '没有 anchor 面也不该把并发压回 1');
    assert.ok(result.stats.committed === 2);
});

// ── H2：novel.json 读-改-写的乐观并发（读时捕获版本 + 冲突重放）──────────────

test('isVersionConflict：认得宿主两类守卫失败（版本不符 / 读时不存在）', () => {
    for (const code of ['FS_STALE_VERSION', 'FS_NOT_OBSERVED', 'FS_VERSION_CONFLICT']) {
        const error = new Error(`${code}: 书/novel.json`);
        error.code = code;
        assert.equal(isVersionConflict(error), true, `${code} 必须判为冲突`);
    }
    assert.equal(isVersionConflict(new Error('FS_SANDBOX_DENIED: 越界')), false, '沙箱拒绝不是冲突，不得被重试吞掉');
    assert.equal(isVersionConflict(new Error('网络错误')), false);
});

test('★ updateJson：读写之间被人插一刀，两边的更新都留得下来（H2 根因）', async () => {
    const book = '并发书';
    const meta = `${book}/novel.json`;
    const io = memIo({ [meta]: JSON.stringify({ title: book, proposals: [] }) });

    // 模拟另一端：在本次「读→写」之间提交一次自己的更新（真机上就是面板另一路的写入）
    const realWriteAt = io.writeJsonAtVersion.bind(io);
    let tripped = false;
    io.writeJsonAtVersion = async (p, value, version) => {
        if (!tripped && p === meta) {
            tripped = true;
            const other = JSON.parse(io.files.get(meta));
            other.proposals.push({ id: 'OTHER', chapter: 2, status: 'pending', createdAt: 't' });
            await io.writeJson(p, other);
        }
        return realWriteAt(p, value, version);
    };

    const { written, attempts } = await updateJson(io, meta, (novel) => {
        novel.proposals.push({ id: 'MINE', chapter: 1, status: 'pending', createdAt: 't' });
        return { value: novel, result: { ids: novel.proposals.map((x) => x.id) } };
    });
    assert.equal(written, true);
    assert.ok(attempts >= 2, '★ 必须真的撞上冲突并重放，否则这条用例什么都没测');
    const ids = JSON.parse(io.files.get(meta)).proposals.map((x) => x.id).sort();
    assert.deepEqual(ids, ['MINE', 'OTHER'],
        '陈旧对象整体覆盖会把 OTHER 抹掉（幽灵提案的成因）——重读重放后两边的更新都该在');
});

test('★ 并发登记提案：两份提案索引都在 novel.json 里（不产生幽灵提案）', async () => {
    const { submitRevisionProposal } = await import('../lib/proposals.js');
    const book = '提案并发书';
    const meta = `${book}/novel.json`;
    const novel = {
        title: book, stage: 'writing', chapters: { 1: { title: '第一章', latest: 1, files: [], path: `${book}/正文/第1章-第一章-v1.md` } },
        proposals: [], cast: [],
    };
    const io = memIo({ [meta]: JSON.stringify(novel) });

    // 第一份登记在写回前，第二份已经落盘 → 第一份必须重放而不是覆盖掉它
    const realWriteAt = io.writeJsonAtVersion.bind(io);
    let injected = false;
    io.writeJsonAtVersion = async (p, value, version) => {
        if (!injected && p === meta) {
            injected = true;
            const cur = JSON.parse(io.files.get(meta));
            cur.proposals.push({ id: 'EARLY', chapter: 1, status: 'pending', createdAt: 't0' });
            await io.writeJson(p, cur);
        }
        return realWriteAt(p, value, version);
    };

    await submitRevisionProposal(io, book, { chapter: 1, content: '正文 A', reason: 'A' });
    assert.ok(injected, '前置：确实制造了一次读-改-写竞态');
    const ids = JSON.parse(io.files.get(meta)).proposals.map((x) => x.id).sort();
    assert.ok(ids.includes('EARLY'), '插进去的那条不能被抹掉');
    assert.equal(ids.length, 2, `两条提案都该在索引里，实际：${ids.join(',')}`);
});

test('★ rememberSession：只重放归属增量，不许拿调用方手上的旧快照整体回写', async () => {
    const { rememberSession } = await import('../lib/tools/common.js');
    const book = '归属并发书';
    const meta = `${book}/novel.json`;
    const io = memIo({
        [meta]: JSON.stringify({
            title: book, sessions: [],
            proposals: [{ id: 'PANEL-1', chapter: 1, status: 'pending', createdAt: 't' }],
        }),
    });
    io.sessionId = 'sess-9';
    // 调用方手上是**更早**读到的快照（没有面板刚登记的那条提案）
    const stale = JSON.parse(io.files.get(meta));
    stale.proposals = [];

    const added = await rememberSession(io, pathsFor(book), stale);
    assert.equal(added, true, '补录成功要回 true（调用方据此判断）');

    const onDisk = JSON.parse(io.files.get(meta));
    assert.deepEqual(onDisk.sessions, ['sess-9'], '归属要落到盘上');
    assert.deepEqual(onDisk.proposals.map((x) => x.id), ['PANEL-1'],
        '★ 旧快照整体回写会把面板刚登记的提案抹掉（幽灵提案的另一条成因）——只能重放增量');
    assert.deepEqual(stale.sessions, ['sess-9'], '调用方手上的对象也要同步归属，免得它随后 saveBook 又把它写丢');
});
