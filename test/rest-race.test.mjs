// test/rest-race.test.mjs — 真机竞态回归（node:test 可跑版）。
//
// 起因（2026-10-14 真机验证）：面板双开并发保存同一章，memIo 替身（同步 Map，原子）
// 测不出真 backend 的异步交错——曾 3/10 失败，两种形态：FS_VERSION_CONFLICT 互抢耗尽
// updateJson 的 3 次重放；writeFile 的 O_TRUNC 中间态被并发 readText 读到 → novel.json
// 「不是合法 JSON」误报。修复：backend 同路径写互斥 + tmp+rename 原子替换
//（lib/mcp-standalone.js）+ updateJson 重放上限 3→8 加微退避（lib/fsio.js）。
// 本用例用**真** node:fs 后端 + 真 handler（不经替身），锁住这个窗口不再复发。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerServerApi } from '../lib/server-api.js';
import { createNodeFsBackend } from '../lib/mcp-standalone.js';

test('REST 并发双存同一章：真 backend 上 3 组全 2xx，版本单调、无丢更新', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-race-'));
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-race-home-'));
    try {
        const registrations = [];
        const ctx = {
            fs: createNodeFsBackend(root),
            emit() {}, logger: { info() {} },
            inject: (_d, fn) => { fn(ctx); },
            effect: (fn) => { const c = fn(); return typeof c === 'function' ? c : () => {}; },
            webServer: { register: (def) => { registrations.push(def); return () => {}; } },
        };
        registerServerApi(ctx, { workspaceRoot: root, scanTopK: 8, minChapterChars: 10, maxChapterChars: 5000 }, {
            homedir: fakeHome,
            sessionProbe: () => ({ sessions: null, workspace: null, full: false }),
        });
        // 直接驱动 handler（与替身测试同形态，但 fs 后端是真 node:fs——异步交错真实存在）
        const handler = registrations[0].handler;
        const post = async (body) => {
            let raw = '';
            const res = { statusCode: 0, body: '', headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(s) { this.body = s ?? ''; this.ended = true; }, writeHead(code) { this.statusCode = code; } };
            const req = {
                method: 'POST',
                url: `/api/novel-forge/projects/${encodeURIComponent('竞态书')}/chapters/1`,
                headers: { host: 'localhost:3080', 'content-type': 'application/json', 'x-dsh-novel-forge': '1' },
                on(ev, fn) {
                    if (ev === 'data') setImmediate(() => fn(Buffer.from(JSON.stringify(body))));
                    if (ev === 'end') setImmediate(() => setImmediate(fn));
                },
                get rawHeaders() { return []; },
                [Symbol.asyncIterator]() {
                    let sent = false;
                    return { next: () => Promise.resolve(sent ? { done: true } : { done: false, value: Buffer.from(JSON.stringify(body)) }) };
                },
            };
            raw = await Promise.race([handler(req, res), new Promise((_, rej) => setTimeout(() => rej(new Error('handler 10s 未结束')), 10_000))]);
            if (raw === undefined) raw = undefined;   // handler 直接写 res
            let json = null; try { json = JSON.parse(res.body); } catch { /* 无体 */ }
            return { status: res.statusCode, json };
        };

        // 建书（数据布局最小集）
        const book = '竞态书';
        const bdir = path.join(root, book);
        fs.mkdirSync(path.join(bdir, '大纲', '细纲'), { recursive: true });
        fs.writeFileSync(path.join(bdir, 'novel.json'), JSON.stringify({
            title: book, genre: '悬疑', logline: '', stage: 'chapter', phases: {},
            approvals: { outline: { 1: true } },
            chapters: {}, cast: [], proposals: [], gateFailures: {},
        }));
        fs.writeFileSync(path.join(bdir, '大纲', '细纲', '第1章.md'), '# 第1章\n\n- 场景一。\n- 场景二。\n- 场景三。');

        const para = ['雾从水面漫上来。', '灯影里站着一个人。', '她认出了那道暗号。'].join('\n\n');
        const versions = [];
        for (let i = 0; i < 3; i += 1) {
            const [a, b] = await Promise.all([
                post({ text: `${para}（第${i}轮甲线）` }).catch((e) => ({ status: 'REJ', json: { error: { code: 'REJ', message: String(e) } } })),
                post({ text: `${para}（第${i}轮乙线）` }).catch((e) => ({ status: 'REJ', json: { error: { code: 'REJ', message: String(e) } } })),
            ]);
            if (a.status !== 200 || b.status !== 200) {
                console.log(`[race 第${i}组] a=${a.status} b=${b.status}`, JSON.stringify([a, b].filter((x) => x.status !== 200).map((x) => x.json?.error)).slice(0, 300));
            }
            assert.equal(a.status, 200, `第${i}组甲 200，实际 ${a.status}：${JSON.stringify(a.json?.error)}`);
            assert.equal(b.status, 200, `第${i}组乙 200，实际 ${b.status}：${JSON.stringify(b.json?.error)}`);
            versions.push(a.json.value.version, b.json.value.version);
        }
        // 并发下两个响应的落账顺序无保证（后发起者可能重放到更高版本）——正确语义是
        // 「版本集合连续、无重复、无空洞」：每版都真实落盘，novel.json 记到最新。
        assert.deepEqual([...versions].sort((x, y) => x - y), [1, 2, 3, 4, 5, 6], '版本集合恰为 v1-v6（连续、无重复、无空洞）');
        const saved = JSON.parse(fs.readFileSync(path.join(bdir, 'novel.json'), 'utf8'));
        assert.equal(saved.chapters['1'].latest, 6, 'novel.json 记账与最新版本一致');
        const files = fs.readdirSync(path.join(bdir, '正文'));
        assert.equal(files.length, 6, `3 组 × 每组两版 = 恰好 6 个版本文件（多一个都是 tmp 残留/重复），实际 ${files.length}`);
        assert.ok(files.every((f) => !f.includes('.nf-tmp-')), '不残留临时文件');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(fakeHome, { recursive: true, force: true });
    }
});
