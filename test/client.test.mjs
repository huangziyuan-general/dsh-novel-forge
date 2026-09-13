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

test('client headless: 通过 __ModuleLoader__ 语义加载，inject 声明 slots + sidebarRightTabs + sidebarRight + remote + remote.workspaceFiles', () => {
    const { exports } = loadClientBundle();
    // 注意：exports.inject 是 vm realm 里建的数组，原型不同于 node，需 Array.from 拉回
    assert.deepEqual(Array.from(exports.inject).sort(),
        ['remote', 'remote.workspaceFiles', 'sidebarRight', 'sidebarRightTabs', 'slots'],
        '模块必须声明 inject=["slots","sidebarRightTabs","sidebarRight","remote","remote.workspaceFiles"]'
        + '（打开 tab 要导航面；数据面要 remote + 其 workspaceFiles 子域显式声明）');
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

    // e) list 的真实契约（@deepseek-ai/dsh-api-workspace-files）：
    //    list(sessionId, path, signal?) —— path 必填非空，**且只能列会话工作区内的路径**。
    //    根路径只能用工作区相对根 "."；绝不能用 $host.home —— home 是 Host 机器家目录，
    //    通常正是工作区根的父目录，Host 会以 workspace-file/outside-workspace 拒绝。
    const calls = [];
    const wfReal = {
        list: (...args) => {
            calls.push(args);
            if (args[1] === '.') {
                return Promise.resolve({ ok: true, value: { path: '', entries: [{ name: '星海拾骨', type: 'directory' }], truncated: false } });
            }
            // 真实 Host 对工作区外路径的答复
            return Promise.resolve({ ok: false, error: { code: 'workspace-file/outside-workspace', message: `"${args[1]}" is outside the workspace` } });
        },
    };
    const gotRoot = await probe({ $host: { home: '/Users/someone', isLoopback: false }, workspaceFiles: wfReal }, 's1');
    assert.ok(gotRoot.rootEntries, '工作区相对根 "." 必须列出成功');
    assert.equal(calls[0][1], '.', '第一个尝试必须是工作区相对根 "."，而不是 $host.home');
    assert.ok(gotRoot.rootEntries.via.includes('"."'), '必须记下命中的调用形态，便于后续收敛');
    assert.equal(gotRoot.rootEntries.listing.entries[0].name, '星海拾骨', '根目录应列出书目目录');

    // e2) 回归防线：把 $host.home 当 list 根必然被 Host 拒绝——v0.3.4~0.3.6 接真实
    //     环境 100% 失败的真因；本地 mock 里 home 恰好等于工作区根才导致"全绿但接不上"。
    const homeCalls = [];
    const wfHomeOnly = {
        list: (...args) => {
            homeCalls.push(args);
            return Promise.resolve({ ok: false, error: { code: 'workspace-file/outside-workspace', message: `"${args[1]}" is outside the workspace` } });
        },
    };
    const homeProbe = await probe({ $host: { home: '/Users/someone', isLoopback: false }, workspaceFiles: wfHomeOnly }, 's1');
    assert.equal(homeProbe.rootEntries, null, 'home 作根必失败，不得伪造目录');
    assert.ok(!homeCalls.some((a) => a[1] === '/Users/someone'), '不得再把 $host.home 当作 list 根路径');

    // f) 形态全失败 → 不伪造数据，错误里带原始错误码（诊断价值）
    const allFail = await probe({
        workspaceFiles: { list: () => Promise.resolve({ ok: false, error: { code: 'gateway/internal', message: 'boom' } }) },
    }, 's1');
    assert.equal(allFail.rootEntries, null, '全失败时不得伪造目录');
    assert.ok(allFail.rootError.includes('gateway/internal'), '错误必须原样带回错误码');
    assert.ok(allFail.rootError.includes('工作区'), '错误必须点明工作区边界这一约束');

    // g) list 直接抛异常也要被吞进诊断，不能冒泡打断面板
    const throwing = await probe({
        workspaceFiles: { list: () => { throw new Error('kaboom'); } },
    }, 's1');
    assert.ok(throwing.rootError.includes('kaboom'), '抛错也要聚合进诊断，不能冒泡');
});

import { summarizeBook } from '../lib/book-console.js';

// ── 数据面：client 内联解析与 lib/book-console.js 的 parity ────────────────────
test('数据面 parity: client 内联 summarizeBookClient 与服务端 summarizeBook 同口径', () => {
    const { exports } = loadClientBundle();
    const sc = exports.__internals.summarizeBookClient;
    assert.equal(typeof sc, 'function', '__internals 必须导出 summarizeBookClient');

    const samples = [
        {
            name: '星尘小记',
            novel: JSON.stringify({
                title: '星尘小记', genre: '玄幻', stage: 'drafting',
                approvals: { outline: { 1: 't', 2: 't' } },
                chapters: { 1: { title: 'a', versions: [1] }, 2: { title: 'b', versions: [1] } },
                cast: ['林晚'],
            }),
            facts: JSON.stringify([{ entity: '林晚', key: '境界', value: '筑基三层', chapter: 2 }]),
            foreshadows: JSON.stringify([
                { id: 'F1', setup: '雾', chapter: 1, plan: 2, payoffChapter: null },
            ]),
            style: JSON.stringify({ book: '星尘小记', chapters: 2, baseline: { dims: { syntax: { mu: 4 } } }, builtAt: 't' }),
        },
        { name: '空壳', novel: null, facts: null, foreshadows: null, style: null },
        {
            name: '坏书',
            novel: '{ not json',
            facts: '[]',
            foreshadows: null,
            style: JSON.stringify({ baseline: { dims: {} } }),
        },
    ];
    for (const s of samples) {
        const theirs = summarizeBook({ name: s.name, novel: s.novel, facts: s.facts, foreshadows: s.foreshadows, style: s.style });
        const ours = sc({ name: s.name, novel: s.novel, facts: s.facts, foreshadows: s.foreshadows, style: s.style });
        // 两种实现只对齐面板要展示的量化字段口径
        assert.equal(ours.title, theirs.title, `title 口径(${s.name})`);
        assert.equal(ours.stage, theirs.stage, `stage 口径(${s.name})`);
        assert.equal(ours.chapters, theirs.chapters, `chapters 口径(${s.name})`);
        assert.equal(ours.approved, theirs.approved, `approved 口径(${s.name})`);
        assert.equal(ours.facts, theirs.facts, `facts 口径(${s.name})`);
        assert.equal(ours.foreshadows.total, theirs.foreshadows.total, `foreshadows.total 口径(${s.name})`);
        assert.equal(ours.foreshadows.open, theirs.foreshadows.open, `foreshadows.open 口径(${s.name})`);
        assert.equal(ours.styleBuilt, theirs.style.built, `styleBuilt 口径(${s.name})`);
    }
});

// ── 读盘探针：多形态 read 收敛 + 降级 ──────────────────────────────────────
test('数据面 probeReadBook: read 命中形态即取文本并parse出摘要', async () => {
    const { exports } = loadClientBundle();
    const prb = exports.__internals.probeReadBook;
    const S = {
        novel: JSON.stringify({ title: '灰谷', genre: '悬疑', stage: 'outline', approvals: { outline: {} }, chapters: {} }),
        facts: JSON.stringify([{ entity: '伊', key: '位置', value: '灰谷', chapter: 1 }]),
        foreshadows: JSON.stringify([{ id: 'F1', setup: '雾', chapter: 1, plan: 3, payoffChapter: null }]),
        style: JSON.stringify({ book: '灰谷', chapters: 0, baseline: { dims: {} }, builtAt: 't' }),
    };
    // 命中官方契约形态 read(sessionId, path, range, signal?) —— range 是必填对象；
    // 返回 WorkspaceFileText 对象（非裸字符串），absolutePath 是"确实读到盘"的凭证。
    let calls = [];
    const wf = { read: async (sid, path, range) => {
        calls.push({ sid, path, range });
        if (!range || typeof range !== 'object') {
            // 真实 Remote 面对缺参的答复：装配错误（arity）直接 reject
            throw new Error('assembly fault: read() expects (sessionId, path, range, signal?)');
        }
        const name = path.split('/').pop();
        const text = name === 'novel.json' ? S.novel
            : name === 'facts.json' ? S.facts
            : name === '伏笔.json' ? S.foreshadows
            : name === 'style-baseline.json' ? S.style
            : null;
        if (text === null || sid !== 's1') return { ok: false, error: { code: 'workspace-file/not-found' } };
        return { ok: true, value: { offset: 1, text, lines: 3, eof: true, absolutePath: '/ws/' + path, version: 'v1' } };
    } };
    const out = await prb(wf, 's1', '灰谷');
    assert.equal(out.summary.title, '灰谷');
    assert.equal(out.summary.stage, 'outline');
    assert.equal(out.summary.facts, 1);
    assert.equal(out.summary.foreshadows.open, 1);
    assert.equal(out.summary.styleBuilt, true);
    assert.equal(out.readError, null, '四文件都应命中，不得有读取失败');
    assert.equal(out.files.novel, S.novel);
    assert.equal(out.readForm, 'novel@0', '应命中官方形态 (sessionId, path, range, signal?) 并以 novel 记录');
    assert.ok(calls.every((c) => c.range && typeof c.range === 'object'), '每次 read 都必须带 range 对象（缺参会被 arity 拒）');
    assert.equal(out.absPath, '/ws/灰谷/novel.json', '必须带出 Host 返回的绝对路径（读到盘的凭证）');
});

test('数据面 probeReadBook: 工作区根本身是书时路径不带前导斜杠', async () => {
    const { exports } = loadClientBundle();
    const prb = exports.__internals.probeReadBook;
    const paths = [];
    const wf = { read: async (sid, path, range) => {
        paths.push(path);
        return { ok: true, value: { offset: 1, text: '{}', lines: 1, eof: true, absolutePath: '/ws/' + path, version: 'v1' } };
    } };
    const out = await prb(wf, 's1', '');
    assert.ok(paths.length > 0, '必须发起读取');
    assert.ok(paths.includes('novel.json'), '应读工作区根下的 novel.json');
    // "/novel.json" 会被当作绝对路径而绕过工作区根，必须避免
    assert.ok(paths.every((p) => !p.startsWith('/')), '工作区根即书时路径不得带前导斜杠');
    assert.equal(out.book, '（工作区根即书）', '书名标签应标明这是工作区根本身');
});

test('数据面 loadBookConsole: 两态判定 + 非书目录预筛（不刷 not-found 噪声）', async () => {
    const { exports } = loadClientBundle();
    const lbc = exports.__internals.loadBookConsole;
    // 工作区根模拟：星海拾骨/ 是锻炉书（含 novel.json），dsh-novel-forge/ 是普通仓库目录
    const dirMap = {
        '星海拾骨': [{ name: 'novel.json', type: 'file' }, { name: '账本', type: 'directory' }],
        'dsh-novel-forge': [{ name: 'package.json', type: 'file' }, { name: 'lib', type: 'directory' }],
    };
    let readPaths = [];
    const remote = {
        workspaceFiles: {
            list: async (sid, path) => (dirMap[path]
                ? { ok: true, value: { path, entries: dirMap[path], truncated: false } }
                : { ok: false, error: { code: 'workspace-file/outside-workspace', message: 'nope' } }),
            read: async (sid, path, range) => {
                readPaths.push(path);
                return { ok: true, value: { offset: 1, text: '{}', lines: 1, eof: true, absolutePath: '/ws/' + path, version: 'v1' } };
            },
        },
    };
    // ② 根下是子目录 → 只把**含 novel.json 的**当书
    const books = await lbc(remote, 's1', { rootEntries: { listing: { entries: [
        { name: '星海拾骨', type: 'directory' },
        { name: 'dsh-novel-forge', type: 'directory' },
        { name: 'README.md', type: 'file' },
    ] } } });
    assert.equal(books.length, 1, '只把含 novel.json 的目录当书；普通文件与非书目录都跳过');
    assert.equal(books[0].book, '星海拾骨');
    assert.ok(!readPaths.some((p) => p.startsWith('dsh-novel-forge/')),
        '非书目录不得被读盘——否则每个目录盲读 4 次，刷满 workspace-file/not-found 噪声');
    assert.equal(books[0].readError, null, '真书不该有读盘失败');

    // ① 根下直接有 novel.json → 工作区根本就**是一本书**，只读这一本
    readPaths = [];
    const single = await lbc(remote, 's1', { rootEntries: { listing: { entries: [
        { name: 'novel.json', type: 'file' },
        { name: '账本', type: 'directory' },
    ] } } });
    assert.equal(single.length, 1, '工作区根即书时只读这一本，不再把同级目录当书');
    assert.equal(single[0].book, '（工作区根即书）');
    assert.ok(readPaths.every((p) => !p.startsWith('/')), '工作区根即书时路径不得带前导斜杠');
    assert.ok(readPaths.some((p) => p === 'novel.json'), '根即书应直读根下的 novel.json');

    // list 全失败（listing 缺席）→ 空数组，不伪造
    assert.deepEqual(Array.from(await lbc(remote, 's1', { rootEntries: null })), [], 'list 失败时不得伪造书目');
});

test('数据面 dirHasNovel: 任何异常都当"不是书"，绝不抛', async () => {
    const { exports } = loadClientBundle();
    const dhn = exports.__internals.dirHasNovel;
    const ok = { list: async () => ({ ok: true, value: { entries: [{ name: 'novel.json', type: 'file' }] } }) };
    assert.equal(await dhn(ok, 's1', 'a'), true, '含 novel.json 的目录应判为书');
    const noNovel = { list: async () => ({ ok: true, value: { entries: [{ name: 'package.json', type: 'file' }] } }) };
    assert.equal(await dhn(noNovel, 's1', 'a'), false, '不含 novel.json 判为非书');
    const boom = { list: async () => { throw new Error('gateway/internal'); } };
    assert.equal(await dhn(boom, 's1', 'a'), false, '抛错必须吞掉当非书');
    assert.equal(await dhn({}, 's1', 'a'), false, '无 list 方法当非书');
    assert.equal(await dhn(null, 's1', 'a'), false, 'wf 缺席当非书');
});

test('数据面 probeReadBook: 全部形态失败时降级、不伪造、带错误说明', async () => {
    const { exports } = loadClientBundle();
    const prb = exports.__internals.probeReadBook;
    const wf = { read: async () => { throw new Error('gateway/internal'); } };
    const out = await prb(wf, 's1', '灰谷');
    assert.equal(out.summary, null, '拿不到文件就不该有摘要');
    assert.ok(out.readError && out.readError.includes('gateway/internal'), '错误必须原样带回错误码');
    assert.equal(Object.keys(out.files).length, 0, '不得伪造文件');
});

test('数据面 probeReadBook: read 缺位时降级说明', async () => {
    const { exports } = loadClientBundle();
    const prb = exports.__internals.probeReadBook;
    const out = await prb({}, 's1', '灰谷');
    assert.equal(out.readError, 'workspaceFiles.read 不可用');
    assert.equal(out.summary, null);
});

test('数据面 probeReadBook: 可选文件缺失（style 未建基线）不报错、计正常摘要', async () => {
    const { exports } = loadClientBundle();
    const prb = exports.__internals.probeReadBook;
    const S = {
        novel: JSON.stringify({ title: 'X', genre: 'g', stage: 'planning', approvals: { outline: {} }, chapters: {} }),
        facts: JSON.stringify([{ entity: 'e', key: 'k', value: 'v', chapter: 1 }]),
        foreshadows: '[]',
    };
    const wf = { read: async (sid, path) => {
        if (path.endsWith('novel.json')) return { ok: true, value: { text: S.novel } };
        if (path.endsWith('facts.json')) return { ok: true, value: { text: S.facts } };
        if (path.endsWith('伏笔.json')) return { ok: true, value: { text: S.foreshadows } };
        // style-baseline.json 未建 → 服务端 not-found（抛错形态如实回来）
        if (path.endsWith('style-baseline.json')) throw new Error('workspace-file/not-found：no entry at "X/.novel/style-baseline.json"');
        throw new Error('unexpected path ' + path);
    } };
    const out = await prb(wf, 's1', 'X');
    assert.equal(out.readError, null, '可选 style 文件 not-found 不得进 readError');
    assert.ok(out.summary, 'novel 读到就有摘要');
    assert.equal(out.summary.styleBuilt, false, 'style 缺失 → styleBuilt=false');
    assert.equal(out.summary.facts, 1, 'facts 正常计入');
    assert.equal(out.summary.foreshadows.open, 0, '空的伏笔数组 → open 0');
});

test('数据面 probeReadBook: novel.json 读不到（必需）才报错、不造摘要', async () => {
    const { exports } = loadClientBundle();
    const prb = exports.__internals.probeReadBook;
    const wf = { read: async () => { throw new Error('workspace-file/not-found：no entry'); } };
    const out = await prb(wf, 's1', 'X');
    assert.ok(out.readError && out.readError.includes('novel'), 'novel 必需文件缺失必须报错');
    assert.equal(out.summary, null, 'novel 缺 → 不造幽灵书目');
});
