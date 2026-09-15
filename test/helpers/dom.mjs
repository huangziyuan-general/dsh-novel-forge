// test/helpers/dom.mjs — headless 装载体：在 node 里真跑 lib/client.js 的 apply()。
//
// 历史教训（0.4.x）：client 测试曾写成 `assert.ok(code.includes('mountSidebarEntry'))`
// 这类**字符串断言**，于是「插一次就被 React 冲掉、之后永不自愈」这个真 bug
// 一路 77/77 全绿、真机入口整个消失。所以这里给出可执行的替身：
// 真跑 apply()，断言**实际注册了什么、实际打了哪些请求**。
//
// 0.5.0 起入口换成右侧栏 tab（不再往左侧栏注入 DOM），装载体相应改为：
//   · 记录 sidebarRightTabs.register / slots.register 的实参
//   · openTab 可控（抛错 = seat 未挂载）
//   · ctx.sessions.list 给当前会话
//   · 记账式假定时器（不真跑，测试手动 flush）
//
// ★ 替身必须镜像**宿主真机**，不是镜像我们自己的实现：
//   · `react` 有 hooks，但**没有 createRoot**（真机 createRoot 只在 react-dom/client）
//   · `ctx.slots.inject(name, cb)` 是官方写法（等 seat 可用再注册）
//   · `ctx.effect(fn)` 语义是「立刻执行 fn，fn 的**返回值**登记为清理函数」
import fs from 'node:fs';
import vm from 'node:vm';

// ── 极简 DOM（panel.js 的 attach() 要往容器上挂事件代理） ──

function matchSimple(el, sel) {
    const m = sel.match(/^([a-zA-Z0-9]*)\[([a-zA-Z0-9-]+)([*^$]?)="([^"]*)"\]$/);
    if (m) {
        const [, tag, attr, op, val] = m;
        if (tag && el.tagName.toLowerCase() !== tag.toLowerCase()) return false;
        const actual = el.attrs[attr];
        if (actual === undefined) return false;
        if (op === '*') return String(actual).includes(val);
        if (op === '^') return String(actual).startsWith(val);
        return String(actual) === val;
    }
    const m2 = sel.match(/^([a-zA-Z0-9]*)\[([a-zA-Z0-9-]+)\]$/);
    if (m2) {
        const [, tag, attr] = m2;
        if (tag && el.tagName.toLowerCase() !== tag.toLowerCase()) return false;
        return el.attrs[attr] !== undefined;
    }
    if (sel.startsWith('.')) return (el.attrs.class || '').split(/\s+/).includes(sel.slice(1));
    // `#id`：真机当然支持，替身也必须支持 —— 否则「查到已有 <style> 就收养」这条
    // 单例逻辑在测试里恒走不到（每次都插第二份）。又一次「替身比真机窄」的坑。
    if (sel.startsWith('#')) return el.id === sel.slice(1);
    return el.tagName.toLowerCase() === sel.toLowerCase();
}
function matchesSelector(el, selector) {
    return selector.split(',').map((s) => s.trim()).some((s) => matchSimple(el, s));
}
function walk(el, out = []) {
    for (const c of el.children) { out.push(c); walk(c, out); }
    return out;
}

export class El {
    constructor(tag) {
        this.tagName = tag.toUpperCase();
        this.nodeType = 1;
        this.attrs = {};
        this.children = [];
        this.parentElement = null;
        this.style = { cssText: '' };
        this._html = '';
        this._listeners = {};
        const self = this;
        this.dataset = new Proxy({}, {
            set(_, k, v) {
                self.attrs['data-' + String(k).replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())] = String(v);
                return true;
            },
            get(_, k) {
                return self.attrs['data-' + String(k).replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())];
            },
            has(_, k) { return ('data-' + String(k).replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())) in self.attrs; },
        });
    }
    set innerHTML(v) { this._html = v; this.children = []; }
    get innerHTML() { return this._html; }
    get isConnected() { let n = this; while (n.parentElement) n = n.parentElement; return n.__isRoot === true; }
    matches(sel) { return matchesSelector(this, sel); }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return this.attrs[k] ?? null; }
    addEventListener(t, fn) { (this._listeners[t] ||= []).push(fn); }
    removeEventListener(t, fn) {
        const list = this._listeners[t];
        if (!list) return;
        const i = list.indexOf(fn);
        if (i >= 0) list.splice(i, 1);
    }
    /** 按事件类型派发一次，**沿 parentElement 链冒泡**（容器级代理靠它命中）。 */
    dispatch(type, event = {}) {
        let node = this;
        while (node) {
            for (const fn of [...(node._listeners[type] ?? [])]) {
                fn({ preventDefault() {}, stopPropagation() {}, target: this, ...event });
            }
            node = node.parentElement;
        }
    }
    click() { this.dispatch('click'); }
    get firstElementChild() { return this.children[0] ?? null; }
    append(...nodes) { for (const n of nodes) { n.parentElement = this; this.children.push(n); } }
    prepend(...nodes) { for (const n of nodes) { n.parentElement = this; this.children.unshift(n); } }
    appendChild(n) { this.append(n); return n; }
    remove() {
        const p = this.parentElement;
        if (p) { const i = p.children.indexOf(this); if (i >= 0) p.children.splice(i, 1); }
        this.parentElement = null;
    }
    insertBefore(node, anchor) {
        if (node.parentElement) node.remove();
        node.parentElement = this;
        const at = anchor ? this.children.indexOf(anchor) : -1;
        if (at < 0) this.children.push(node); else this.children.splice(at, 0, node);
        return node;
    }
    querySelector(sel) { return walk(this).find((e) => matchesSelector(e, sel)) ?? null; }
    querySelectorAll(sel) { return walk(this).filter((e) => matchesSelector(e, sel)); }
    closest(sel) { let n = this; while (n) { if (matchesSelector(n, sel)) return n; n = n.parentElement; } return null; }
    contains(n) { return n === this || walk(this).includes(n); }
    get title() { return this.attrs.title; } set title(v) { this.attrs.title = v; }
    get type() { return this.attrs.type; } set type(v) { this.attrs.type = v; }
    get className() { return this.attrs.class; } set className(v) { this.attrs.class = v; }
    get id() { return this.attrs.id; } set id(v) { this.attrs.id = String(v); }
}

/**
 * 建一个最小 document（够 panel.js 的 createElement / appendChild / 样式注入用）。
 *
 * **必须有 `head`**（真机有，替身就得有）：面板的交互态样式表由 css.js 注入到 head，
 * 替身少了 head 会让「注入」在真机能跑、在测试里静默走不到 —— 那就等于没测。
 */
export function createDom() {
    const head = new El('head');
    head.__isRoot = true;
    const body = new El('body');
    body.__isRoot = true;
    // 查询范围 = head 子树 + body 子树（等价于真机 document 的整棵树）
    const allNodes = () => [head, ...walk(head), body, ...walk(body)];
    const document = {
        head, body,
        createElement: (t) => new El(t),
        createElementNS: (_ns, t) => new El(t),
        getElementById: (id) => allNodes().find((e) => e.id === id) ?? null,
        querySelector: (sel) => allNodes().find((e) => matchesSelector(e, sel)) ?? null,
        querySelectorAll: (sel) => allNodes().filter((e) => matchesSelector(e, sel)),
    };
    class MutationObserver {
        constructor(cb) { this.cb = cb; }
        observe() {}
        disconnect() {}
    }
    return { document, MutationObserver, El, body };
}

/**
 * 宿主模块表替身 —— **必须镜像 dsh 真机**（官方 CHUNK_EXTERNALS）：
 *   react · react/jsx-runtime · react-dom · react-dom/client · cordis
 *
 * ★ `react` 提供 hooks（useState/useRef/useEffect…），但**不得**提供 createRoot
 *   —— 真机上 createRoot 只在 react-dom/client 里。0.4.2 的替身顺手给 react
 *   挂了 createRoot，把假前提固化成绿灯，真机「点一次没反应、再点一次空白」。
 */
function hostModuleTable() {
    const noopElement = () => null;
    const hooks = {
        useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
        useRef: (init) => ({ current: init }),
        useEffect: () => {},
        useCallback: (fn) => fn,
        useMemo: (fn) => fn(),
    };
    return {
        'react': {
            createElement: noopElement,
            Fragment: Symbol('Fragment'),
            Component: class { constructor(p) { this.props = p; } },
            ...hooks,
            // ⚠️ 故意不提供 createRoot —— react 核心包真没有
        },
        'react/jsx-runtime': { jsx: noopElement, jsxs: noopElement },
        'react-dom': {},
        'react-dom/client': {},
        'cordis': {},
    };
}

/** 记账式假定时器：只入队不真跑，测试手动 flush（时序断言才能确定性）。 */
function makeTimers() {
    let seq = 0;
    const queue = [];
    const cancelled = new Set();
    const setTimer = (fn, ms) => { const id = ++seq; queue.push({ id, fn, ms }); return id; };
    const clearTimer = (id) => { cancelled.add(id); };
    /** 跑若干轮定时器（每轮让 async 回调的 await 落地）。 */
    const flush = async (rounds = 10) => {
        for (let i = 0; i < rounds; i++) {
            const batch = queue.splice(0, queue.length).filter((t) => !cancelled.has(t.id));
            if (batch.length === 0) return;
            for (const t of batch) { try { t.fn(); } catch { /* 被测代码自己兜 */ } }
            await new Promise((resolve) => setImmediate(resolve));
        }
    };
    return { setTimer, clearTimer, flush, pending: () => queue.filter((t) => !cancelled.has(t.id)).length };
}

/**
 * 以 __ModuleLoader__ 语义加载 lib/client.js 并物化 exports。
 * @param {object} dom createDom() 的产物
 * @param {string|URL} bundlePath
 * @param {object} [opts]
 * @param {Function} [opts.fetch] 替换 fetch（默认返回空列表）
 * @param {object}   [opts.moduleOverrides] 覆盖宿主模块表（测降级路径）
 * @param {object}   [opts.sandboxExtra] 追加沙箱全局
 */
export function loadClient(dom, bundlePath, opts = {}) {
    const code = fs.readFileSync(bundlePath, 'utf8');
    const timers = makeTimers();
    const requests = [];
    let registration;
    const sandbox = {
        window: { __ModuleLoader__: { load: (r) => { registration = r; } } },
        document: dom.document,
        MutationObserver: dom.MutationObserver,
        setTimeout: timers.setTimer,
        clearTimeout: timers.clearTimer,
        fetch: opts.fetch ?? ((url, init) => {
            requests.push({ url, init });
            return Promise.resolve({ json: () => Promise.resolve({ ok: true, value: [] }) });
        }),
        console: { info: () => {}, warn: () => {}, error: () => {}, log: () => {} },
        ...(opts.sandboxExtra ?? {}),
    };
    sandbox.globalThis = sandbox;
    vm.runInContext(code, vm.createContext(sandbox));
    if (!registration) throw new Error('client.js 没有调用 __ModuleLoader__.load');
    const table = Object.assign(hostModuleTable(), opts.moduleOverrides ?? {});
    const required = [];
    const require = (spec) => {
        required.push(spec);
        if (!(spec in table)) throw new Error('宿主未播种模块 "' + spec + '"（宿主模块表里没有它）');
        return table[spec];
    };
    return { id: registration.id, exports: registration.factory(require), required, sandbox, timers, requests };
}

/**
 * 真实语义的 cordis ctx 替身。
 *
 * `effect(fn)`：**立刻执行 fn**，把 fn 的**返回值**登记为清理函数
 * （官方写法 `ctx.effect(() => () => {...清理...})`；写成 `(f) => f()` 与真机相反，
 * 会让「apply 里注册 disposer」这类改动测不出来）。
 *
 * @param {object} [opts]
 * @param {string|null} [opts.sessionId] 当前会话（ctx.sessions.list.current）
 * @param {boolean} [opts.openTabThrows] openTab 抛错（模拟 seat 尚未挂载）
 * @param {boolean} [opts.withoutSessions] 不给 sessions 服务（降级路径）
 */
export function makeCtx(opts = {}) {
    const cleanups = [];
    const registered = { tabs: [], slots: [] };
    const opened = [];
    const openTabOptions = [];
    let openTabThrows = opts.openTabThrows === true;

    const listeners = [];
    const listFace = {
        getSnapshot: () => ({ current: opts.sessionId ?? null }),
        subscribe: (fn) => { listeners.push(fn); return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); }; },
    };

    const ctx = {
        // 服务面
        effect: (fn) => {
            const cleanup = fn();                       // 立刻执行
            if (typeof cleanup !== 'function') return () => {};
            cleanups.push(cleanup);
            let done = false;
            return () => { if (done) return; done = true; cleanup(); };
        },
        slots: {
            register: (spec, component) => { registered.slots.push({ spec, component }); return () => {}; },
            inject: (_name, cb) => cb(),                // 官方写法：等 seat 可用再注册
        },
        sidebarRightTabs: {
            register: (definition) => { registered.tabs.push(definition); return () => {}; },
        },
        sidebarRight: {
            openTab: (kind, options) => {
                if (openTabThrows) throw new Error('seat not mounted');
                opened.push(kind);
                openTabOptions.push(options);
            },
        },
        // 内部抓手
        _registered: registered,
        _opened: opened,
        _openTabOptions: openTabOptions,
        _listeners: listeners,
        _setOpenTabThrows: (v) => { openTabThrows = v; },
        _setSession: (id) => { opts.sessionId = id; for (const fn of [...listeners]) fn(); },
        _listFace: listFace,
    };
    if (opts.withoutSessions !== true) ctx.sessions = { list: listFace };
    // 有些实现走 snapshot() 形态 —— 留一个开关方便测兜底分支
    if (opts.sessionsShape === 'fn') ctx.sessions = { list: { snapshot: () => ({ current: opts.sessionId ?? null }) } };
    if (opts.sessionsShape === 'bare') ctx.sessions = { list: { current: opts.sessionId ?? null } };

    return { ctx, registered, opened, cleanups, dispose: () => { for (const fn of cleanups.splice(0)) fn(); } };
}
