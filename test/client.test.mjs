// test/client.test.mjs — 浏览器 client-half 的 headless 注册契约测试。
//
// 背景：浏览器半无法在假 ctx 里做完整 React 挂载，此前只能守 package.json 结构。
// 这里更进一步：用 node:vm 以 __ModuleLoader__ 的真实语义加载 lib/client.js，
// 物化出 { inject, apply }，再用一个 slots/effect stub 跑 apply(ctx)，
// 断言它按正确的 API 形状走完**右侧栏 tab 的三步**：
//   ① sidebarRightTabs.register（声明 tab 类型）
//   ② slots.inject × 2（面板 + chip 标题两个 seat）
//   ③ sidebarRight.openTab（真正打开 tab —— 缺这步类型注册得再对右侧栏也不会多出一格）
// 另附 guide 条目与"seat 未挂载 → 重试 → 挂载后打开成功"的时序断言。
// 这样即便没有浏览器，也能确定性验证 client 产物 load 不炸、注册调用正确。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

/**
 * 用 __ModuleLoader__ 语义执行 lib/client.js，返回物化的模块 exports 与定时器账本。
 *
 * sandbox 里补 setTimeout/clearTimeout/console：client bundle 用全局定时器排重试，
 * 这是平台惯例（官方 dsh-client-ui-sidebar-documentpreview 的 client bundle 里
 * 有 20+ 处 setTimeout）。这里换成**受控假定时器**——只记账不真跑，测试手动触发，
 * 于是重试时序可确定性断言，不引真实等待、不 flake。
 */
function loadClientBundle() {
    const code = fs.readFileSync('./lib/client.js', 'utf8');
    let registration;
    const timers = [];
    const sandbox = {
        window: {
            __ModuleLoader__: {
                load: (reg) => { registration = reg; },
            },
        },
        setTimeout: (fn, ms) => { timers.push({ fn, ms, cancelled: false }); return timers.length; },
        clearTimeout: (id) => { const t = timers[id - 1]; if (t) t.cancelled = true; },
        console: { info: () => {}, warn: () => {}, log: () => {} },
    };
    const ctx = vm.createContext(sandbox);
    vm.runInContext(code, ctx); // 触发 window.__ModuleLoader__.load({ id, factory })
    assert.ok(registration, 'client.js 必须调用 __ModuleLoader__.load');
    assert.equal(registration.id, 'dsh-novel-forge', 'load id 必须等于插件名');
    const require = (spec) => {
        // client.js 只依赖 react；注册路径不触碰组件，stub 即可。若未来引入更多外部
        // 模块（未声明进包、又非平台种子词）会在此暴露，恰好就是我们要防的漂移。
        if (spec === 'react' || spec === 'react/jsx-runtime') return {};
        throw new Error(`headless 未提供模块 "${spec}"`);
    };
    return { exports: registration.factory(require), timers };
}

/** 记录注册调用的 slots/effect stub（对齐 cordis ctx 的 apply 姿势）。 */
function makeCtxStub({ seatMounted = false } = {}) {
    const injected = [];
    const registered = [];
    const tabTypes = [];
    const opened = [];
    const openFailures = [];
    const state = { seatMounted };
    const ctx = {
        slots: {
            inject: (name, fn) => { injected.push({ name, fn }); return fn; },
            register: (meta, comp) => { registered.push({ meta, comp }); },
        },
        sidebarRightTabs: { register: (def) => { tabTypes.push(def); return () => {}; } },
        sidebarRight: {
            // 真实语义：seat 未挂载时 openTab 直接抛（没有 session 可操作，宁可报错也不静默写）
            openTab: (kind) => {
                if (!state.seatMounted) { openFailures.push(kind); throw new Error('no mounted seat for session'); }
                opened.push(kind);
            },
        },
        effect: (fn) => fn(),
    };
    return { ctx, injected, registered, tabTypes, opened, openFailures, mountSeat: () => { state.seatMounted = true; } };
}

test('client headless: 通过 __ModuleLoader__ 语义加载，inject 声明 slots + sidebarRightTabs + sidebarRight + remote', () => {
    const { exports } = loadClientBundle();
    // 注意：exports.inject 是 vm realm 里建的数组，原型不同于 node，需 Array.from 拉回
    assert.deepEqual(Array.from(exports.inject).sort(), ['remote', 'sidebarRight', 'sidebarRightTabs', 'slots'],
        '模块必须声明 inject=["slots","sidebarRightTabs","sidebarRight","remote"]'
        + '（打开 tab 要导航面；数据面要 remote）');
    assert.equal(typeof exports.apply, 'function', '模块必须导出 apply(ctx)');
});

test('client headless: apply() 先注册 tab 类型（含 guide 入口），再注册面板与标题 seat（id/key 同源）', () => {
    const { exports } = loadClientBundle();
    const { ctx, injected, registered, tabTypes } = makeCtxStub();
    exports.apply(ctx);
    // ① 必须注册右侧栏 tab 类型（没有它就不会有 tab 入口）
    assert.equal(tabTypes.length, 1, 'apply() 必须调用 sidebarRightTabs.register 恰好一次');
    const def = tabTypes[0];
    assert.equal(def.id, 'novel-forge', 'tab 类型 id 必须为 novel-forge');
    assert.equal(def.kind, 'novel-forge', 'tab 类型 kind 必须唯一且稳定');
    assert.equal(typeof def.title, 'function', 'tab 类型必须带 title()');
    assert.equal(def.title(), '锻炉', 'tab 标题必须为 锻炉');
    // ①b page type：不声明 patterns（页面由 kind 打开，不认领地址）
    assert.equal(def.patterns, undefined, 'page 类型不应声明 patterns');
    // ①c guide 条目：右侧栏 guide 页的常驻入口（任何 session 都能从这里点开）
    assert.ok(Array.isArray(def.guide) && def.guide.length === 1, 'tab 类型必须带 1 个 guide 条目');
    const entry = def.guide[0];
    assert.equal(typeof entry.order, 'number', 'guide 条目必须带数字 order');
    assert.equal(typeof entry.title, 'function', 'guide 条目 title 必须是 thunk');
    assert.ok(entry.title().includes('锻炉'), 'guide 条目 title 必须点出锻炉');
    // ② 两个必须出现的槽位注入点
    const names = injected.map((i) => i.name).sort();
    assert.deepEqual(names, ['sidebar.right.pane.tab', 'sidebar.right.pane.tab.title'],
        'apply() 必须注入 tab 面板与 tab 标题两个槽位点',
    );
    // ③ 每个槽位注入的回调，执行时恰好触发一次 slots.register，name 同名、key 同 tab id
    for (const { name, fn } of injected) {
        const before = registered.length;
        fn(); // 触发注入回调 → 内部调用 ctx.slots.register
        const added = registered.slice(before);
        assert.equal(added.length, 1, `槽位 ${name} 应产出恰好一次 register`);
        assert.equal(added[0].meta.name, name, `register 元数据 name 必须等于槽位 ${name}`);
        assert.equal(added[0].meta.key, 'novel-forge', 'register 的 key 必须与 tab 类型 id 一致（sidebarRightTabs 按 id 派发）');
        assert.equal(typeof added[0].comp, 'function', 'register 必须带一个组件');
    }
});

test('client headless: 第三步 openTab —— seat 未挂载时重试，挂载后打开「锻炉」tab', () => {
    const { exports, timers } = loadClientBundle();
    const stub = makeCtxStub({ seatMounted: false });
    exports.apply(stub.ctx);

    // ③a apply() 必须排一个延迟尝试（此刻 seat 还没挂载，不能当场 open）
    assert.equal(timers.length, 1, 'apply() 应排 1 个启动延迟，而不是立刻 openTab');
    assert.equal(stub.opened.length, 0, 'apply() 当场不应打开 tab');
    assert.equal(typeof timers[0].fn, 'function', '启动延迟必须带回调');

    // ③b seat 未挂载：触发 → 抛 → 再排下一次重试
    timers[0].fn();
    assert.deepEqual(stub.openFailures, ['novel-forge'], 'seat 未挂载时 openTab 应以 kind 调用并失败');
    assert.equal(stub.opened.length, 0, '失败后不应记为已打开');
    assert.equal(timers.length, 2, '失败后必须排下一次重试');

    // ③c seat 挂载后：触发 → 打开成功，且不再排重试（开成即停，不打扰用户手动关闭）
    stub.mountSeat();
    timers[1].fn();
    assert.deepEqual(stub.opened, ['novel-forge'], 'seat 挂载后必须成功打开 novel-forge tab');
    assert.equal(timers.length, 2, '打开成功后不应再排重试');

    // ③d 已打开后再触发遗留定时器，不应重复打开
    timers[1].fn();
    assert.equal(stub.opened.length, 1, '已打开后不应重复打开');
});

test('client headless: 面板注册带 inject 工厂，向组件注入 sessionId（数据面定位工作区的官方姿势）', () => {
    const { exports } = loadClientBundle();
    const { ctx, injected, registered } = makeCtxStub();
    exports.apply(ctx);
    for (const { fn } of injected) fn();

    const pane = registered.find((r) => r.meta.name === 'sidebar.right.pane.tab');
    assert.ok(pane, '必须注册 tab 面板');
    assert.equal(typeof pane.meta.inject, 'function',
        '面板注册必须带 inject 工厂 —— 这是拿到 sessionId 的唯一官方姿势（对齐 dsh-client-ui-sidebar-documentpreview）');

    const props = pane.meta.inject('sess-42', { open() {} });
    assert.equal(props.sessionId, 'sess-42', 'inject 工厂必须把 sessionId 交给组件（数据面靠它定位工作区）');
    assert.ok('actions' in props, 'inject 工厂必须回传 actions，供面板触发导航动作');

    const title = registered.find((r) => r.meta.name === 'sidebar.right.pane.tab.title');
    assert.equal(title.meta.inject, undefined, 'chip 标题不需要会话上下文，不应挂 inject 工厂');
});

test('client headless: 面板版本号与 package.json 同步（防版本漂移）', () => {
    const { exports } = loadClientBundle();
    const pkg = JSON.parse(fs.readFileSync('./package.json', 'utf8'));
    assert.equal(exports.__internals.PLUGIN_VERSION, pkg.version,
        'client.js 的 PLUGIN_VERSION 必须等于 package.json 的 version —— '
        + '面板写死旧版本号是真实发生过的漂移（0.3.0 硬编码一路挂到 0.3.3），这条断言就是防线');
});

test('client headless: probeRemote —— 域清单 / $host / list 形态降级 / 错误聚合', async () => {
    const { exports } = loadClientBundle();
    const probe = exports.__internals.probeRemote;

    // a) ctx.remote 缺席（inject 未生效）→ 给出可读 fatal，绝不抛
    const noRemote = await probe(null, 's1');
    assert.ok(noRemote.fatal && noRemote.fatal.includes('ctx.remote'), 'remote 缺席必须给出可读 fatal');

    // b) remote 在但没有 workspaceFiles 域 → 明确报出来
    const noWf = await probe({}, 's1');
    assert.ok(noWf.rootError && noWf.rootError.includes('workspaceFiles'), '缺 workspaceFiles 域必须报出');

    // c) 有 workspaceFiles 但没有 sessionId → 不猜路径，直接报无法定位
    const noSession = await probe({ workspaceFiles: {} }, null);
    assert.ok(noSession.rootError && noSession.rootError.includes('sessionId'), '无 sessionId 必须明确报出');

    // d) 域清单滤掉 $ 开头的内部成员，$host 事实带出
    //    注意：返回值是 vm realm 里造的对象，原型与 node realm 不同，需先拉回再严格比较。
    const named = await probe({ $host: { home: '/h', isLoopback: true }, workspaceFiles: {} }, 's1');
    assert.deepEqual(Array.from(named.domains), ['workspaceFiles'], '域清单必须滤掉 $ 前缀的内部成员（$host/$stream/$mount/$on）');
    assert.deepEqual({ ...named.host }, { home: '/h', isLoopback: true }, '$host 的 home / isLoopback 必须带出');

    // e) 第一种调用形态失败、第二种成功 → 降级到能用的形态，并记下 via
    const calls = [];
    const wf = {
        list: (...args) => {
            calls.push(args);
            if (calls.length === 1) return Promise.resolve({ ok: false, error: { code: 'gateway/bad-request' } });
            return Promise.resolve({ ok: true, value: { path: '', entries: [{ name: '设定', type: 'directory' }], truncated: false } });
        },
    };
    const degraded = await probe({ workspaceFiles: wf }, 's1');
    assert.ok(degraded.rootEntries, '第二种形态成功时必须拿到目录');
    assert.equal(calls.length, 2, '第一次失败后必须继续尝试下一种形态');
    assert.ok(degraded.rootEntries.via.includes('path'), '必须记下命中的调用形态，便于一次性收敛到正确写法');

    // f) 形态全失败 → 不伪造数据，错误里带原始错误码与尝试次数（诊断价值）
    const allFail = await probe({
        workspaceFiles: { list: () => Promise.resolve({ ok: false, error: { code: 'gateway/internal', message: 'boom' } }) },
    }, 's1');
    assert.equal(allFail.rootEntries, null, '全失败时不得伪造目录');
    assert.ok(allFail.rootError.includes('gateway/internal'), '错误必须原样带回错误码');
    assert.ok(allFail.rootError.includes('四'), '错误必须说明试了几种形态');

    // g) list 直接抛异常也要被吞进诊断，不能冒泡打断面板
    const throwing = await probe({
        workspaceFiles: { list: () => { throw new Error('kaboom'); } },
    }, 's1');
    assert.ok(throwing.rootError.includes('kaboom'), '抛错也要聚合进诊断，不能冒泡');
});
