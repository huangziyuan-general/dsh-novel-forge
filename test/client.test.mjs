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

test('★ 未保存草稿：返回前先确认（丢弃改动才离开，取消留在原地）', async () => {
    const { controller } = bootBook();
    await controller.handleAction('open', { dataset: { id: '星海拾骨' } });
    assert.equal(controller.state.view, 'detail');
    // 模拟用户在草稿里打字产生未保存改动（onInput field=draft 的等价结果）
    controller.state.draft = '写了一半的字'; controller.state.draftModified = true;

    // 点返回 → 不离开，挂起确认
    await controller.handleAction('back', { dataset: {} });
    assert.equal(controller.state.view, 'detail', '有改动时返回必须先确认');
    assert.equal(controller.state.discardPending?.kind, 'back', '挂起的是返回意图');

    // 取消 → 留在原地、草稿不丢
    await controller.handleAction('discard-cancel', { dataset: {} });
    assert.equal(controller.state.view, 'detail', '取消后仍在详情');
    assert.equal(controller.state.discardPending, null, '取消后提示消失');
    assert.equal(controller.state.draft, '写了一半的字', '取消后草稿不丢');

    // 再返回并确认丢弃 → 回项目列表、提示清空
    controller.state.draftModified = true;
    await controller.handleAction('back', { dataset: {} });
    await controller.handleAction('discard-confirm', { dataset: {} });
    assert.equal(controller.state.view, 'projects', '确认丢弃后返回列表');
    assert.equal(controller.state.discardPending, null, '确认后挂起清空');
});

test('★ 删除有取消出口：误触「删除」后点「取消」不删书', async () => {
    const { requests, controller } = bootBook();
    await controller.handleAction('open', { dataset: { id: '星海拾骨' } });
    await controller.handleAction('delete', { dataset: {} });
    assert.equal(controller.state.deleteState, 'confirm', '第一次点只进确认态，不删');
    await controller.handleAction('delete-cancel', { dataset: {} });
    assert.equal(controller.state.deleteState, null, '取消后离开确认态');
    assert.ok(!requests.some((r) => r.init?.method === 'DELETE'), '取消后没发出删除请求');
});

test('★ 列表改名：确认后 POST /projects/:id/rename 带新书名；空名被拦', async () => {
    const { requests, controller } = bootBook();
    await controller.refreshProjects(); // 载入列表，让 rename 能拿当前书名做预填
    // 打开改名表单
    await controller.handleAction('rename-open', { dataset: { id: '星海拾骨' } });
    assert.equal(controller.state.rename?.id, '星海拾骨', '改名表单打开');
    assert.equal(controller.state.rename.value, '星海拾骨', '预填当前书名');
    // 空名被拦，不发请求
    controller.state.rename.value = '   ';
    await controller.handleAction('rename-confirm', { dataset: {} });
    assert.equal(controller.state.error, '书名不能为空', '空书名被拦');
    assert.ok(!requests.some((r) => r.url.includes('/rename')), '空名没发 rename 请求');
    // 填名字提交
    controller.state.rename.value = '新书名';
    await controller.handleAction('rename-confirm', { dataset: {} });
    const req = requests.find((r) => r.url.includes('/rename'));
    assert.ok(req, '发出了 rename 请求');
    assert.equal(req.init.method, 'POST', 'rename 是 POST');
    assert.equal(JSON.parse(req.init.body).title, '新书名', 'body 带新书名');
    assert.equal(controller.state.rename, null, '改名后表单关闭');
});

test('★ 列表删除：两步确认走 DELETE；取消不删', async () => {
    const { requests, controller } = bootBook();
    // 第一次点只进确认，不发删除
    await controller.handleAction('list-delete', { dataset: { id: '星海拾骨' } });
    assert.equal(controller.state.listDeleteId, '星海拾骨', '第一次点只进确认态');
    assert.ok(!requests.some((r) => r.init?.method === 'DELETE'), '确认前没删');
    // 取消后离开确认态、仍不删
    await controller.handleAction('list-delete-cancel', { dataset: {} });
    assert.equal(controller.state.listDeleteId, null, '取消后离开确认态');
    assert.ok(!requests.some((r) => r.init?.method === 'DELETE'), '取消后没删');
    // 再来一遍并确认删除 → 发 DELETE，目标书正确
    await controller.handleAction('list-delete', { dataset: { id: '星海拾骨' } });
    await controller.handleAction('list-delete', { dataset: { id: '星海拾骨' } });
    const del = requests.find((r) => r.init?.method === 'DELETE');
    assert.ok(del, '确认后发出 DELETE');
    assert.ok(del.url.includes('/projects/星海拾骨'), 'DELETE 目标书正确');
    assert.equal(controller.state.listDeleteId, null, '删完回到非确认态');
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
    // ⚠️ 这里必须用 `id`：视图是 `Btn({ action:'play-from', id: c.no })`，
    // 而 Btn 把 id 写成 **data-id**（全项目没有任何地方写 data-no）。
    // 早先这行手写成 `{ no: '2' }` —— 测试**照着实现编了个 dataset**，
    // 于是实现读错属性名也照样全绿，而真机上整列「▶」都是死的。
    // 教训同 AGENTS.md「替身必须镜像宿主真机，不是镜像自己的实现」：这里的"真机"是**视图渲染出来的属性**。
    await controller.handleAction('play-from', { dataset: { id: '2' } });
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

test('★ 播放钮的章号只认 data-id（视图怎么渲染，控制器就怎么读）', async () => {
    const { synth, controller } = bootBook();
    await controller.handleAction('open', { dataset: { id: '星海拾骨' } });

    // 视图真渲染出来的属性是 data-id（Btn 把 id 写成 data-id）
    await controller.handleAction('play-from', { dataset: { id: '3' } });
    assert.equal(controller.state.playback.currentNo, 3, '★ 章号必须来自 data-id —— 它才是视图真正写出来的属性');
    assert.ok(synth.spoken.length >= 1, '指定章号后应当真的开始朗读');

    // 反向锁定：data-no 是全项目的"幽灵属性"，谁都不写它。
    // 读它 → Number(undefined) = NaN → 播放器转一圈回 idle → 界面毫无反应。
    controller.state.playback = { status: 'idle', currentNo: null };
    controller.state.error = '';
    await controller.handleAction('play-from', { dataset: { no: '2' } });
    assert.equal(controller.state.playback.status, 'idle', '读 data-no 必然拿不到章号（这就是当年的故障）');
    assert.match(controller.state.error, /章号/, '★ 拿不到章号必须给可读报错，不许静默什么都不做');
});

test('★ 静默失败防线：任何 handler 都不该"点了跟没点一样"', async () => {
    const { controller } = bootBook();
    await controller.handleAction('open', { dataset: { id: '星海拾骨' } });

    // 空 dataset / 脏 dataset 一律要留下痕迹（error 或 notice），否则用户只会看到"按钮坏了"
    for (const [action, dataset] of [
        ['play-from', {}],
        ['play-from', { id: 'NaN' }],
        ['play-from', { id: '0' }],
        ['play-from', { id: '-3' }],
    ]) {
        controller.state.error = ''; controller.state.notice = '';
        await controller.handleAction(action, { dataset });
        assert.ok(
            controller.state.error || controller.state.notice,
            `★ ${action} 收到 ${JSON.stringify(dataset)} 时必须给出反馈（不能静默）`,
        );
    }
});

test('★ stop 即停：必须 cancel 语音引擎，迟到的 onend 不复活播放', async () => {
    const { synth, controller } = bootBook();
    await controller.handleAction('open', { dataset: { id: '星海拾骨' } });
    await controller.handleAction('play-from', { dataset: { id: '1' } });
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
    await controller.handleAction('play-from', { dataset: { id: '1' } });

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
    await controller.handleAction('play-from', { dataset: { id: '1' } });
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

// ── 交互态样式表（0.13.1）──────────────────────────────────────────────────
// 为什么这组必须有：内联样式**压不过** `:hover` / `:active`，所以「按钮有没有按下反馈」
// 完全取决于生成出来的这张表。表里缺一条 = 那个变体静默没有反馈（不报错、不警告），
// 表现就是用户说的「点了没反应」。

const BTN_VARIANTS = ['primary', 'secondary', 'ghost', 'accent', 'danger'];

test('★ 交互态样式表：每个按钮变体都齐备 rest / hover / active 三态', () => {
    const { mod } = boot();
    const { buildCss, PANEL_ATTR } = mod.exports.__internals;
    const css = buildCss();
    for (const variant of BTN_VARIANTS) {
        const sel = `[${PANEL_ATTR}] [data-nf-btn][data-variant="${variant}"]`;
        assert.ok(css.includes(`${sel}{`), `${variant} 缺常态规则`);
        assert.ok(css.includes(`${sel}:hover:not(:disabled)`), `${variant} 缺 hover 规则`);
        assert.ok(css.includes(`${sel}:active:not(:disabled)`),
            `${variant} 缺 active 规则 —— 这就是「按钮按下去没反应」`);
    }
    // 按下必须真的"看得出"：位移 + 内阴影，而不只是换个底色
    assert.ok(/translateY\(1px\)/.test(css), 'active 态要有下沉位移');
    assert.ok(/inset 0 1px 3px/.test(css), 'active 态要有内阴影');
});

test('★ 交互态样式表：可点区域 / 分段控件 / 聚焦态都有规则', () => {
    const { mod } = boot();
    const { buildCss, PANEL_ATTR } = mod.exports.__internals;
    const css = buildCss();
    for (const need of [
        '[data-nf-tap]:hover', '[data-nf-tap]:active',
        '[data-nf-seg]:hover:not([data-active="1"])', '[data-nf-seg][data-active="1"]',
        'input:focus', 'summary:hover',
        // 卡片/行的底色是内联的（card() 给的）—— 内联优先级更高，
        // hover/active 不写 `!important` 就永远压不过去，等于白写
        '!important',
    ]) {
        assert.ok(css.includes(need), `样式表缺 ${need}`);
    }
    // 每条规则都必须以面板根限定（深色补丁允许前置 :where(...)），不许外溢到宿主界面
    const bad = css.split('\n')
        .filter((l) => l.includes('{') && !l.trimStart().startsWith('/*'))
        .filter((l) => !l.includes(`[${PANEL_ATTR}]`));
    assert.deepEqual(bad, [], '有规则没有以面板根限定：\n' + bad.join('\n'));
});

test('★ 深色补丁必须用 :where() 降权重（否则会压掉按下态）', () => {
    const { mod } = boot();
    const css = mod.exports.__internals.buildCss();
    const dark = css.split('\n').filter((l) => l.includes('data-ds-dark-theme'));
    assert.ok(dark.length > 0, '深色补丁一条都没有？');
    for (const line of dark) {
        // `body[data-ds-dark-theme] [y]` 的权重 (0,2,1) 高于 `[y]:active` (0,2,0)
        // → 会把 :active 的内阴影吃掉，深色下按下又变得没反馈
        assert.ok(line.startsWith(':where(body[data-ds-dark-theme])'),
            '深色补丁必须写成 :where(body[...]) 保持权重为 0：' + line);
    }
});

test('★ 样式表注入是 DOM 单例：反复装配只留一份，内容过期就就地更新', () => {
    const { dom, mod } = boot();
    const { ensureStyles, STYLE_ID } = mod.exports.__internals;
    const first = ensureStyles(dom.document);
    assert.ok(first, '应注入成功');
    assert.equal(first.parentElement, dom.document.head, '<style> 应注入到 head');
    // 宿主会反复装配插件（切会话 / 重挂载）→ 第二次必须"收养"，不能再插一份
    ensureStyles(dom.document);
    ensureStyles(dom.document);
    assert.equal(dom.document.querySelectorAll(`#${STYLE_ID}`).length, 1,
        '样式表必须只有一份（每次装配插一份的话，宿主里会越积越多）');
    // 内容过期（换版本 / 热更）→ 就地刷新，不新增节点
    first.textContent = 'stale';
    ensureStyles(dom.document);
    assert.equal(dom.document.querySelectorAll(`#${STYLE_ID}`).length, 1);
    assert.ok(first.textContent.includes('data-nf-btn'), '过期内容应被就地刷新');
    // 没有 document 的环境（headless / 非浏览器）不能抛
    assert.equal(ensureStyles(null), null);
    assert.equal(ensureStyles({}), null);
});

test('★ 阅读器：📖 取正文展开；✕ 收起；章号只认 data-id（同播放钮的教训）', async () => {
    const { requests, controller } = bootBook();
    await controller.handleAction('open', { dataset: { id: '星海拾骨' } });

    // 点第 2 章的 📖 → 取正文、落 reader（标题取自目录）
    await controller.handleAction('read-chapter', { dataset: { id: '2' } });
    assert.ok(requests.some((r) => /\/chapters\/2($|\?)/.test(r.url)), '★ 阅读必须真的去取该章正文');
    assert.equal(controller.state.reader?.no, 2);
    assert.equal(controller.state.reader?.loading, false, '取完后退出加载态');
    assert.ok(controller.state.reader?.text.includes('龙渊的清晨'), '正文落进 reader');
    assert.equal(controller.state.reader?.title, '夜训', '标题取自章节目录');

    // ✕ 收起
    await controller.handleAction('close-reader', { dataset: {} });
    assert.equal(controller.state.reader, null, '✕ 必须清掉阅读器');

    // 反向锁定：章号缺失必须报错（不许静默）——与播放钮同一契约
    controller.state.error = '';
    await controller.handleAction('read-chapter', { dataset: {} });
    assert.match(controller.state.error, /章号/, '★ 拿不到章号必须给可读报错');
    assert.equal(controller.state.reader, null, '失败时不留半开的阅读器');
});

// ── 陈旧响应守卫（请求序号）：快速切换时慢响应不得覆盖新状态 ──

/**
 * 可控时序的 fetch：命中 auto 规则的请求立即回；其余挂起，测试用 respond() 手动放行。
 * 断言「陈旧响应被丢弃」必须能控制谁先回——scriptedFetch 的立即兑现做不到这一点。
 * 注意：假 fetch 必须真的会 resolve/reject，否则 apiFetch 的 12s 超时定时器
 * 清不掉，node --test 会等事件池等到天荒地老（这里的挂死就是这么来的）。
 */
function gatedFetch(auto = []) {
    const requests = [];
    const pending = [];
    const fetch = (url, init) => {
        const u = String(url);
        requests.push({ url: u, init });
        const rule = auto.find((r) => (typeof r.match === 'string' ? u.includes(r.match) : r.match.test(u)));
        if (rule) return Promise.resolve({ json: () => Promise.resolve({ ok: true, value: rule.value }) });
        let resolve, reject;
        const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
        const entry = { url: u, done: false,
            resolve: (v) => { if (!entry.done) { entry.done = true; resolve({ json: () => Promise.resolve({ ok: true, value: v }) }); } },
            reject: (e) => { if (!entry.done) { entry.done = true; reject(e); } } };
        pending.push(entry);
        return promise;
    };
    // 精确匹配优先，子串兜底——用完整 URL 调用就不会错杀相邻端点
    const respond = (match, value) => {
        let entry = pending.find((p) => !p.done && p.url === match);
        if (!entry) entry = pending.find((p) => !p.done && p.url.includes(match));
        assert.ok(entry, `gatedFetch.respond: 没有匹配 ${match} 的挂起请求（在等：${pending.filter((p) => !p.done).map((p) => p.url).join(' , ') || '（无）'}）`);
        entry.resolve(value);
    };
    // 多轮排水：respond 之后「promise → apiFetch 续体 → Promise.all → openProject 续体 →
    // 尾部三连 fetch 发出」要跨好几轮微任务+宏任务；只等一针 setImmediate 会时好时坏。
    const settle = async () => {
        for (let i = 0; i < 6; i += 1) await new Promise((r) => setImmediate(r));
    };
    return { fetch, requests, pending, respond, settle };
}

test('★ 陈旧响应守卫：快速连开两本书，慢到的旧书响应不得覆盖新状态', async () => {
    const dfr = gatedFetch();
    const dom = createDom();
    const mod = loadClient(dom, BUNDLE, { fetch: dfr.fetch });
    const controller = mod.exports.__internals.createForgeController({ sessionId: 's1' });

    // 连开两本：甲先点、乙后点；乙的响应先回，甲的慢响应最后才落地
    const p1 = controller.handleAction('open', { dataset: { id: '甲' } });
    const p2 = controller.handleAction('open', { dataset: { id: '乙' } });

    // 乙全链路放行。⚠️ URL 段是 percent-encoded（视图 encodeURIComponent，0.6.3 的老教训），
    // match 必须用编码后的书名；openProject 的 detail/章请求不带 session（withSession 只在列表页用）。
    const yi = encodeURIComponent('乙');
    dfr.respond(`/api/novel-forge/projects/${yi}/chapters/1`, '乙的第一章');
    dfr.respond(`/api/novel-forge/projects/${yi}`, { title: '乙书' });
    await dfr.settle(); // 第一波响应落地后，openProject 才会发目录/要素/提案三连
    dfr.respond(`/api/novel-forge/projects/${yi}/chapters`, []);
    dfr.respond(`/api/novel-forge/projects/${yi}/elements`, {});
    dfr.respond(`/api/novel-forge/projects/${yi}/proposals`, { proposals: [] });
    await p2;
    assert.equal(controller.state.selected, '乙');
    assert.equal(controller.state.detail?.title, '乙书');
    assert.equal(controller.state.draft, '乙的第一章');

    // 甲的响应现在才到——必须整体被丢弃（detail 与 draft 都不许串台）
    const jia = encodeURIComponent('甲');
    dfr.respond(`/api/novel-forge/projects/${jia}/chapters/1`, '甲的第一章');
    dfr.respond(`/api/novel-forge/projects/${jia}`, { title: '甲书' });
    await p1;

    assert.equal(controller.state.selected, '乙', 'selected 不被慢响应拉回');
    assert.equal(controller.state.detail?.title, '乙书', '★ 甲的 detail 不得覆盖乙的');
    assert.equal(controller.state.draft, '乙的第一章', '★ 甲的章正文不得覆盖乙的——否则接着点保存就会写错书');
    assert.equal(controller.state.error, '', '丢弃是静默的：不该给用户报错');
});

test('★ 陈旧响应守卫：快速连点两章，后点的章必须赢（draft 与 chapterNo 永远同章）', async () => {
    // detail / 目录 / 要素 / 提案走 auto 立即回；只有章正文挂起，手动控序。
    // 用锚定结尾的正则：/chapters$ 只命中目录、不误伤 /chapters/N 的正文请求。
    const shu = encodeURIComponent('书');
    const dfr = gatedFetch([
        { match: new RegExp(`/projects/${shu}$`), value: { title: '书' } },
        { match: /\/chapters$/, value: [] },
        { match: /\/elements$/, value: {} },
        { match: /\/proposals$/, value: { proposals: [] } },
    ]);
    const dom = createDom();
    const mod = loadClient(dom, BUNDLE, { fetch: dfr.fetch });
    const controller = mod.exports.__internals.createForgeController({ sessionId: 's1' });

    const p = controller.handleAction('open', { dataset: { id: '书' } });
    dfr.respond(`/api/novel-forge/projects/${shu}/chapters/1`, '第一章正文');
    await p;
    assert.equal(controller.state.draft, '第一章正文');

    // 章号输入框连切两章：先点第 3 章、再点第 2 章；第 3 章响应先回、第 2 章后回。
    // 走真事件代理（input 事件 + data-field），不是直呼内部函数——契约是视图派发的那条路。
    const root = new dom.El('div');
    controller.attach(root);
    const input = new dom.El('input');
    input.dataset.field = 'chapterNo';
    root.append(input);

    input.value = '3';
    input.dispatch('input');
    input.value = '2';
    input.dispatch('input');
    await dfr.settle();

    dfr.respond(`/api/novel-forge/projects/${shu}/chapters/3`, '第三章正文'); // 慢到的旧请求
    await dfr.settle();
    assert.equal(controller.state.draft, '第一章正文', '第 3 章响应到达时 chapterNo 已是 2：不得覆盖');
    assert.equal(controller.state.chapterNo, 2);

    dfr.respond(`/api/novel-forge/projects/${shu}/chapters/2`, '第二章正文'); // 后点的章后回
    await dfr.settle();
    assert.equal(controller.state.draft, '第二章正文', '★ 后点的章必须赢——draft 与 chapterNo 同章，保存才不会写错章');
    assert.equal(controller.state.chapterNo, 2);
    assert.equal(controller.state.error, '');
});
