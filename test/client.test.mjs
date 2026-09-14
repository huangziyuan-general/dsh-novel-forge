// test/client.test.mjs — 浏览器 client-half 的**行为**测试（不是字符串断言）。
//
// 为什么这么写：0.4.0 用 `code.includes('mountSidebarEntry')` 守着入口，
// 于是「插一次就被 React 冲掉、之后永不自愈」这个真 bug 一路 77/77 全绿、
// 真机锻炉整个消失。现在真跑 apply()，断言**实际注册了什么、实际打了哪些请求**。
//
// 0.5.0 换了入口路线（左侧栏 DOM 注入 → 右侧栏 tab 三步契约）+ 会话语义
// （项目跟会话走），本文件围绕这两件事重建：
//   ① 三步契约：sidebarRightTabs.register / slots.register(pane.tab) / openTab
//   ② 显示时机：**本会话有项目才自动开 tab**，不重复打扰，会话切换重新判断
//   ③ 会话过滤：面板的请求必须带 session；创建/认领必须写会话戳
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createDom, loadClient, makeCtx } from './helpers/dom.mjs';

const BUNDLE = new URL('../lib/client.js', import.meta.url);
const TAB_ID = 'dsh-novel-forge';
const TAB_KIND = 'novel-forge';

/** 装一次 client bundle + 一个 ctx，并跑 apply()。 */
function boot(ctxOpts = {}, clientOpts = {}) {
    const dom = createDom();
    const mod = loadClient(dom, BUNDLE, clientOpts);
    const harness = makeCtx(ctxOpts);
    mod.exports.apply(harness.ctx);
    return { dom, mod, ...harness };
}

/** 造一个 fetch：按调用序号返回不同 value，并记录请求。 */
function scriptedFetch(sequence) {
    const requests = [];
    let i = 0;
    const fetch = (url, init) => {
        requests.push({ url: String(url), init });
        const step = sequence[Math.min(i, sequence.length - 1)];
        i += 1;
        if (step && step.reject) return Promise.reject(new Error(step.reject));
        return Promise.resolve({ json: () => Promise.resolve({ ok: true, value: step && 'value' in step ? step.value : [] }) });
    };
    return { fetch, requests };
}

// ── 加载与模块表 ──

test('加载契约：__ModuleLoader__ id 与包名一致，导出 { inject, apply }', () => {
    const { mod } = boot();
    assert.equal(mod.id, 'dsh-novel-forge', 'load id 必须等于插件名');
    assert.equal(typeof mod.exports.apply, 'function', '必须导出 apply(ctx)');
    assert.deepEqual(Array.from(mod.exports.inject),
        ['slots', 'sidebarRightTabs', 'sidebarRight', 'sessions'],
        '右侧栏三步契约需要 slots / sidebarRightTabs / sidebarRight，会话过滤需要 sessions');
});

test('模块取用：只向宿主播种的模块表要东西（不得 require 表外模块）', () => {
    const { mod } = boot();
    const allowed = new Set(['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', 'cordis']);
    for (const spec of mod.required) {
        assert.ok(allowed.has(spec), `★ 不得不经宿主模块表直接 require("${spec}")`);
    }
});

test('★ 不再自建全屏层：apply() 不往 document.body 挂任何容器', () => {
    const { dom } = boot();
    assert.equal(dom.body.children.length, 0,
        '★ 0.5.0 起面板由右侧栏 slot 框架渲染，不应再出现自建的全屏遮罩（那是「空白页」的来源）');
});

// ── ① 声明 tab 类型 ──

test('① 声明 tab 类型：register 收到 page type（id / kind / 常量标题 / guide 入口）', () => {
    const { registered } = boot();
    assert.equal(registered.tabs.length, 1, '应当只注册一个 tab 类型');
    const def = registered.tabs[0];
    assert.equal(def.id, TAB_ID, 'definition.id 必须等于包名（它是内容 seat 的 key）');
    assert.equal(def.kind, TAB_KIND, 'kind 是 openTab 点名的判别符');
    assert.equal(def.priority, 'extension', '第三方类型默认 extension 档');
    assert.equal(def.patterns, undefined, '不给 patterns ⇒ page type（由 kind 打开，不认领地址）');
    assert.equal(typeof def.title, 'function', 'title 必须是函数（thunked copy）');
    // page type 的 title 由 pageAddress(kind) = `sidebar://<kind>` 调用；我们返回常量
    assert.match(def.title('sidebar://' + TAB_KIND), /锻炉/, 'tab chip 必须有可见文案');
    assert.ok(Array.isArray(def.guide) && def.guide.length > 0, '★ 必须有 guide 入口胶囊（自动打开失败时的保底通道）');
    assert.equal(typeof def.guide[0].title, 'function');
    assert.equal(typeof def.guide[0].description, 'function');
});

// ── ② 注册内容 seat ──

test('② 注册内容 seat：key 用 definition.id，且 inject 工厂能拿到 sessionId', () => {
    const { registered, mod } = boot();
    const seat = registered.slots.find((s) => s.spec.name === 'sidebar.right.pane.tab');
    assert.ok(seat, '必须注册 sidebar.right.pane.tab（只声明类型 = 有格子没内容）');
    assert.equal(seat.spec.key, TAB_ID, '内容 seat 的 key 用 definition 的 id（不是 kind）');
    assert.equal(typeof seat.spec.inject, 'function', '★ 必须有 inject 工厂 —— sessionId 只有它能给');
    // 注意：inject 的返回值来自 vm 沙箱（另一个 realm），断言属性而不是 deepEqual
    //（跨 realm 的 Object.prototype 不同，strict deepEqual 会误判为不相等）
    assert.equal(seat.spec.inject('session-abc').sessionId, 'session-abc',
        'inject 工厂必须把 sessionId 交给面板（「项目跟会话走」的全部依据）');
    assert.equal(seat.component, mod.exports.__internals.ForgePanel, '内容必须是面板组件');
});

// ── ③ 打开时机：有项目才显示 ──

// ── ③ 打开：锻炉是右侧栏常驻的独立 tab ──

test('★ ③ 独立 tab：锻炉常驻右侧栏——本会话没有项目也照常打开', async () => {
    const { mod, opened } = boot({ sessionId: 's1' }, { fetch: scriptedFetch([{ value: [] }]).fetch });
    await mod.timers.flush(1);
    assert.ok(opened.includes(TAB_KIND),
        '★ 独立右侧栏 tag：无任何项目也打开（不再被「会话有项目才开」门控压掉）');
});

test('独立打开只发生一次：装配时开一次，开成即停不重复', async () => {
    const { mod, opened } = boot({ sessionId: 's1' }, { fetch: scriptedFetch([{ value: [] }]).fetch });
    await mod.timers.flush(8);
    assert.equal(opened.length, 1, '★ 独立 tag 开成即停（关掉是用户的自由，不跟用户抢）');
});

// ── session-watch 调度层自身语义（apply 不再用它做门控，但能力仍经 __internals 直测）──

test('★ startForgeAutoOpen：本会话有项目才开，轮询到项目出现后补开', async () => {
    const dom = createDom();
    const mod = loadClient(dom, BUNDLE);
    const { ctx, opened } = makeCtx({ sessionId: 's1' });
    const { startForgeAutoOpen } = mod.exports.__internals;
    const seq = scriptedFetch([{ value: [] }, { value: [] }, { value: [{ name: '后建的书' }] }]);
    // startForgeAutoOpen 期望 fetchProjects 解析出数组（真实 wiring 里 apiFetch 已解好）；
    // 这里把 {value} 包成数组，别把裸 {json()} 传进去。
    const fetchProjects = (id) => seq.fetch(id, {}).then((r) => r.json()).then((j) => j.value ?? []);
    startForgeAutoOpen(ctx, {
        fetchProjects, openTab: () => opened.push(TAB_KIND),
        setTimer: mod.timers.setTimer, clearTimer: mod.timers.clearTimer,
    });
    await mod.timers.flush(2);
    assert.equal(opened.length, 0, '前置：前两轮还没有项目');
    await mod.timers.flush(1);
    assert.equal(opened.length, 1, '★ 轮询到项目出现后补开（书由会话里 AI 调工具创建，客户端收不到通知）');
    assert.ok(seq.requests.length > 0, '确实走了轮询请求');
});

test('★ startForgeAutoOpen：切到有项目的会话重新判断，单会话不重复', async () => {
    const dom = createDom();
    const mod = loadClient(dom, BUNDLE);
    const { ctx, opened } = makeCtx({ sessionId: 's1' });
    const { startForgeAutoOpen } = mod.exports.__internals;
    const seq = scriptedFetch([{ value: [{ name: '书A' }] }]);
    const fetchProjects = (id) => seq.fetch(id, {}).then((r) => r.json()).then((j) => j.value ?? []);
    startForgeAutoOpen(ctx, {
        fetchProjects, openTab: () => opened.push(TAB_KIND),
        setTimer: mod.timers.setTimer, clearTimer: mod.timers.clearTimer,
    });
    await mod.timers.flush(1);
    assert.equal(opened.length, 1, '前置：会话 s1 有项目已开');
    ctx._setSession('s2');
    await mod.timers.flush(1);
    assert.equal(opened.length, 2, '★ 换会话重新判断（每会话各开一次）');
    ctx._setSession('s1');
    await mod.timers.flush(1);
    assert.equal(opened.length, 2, '切回已开过的会话不再打扰');
});

test('③ openTab 抛错（seat 未挂载）不炸：重试链由 openForgeTab 自己兜', async () => {
    const seq = scriptedFetch([{ value: [{ name: '书' }] }]);
    const { mod, opened, ctx } = boot({ sessionId: 's1', openTabThrows: true }, { fetch: seq.fetch });
    await mod.timers.flush(4);
    assert.equal(opened.length, 0, '前置：seat 未挂载时 openTab 抛错');

    ctx._setOpenTabThrows(false);             // seat 挂上了
    await mod.timers.flush(40);               // 走内部的 250ms 重试链
    assert.deepEqual(opened, [TAB_KIND], '★ seat 挂载后重试链必须把 tab 开出来（首次排 400ms，之后 250ms 一轮）');
});

test('★ openForgeTab 时序：抛错 → 排下一次 → 成功后不再重复', async () => {
    const dom = createDom();
    const mod = loadClient(dom, BUNDLE);
    const { ctx, opened } = makeCtx({ openTabThrows: true });
    const { openForgeTab } = mod.exports.__internals;

    openForgeTab(ctx, { timer: mod.timers.setTimer, maxTries: 5, log: { info() {}, warn() {} } });
    await mod.timers.flush(1);
    assert.equal(opened.length, 0, '前置：首次尝试抛错');

    ctx._setOpenTabThrows(false);
    await mod.timers.flush(3);
    assert.deepEqual(opened, [TAB_KIND], '挂载后重试一次即成功');

    await mod.timers.flush(5);
    assert.equal(opened.length, 1, '★ 开成即停，绝不重复打开');
});

test('会话服务缺失时不炸（降级：不自动打开，用户仍可从 guide 进）', () => {
    const dom = createDom();
    const mod = loadClient(dom, BUNDLE, {});
    const { ctx } = makeCtx({ withoutSessions: true });
    assert.doesNotThrow(() => mod.exports.apply(ctx), '★ 拿不到 ctx.sessions 也必须能装配');
    assert.equal(mod.exports.__internals.currentSessionId(ctx), null, '读不到会话 id 时返回 null（不抛）');
});

test('currentSessionId：三种快照形态都能读出当前会话', () => {
    const dom = createDom();
    const mod = loadClient(dom, BUNDLE);
    const { currentSessionId } = mod.exports.__internals;
    assert.equal(currentSessionId(makeCtx({ sessionId: 's1' }).ctx), 's1', 'getSnapshot 形态');
    assert.equal(currentSessionId(makeCtx({ sessionId: 's2', sessionsShape: 'fn' }).ctx), 's2', 'snapshot() 形态');
    assert.equal(currentSessionId(makeCtx({ sessionId: 's3', sessionsShape: 'bare' }).ctx), 's3', '裸对象形态');
    assert.equal(currentSessionId({}), null, '没有 sessions 服务 → null');
});

// ── 卸载 ──

test('卸载：startForgeAutoOpen stop 后停止轮询（不再发请求）', async () => {
    const dom = createDom();
    const mod = loadClient(dom, BUNDLE);
    const { ctx } = makeCtx({ sessionId: 's1' });
    const { startForgeAutoOpen } = mod.exports.__internals;
    const seq = scriptedFetch([]);   // 一直无项目 → 持续轮询
    const stop = startForgeAutoOpen(ctx, {
        fetchProjects: seq.fetch, openTab: () => {},
        setTimer: mod.timers.setTimer, clearTimer: mod.timers.clearTimer,
    });
    await mod.timers.flush(3);
    const before = seq.requests.length;
    assert.ok(before > 0, '前置：已发生轮询请求');
    stop();
    await mod.timers.flush(4);
    assert.equal(seq.requests.length, before, '★ stop 后不得再轮询（否则每次重装都漏一条定时器）');
});

// ── 面板控制器：会话过滤（「项目跟会话走」的落点） ──

test('★ 面板列表请求带会话：GET /projects?session=<id>', async () => {
    const seq = scriptedFetch([{ value: [{ name: '书A' }] }, { value: [] }]);
    const dom = createDom();
    const mod = loadClient(dom, BUNDLE, { fetch: seq.fetch });
    const controller = mod.exports.__internals.createForgeController({ sessionId: 's1' });

    await controller.refreshProjects();

    const urls = seq.requests.map((r) => r.url);
    assert.ok(urls.some((u) => u === '/api/novel-forge/projects?session=s1'),
        `★ 列表必须按会话过滤（请求：${urls.join(' , ')}）`);
    assert.ok(urls.some((u) => u === '/api/novel-forge/projects?scope=unclaimed'),
        '未归属的旧书要单独查一份（给认领入口）');
    assert.equal(controller.state.projects.length, 1, '响应要落到 state.projects');
});

test('★ 创建项目带会话戳：POST /projects body 里有 session', async () => {
    const seq = scriptedFetch([{ value: [] }, { value: [] }, { value: [] }, { value: [] }]);
    const dom = createDom();
    const mod = loadClient(dom, BUNDLE, { fetch: seq.fetch });
    const controller = mod.exports.__internals.createForgeController({ sessionId: 's1' });
    controller.state.title = '新书';

    await controller.handleAction('create', { dataset: {} });

    const post = seq.requests.find((r) => r.init && r.init.method === 'POST');
    assert.ok(post, '必须发出创建请求');
    const body = JSON.parse(post.init.body);
    assert.equal(body.session, 's1', '★ 创建时就要打会话戳，否则新书不属于任何会话、列表里看不见');
    assert.equal(body.title, '新书');
});

test('★ 认领未归属的书：POST /projects/claim 带 session 与 ids', async () => {
    const seq = scriptedFetch([{ value: [] }, { value: [] }]);
    const dom = createDom();
    const mod = loadClient(dom, BUNDLE, { fetch: seq.fetch });
    const controller = mod.exports.__internals.createForgeController({ sessionId: 's1' });

    await controller.handleAction('claim', { dataset: { id: '星海拾骨' } });

    const post = seq.requests.find((r) => r.url.endsWith('/projects/claim'));
    assert.ok(post, '必须走认领端点');
    const body = JSON.parse(post.init.body);
    assert.equal(body.session, 's1');
    assert.deepEqual(body.ids, ['星海拾骨'], '认领单本时只带这一本');
});

test('拿不到会话 id 时降级：请求不带 session（显示全部，不静默失败）', async () => {
    const seq = scriptedFetch([{ value: [] }, { value: [] }]);
    const dom = createDom();
    const mod = loadClient(dom, BUNDLE, { fetch: seq.fetch });
    const controller = mod.exports.__internals.createForgeController({ sessionId: null });

    await controller.refreshProjects();

    assert.ok(seq.requests.some((r) => r.url === '/api/novel-forge/projects'),
        '无会话 id 时退化成全量查询（面板顶部会提示「全部项目」）');
});

// ── 原生事件代理 ──

test('★ 事件代理：attach 后 data-action 能走通，detach 后不再响应', async () => {
    const seq = scriptedFetch([{ value: [] }, { value: [] }]);
    const dom = createDom();
    const mod = loadClient(dom, BUNDLE, { fetch: seq.fetch });
    const controller = mod.exports.__internals.createForgeController({ sessionId: 's1' });

    const node = new dom.El('div');
    controller.attach(node);
    const button = new dom.El('button');
    button.dataset.action = 'refresh-projects';
    node.append(button);

    button.dispatch('click', { target: button });
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(seq.requests.length > 0, '★ 点击必须触发动作（宿主里 React 合成事件不可靠，全走原生代理）');

    const count = seq.requests.length;
    controller.detach();
    button.dispatch('click', { target: button });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(seq.requests.length, count, 'detach 之后不再响应（否则面板卸载后还留着一份监听）');
});

// ── 章节听书（0.6.0）：两个标签 + 语音连播 ──

/** 朗读对象构造器（镜像真机：Web Speech 只收 SpeechSynthesisUtterance 实例）。 */
class SpeechSynthesisUtterance {
    constructor(text = '') { this.text = String(text); this.lang = 'zh-CN'; this.rate = 1; }
}

/** 语音引擎替身：speak 只入队，onend 由测试手动触发（真机里是异步回调）。
 *  ⚠️ 按真机契约收口：只收 SpeechSynthesisUtterance 实例，普通对象直接 TypeError ——
 *  否则"真机炸"会一路绿灯（见 0.4.2/0.4.3 两次学费）。 */
function makeSynth() {
    const spoken = [];
    return {
        spoken,
        cancelCount: 0, pauseCount: 0, resumeCount: 0,
        speak(u) {
            if (!(u instanceof SpeechSynthesisUtterance)) {
                throw new TypeError("The provided value is not of type 'SpeechSynthesisUtterance'");
            }
            spoken.push(u);
        },
        cancel() { this.cancelCount += 1; },
        pause() { this.pauseCount += 1; },
        resume() { this.resumeCount += 1; },
    };
}

/** 按路径分发的假 fetch：目录 3 章、每章同一段正文、要素齐全。 */
function makeFetchRouter(requests) {
    const CHAPTERS = [
        { no: 1, title: '初入龙渊', chars: 20 },
        { no: 2, title: '夜训', chars: 20 },
        { no: 3, title: '飞刀', chars: 20 },
    ];
    const CHAPTER_TEXT = '龙渊的清晨来得比城市早。\n操场上已经站满了人。';
    const ELEMENTS = {
        meta: { title: '星海拾骨', genre: '玄幻', logline: '在星海捡骨头的人。', stage: 'planning', createdAt: '2026-09-13T04:55:48Z', updatedAt: '2026-09-13T04:55:48Z', cast: ['林晚'] },
        outline: { full: null, chapterOutlines: [] },
        characters: [{ name: '林晚', text: '主角卡内容' }],
        worldbookCount: 0, glossaryCount: 0,
        facts: [{ entity: '林晚', key: '境界', value: '拾骨锻体一炉', chapter: 1 }],
        foreshadows: [],
    };
    return (url, init) => {
        // 路径里的书名是 encodeURIComponent 过的 —— decode 后好断言
        const u = decodeURIComponent(String(url));
        requests.push({ url: u, init });
        const respond = (value) => Promise.resolve({ json: () => Promise.resolve({ ok: true, value }) });
        if (/\/elements($|\?)/.test(u)) return respond(ELEMENTS);
        if (/\/chapters\/\d+($|\?)/.test(u)) return respond(CHAPTER_TEXT);
        if (/\/chapters($|\?)/.test(u)) return respond(CHAPTERS);
        if (/\/projects\/[^/?]+($|\?)/.test(u)) return respond({ title: '星海拾骨', stage: 'planning', chapters: {} });
        if (u.includes('scope=unclaimed')) return respond([]);
        return respond([{ name: '星海拾骨' }]);
    };
}

/** 开一本书：语音替身挂在沙箱 globalThis 上（resolveSynth 从那里取）。 */
function bootBook({ withSynth = true } = {}) {
    const synth = withSynth ? makeSynth() : null;
    const requests = [];
    const dom = createDom();
    const mod = loadClient(dom, BUNDLE, {
        fetch: makeFetchRouter(requests),
        // 镜像真机：speechSynthesis + SpeechSynthesisUtterance 都在全局（defaultUtteranceFactory 从 globalThis 取）
        ...(withSynth ? { sandboxExtra: { speechSynthesis: synth, SpeechSynthesisUtterance } } : {}),
    });
    const controller = mod.exports.__internals.createForgeController({ sessionId: 's1' });
    return { synth, requests, mod, controller };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('★ 听书目录：openProject 拉章节目录；两个标签可来回切', async () => {
    const { requests, controller } = bootBook();
    await controller.handleAction('open', { dataset: { id: '星海拾骨' } });
    assert.ok(requests.some((r) => /\/projects\/星海拾骨\/chapters($|\?)/.test(r.url)),
        '★ 打开书必须拉章节目录（它既是听书清单，也是连播的边界）');
    assert.equal(controller.state.chapterList.length, 3, '目录落到 state.chapterList');
    assert.equal(controller.state.detailTab, 'info', '默认落在「基本信息」标签');

    await controller.handleAction('detail-tab', { dataset: { tab: 'chapters' } });
    assert.equal(controller.state.detailTab, 'chapters', '★ 能切到「章节听书」标签');
    await controller.handleAction('detail-tab', { dataset: { tab: 'info' } });
    assert.equal(controller.state.detailTab, 'info', '能切回「基本信息」');
});

test('★ 基本要素：openProject 拉 /elements（档案/大纲/角色卡/设定/账本），失败置空不炸', async () => {
    const { requests, controller } = bootBook();
    await controller.handleAction('open', { dataset: { id: '星海拾骨' } });
    assert.ok(requests.some((r) => /\/projects\/星海拾骨\/elements($|\?)/.test(r.url)),
        '★ 打开书必须拉基本要素（基本信息标签就是要素总览）');
    const el = controller.state.elements;
    assert.ok(el && el.meta, '要素落到 state.elements');
    assert.equal(el.meta.title, '星海拾骨');
    assert.equal(el.characters.length, 1, '角色卡列表落地');
    assert.equal(el.facts.length, 1, '账本事实落地（时间线数据源）');

    // elements 接口挂了也不能影响打开书 —— 置空、视图给空态
    const requests2 = [];
    const dom = createDom();
    const failElements = (url) => {
        const u = decodeURIComponent(String(url));
        requests2.push(u);
        if (/\/elements($|\?)/.test(u)) return Promise.reject(new Error('boom'));
        if (/\/chapters\/\d+($|\?)/.test(u)) return Promise.resolve({ json: () => Promise.resolve({ ok: true, value: '' }) });
        if (/\/chapters($|\?)/.test(u)) return Promise.resolve({ json: () => Promise.resolve({ ok: true, value: [] }) });
        if (/\/projects\/[^/?]+($|\?)/.test(u)) return Promise.resolve({ json: () => Promise.resolve({ ok: true, value: { title: '书', chapters: {} } }) });
        return Promise.resolve({ json: () => Promise.resolve({ ok: true, value: [] }) });
    };
    const mod2 = loadClient(dom, BUNDLE, { fetch: failElements });
    const c2 = mod2.exports.__internals.createForgeController({ sessionId: 's1' });
    await c2.handleAction('open', { dataset: { id: '书' } });
    assert.equal(c2.state.elements, null, '★ 要素接口失败 → 置 null（视图渲染空态），书照常打开');
    assert.equal(c2.state.detail?.title, '书', '书的主体数据不受影响');
});

test('★ 连播：从指定章开始，读完自动接下一章，目录尽头自动停', async () => {
    const { synth, requests, controller } = bootBook();
    await controller.handleAction('open', { dataset: { id: '星海拾骨' } });

    // 指定从第 2 章开始听
    await controller.handleAction('play-from', { dataset: { no: '2' } });
    assert.equal(controller.state.playback.currentNo, 2, '★ 「从哪章听」由用户指定');
    assert.equal(controller.state.playback.status, 'playing');
    assert.equal(synth.spoken.length, 1, '第 2 章正文已入朗读队列');
    assert.ok(synth.spoken[0].text.includes('龙渊的清晨'), '读的是取回来的章节文本');

    // 读完第 2 章（触发末块 onend）→ 自动取并读第 3 章
    synth.spoken[synth.spoken.length - 1].onend();
    await tick();
    assert.ok(requests.some((r) => /\/chapters\/3($|\?)/.test(r.url)), '★ 读完一章自动去取下一章（连播的核心）');
    assert.equal(synth.spoken.length, 2, '第 3 章继续朗读');
    assert.equal(controller.state.playback.currentNo, 3);

    // 第 3 章是目录尽头 → 读完收工，不空转
    synth.spoken[synth.spoken.length - 1].onend();
    await tick();
    assert.equal(controller.state.playback.status, 'idle', '★ 目录尽头自动停');
    assert.equal(controller.state.playback.currentNo, null);
});

test('★ stop 即停：必须 cancel 语音引擎，迟到的 onend 不复活播放', async () => {
    const { synth, controller } = bootBook();
    await controller.handleAction('open', { dataset: { id: '星海拾骨' } });
    await controller.handleAction('play-from', { dataset: { no: '1' } });
    assert.equal(controller.state.playback.status, 'playing', '前置：已在播放');

    const spokenCount = synth.spoken.length;
    await controller.handleAction('playback-stop', { dataset: {} });
    assert.equal(controller.state.playback.status, 'idle');
    assert.ok(synth.cancelCount >= 1, '★ stop 必须 cancel 引擎 —— 不 cancel 声音停不下来');

    // 真实浏览器 cancel 之后仍可能补发 onend —— 必须被代际计数作废
    synth.spoken[spokenCount - 1]?.onend?.();
    await tick();
    assert.equal(synth.spoken.length, spokenCount, '★ 迟到的 onend 不得触发下一块（防「停了又活过来」）');
    assert.equal(controller.state.playback.status, 'idle');
});

test('暂停 / 继续：状态机 playing ↔ paused', async () => {
    const { synth, controller } = bootBook();
    await controller.handleAction('open', { dataset: { id: '星海拾骨' } });
    await controller.handleAction('play-from', { dataset: { no: '1' } });

    await controller.handleAction('playback-pause', { dataset: {} });
    assert.equal(controller.state.playback.status, 'paused');
    assert.ok(synth.pauseCount >= 1, '暂停要透传给语音引擎');

    await controller.handleAction('playback-resume', { dataset: {} });
    assert.equal(controller.state.playback.status, 'playing');
    assert.ok(synth.resumeCount >= 1, '继续要透传给语音引擎');
});

test('★ 无语音引擎：给可读报错而不是静默炸掉', async () => {
    const { controller } = bootBook({ withSynth: false });
    await controller.handleAction('open', { dataset: { id: '星海拾骨' } });
    controller.state.error = '';
    await controller.handleAction('play-from', { dataset: { no: '1' } });
    assert.match(controller.state.error, /语音|speechSynthesis/, '★ 报错要说人话（用户能看懂为什么没声音）');
    assert.notEqual(controller.state.playback.status, 'playing', '没引擎就不能进入播放态');
});

test('★ 真机契约：speak 只收 SpeechSynthesisUtterance 实例，普通对象被引擎拒也不卡死', async () => {
    const dom = createDom();
    const mod = loadClient(dom, BUNDLE);
    const strictSynth = makeSynth();   // 严格替身：普通对象必抛 TypeError（镜像真机）
    const player = mod.exports.__internals.createTtsPlayer({
        synth: strictSynth,
        loadChapter: async () => '第一段。\n第二段。',
        hasChapter: () => false,
        nextChapterAfter: () => null,
        makeUtterance: (t) => ({ text: t, lang: 'zh-CN', rate: 1 }),  // 故意给普通对象
        onChange() {},
        chunkLimit: 40,
    });
    await player.playFrom(1);   // 普通对象 → speak 抛 TypeError → speakNext 的 try/catch 吞掉并自动收工
    await tick();
    assert.equal(player.status, 'idle', '★ 普通对象被引擎拒绝后不能卡死在 playing（正常收工）');
});

test('★ 连播按目录跳缺口：章号不连续时从上一章跳到下一存在的章', async () => {
    const dom = createDom();
    const mod = loadClient(dom, BUNDLE, { sandboxExtra: { SpeechSynthesisUtterance } });  // 让默认工厂产真实例
    const synth = makeSynth();
    const nos = [1, 3, 5];   // 只有 1、3、5 —— 老逻辑 currentNo+1 会在缺口 2 处早停
    const player = mod.exports.__internals.createTtsPlayer({
        synth,
        loadChapter: (no) => Promise.resolve(`第 ${no} 章正文。`),
        hasChapter: (no) => nos.includes(no),
        nextChapterAfter: (no) => nos.find((n) => n > no) ?? null,
        onChange() {},
        chunkLimit: 60,
    });
    await player.playFrom(1);
    await tick();
    assert.equal(player.currentNo, 1, '从第 1 章起播');
    synth.spoken[synth.spoken.length - 1].onend();
    await tick();
    assert.equal(player.currentNo, 3, '★ 章号有缺口也跳到下一存在的章（3），不在 2 早停');
    synth.spoken[synth.spoken.length - 1].onend();
    await tick();
    assert.equal(player.currentNo, 5, '★ 继续跳到 5');
    synth.spoken[synth.spoken.length - 1].onend();
    await tick();
    assert.equal(player.status, 'idle', '★ 目录尽头正常收工');
});

test('chunkText：>limit 的段落按句末标点断开、多句合并到 limit 内；空行/纯空白被滤掉', () => {
    const { chunkText } = loadClient(createDom(), BUNDLE).exports.__internals;
    // 短句合并：贴 limit 切成几块，小块不放超
    const text = '甲句。乙句。丙句。丁句。';
    const chunks = chunkText(text, 6);
    assert.ok(chunks.length >= 2, '短句应合并成几块');
    for (const c of chunks) assert.ok(c.length <= 7, `小块 ${JSON.stringify(c)} 不应超 7`);
    assert.equal(chunks.join(''), text, '合并后内容不丢字不漏字');
    // 空行 / 纯空白 paragraph 要过滤，不留空块
    assert.equal(chunkText('\n\n   \n第一句。\n\n').length, 1, '空白段落不产生空块');
    // 单个无标点的超长句：limit 拦不住就得整句成块，但不能丢
    const long = '没有标点会被整句保留的那么长一句话这样的话不能硬切断'.repeat(2);
    const c2 = chunkText(long, 10);
    assert.equal(c2.join(''), long.replace(/\n/g, '').trim(), '超长单句成块后内容一致');
});

// ── apiFetch 的健壮性（0.6.2：不许出现「永远加载中」） ──

test('★ 请求卡死：超时后必须变成可读错误，而不是永远 pending', async () => {
    const dom = createDom();
    // 真 setTimeout/clearTimeout/AbortController：让 30ms 超时真实走一遍；
    // fetch 永不 resolve，只能靠 signal 中止 —— 服务端不回包的镜像。
    const mod = loadClient(dom, BUNDLE, {
        fetch: (url, init) => new Promise((resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
                const e = new Error('The operation was aborted.');
                e.name = 'AbortError';
                reject(e);
            });
        }),
        sandboxExtra: { AbortController, setTimeout, clearTimeout },
    });
    await assert.rejects(
        mod.exports.__internals.apiFetch('/projects', { timeoutMs: 30 }),
        /超时/,
        '★ 卡死的请求超时后必须给「超时」错误，不许永远 pending',
    );
});

test('★ 响应不是 JSON（401 文本 / 代理 HTML）：报错要指向「硬刷新」而不是 SyntaxError 天书', async () => {
    const dom = createDom();
    const mod = loadClient(dom, BUNDLE, {
        fetch: () => Promise.resolve({
            status: 401,
            json: () => Promise.reject(new SyntaxError('Unexpected token \'d\'... is not valid JSON')),
        }),
    });
    await assert.rejects(
        mod.exports.__internals.apiFetch('/projects'),
        /响应不是 JSON/,
        '★ 非 JSON 响应要给出可读错误（指引硬刷新）',
    );
});

test('★ ok:false 照旧抛服务端 message（原有契约不回归）', async () => {
    const dom = createDom();
    const mod = loadClient(dom, BUNDLE, {
        fetch: () => Promise.resolve({
            status: 500,
            json: () => Promise.resolve({ ok: false, error: { code: 'IO_FAILURE', message: '磁盘炸了' } }),
        }),
    });
    await assert.rejects(mod.exports.__internals.apiFetch('/projects'), /磁盘炸了/);
});

// ── 结构契约 ──

test('结构契约：经典脚本 bundle、版本一致、产物由源码构建而来', () => {
    const code = fs.readFileSync(BUNDLE, 'utf8');
    assert.ok(code.includes('window.__ModuleLoader__.load'), '必须是 __ModuleLoader__ bundle');
    assert.ok(!/^\s*(import|export)\s/m.test(code), '★ 不能含 ESM 语法——dsh 按经典脚本执行，混入 import/export 会整包 syntax error');
    assert.match(code, /^\/\/ ⚠️ 自动生成/, '★ 产物必须带 generated 头——缺它说明有人直接改了产物，构建链被绕过');

    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    assert.equal(pkg.exports['./client'], './lib/client.js');
    assert.equal(pkg.dsh.client.platform, 'web');
    const v = code.match(/PLUGIN_VERSION\s*=\s*"([^"]+)"/);
    assert.ok(v, 'client.js 必须有 PLUGIN_VERSION 常量');
    assert.equal(v[1], pkg.version, '★ PLUGIN_VERSION 必须与 package.json 版本一致（防版本漂移）');

    const srcVersion = fs.readFileSync(new URL('../src/client/index.js', import.meta.url), 'utf8')
        .match(/PLUGIN_VERSION\s*=\s*['"]([^'"]+)['"]/);
    assert.ok(srcVersion, 'src/client/index.js 必须有 PLUGIN_VERSION 字面量');
    assert.equal(srcVersion[1], pkg.version, '★ 源码版本必须与 package.json 一致');
});

test('构建链：四视图是独立源码且被打进产物', () => {
    const code = fs.readFileSync(BUNDLE, 'utf8');
    const viewsDir = new URL('../src/client/views/', import.meta.url);
    const views = [
        ['project-list.js', 'ProjectListView'],
        ['project-detail.js', 'ProjectDetailView'],
        ['chapters.js', 'ChapterListView'],
        ['overview.js', 'ProjectOverviewView'],
        ['lorebook.js', 'LorebookView'],
        ['settings.js', 'SettingsView'],
    ];
    for (const [file, symbol] of views) {
        const src = fs.readFileSync(new URL(file, viewsDir), 'utf8');
        assert.match(src, new RegExp(`export function ${symbol}`), `${file} 必须导出 ${symbol}`);
        assert.ok(code.includes(symbol), `产物必须含 ${symbol}（视图确实被打包进来了）`);
    }
});

test('★ 入口路线唯一：左侧栏 DOM 注入的痕迹必须退场（不许两条路线并存）', () => {
    const code = fs.readFileSync(BUNDLE, 'utf8');
    for (const gone of ['data-dsh-novel-forge-entry', 'newSession', 'sidebarCol', 'MutationObserver']) {
        assert.ok(!code.includes(gone),
            `★ 产物里还有「${gone}」——左侧栏路线（DOM 注入 + 自愈观察者）必须删干净，否则两条入口同时存在`);
    }
    assert.ok(code.includes('sidebarRightTabs'), '必须走官方右侧栏契约');
});
