// test/server-api.test.mjs — REST 数据面（lib/server-api.js + createServerFsio）行为测试。
//
// 工具面早已有 smoke.test.mjs 的「全工具×真校验器」护栏，REST 半边此前零测试——
// 0.13.5/0.13.6 修的五处安全/一致性（fence 全覆盖 / workspace 白名单 / 章节号整数 /
// 写章审计 / writeText mode）全靠人肉复核。这里把这条链钉进 CI。
//
// 风格与替身语义对齐 smoke.test.mjs 的假 fs（同形状 targetKey / intent），但必须补齐
// smoke 替身缺的那一课：**按宿主真机语义真的拒绝**——
//   · createIfAbsent 撞上已存在 → 抛 FS_NOT_OBSERVED（smoke 已有）；
//   · replaceIfVersion 撞缺文件/版本不符 → 抛 FS_STALE_VERSION（smoke 没实现，这里必须实现，
//     否则 R5「create 必须响亮失败」测的是替身宽容，不是源码行为）。
// 宿主语义出处：@deepseek-ai/dsh-fs types.d.ts 的 FsWriteIntent 注释：
//   "createIfAbsent rejects an existing target with FS_NOT_OBSERVED;
//    replaceIfVersion rejects absence or mismatch with FS_STALE_VERSION.
//    Omitting the intent means unconditional create-or-overwrite."
//
// req/res 替身对齐 Node http 真机：
//   · req 是流：readJsonBody 靠 'data'/'end' 事件拿 body；真流在监听器挂上之前会**缓冲**
//     而不是丢事件——替身同理（事件在监听器注册后的下一个 macrotask 重放）；
//   · res.end 之后再 writeHead / end → 抛（Node 的 ERR_HTTP_HEADERS_SENT / already-finished
//     语义），防止 handler 双写响应在测试里静默通过。

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerServerApi } from '../lib/server-api.js';
import { createServerFsio } from '../lib/fsio.js';

const PREFIX = '/api/novel-forge';
const FENCE = 'x-dsh-novel-forge';

// ── R1 路由清单（护栏本体）──────────────────────────────────────────────
//
// **同步方式**：每条路由的入口条件都是 `req.method === '...' && segments[...] === '...'`，
// 且 trusted 检查是该分支第一行（`if (!trusted(req))`）。'R1-00' 用例从源码扫出
// `req.method ===` 条数与 `!trusted(req)` 条数，双双对齐本清单长度——将来加端点
// 漏写 fence（条数差一）或漏进清单，都会被这条断言当场抓住，清单不会烂掉。
const ROUTES = [
    { name: 'GET /projects（列表）', method: 'GET', url: `${PREFIX}/projects` },
    { name: 'POST /projects/claim', method: 'POST', url: `${PREFIX}/projects/claim` },
    { name: 'POST /projects（创建）', method: 'POST', url: `${PREFIX}/projects` },
    { name: 'GET /projects/:id', method: 'GET', url: `${PREFIX}/projects/护栏本` },
    { name: 'GET /projects/:id/elements', method: 'GET', url: `${PREFIX}/projects/护栏本/elements` },
    { name: 'GET /projects/:id/chapters', method: 'GET', url: `${PREFIX}/projects/护栏本/chapters` },
    { name: 'GET /projects/:id/chapters/:no', method: 'GET', url: `${PREFIX}/projects/护栏本/chapters/1` },
    { name: 'GET /projects/:id/continuity', method: 'GET', url: `${PREFIX}/projects/护栏本/continuity` },
    { name: 'GET /projects/:id/diagnose', method: 'GET', url: `${PREFIX}/projects/护栏本/diagnose` },
    { name: 'POST /projects/:id/chapters/:no（保存）', method: 'POST', url: `${PREFIX}/projects/护栏本/chapters/1` },
    { name: 'POST .../chapters/:no/write', method: 'POST', url: `${PREFIX}/projects/护栏本/chapters/1/write` },
    { name: 'POST .../chapters/:no/polish', method: 'POST', url: `${PREFIX}/projects/护栏本/chapters/1/polish` },
    { name: 'POST .../chapters/:no/proofread', method: 'POST', url: `${PREFIX}/projects/护栏本/chapters/1/proofread` },
    { name: 'POST /projects/:id/draft-batch', method: 'POST', url: `${PREFIX}/projects/护栏本/draft-batch` },
    { name: 'GET /projects/:id/proposals', method: 'GET', url: `${PREFIX}/projects/护栏本/proposals` },
    { name: 'GET /projects/:id/proposals/:pid', method: 'GET', url: `${PREFIX}/projects/护栏本/proposals/P1` },
    { name: 'POST /projects/:id/proposals/prune', method: 'POST', url: `${PREFIX}/projects/护栏本/proposals/prune` },
    { name: 'POST /projects/:id/proposals/:pid/apply', method: 'POST', url: `${PREFIX}/projects/护栏本/proposals/P1/apply` },
    { name: 'POST /projects/:id/proposals/:pid/discard', method: 'POST', url: `${PREFIX}/projects/护栏本/proposals/P1/discard` },
    { name: 'POST /projects/:id/export', method: 'POST', url: `${PREFIX}/projects/护栏本/export` },
    { name: 'DELETE /projects/:id', method: 'DELETE', url: `${PREFIX}/projects/护栏本` },
    { name: 'POST /projects/:id/rename', method: 'POST', url: `${PREFIX}/projects/护栏本/rename` },
    { name: 'POST /projects/:id/clone', method: 'POST', url: `${PREFIX}/projects/护栏本/clone` },
    { name: 'GET /worldbook/:bookId', method: 'GET', url: `${PREFIX}/worldbook/护栏本` },
    { name: 'POST /worldbook/:bookId', method: 'POST', url: `${PREFIX}/worldbook/护栏本` },
    { name: 'PUT /worldbook/:bookId/:entryId', method: 'PUT', url: `${PREFIX}/worldbook/护栏本/1` },
    { name: 'DELETE /worldbook/:bookId/:entryId', method: 'DELETE', url: `${PREFIX}/worldbook/护栏本/1` },
];

// ── 假 fs：覆盖临时目录，intent 语义镜像宿主 ─────────────────────────────

function insideAny(abs, roots) {
    return roots.some((r) => {
        const rel = path.relative(r, abs);
        return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    });
}

function makeFakeBackend({ allowWriteRoots, allowReadRoots }) {
    const versions = new Map();      // abs → 写次数（版本计数器）
    const writes = [];               // 全部写尝试（含被拒的），供审计断言用
    const versionOf = (abs) => `v${versions.get(abs) ?? 0}`;

    return {
        versions, writes,
        async resolve(p, opts) {
            const abs = path.isAbsolute(p) ? path.normalize(p) : path.resolve(opts?.cwd ?? process.cwd(), p);
            return { targetKey: `key:${abs}`, displayPath: abs };
        },
        async stat(target) {
            const abs = target.targetKey.slice(4);
            if (!insideAny(abs, allowReadRoots)) return undefined;   // 受控根之外 = 宿主不可见（安全降级，镜像 scan 对陌生根的跳过）
            try {
                const s = fs.statSync(abs);
                return s.isDirectory()
                    ? { version: versionOf(abs), type: 'directory', size: s.size }
                    : { version: versionOf(abs), type: s.isFile() ? 'file' : 'other', size: s.size };
            } catch {
                return undefined;
            }
        },
        async readText(target) {
            const abs = target.targetKey.slice(4);
            if (!insideAny(abs, allowReadRoots)) throw new Error(`FS_OUTSIDE_WORKSPACE: ${abs}`);
            return fs.readFileSync(abs, 'utf8');
        },
        async listDir(target) {
            const abs = target.targetKey.slice(4);
            if (!insideAny(abs, allowReadRoots)) throw new Error(`FS_OUTSIDE_WORKSPACE: ${abs}`);
            return fs.readdirSync(abs, { withFileTypes: true }).map((d) => ({
                name: d.name,
                type: d.isDirectory() ? 'directory' : (d.isFile() ? 'file' : 'other'),
            }));
        },
        async writeText(target, content, intent) {
            const abs = target.targetKey.slice(4);
            writes.push({ abs, intentKind: intent?.kind ?? 'unconditional', intent });
            if (!insideAny(abs, allowWriteRoots)) {
                const error = new Error(`FS_OUTSIDE_WORKSPACE: ${abs}`);
                error.code = 'FS_OUTSIDE_WORKSPACE';
                throw error;
            }
            const exists = fs.existsSync(abs);
            if (intent?.kind === 'createIfAbsent' && exists) {
                const error = new Error(`FS_NOT_OBSERVED: ${abs} 已存在`);
                error.code = 'FS_NOT_OBSERVED';
                throw error;
            }
            if (intent?.kind === 'replaceIfVersion') {
                if (!exists || versionOf(abs) !== intent.version) {
                    const error = new Error(`FS_STALE_VERSION: ${abs}（期望 ${intent.version}，实际 ${exists ? versionOf(abs) : '不存在'}）`);
                    error.code = 'FS_STALE_VERSION';
                    throw error;
                }
            }
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            const before = exists ? fs.readFileSync(abs, 'utf8') : null;
            fs.writeFileSync(abs, content);
            versions.set(abs, (versions.get(abs) ?? 0) + 1);
            return { operation: exists ? 'update' : 'create', version: versionOf(abs), before, after: content };
        },
    };
}

// ── req/res 替身（对齐 Node http 流语义）────────────────────────────────

class FakeReq extends EventEmitter {
    constructor({ method, url, headers, body }) {
        super();
        this.method = method;
        this.url = url;
        this.headers = {};
        for (const [k, v] of Object.entries(headers ?? {})) this.headers[k.toLowerCase()] = v;
        this._chunks = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))];
        this._cursor = 0;
        this._endSent = false;
        this.destroyed = false;
    }
    on(ev, fn) {
        super.on(ev, fn);
        if (ev === 'data' || ev === 'end') setImmediate(() => this._replay());   // 真流缓冲到监听器挂上才交付
        return this;
    }
    _replay() {
        while (this._cursor < this._chunks.length && this.listenerCount('data') > 0) {
            this.emit('data', this._chunks[this._cursor++]);
        }
        if (this._cursor === this._chunks.length && !this._endSent && this.listenerCount('end') > 0) {
            this._endSent = true;
            this.emit('end');
        }
    }
    destroy() { this.destroyed = true; }
}

class FakeRes {
    constructor() { this.statusCode = 0; this.headers = {}; this.body = ''; this.ended = false; }
    writeHead(status, headers) {
        if (this.ended) throw new Error('ERR_HTTP_HEADERS_SENT: res.end 之后不得再 writeHead');
        this.statusCode = status;
        Object.assign(this.headers, headers ?? {});
        return this;
    }
    end(data) {
        if (this.ended) throw new Error('ERR_STREAM_ALREADY_FINISHED: res.end 被调用两次');
        this.ended = true;
        this.body = data === undefined ? '' : String(data);
    }
    get json() { return JSON.parse(this.body); }
}

// ── 装载载体 ───────────────────────────────────────────────────────────

let root;               // 受控工作区根（= config.workspaceRoot）
let fakeHome;           // 假 home（扫描根推导的 sessions/projcache 源指到这里，测试封闭）
let backend;
let ctx;
let handler;

/** 驱动一次请求；fence 默认带（R1 用 fence:false 关掉）。返回 FakeRes。 */
async function drive(opts) {
    const headers = { ...(opts.headers ?? {}) };
    if (opts.fence !== false) headers[FENCE] = '1';
    const req = new FakeReq({ method: opts.method, url: opts.url, headers, body: opts.body });
    const res = new FakeRes();
    const running = handler(req, res);
    let timer;
    try {
        await new Promise((r) => setImmediate(() => setImmediate(r)));   // 让 body 事件有机会按流语义送达
        await Promise.race([
            running,
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('handler 5 秒未结束：body 事件可能没被消费')), 5000); }),
        ]);
    } finally {
        clearTimeout(timer);
    }
    assert.equal(res.ended, true, `${opts.method} ${opts.url}：handler 没有写响应就返回了`);
    return res;
}

function createBook(title = '护栏本', extra = {}) {
    return drive({ method: 'POST', url: `${PREFIX}/projects`, body: { title, ...extra } });
}

function readAudit(book) {
    const p = path.join(root, book, '.novel', 'audit.jsonl');
    if (!fs.existsSync(p)) return [];
    return fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
}

function walkFiles(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) walkFiles(abs, out); else out.push(abs);
    }
    return out;
}

before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-forge-rest-'));
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-forge-home-'));
    backend = makeFakeBackend({ allowWriteRoots: [root], allowReadRoots: [root] });
    const registrations = [];
    ctx = {
        fs: backend,
        emit() {},
        logger: { info() {} },
        inject: (_deps, fn) => { fn(ctx); },
        effect: (fn) => { const cleanup = fn(); return typeof cleanup === 'function' ? cleanup : () => {}; },
        webServer: { register: (def) => { registrations.push(def); return () => {}; } },
    };
    registerServerApi(ctx, { workspaceRoot: root, scanTopK: 8 }, { homedir: fakeHome });
    assert.equal(registrations.length, 1, 'registerServerApi 必须恰好注册一条 prefix 路由');
    assert.equal(registrations[0].kind, 'prefix');
    assert.equal(registrations[0].path, PREFIX);
    handler = registrations[0].handler;
});

after(() => {
    if (root !== undefined) fs.rmSync(root, { recursive: true, force: true });
    if (fakeHome !== undefined) fs.rmSync(fakeHome, { recursive: true, force: true });
});

// ── W：扫描根推导（Windows 真机「书在盘上、面板空」的根因回归）──────────
//
// 旧实现只从 ~/.dsh/sessions 目录名反推（`--Users-me-Doc-novel--` → /Users/me/Doc/novel），
// Windows 的 `D:\X` 反推成 `/D://X` 必然 statSync 失败被跳过 → 扫描根只剩进程 cwd →
// 书生成在盘上、面板永远空。新实现三源合并（全部经 statSync 验证）：
//   live sessions——dsh 0.1.5-rc.2 源码核过：服务在 base 层装载（dsh-base/cordis.patch.yml L34，
//     SessionStore list() 可调），但 store 由创建 fiber 持有 → 会话只在 agent 轮运行期间在册，
//     面板空闲期≈空（W2 锁代码分支、W4b 锁「服务存在即现算」；浏览器半的 ctx.sessions 是另一套网关服务）
//   projcache——持久主源，两代落盘形态都读（单文件 + 目录态 record.identity.cwd，无损跨平台），
//     缓存带内容签名失效（W4：新会话落盘即时进场）；
//   目录名反推——POSIX + Windows 盘符双候选兜底（W1/W3）。

test('W1 纯函数：projcache 解析——Windows cwd 原样取出，坏输入零崩溃', async () => {
    const { parseProjcacheRoots, parseProjcacheSessionFile, decodeSessionDirRoots } = await import('../lib/server-api.js');
    const win = parseProjcacheRoots(JSON.stringify({
        tables: { sessions: { a: { identity: { cwd: 'D:\\新建文件夹 (4)' } }, b: { identity: {} } } },
    }));
    assert.deepEqual(win, ['D:\\新建文件夹 (4)'], '★ Windows 盘符路径必须无损通过（旧目录名反推对它无能为力）');
    assert.deepEqual(parseProjcacheRoots('不是 JSON'), []);
    assert.deepEqual(parseProjcacheRoots('{}'), []);
    assert.deepEqual(parseProjcacheRoots(null), []);
    // 目录态分会话文件（dsh 0.1.5 起）：cwd 在 record.identity.cwd，Windows 真机只剩这一形态
    assert.deepEqual(
        parseProjcacheSessionFile(JSON.stringify({ version: 1, record: { identity: { cwd: 'D:\\新建文件夹 (4)' } } })),
        ['D:\\新建文件夹 (4)'], '★ 目录态 record.identity.cwd 必须无损取出');
    assert.deepEqual(parseProjcacheSessionFile(JSON.stringify({ identity: { cwd: '/Users/me/proj' } })),
        ['/Users/me/proj'], '旧宿主顶层 identity.cwd 兼容');
    assert.deepEqual(parseProjcacheSessionFile(JSON.stringify({ record: { identity: {} } })), [], '无 cwd → 空数组不抛');
    assert.deepEqual(parseProjcacheSessionFile('不是 JSON'), []);
    assert.deepEqual(parseProjcacheSessionFile(null), []);
    assert.deepEqual(decodeSessionDirRoots(['--Users-me-Doc-novel--']), ['/Users/me/Doc/novel'], 'POSIX 反推保持不变');
    const winKey = decodeSessionDirRoots(['--D-~65B0~5EFA~6587~4EF6~5939~0020~00284~0029--']);
    assert.deepEqual(winKey, ['D:\\新建文件夹 (4)', '/D/新建文件夹 (4)'], '★ Windows 真机 key（dsh 0.1.5-rc.2 实录：~XXXX escape 变体，:\\ 压成一个 -）必须反解出盘符形态——旧实现在这台机器上永远扫不到书');
    const winDrive = decodeSessionDirRoots(['--D-Users-zxc26-Desktop-tt-ai--']);
    assert.deepEqual(winDrive, ['D:\\Users\\zxc26\\Desktop\\tt\\ai', '/D/Users/zxc26/Desktop/tt/ai'], '全 ASCII 盘符 key 双形态候选，statSync 决定哪个生效');
    assert.ok(decodeSessionDirRoots(['--D--X--']).includes('/D//X'), 'Windows 反推 POSIX 形态如实产出（上层 statSync 会跳过）');
    assert.deepEqual(decodeSessionDirRoots('不是数组'), []);
    const { unescapeTildeHex } = await import('../lib/server-api.js');
    assert.equal(unescapeTildeHex('~65B0~5EFA~6587~4EF6~5939~0020~00284~0029'), '新建文件夹 (4)', 'escape 变体反解：~XXXX 四位十六进制，ASCII 字面字符原样保留');
    assert.equal(unescapeTildeHex(null), '');
});

test('W2 集成：live sessions 的 header.cwd 进扫描根——面板所在会话的书必可见', async () => {
    const { registerServerApi } = await import('../lib/server-api.js');
    const liveRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-forge-live-'));
    fs.mkdirSync(path.join(liveRoot, '直播书'));
    fs.writeFileSync(path.join(liveRoot, '直播书', 'novel.json'), JSON.stringify({ title: '直播书', stage: 'writing', sessions: [], chapters: {} }));
    const registrations = [];
    const liveCtx = {
        fs: makeFakeBackend({ allowWriteRoots: [root], allowReadRoots: [root, liveRoot] }),
        emit() {},
        logger: { info() {} },
        sessions: { list: () => [{ header: { cwd: liveRoot, id: 'sess-live' } }, { cwd: '不存在的路径' }] },
        inject: (_deps, fn) => { fn(liveCtx); },
        effect: (fn) => { const cleanup = fn(); return typeof cleanup === 'function' ? cleanup : () => {}; },
        webServer: { register: (def) => { registrations.push(def); return () => {}; } },
    };
    registerServerApi(liveCtx, { workspaceRoot: root, scanTopK: 8 }, { homedir: fakeHome });
    const liveHandler = registrations[0].handler;
    const origHandler = handler;   // drive() 用闭包里的 handler——临时换装
    handler = liveHandler;
    try {
        const res = await drive({ method: 'GET', url: `${PREFIX}/projects` });
        assert.equal(res.statusCode, 200);
        const names = res.json.value.map((x) => x.name);
        assert.ok(names.includes('直播书'), '★ live 会话工作区里的书必须进列表（命中窗口 = 会话 agent 轮运行中，正与本用例同构）');
        assert.ok(!names.some((n) => n === '不存在的路径'), '坏 cwd 只是跳过，不进列表');
    } finally {
        handler = origHandler;
        fs.rmSync(liveRoot, { recursive: true, force: true });
    }
});

test('W3 集成：projcache 的 Windows cwd 在 statSync 可达时进扫描根', async () => {
    // macOS 上造不出 D:\ 真目录——用 tmp 目录冒充「projcache 里的非活跃工作区」验证同一条通路
    const { registerServerApi } = await import('../lib/server-api.js');
    const ghostRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-forge-ghost-'));
    fs.mkdirSync(path.join(fakeHome, '.dsh', 'storages'), { recursive: true });
    fs.writeFileSync(path.join(fakeHome, '.dsh', 'storages', 'session_projcache.json'), JSON.stringify({
        tables: { sessions: { ghost: { identity: { cwd: ghostRoot } } } },
    }));
    fs.mkdirSync(path.join(ghostRoot, '幽灵书'));
    fs.writeFileSync(path.join(ghostRoot, '幽灵书', 'novel.json'), JSON.stringify({ title: '幽灵书', stage: 'writing', sessions: [], chapters: {} }));
    const registrations = [];
    const ghostCtx = {
        fs: makeFakeBackend({ allowWriteRoots: [root], allowReadRoots: [root, ghostRoot] }),
        emit() {},
        logger: { info() {} },
        inject: (_deps, fn) => { fn(ghostCtx); },
        effect: (fn) => { const cleanup = fn(); return typeof cleanup === 'function' ? cleanup : () => {}; },
        webServer: { register: (def) => { registrations.push(def); return () => {}; } },
    };
    registerServerApi(ghostCtx, { workspaceRoot: root, scanTopK: 8 }, { homedir: fakeHome });
    const ghostHandler = registrations[0].handler;
    const origHandler = handler;
    handler = ghostHandler;
    try {
        const res = await drive({ method: 'GET', url: `${PREFIX}/projects` });
        assert.equal(res.statusCode, 200);
        assert.ok(res.json.value.map((x) => x.name).includes('幽灵书'), '★ projcache 里的工作区必须进扫描根');
    } finally {
        handler = origHandler;
        fs.rmSync(ghostRoot, { recursive: true, force: true });
        fs.rmSync(path.join(fakeHome, '.dsh'), { recursive: true, force: true });   // 还原假 home，别的用例不受污染
    }
});

test('W3b 集成：目录态 projcache（record.identity.cwd）进扫描根——真机 Windows 只剩这形态', async () => {
    // Windows 真机（dsh 0.1.5-rc.2）实测：单文件 session_projcache.json 不存在，
    // 数据在 session_projcache/sessions/*.json 的 record.identity.cwd 里。旧实现只读单文件
    // → 源①静默归零 → 面板空。本用例只造目录态、绝不建单文件，锁死这条通路。
    const { registerServerApi } = await import('../lib/server-api.js');
    const dirRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-forge-dirpc-'));
    const sessDir = path.join(fakeHome, '.dsh', 'storages', 'session_projcache', 'sessions');
    fs.mkdirSync(sessDir, { recursive: true });
    fs.writeFileSync(path.join(sessDir, '8d36e786.json'), JSON.stringify({
        version: 1, record: { identity: { cwd: dirRoot } },
    }));
    fs.writeFileSync(path.join(sessDir, 'junk.json'), '不是 JSON');   // 坏文件不得阻断其余会话
    fs.mkdirSync(path.join(dirRoot, '目录书'));
    fs.writeFileSync(path.join(dirRoot, '目录书', 'novel.json'), JSON.stringify({ title: '目录书', stage: 'writing', sessions: [], chapters: {} }));
    const registrations = [];
    const dctx = {
        fs: makeFakeBackend({ allowWriteRoots: [root], allowReadRoots: [root, dirRoot] }),
        emit() {},
        logger: { info() {} },
        inject: (_deps, fn) => { fn(dctx); },
        effect: (fn) => { const cleanup = fn(); return typeof cleanup === 'function' ? cleanup : () => {}; },
        webServer: { register: (def) => { registrations.push(def); return () => {}; } },
    };
    registerServerApi(dctx, { workspaceRoot: root, scanTopK: 8 }, { homedir: fakeHome });
    const origHandler = handler;
    handler = registrations[0].handler;
    try {
        const res = await drive({ method: 'GET', url: `${PREFIX}/projects` });
        assert.equal(res.statusCode, 200);
        assert.ok(res.json.value.map((x) => x.name).includes('目录书'), '★ 目录态 projcache 的工作区必须进扫描根（单文件不存在时也不能空）');
    } finally {
        handler = origHandler;
        fs.rmSync(dirRoot, { recursive: true, force: true });
        fs.rmSync(path.join(fakeHome, '.dsh'), { recursive: true, force: true });
    }
});

test('W4 集成：新会话落盘 projcache 目录态即时进扫描根——内容签名失效，不等 60s TTL', async () => {
    // 真机时序：新建会话 → 宿主写 session_projcache/sessions/<id>.json（per-record 布局，dsh
    // 0.1.5-rc.2 源码核过）→ 该会话建书。旧实现持久源纯 TTL 缓存，新工作区要等 ≤60s 才进场
    // ——「新会话建书面板空」的真机路径由这条签名修消灭（2cbb6fc 曾以为靠 live 脱离 TTL 即可，
    // 但 store 由 fiber 持有、面板空闲期会话不在册，见 W4b 与 server-api 头部注释⓪）。
    // 本用例**刻意不给 sessions 服务**——镜像「面板空闲期发起请求」的真实时序；旧实现（纯 TTL、无签名）此用例必红。
    const { registerServerApi } = await import('../lib/server-api.js');
    const lateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-forge-late-'));
    fs.mkdirSync(path.join(lateRoot, '迟到书'));
    fs.writeFileSync(path.join(lateRoot, '迟到书', 'novel.json'), JSON.stringify({
        title: '迟到书', stage: 'writing', sessions: ['sess-2'], chapters: {},
    }));
    const registrations = [];
    const lctx = {
        fs: makeFakeBackend({ allowWriteRoots: [root], allowReadRoots: [root, lateRoot] }),
        emit() {},
        logger: { info() {} },
        inject: (_deps, fn) => { fn(lctx); },
        effect: (fn) => { const cleanup = fn(); return typeof cleanup === 'function' ? cleanup : () => {}; },
        webServer: { register: (def) => { registrations.push(def); return () => {}; } },
    };
    registerServerApi(lctx, { workspaceRoot: root, scanTopK: 8 }, { homedir: fakeHome });
    const origHandler = handler;
    handler = registrations[0].handler;
    const sessDir = path.join(fakeHome, '.dsh', 'storages', 'session_projcache', 'sessions');
    try {
        const first = await drive({ method: 'GET', url: `${PREFIX}/projects?session=sess-2` });
        assert.equal(first.statusCode, 200);
        assert.equal(first.json.value.length, 0, '前置：projcache 还没有该会话时书不可见（缓存刚落定，仍在 TTL 窗口内）');
        // 新会话落盘（同一 TTL 窗口内）：目录 mtime + entry 数双变 → 持久缓存必须立即作废
        fs.mkdirSync(sessDir, { recursive: true });
        fs.writeFileSync(path.join(sessDir, 'c1c34790.json'), JSON.stringify({
            version: 1, record: { identity: { cwd: lateRoot }, rows: {} },
        }));
        const second = await drive({ method: 'GET', url: `${PREFIX}/projects?session=sess-2` });
        assert.equal(second.statusCode, 200);
        assert.ok(second.json.value.map((x) => x.name).includes('迟到书'),
            '★ 目录态文件出现 → 该工作区必须不等 TTL 立即进扫描根（旧实现：纯 TTL，此处必红）');
    } finally {
        handler = origHandler;
        fs.rmSync(lateRoot, { recursive: true, force: true });
        fs.rmSync(path.join(fakeHome, '.dsh'), { recursive: true, force: true });
    }
});

test('W4b live 分支（代码路径）：live 不参与任何缓存——服务在册的窗口内新工作区即时进根', async () => {
    // 真机语义（dsh 0.1.5-rc.2 源码核过）：sessions 服务在 base 层装载（dsh-base/cordis.patch.yml
    // L34，SessionStore list() 可调），但 store 由创建 fiber 持有 → 命中窗口 = 拥有该工作区的
    // 会话 agent 轮正在运行（恰是「agent 刚把书建进新工作区、运行中面板刷新」的场景）。本用例用
    // 替身注入 live 数组，锁的是代码分支「live 每次现算、不进持久层缓存」。
    // （2cbb6fc 的老 W4 拿 live 锁空闲期即时性，前提不成立；空闲期真机收益由上面的签名修兑现。）
    const { registerServerApi } = await import('../lib/server-api.js');
    const liveRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-forge-liveb-'));
    fs.mkdirSync(path.join(liveRoot, '直播迟到书'));
    fs.writeFileSync(path.join(liveRoot, '直播迟到书', 'novel.json'), JSON.stringify({
        title: '直播迟到书', stage: 'writing', sessions: ['sess-3'], chapters: {},
    }));
    const liveSessions = [];   // 可变数组：测试中途「新会话上线」
    const registrations = [];
    const lctx = {
        fs: makeFakeBackend({ allowWriteRoots: [root], allowReadRoots: [root, liveRoot] }),
        emit() {},
        logger: { info() {} },
        sessions: { list: () => liveSessions },
        inject: (_deps, fn) => { fn(lctx); },
        effect: (fn) => { const cleanup = fn(); return typeof cleanup === 'function' ? cleanup : () => {}; },
        webServer: { register: (def) => { registrations.push(def); return () => {}; } },
    };
    registerServerApi(lctx, { workspaceRoot: root, scanTopK: 8 }, { homedir: fakeHome });
    const origHandler = handler;
    handler = registrations[0].handler;
    try {
        const first = await drive({ method: 'GET', url: `${PREFIX}/projects?session=sess-3` });
        assert.equal(first.statusCode, 200);
        assert.equal(first.json.value.length, 0, '前置：live 为空时该书不可见');
        liveSessions.push({ header: { cwd: liveRoot, id: 'sess-3' } });   // 新会话上线（同一 TTL 窗口内）
        const second = await drive({ method: 'GET', url: `${PREFIX}/projects?session=sess-3` });
        assert.equal(second.statusCode, 200);
        assert.ok(second.json.value.map((x) => x.name).includes('直播迟到书'),
            '★ live 会话的新工作区必须立即进扫描根（live 不进缓存——代码分支锁定）');
    } finally {
        handler = origHandler;
        fs.rmSync(liveRoot, { recursive: true, force: true });
        fs.rmSync(path.join(fakeHome, '.dsh'), { recursive: true, force: true });
    }
});

// ── H0：载体与替身自检（先证明替身会「真的拒绝」，后面所有断言才不作数于空转）──

test('H0 载体自检：假 fs 按宿主语义拒绝；列表端点可跑通', async () => {
    const target = { targetKey: `key:${path.join(root, 'H0.txt')}` };
    const created = await ctx.fs.writeText(target, '一份\n', { kind: 'createIfAbsent' });
    assert.equal(created.operation, 'create');
    await assert.rejects(() => ctx.fs.writeText(target, '覆盖\n', { kind: 'createIfAbsent' }), /FS_NOT_OBSERVED/,
        '替身必须像宿主一样拒绝 createIfAbsent 撞已存在');
    await assert.rejects(() => ctx.fs.writeText(target, '覆盖\n', { kind: 'replaceIfVersion', version: 'v-不匹配' }), /FS_STALE_VERSION/,
        '替身必须像宿主一样拒绝版本不符的 replaceIfVersion');
    const updated = await ctx.fs.writeText(target, '覆盖\n', { kind: 'replaceIfVersion', version: created.version });
    assert.equal(updated.operation, 'update');
    await assert.rejects(() => ctx.fs.writeText({ targetKey: `key:${path.join(os.tmpdir(), 'novel-forge-H0-外面.txt')}` }, 'x'), /FS_OUTSIDE_WORKSPACE/,
        '受控根之外的写必须炸（宿主沙箱语义）');

    const b1 = await createBook('列表书甲');
    assert.equal(b1.statusCode, 200);
    const b2 = await createBook('列表书乙', { session: 'sess-R' });
    assert.equal(b2.statusCode, 200);
    const list = await drive({ method: 'GET', url: `${PREFIX}/projects?scope=all` });
    assert.equal(list.statusCode, 200);
    assert.deepEqual(list.json.value.map((x) => x.name).sort(), ['列表书乙', '列表书甲']);
});

// ── R1：fence 全覆盖回归 ────────────────────────────────────────────────

test('R1-00 路由清单与源码计数同步（清单烂掉即红）', () => {
    const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'lib', 'server-api.js'), 'utf8');
    const methodChecks = src.match(/req\.method === '/g) ?? [];
    const trustedChecks = src.match(/!trusted\(req\)/g) ?? [];
    assert.equal(methodChecks.length, ROUTES.length,
        `源码里 req.method 路由条数（${methodChecks.length}）≠ 清单条数（${ROUTES.length}）——加了端点没进清单，R1 覆盖不了它`);
    assert.equal(trustedChecks.length, ROUTES.length,
        `源码 fence 检查条数（${trustedChecks.length}）≠ 路由条数（${ROUTES.length}）——有端点漏写 trusted(req)！`);
});

test('R1 fence 全覆盖：27 条路由逐个不带 fence 头 → 403 FORBIDDEN', async () => {
    for (const r of ROUTES) {
        const res = await drive({ method: r.method, url: r.url, fence: false, body: {} });
        assert.equal(res.statusCode, 403, `${r.name}：缺 fence 必须 403，实际 ${res.statusCode}`);
        assert.equal(res.json.error?.code, 'FORBIDDEN', `${r.name}：错误码应为 FORBIDDEN，实际 ${JSON.stringify(res.json)}`);
        assert.equal(res.json.ok, false);
    }
});

// ── R2：workspace 白名单（H4 修复）+ 非法书名 ──────────────────────────

test('R2a workspace 不在受控根集合 → 403 WORKSPACE_FORBIDDEN 且盘上无落点', async () => {
    const evilRoot = path.join(os.tmpdir(), `novel-forge-evil-${Date.now()}`);
    const res = await drive({ method: 'POST', url: `${PREFIX}/projects`, body: { title: '越界书', workspace: evilRoot } });
    assert.equal(res.statusCode, 403, `非法 workspace 必须 403，实际 ${res.statusCode}：${res.body}`);
    assert.equal(res.json.error?.code, 'WORKSPACE_FORBIDDEN');
    assert.equal(fs.existsSync(evilRoot), false, '403 之后绝不允许在非法根创建任何文件');
    assert.deepEqual(backend.writes.filter((w) => insideAny(w.abs, [evilRoot])), [], '假 fs 层面也不允许有任何写尝试落到非法根');
});

test('R2b 省略 workspace → 落在 config 根；显式传 config 根同样放行', async () => {
    const omitted = await createBook('落点甲');
    assert.equal(omitted.statusCode, 200, omitted.body);
    assert.equal(omitted.json.value.id, '落点甲');
    assert.ok(fs.existsSync(path.join(root, '落点甲', 'novel.json')), '缺省必须落 config.workspaceRoot');
    const meta = JSON.parse(fs.readFileSync(path.join(root, '落点甲', 'novel.json'), 'utf8'));
    assert.deepEqual(meta.sessions, [], '不带 session 不许凭空造归属');

    const explicit = await drive({ method: 'POST', url: `${PREFIX}/projects`, body: { title: '落点乙', workspace: root, session: 'sess-W' } });
    assert.equal(explicit.statusCode, 200, explicit.body);
    assert.ok(fs.existsSync(path.join(root, '落点乙', 'novel.json')));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, '落点乙', 'novel.json'), 'utf8')).sessions, ['sess-W']);
});

test('R2c 非法书名被拒（. / .. / .git / 含「/」/ 超 64 字）——拒绝且无落盘', async () => {
    const tooLong = '长'.repeat(65);
    // 期望的正确行为：不 200 就必须在盘上零副作用；200 也必须已被安全清洗成单层目录名。
    // assertBookName 的拒绝是**请求的问题**，必须 400 BAD_BOOK（曾经掉进外层 catch 变 500 IO_FAILURE）。
    for (const title of ['.', '..', '.git', tooLong]) {
        const res = await createBook(title);
        assert.notEqual(res.json.ok, true, `非法书名「${title.slice(0, 12)}…」竟然创建成功`);
        assert.equal(res.statusCode, 400, `非法书名「${title.slice(0, 12)}…」应 400，实际 ${res.statusCode}：${res.body}`);
        assert.equal(res.json.error?.code, 'BAD_BOOK', `错误码应为 BAD_BOOK，实际 ${JSON.stringify(res.json.error)}`);
    }
    for (const junk of ['..', '.git', tooLong]) {
        assert.equal(walkFiles(root).some((f) => path.basename(path.dirname(f)) === junk || path.basename(f) === junk), false,
            `非法名「${junk.slice(0, 12)}」不得在盘上留下任何文件`);
    }
    // 含「/」：实现是**先清洗后校验**（斜杠→下划线），正确期望 = 绝不产生嵌套路径
    const slash = await createBook('父/子');
    assert.equal(slash.statusCode, 200, slash.body);
    assert.equal(slash.json.value.id, '父_子', '「/」必须被清洗为单层安全名');
    assert.ok(fs.existsSync(path.join(root, '父_子', 'novel.json')));
    assert.equal(fs.existsSync(path.join(root, '父')), false, '绝不允许按斜杠拆成嵌套目录穿越工作区');
});

test('R2d 重复创建同名书 → 409 BOOK_EXISTS，原书 novel.json 一字未动', async () => {
    const first = await drive({ method: 'POST', url: `${PREFIX}/projects`, body: { title: '同名书', session: 'sess-keep' } });
    assert.equal(first.statusCode, 200, first.body);
    const metaPath = path.join(root, '同名书', 'novel.json');
    // 给原书造一点「不能被抹掉」的状态：章节索引 + 会话归属
    const mine = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    mine.chapters = { 1: { title: '第一章', latest: 3, versions: [1, 2, 3] } };
    fs.writeFileSync(metaPath, JSON.stringify(mine, null, 2));
    const before = fs.readFileSync(metaPath, 'utf8');

    const again = await drive({ method: 'POST', url: `${PREFIX}/projects`, body: { title: '同名书', session: 'sess-other' } });
    assert.equal(again.statusCode, 409, `同名书必须响亮拒绝，实际 ${again.statusCode}：${again.body}`);
    assert.equal(again.json.error?.code, 'BOOK_EXISTS', JSON.stringify(again.json.error));
    assert.equal(fs.readFileSync(metaPath, 'utf8'), before,
        '★ 二次创建不得覆盖 novel.json——用默认 auto 写会把章节索引/会话归属/阶段清成 defaultNovel，正文沦为孤儿');
});

// ── R3：章节号整数校验（0.13.6 修复）───────────────────────────────────

test('R3 POST chapters/:no 非正整数章节号 → 400，盘上无「第NaN章」、novel.json 无脏键', async () => {
    const created = await createBook('章号书');
    assert.equal(created.statusCode, 200);
    const metaPath = path.join(root, '章号书', 'novel.json');
    const before = fs.readFileSync(metaPath, 'utf8');

    for (const bad of ['abc', '1.5', '-2', '0', 'NaN', 'Infinity']) {
        const res = await drive({ method: 'POST', url: `${PREFIX}/projects/章号书/chapters/${encodeURIComponent(bad)}`, body: { title: '脏', text: '脏数据' } });
        assert.equal(res.statusCode, 400, `章节号「${bad}」必须 400，实际 ${res.statusCode}：${res.body}`);
        assert.equal(res.json.error?.code, 'BAD_CHAPTER', `章节号「${bad}」错误码应为 BAD_CHAPTER`);
    }
    assert.equal(fs.readFileSync(metaPath, 'utf8'), before, '400 之后 novel.json 必须一字未动');
    const meta = JSON.parse(before);
    for (const key of ['NaN', '-2', '0', '1.5', 'Infinity', 'abc']) {
        assert.equal(meta.chapters?.[key], undefined, `novel.json.chapters 不得出现键「${key}」`);
    }
    const strays = walkFiles(path.join(root, '章号书')).filter((f) => /第(NaN|-2|0|1\.5|Infinity|NaN)章/.test(path.basename(f)));
    assert.deepEqual(strays, [], `盘上不得出现脏章节文件：${strays.join(',')}`);
});

test('R3b GET chapters/:no 与 POST 同款守卫：脏章号 400，而不是静默返回空正文', async () => {
    const created = await createBook('守卫对称书');
    assert.equal(created.statusCode, 200);
    await drive({
        method: 'POST', url: `${PREFIX}/projects/守卫对称书/chapters/1`,
        body: { title: '第一章', text: '正文内容。' },
    });
    for (const bad of ['abc', '1.5', '-2', '0']) {
        const res = await drive({ method: 'GET', url: `${PREFIX}/projects/守卫对称书/chapters/${encodeURIComponent(bad)}` });
        assert.equal(res.statusCode, 400, `GET 章节号「${bad}」必须 400，实际 ${res.statusCode}`);
        assert.equal(res.json.error?.code, 'BAD_CHAPTER', `GET 章节号「${bad}」错误码应为 BAD_CHAPTER`);
        // 过去没有守卫：NaN 当键查 → 200 + 空串，看着像「这章是空的」，真相是请求写错了
        assert.notEqual(res.json.ok, true, '★ 不许用 200 空串掩盖参数错误');
    }
    const ok = await drive({ method: 'GET', url: `${PREFIX}/projects/守卫对称书/chapters/1` });
    assert.equal(ok.statusCode, 200, '合法章号照常读');
    assert.equal(ok.json.value, '正文内容。');
});

// ── R4：合法保存章节 → 审计链有 user 的一笔（H5 修复）──────────────────

test('R4 保存章节落盘正文 + novel.json 记账 + audit.jsonl 有 rest/chapter_save(actor=user)', async () => {
    const created = await createBook('审计书');
    assert.equal(created.statusCode, 200);

    const res = await drive({
        method: 'POST', url: `${PREFIX}/projects/审计书/chapters/1`,
        body: { title: '雨夜来客', text: '夜色像墨，她推开了义庄的门。' },
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.value.chapter.latest, 1);
    assert.ok(fs.existsSync(path.join(root, '审计书', '正文', '第1章-雨夜来客-v1.md')), '正文必须按版本化命名落盘');

    const meta = JSON.parse(fs.readFileSync(path.join(root, '审计书', 'novel.json'), 'utf8'));
    assert.equal(meta.chapters['1'].latest, 1, 'novel.json 章节索引必须更新');
    assert.ok(meta.chapters['1'].path.startsWith('审计书/'), 'chapterRelPath 语义：path 已含书目前缀');

    const rows = readAudit('审计书');
    const save = rows.find((r) => r.action === 'rest/chapter_save');
    assert.ok(save, `审计必须落 rest/chapter_save 一笔，实际 actions=${rows.map((r) => r.action).join(',')}`);
    assert.equal(save.actor, 'user', 'REST/面板通道审计 actor 必须是 user');
    assert.equal(save.chapter, 1);
    assert.equal(save.version, 1);
    assert.equal(typeof save.chars, 'number');

    // 第二版：旧版保留（改稿永远新增版本，不覆盖）
    const res2 = await drive({ method: 'POST', url: `${PREFIX}/projects/审计书/chapters/1`, body: { title: '雨夜来客', text: '改：夜色更浓。' } });
    assert.equal(res2.statusCode, 200, res2.body);
    assert.equal(res2.json.value.chapter.latest, 2);
    assert.ok(fs.existsSync(path.join(root, '审计书', '正文', '第1章-雨夜来客-v1.md')));
    assert.ok(fs.existsSync(path.join(root, '审计书', '正文', '第1章-雨夜来客-v2.md')));
    assert.equal(rows.length, readAudit('审计书').length - 1, '第二版应再各追加一条审计');
});

// ── R5：createServerFsio 的 mode 语义（H1 修复，REST 永不静默覆盖）──────

test('R5 createServerFsio：create 撞已存在响亮失败 / auto 走版本守卫 / replace 无条件 / writeJson 透传 mode', async () => {
    const fsio = createServerFsio(ctx, root);

    // (a) 目标不存在：'create' 成功
    await fsio.writeText('mode/新建.txt', '第一笔\n', 'create');
    assert.equal(await fsio.readText('mode/新建.txt'), '第一笔\n');

    // (b) 目标已存在：'create' 必须响亮失败且旧内容原样（不许静默覆盖）
    await assert.rejects(() => fsio.writeText('mode/新建.txt', '偷覆盖\n', 'create'), /FS_NOT_OBSERVED/,
        "'create' 撞已存在必须抛 FS_NOT_OBSERVED（0.13.6 前 mode 被丢弃 = 静默覆盖）");
    assert.equal(await fsio.readText('mode/新建.txt'), '第一笔\n', '被拒后旧内容必须原样');

    // (c) 'auto'：不存在 → createIfAbsent；已存在 → 带 stat 到的 version 做 replaceIfVersion
    backend.writes.length = 0;
    await fsio.writeText('mode/auto-新.txt', 'x', 'auto');
    assert.equal(backend.writes.at(-1).intentKind, 'createIfAbsent', "'auto' 在缺文件时按 createIfAbsent 新建");
    const vBefore = (await fsio.stat('mode/新建.txt')).info.version;
    await fsio.writeText('mode/新建.txt', '守卫生效\n', 'auto');
    assert.equal(backend.writes.at(-1).intentKind, 'replaceIfVersion', "'auto' 在已存在时必须走版本守卫");
    assert.equal(backend.writes.at(-1).intent.version, vBefore, '守卫用的必须是刚 stat 到的版本');
    assert.equal(await fsio.readText('mode/新建.txt'), '守卫生效\n');

    // 'replace' → 无条件（intent 缺省），这是唯一允许覆盖的通道
    await fsio.writeText('mode/新建.txt', '覆盖者\n', 'replace');
    assert.equal(backend.writes.at(-1).intentKind, 'unconditional', "'replace' 必须不带 intent");

    // 乐观并发原语：基线版本必须来自**读取那一刻**（writeTextIfVersion 那种「写前一刻
    // 自己 stat」已被删除 —— 版本永远匹配，拦不住读-改-写）
    const base = (await fsio.readTextWithVersion('mode/新建.txt')).version;
    await fsio.writeTextAtVersion('mode/新建.txt', '守卫二\n', base);
    assert.equal(backend.writes.at(-1).intentKind, 'replaceIfVersion');
    assert.equal(backend.writes.at(-1).intent.version, base, '守卫用的必须是读取时拿到的版本');
    await fsio.writeTextAtVersion('mode/atver-新.txt', '新\n', null);
    assert.equal(backend.writes.at(-1).intentKind, 'createIfAbsent', '读时不存在 → 只允许新建，被人抢建就该失败而不是覆盖');
    await assert.rejects(() => fsio.writeTextAtVersion('mode/atver-新.txt', '再写\n', null), /FS_NOT_OBSERVED/,
        '同一路径二次「以为它不存在」的写必须响亮失败');

    // (d) writeJson 透传 mode：'create' 撞已存在同样响亮失败
    await fsio.writeJson('mode/json.json', { a: 1 }, 'create');
    assert.equal(JSON.parse(await fsio.readText('mode/json.json')).a, 1);
    await assert.rejects(() => fsio.writeJson('mode/json.json', { a: 2 }, 'create'), /FS_NOT_OBSERVED/,
        'writeJson 不得吞掉 mode（0.13.6 回归防线）');
    assert.equal(JSON.parse(await fsio.readText('mode/json.json')).a, 1, '被拒的 writeJson 不许留下半个新世界');
});

// ── R6：worldbook / novel.json 的读-改-写原子性 ──────────────────────────

test('R6a 世界书 CRUD 正常闭环，且落盘写全部经过版本守卫（基线来自读取时）', async () => {
    const created = await createBook('世界书守卫');
    assert.equal(created.statusCode, 200);

    const add1 = await drive({ method: 'POST', url: `${PREFIX}/worldbook/世界书守卫`, body: { name: '乱葬岗', content: '红泥遇水不散。', keywords: '红泥,乱葬岗' } });
    assert.equal(add1.statusCode, 200, add1.body);
    assert.equal(add1.json.value.id, 1);
    const add2 = await drive({ method: 'POST', url: `${PREFIX}/worldbook/世界书守卫`, body: { name: '铜铃', content: '三响定魂。' } });
    assert.equal(add2.json.value.id, 2, '自增 id 取现有最大 +1');

    const upd = await drive({ method: 'PUT', url: `${PREFIX}/worldbook/世界书守卫/1`, body: { content: '改注：红泥带石灰。' } });
    assert.equal(upd.statusCode, 200, upd.body);
    assert.equal(upd.json.value.content, '改注：红泥带石灰。');
    assert.deepEqual(upd.json.value.keywords, ['红泥', '乱葬岗'], 'PUT 未给 keywords 保留原值');

    const list = await drive({ method: 'GET', url: `${PREFIX}/worldbook/世界书守卫` });
    assert.equal(list.json.value.length, 2);
    const del = await drive({ method: 'DELETE', url: `${PREFIX}/worldbook/世界书守卫/2` });
    assert.equal(del.statusCode, 200);
    const after = await drive({ method: 'GET', url: `${PREFIX}/worldbook/世界书守卫` });
    assert.deepEqual(after.json.value.map((e) => e.id), [1]);

    // 现状钉死：世界书写入文件存在时，REST 一律 replaceIfVersion（0.13.6 H1 之后不再无条件覆盖）
    const wbWrites = backend.writes.filter((w) => w.abs.endsWith(path.join('世界书守卫', '设定', '世界书.json')));
    assert.ok(wbWrites.length >= 4, `应记录到多次世界书写入，实际 ${wbWrites.length}`);
    assert.equal(wbWrites[0].intentKind, 'createIfAbsent', '首次创建走 createIfAbsent');
    for (const w of wbWrites.slice(1)) {
        assert.equal(w.intentKind, 'replaceIfVersion', '后续写入必须带版本守卫（若哪天退回 unconditional 即回归）');
    }
});

test('R6b 并发经端点提交不再丢更新：两边的写入都留得下来（0.13.7 修 H2 后翻转的断言）', async () => {
    // 0.13.6 版这条用例记录的是「A 的成功写入会静默吞掉 B 的条目」，并预告实现升级后
    // 应改写成断言不丢。现在端点走 updateJson（读时捕获版本 + 冲突重读重放）——
    // 自增 id 与章节版本号都必须从重读后的最新内容推出，撞车的一方重试而不是覆盖。
    const created = await createBook('并发提交书');
    assert.equal(created.statusCode, 200);

    const [w1, w2] = await Promise.all([
        drive({ method: 'POST', url: `${PREFIX}/worldbook/并发提交书`, body: { name: 'A 条目', content: 'a' } }),
        drive({ method: 'POST', url: `${PREFIX}/worldbook/并发提交书`, body: { name: 'B 条目', content: 'b' } }),
    ]);
    assert.equal(w1.statusCode, 200, w1.body);
    assert.equal(w2.statusCode, 200, w2.body);
    const list = await drive({ method: 'GET', url: `${PREFIX}/worldbook/并发提交书` });
    assert.equal(list.json.value.length, 2, `两条并发新增都必须留在列表里，实际 ${list.json.value.length}：${JSON.stringify(list.json.value)}`);
    assert.deepEqual(new Set(list.json.value.map((e) => e.id)).size, 2, '自增 id 不得撞车');

    // 同一章并发保存：两个版本都要在（版本号从重读后的最新索引推出，正文文件互不覆盖）
    const [s1, s2] = await Promise.all([
        drive({ method: 'POST', url: `${PREFIX}/projects/并发提交书/chapters/1`, body: { title: '一章', text: '版本甲' } }),
        drive({ method: 'POST', url: `${PREFIX}/projects/并发提交书/chapters/1`, body: { title: '一章', text: '版本乙' } }),
    ]);
    assert.equal(s1.statusCode, 200, s1.body);
    assert.equal(s2.statusCode, 200, s2.body);
    const meta = JSON.parse(fs.readFileSync(path.join(root, '并发提交书', 'novel.json'), 'utf8'));
    assert.equal(meta.chapters['1'].latest, 2, `两次保存应各占一个版本，实际 latest=${meta.chapters['1'].latest}`);
    assert.equal(meta.chapters['1'].versions.length, 2, '两个版本都要进索引');
    const bodies = walkFiles(path.join(root, '并发提交书', '正文')).map((f) => path.basename(f)).sort();
    assert.deepEqual(bodies, ['第1章-一章-v1.md', '第1章-一章-v2.md'], '正文文件不得互相覆盖');
});
