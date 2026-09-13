// test/client.test.mjs — 浏览器 client-half 的 headless 注册契约测试。
//
// 背景：浏览器半无法在假 ctx 里做完整 React 挂载，此前只能守 package.json 结构。
// 这里更进一步：用 node:vm 以 __ModuleLoader__ 的真实语义加载 lib/client.js，
// 物化出 { inject, apply }，再用一个 slots/effect stub 跑 apply(ctx)，
// 断言它按正确的 API 形状、注册进右侧栏两个槽位（tab 面板 + tab 标题）。
// 这样即便没有浏览器，也能确定性验证 client 产物 load 不炸、注册调用正确——
// 是"假 ctx 载不了浏览器半"之外的、可命令复现的门禁。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

/** 用 __ModuleLoader__ 语义执行 lib/client.js，返回物化的模块 exports。 */
function loadClientBundle() {
    const code = fs.readFileSync('./lib/client.js', 'utf8');
    let registration;
    const sandbox = {
        window: {
            __ModuleLoader__: {
                load: (reg) => { registration = reg; },
            },
        },
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
    return registration.factory(require);
}

/** 记录注册调用的 slots/effect stub（对齐 cordis ctx 的 apply 姿势）。 */
function makeCtxStub() {
    const injected = [];
    const registered = [];
    const tabTypes = [];
    const ctx = {
        slots: {
            inject: (name, fn) => { injected.push({ name, fn }); return fn; },
            register: (meta, comp) => { registered.push({ meta, comp }); },
        },
        sidebarRightTabs: { register: (def) => { tabTypes.push(def); return () => {}; } },
        effect: (fn) => fn(),
    };
    return { ctx, injected, registered, tabTypes };
}

test('client headless: 通过 __ModuleLoader__ 语义加载，inject 声明 slots+sidebarRightTabs 服务', () => {
    const exports = loadClientBundle();
    // 注意：exports.inject 是 vm realm 里建的数组，原型不同于 node，需 Array.from 拉回
    assert.deepEqual(Array.from(exports.inject).sort(), ['sidebarRightTabs', 'slots'],
        '模块必须声明 inject=["slots","sidebarRightTabs"]');
    assert.equal(typeof exports.apply, 'function', '模块必须导出 apply(ctx)');
});

test('client headless: apply() 先注册 tab 类型，再注册面板与标题 seat（id/key 同源）', () => {
    const { apply } = loadClientBundle();
    const { ctx, injected, registered, tabTypes } = makeCtxStub();
    apply(ctx);
    // ① 必须注册右侧栏 tab 类型（没有它就不会有 tab 入口）
    assert.equal(tabTypes.length, 1, 'apply() 必须调用 sidebarRightTabs.register 恰好一次');
    const def = tabTypes[0];
    assert.equal(def.id, 'novel-forge', 'tab 类型 id 必须为 novel-forge');
    assert.equal(def.kind, 'novel-forge', 'tab 类型 kind 必须唯一且稳定');
    assert.equal(typeof def.title, 'function', 'tab 类型必须带 title()');
    assert.equal(def.title(), '锻炉', 'tab 标题必须为 锻炉');
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