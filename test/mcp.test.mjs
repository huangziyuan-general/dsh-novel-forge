// test/mcp.test.mjs — MCP 双通道验证。
// ① buildStandaloneTools：node:fs 后端语义（containment/版本守卫）+ 17 工具可执行；
// ② 真起一个 stdio server 子进程，走 JSON-RPC：initialize → tools/list → tools/call。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const hasSdk = fs.existsSync(path.join(import.meta.dirname, '..', 'node_modules', '@deepseek-ai', 'dsh-tools'));

let root;
let standalone;
let buildStandaloneTools;
let createNodeFsBackend;

before(async () => {
    if (!hasSdk) return;
    ({ buildStandaloneTools, createNodeFsBackend } = await import('../lib/mcp-standalone.js'));
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-forge-mcp-'));
    standalone = await buildStandaloneTools(root);
});

after(() => {
    if (root !== undefined) fs.rmSync(root, { recursive: true, force: true });
});

test('standalone: 17 个工具全部装配', () => {
    if (!hasSdk) return;
    assert.equal(standalone.tools.length, 17);
    assert.ok(standalone.tools.some((t) => t.name === 'novel_style'));
});

test('standalone: 后端 containment——越界 resolve 拒绝', () => {
    if (!hasSdk) return;
    const backend = createNodeFsBackend(root);
    assert.rejects(
        () => backend.resolve(path.join(root, '..', 'outside.txt'), { cwd: root }),
        (e) => e.code === 'FS_SANDBOX_DENIED',
    );
});

test('standalone: 后端版本守卫——replaceIfVersion 冲突抛 FS_VERSION_CONFLICT', async () => {
    if (!hasSdk) return;
    const backend = createNodeFsBackend(root);
    const target = await backend.resolve('guard.txt', { cwd: root });
    await backend.writeText(target, 'first', undefined);
    const v1 = (await backend.stat(target)).version;
    await backend.writeText(target, 'second', { kind: 'replaceIfVersion', version: v1 });
    const v2 = (await backend.stat(target)).version;
    await assert.rejects(
        () => backend.writeText(target, 'third', { kind: 'replaceIfVersion', version: v1 }),
        (e) => e.code === 'FS_VERSION_CONFLICT',
    );
    assert.notEqual(v1, v2);
});

test('standalone: novel_project init 在纯 node:fs 通道可用', async () => {
    if (!hasSdk) return;
    const r = await standalone.call('novel_project', { action: 'init', book: '甲编', title: '甲编', genre: '科幻', logline: '测试' });
    assert.equal(r.action, 'init');
    assert.ok(fs.existsSync(path.join(root, '甲编', 'novel.json')));
});

test('stdio server: initialize → tools/list → tools/call 全链', async () => {
    if (!hasSdk) return;
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-forge-mcp-ws-'));
    const child = spawn(process.execPath, [path.join(import.meta.dirname, '..', 'mcp', 'server.mjs')], {
        env: { ...process.env, NOVEL_FORGE_ROOT: ws },
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    const pending = new Map();
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
        buffer += chunk;
        let idx = buffer.indexOf('\n');
        while (idx !== -1) {
            const line = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 1);
            if (line !== '') {
                const msg = JSON.parse(line);
                const resolve = pending.get(msg.id);
                if (resolve) { pending.delete(msg.id); resolve(msg); }
            }
            idx = buffer.indexOf('\n');
        }
    });
    let nextId = 0;
    const rpc = (method, params) => new Promise((resolve) => {
        const id = nextId++;
        pending.set(id, resolve);
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });

    try {
        const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
        assert.equal(init.result.serverInfo.name, 'dsh-novel-forge');

        const listed = await rpc('tools/list', {});
        assert.equal(listed.result.tools.length, 17);
        assert.ok(listed.result.tools.every((t) => t.inputSchema.type === 'object'));

        const called = await rpc('tools/call', {
            name: 'novel_project',
            arguments: { action: 'init', book: '乙编', title: '乙编', genre: '仙侠', logline: 'mcp 通道' },
        });
        assert.equal(called.result.isError, undefined);
        const payload = JSON.parse(called.result.content[0].text);
        assert.equal(payload.action, 'init');
        assert.ok(fs.existsSync(path.join(ws, '乙编', 'novel.json')));
    } finally {
        child.kill();
        fs.rmSync(ws, { recursive: true, force: true });
    }
});
