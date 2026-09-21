#!/usr/bin/env node
// scripts/real-boot-test.mjs — 真机模拟测试：不依赖手编替身，起真宿主、走真 HTTP/stdio、落真磁盘。
//
// 两层：
//   web 层  = 真 dsh 容器（`dsh --profile web --port 0`，隔离 HOME + 复制的 web profile
//             + 沙箱钉死到诱饵根）装载本插件，用真 fetch 走 REST 面板全流程；
//             「书在 ≠ 沙箱回退根、≠ 进程 cwd 的工作区」正是 Windows 真机的故障形状——
//             写成功即证明 REST 绑定根覆写在真宿主 sandbox-policy 下成立。
//   mcp 层  = 真起 `mcp/server.mjs`（stdio 换行分帧），initialize/tools/list/tools/call，
//             工具链在真磁盘上建书，无宿主替身。
//
// 用法：npm run realboot [--layer=web|mcp|all] [--keep] [--verbose]
// 前提：本机装有 dsh（默认 ~/.npm-global），且 ~/.dsh/profiles/web 已 link 本仓库。
// 隔离：所有读写都在仓库内 .realboot-probe/（脚本自建自清，gitignore 已含）。
//
// ⚠ 这是「模拟真机」不是真机本身：macOS 上跑，Windows 路径形态由 test/ 下的实录回放用例
//   负责（aea7149/db4f1b1 的回归）；这里锁的是宿主接缝（mount/fence/沙箱/多工作区/签名字段级语义）。

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
}));
const LAYER = String(args.layer ?? 'all');
const KEEP = Boolean(args.keep);
const VERBOSE = Boolean(args.verbose);

const DSH_BIN = process.env.DSH_BIN
    ?? path.join(os.homedir(), '.npm-global/lib/node_modules/@deepseek-ai/dsh/lib/bin.js');
const REAL_WEB_PROFILE = path.join(os.homedir(), '.dsh/profiles/web');

// ── 断言收集器 ──────────────────────────────────────────────────────────
let passed = 0; let failed = 0; const failures = [];
function check(name, cond, detail = '') {
    if (cond) { passed += 1; console.log(`  ✔ ${name}`); }
    else { failed += 1; failures.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`  ✘ ${name}${detail ? ` — ${detail}` : ''}`); }
    return cond;
}
function soft(name, ok, detail = '') { console.log(`  ${ok ? '✔' : '…'} ${name}${ok || !detail ? '' : ` (${detail})`}`); }

// ── 目录骨架 ────────────────────────────────────────────────────────────
const base = path.join(repoRoot, '.realboot-probe');
fs.rmSync(base, { recursive: true, force: true });
const home = path.join(base, 'home');            // 假 HOME（宿主与插件 homedir() 同源）
const dshHome = path.join(home, '.dsh');        // DSH_HOME=HOME/.dsh：保证插件按 homedir 读到的就是宿主写的
const profileDir = path.join(dshHome, 'profiles/web');
const ws = path.join(base, 'ws');                // 真·会话工作区（插件 config.workspaceRoot）
const ws2 = path.join(base, 'ws2');              // 第二工作区（签名即时性场景）
const decoy = path.join(base, 'decoy');          // 沙箱钉死的诱饵根 + dsh 进程 cwd
const mcprs = path.join(base, 'mcps');           // mcp 层工作区
for (const d of [home, dshHome, profileDir, ws, ws2, decoy, mcprs]) fs.mkdirSync(d, { recursive: true });

function makeWebProfile() {
    if (!fs.existsSync(REAL_WEB_PROFILE)) throw new Error(`找不到 web profile：${REAL_WEB_PROFILE}（真机模拟需要本机跑过 dsh web）`);
    for (const f of ['package.json', 'cordis.yml', 'cordis.patch.yml']) {
        const src = path.join(REAL_WEB_PROFILE, f);
        if (fs.existsSync(src)) fs.copyFileSync(src, path.join(profileDir, f));
    }
    fs.symlinkSync(path.join(REAL_WEB_PROFILE, 'node_modules'), path.join(profileDir, 'node_modules'), 'dir');
    // ① 沙箱回退根钉到诱饵目录（真机故障形状：workspace-write 的 root ≠ 书的根）
    const patchFile = path.join(profileDir, 'cordis.patch.yml');
    let patch = fs.existsSync(patchFile) ? fs.readFileSync(patchFile, 'utf8') : '';
    if (!patch.includes('sandbox-policy')) throw new Error('web profile 补丁里没有 sandbox-policy 行，拒绝在不可控沙箱形态下跑');
    patch = patch.replace(/(id:\s*sandbox-policy[\s\S]*?)workspaceRoot:.*/m, `$1workspaceRoot: ${decoy}`);
    // ② 插件 config：workspaceRoot 指到 ws（spawn cwd=decoy ⇒ 写 ws 只有绑定根覆写才救得回来）
    patch += `\n- id: dsh-novel-forge\n  config:\n    workspaceRoot: ${ws}\n`;
    fs.writeFileSync(patchFile, patch);
}

// ── web 层 ──────────────────────────────────────────────────────────────
async function layerWeb() {
    console.log('\n== WEB 层：真 dsh 容器 + 真 HTTP 面板全流程 ==');
    makeWebProfile();
    const child = spawn(process.execPath, [DSH_BIN, '--profile', 'web', '--port', '0', '--no-open'], {
        cwd: decoy,
        env: { ...process.env, HOME: home, DSH_HOME: dshHome, DSH_PERMISSION_MODE: 'workspace-write' },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let buf = '';
    child.stdout.on('data', (d) => { buf += d; if (VERBOSE) process.stdout.write(d); });
    child.stderr.on('data', (d) => { buf += d; if (VERBOSE) process.stderr.write(d); });

    let baseUrl = null;
    const deadline = Date.now() + 60_000;
    while (!baseUrl && Date.now() < deadline) {
        const m = buf.match(/http:\/\/127\.0\.0\.1:(\d+)/);
        if (m) baseUrl = `http://127.0.0.1:${m[1]}`;
        else if (!child.exitCode) await new Promise((r) => setTimeout(r, 250));
        else break;
    }
    if (!baseUrl) {
        check('容器启动并打出监听地址', false, `exit=${child.exitCode}，日志尾部：${buf.slice(-600)}`);
        return;
    }
    console.log(`  容器就绪：${baseUrl}（进程 cwd=${decoy}，沙箱根钉死在 cwd，书的根=${ws}）`);
    check('容器启动并打出监听地址', true);

    const FENCE = { 'x-dsh-novel-forge': '1' };
    const req = async (method, p, { body, fence = true } = {}) => {
        const res = await fetch(baseUrl + p, {
            method,
            headers: fence ? { ...FENCE, ...(body ? { 'content-type': 'application/json' } : {}) } : {},
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const text = await res.text();
        let json = null; try { json = JSON.parse(text); } catch { /* 保留原文 */ }
        return { status: res.status, json, text };
    };
    const q = (s) => `/api/novel-forge/${s}`;

    try {
        // S1 mount + 自家 fence（不带头的 403 必须来自插件，不是宿主的 401）
        const noFence = await req('GET', q('projects'), { fence: false });
        check('S1a 无 fence 头被拒（401/403 任一防线成立）', noFence.status === 403 || noFence.status === 401, `status=${noFence.status}`);
        const withFence = await req('GET', q('projects'));
        check('S1b 真容器里插件已 mount（fence 头 → 200 + ok:true）', withFence.status === 200 && withFence.json?.ok === true, `status=${withFence.status} body=${withFence.text.slice(0, 120)}`);

        // S2 REST 建书（创建会话 realboot-1；落点 = config.workspaceRoot=ws ≠ 沙箱根 ≠ 进程 cwd 的诱饵）
        const created = await req('POST', q('projects'), { body: { title: '真机冒烟书', session: 'realboot-1' } });
        check('S2a POST /projects 建书 200（写在非沙箱根工作区 = 绑定根覆写端到端成立）', created.status === 200, `status=${created.status} body=${created.text.slice(0, 200)}`);
        const novelPath = path.join(ws, '真机冒烟书', 'novel.json');
        const onDisk = fs.existsSync(novelPath) ? JSON.parse(fs.readFileSync(novelPath, 'utf8')) : null;
        check('S2b novel.json 落在 ws（而非诱饵 cwd）', onDisk !== null && onDisk.title === '真机冒烟书', novelPath);
        check('S2c 会话归属写入 sessions', Array.isArray(onDisk?.sessions) && onDisk.sessions.includes('realboot-1'), JSON.stringify(onDisk?.sessions));
        check('S2d 诱饵目录没被写脏（进程 cwd 无书目录）', !fs.existsSync(path.join(decoy, '真机冒烟书')));
        const mine = await req('GET', q('projects') + '?session=realboot-1');
        const theirs = await req('GET', q('projects') + '?session=别人家的会话');
        check('S2e 面板按会话过滤：本会话可见、他会话不可见',
            (mine.json?.value ?? []).some((b) => b.name === '真机冒烟书') && !(theirs.json?.value ?? []).some((b) => b.name === '真机冒烟书'));

        // S3 存章（REST 直存通道）+ 读回
        const text = '夜色像墨，长街尽头亮着一盏灯。'.repeat(40);
        const saved = await req('POST', q('projects/真机冒烟书/chapters/1'), { body: { title: '真机首章', text } });
        check('S3a 存章 200', saved.status === 200, `status=${saved.status} body=${saved.text.slice(0, 200)}`);
        const chapDir = path.join(ws, '真机冒烟书', '正文');
        const chapFile = fs.existsSync(chapDir) ? fs.readdirSync(chapDir).find((f) => f.includes('真机首章')) : null;
        check('S3b 章节文件落盘（正文/第1章-真机首章-v1.md 形态）', Boolean(chapFile), chapDir);
        const back = await req('GET', q('projects/真机冒烟书/chapters/1'));
        check('S3c 读回正文与存储一致（GET 单元件返回裸文本 value）', back.status === 200 && back.json?.value === text,
            `status=${back.status} head=${String(back.json?.value ?? back.text).slice(0, 60)}`);

        // S4 世界书 CRUD：REST 面 id 设计契约 = max+1 数字（工具面是 'W1' 字符串，混合形态共存，
        // PUT/DELETE 靠 String(e.id) 匹配——3611bfc 修的正是 Number 强转把这层打穿）
        const entry = await req('POST', q('worldbook/真机冒烟书'), { body: { name: '墨骨', content: '一种会发光的金属', keywords: '墨骨', enabled: true } });
        const eid = entry.json?.value?.id;
        check('S4a 建条目 200 且返回可用 id（数字/字符串形态均接受，下游按字符串匹配）',
            entry.status === 200 && (typeof eid === 'string' || typeof eid === 'number') && String(eid) !== '', JSON.stringify(entry.json?.value)?.slice(0, 160));
        const toggled = await req('PUT', q(`worldbook/真机冒烟书/${eid}`), { body: { enabled: false } });
        check('S4b 按字符串 id 停用成功（PUT 不再 NaN 404）', toggled.status === 200 && toggled.json?.value?.enabled === false, `status=${toggled.status}`);
        const removed = await req('DELETE', q(`worldbook/真机冒烟书/${eid}`));
        const listAfter = await req('GET', q('worldbook/真机冒烟书'));
        check('S4c 删除闭环 + 列表清空', removed.status === 200 && (listAfter.json?.value ?? []).length === 0, `del=${removed.status}`);

        // S5/S6 提案列表（lossless JSON 形状）与导出（含真章内容）
        const props = await req('GET', q('projects/真机冒烟书/proposals'));
        check('S5 提案列表 200 且 JSON 合法', props.status === 200 && props.json?.ok === true, `status=${props.status}`);
        const exp = await req('POST', q('projects/真机冒烟书/export'), { body: { format: 'markdown' } });
        check('S6 导出含正文（真磁盘章节被读通）', exp.status === 200 && (exp.json?.value?.content ?? '').includes('长街尽头'), `status=${exp.status}`);

        // S7 扫描根内容签名即时性：新工作区在 store 空置期（无 live 会话）下靠 projcache 目录态进场
        fs.mkdirSync(path.join(ws2, '二号书'), { recursive: true });
        fs.writeFileSync(path.join(ws2, '二号书', 'novel.json'), JSON.stringify({
            title: '二号书', stage: 'drafting', sessions: ['realboot-2'], chapters: {}, updatedAt: new Date().toISOString(),
        }));
        const t0 = Date.now();
        const pre = await req('GET', q('projects') + '?session=realboot-2');
        check('S7a 播种前：二号书不可见（工作区还没进场）', !(pre.json?.value ?? []).some((b) => b.name === '二号书'));
        const pcDir = path.join(dshHome, 'storages/session_projcache/sessions');
        fs.mkdirSync(pcDir, { recursive: true });
        fs.writeFileSync(path.join(pcDir, 'realboot-probe.json'), JSON.stringify({ version: 1, record: { identity: { cwd: ws2 }, rows: {} } }));
        const post = await req('GET', q('projects') + '?session=realboot-2');
        const dt = Date.now() - t0;
        check(`S7b projcache 目录态落盘后下一个请求即见二号书（不等 60s TTL，实测 ${dt}ms）`,
            post.status === 200 && (post.json?.value ?? []).some((b) => b.name === '二号书'), `status=${post.status}`);

        // S9（软）插件的扫描根诊断行进了宿主 stdout：三源计数肉眼可查
        const rootsLine = (buf.match(/\[novel-forge\] 扫描根[^\n]*/g) ?? []).pop();
        soft('S9 扫描根诊断行', Boolean(rootsLine), rootsLine ? rootsLine.slice(0, 160) : '未在 stdout 捕获（可能被宿主日志层吞掉，不判负）');
    } finally {
        child.kill('SIGTERM');
        await new Promise((r) => { const t = setTimeout(() => { child.kill('SIGKILL'); r(); }, 4000); child.on('exit', () => { clearTimeout(t); r(); }); });
    }
}

// ── mcp 层 ──────────────────────────────────────────────────────────────
async function layerMcp() {
    console.log('\n== MCP 层：真起 mcp/server.mjs（stdio JSON-RPC），真磁盘建书 ==');
    const child = spawn(process.execPath, [path.join(repoRoot, 'mcp/server.mjs')], {
        cwd: repoRoot, env: { ...process.env, NOVEL_FORGE_ROOT: mcprs }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    const pending = new Map();
    let idn = 0;
    let lineBuf = '';
    child.stdout.on('data', (d) => {
        lineBuf += d.toString();
        let i;
        while ((i = lineBuf.indexOf('\n')) >= 0) {
            const line = lineBuf.slice(0, i).trim(); lineBuf = lineBuf.slice(i + 1);
            if (!line) continue;
            let msg; try { msg = JSON.parse(line); } catch { continue; }
            const p = pending.get(msg.id);
            if (p) { pending.delete(msg.id); p(msg); }
        }
    });
    const send = (method, params) => new Promise((resolve, reject) => {
        const id = ++idn;
        const t = setTimeout(() => reject(new Error(`MCP ${method} 超时`)), 15_000);
        pending.set(id, (msg) => { clearTimeout(t); resolve(msg); });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
    const notify = (method) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params: {} })}\n`);
    const payload = (msg) => { try { return JSON.parse(msg.result?.content?.[0]?.text ?? 'null'); } catch { return null; } };
    try {
        const init = await send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'realboot', version: '0' } });
        check('M1 initialize 应答（serverInfo 存在）', Boolean(init.result?.serverInfo), JSON.stringify(init).slice(0, 160));
        notify('notifications/initialized');
        const list = await send('tools/list', {});
        const names = (list.result?.tools ?? []).map((t) => t.name);
        check('M2 tools/list：全部 novel_* 前缀（工具数 ≥20）', names.length >= 20 && names.every((n) => n.startsWith('novel_')), `${names.length} 个`);
        const res = await send('tools/call', { name: 'novel_project', arguments: { action: 'init', book: 'MCP冒烟书', title: 'MCP冒烟书' } });
        const out = payload(res);
        check('M3 novel_project init 成功且无 isError', !res.result?.isError, res.result?.content?.[0]?.text?.slice(0, 160) ?? '');
        const bookJson = path.join(mcprs, 'MCP冒烟书', 'novel.json');
        check('M4 真磁盘产物 novel.json', fs.existsSync(bookJson) && JSON.parse(fs.readFileSync(bookJson, 'utf8')).title === 'MCP冒烟书');
        const st = await send('tools/call', { name: 'novel_project', arguments: { action: 'status', book: 'MCP冒烟书' } });
        check('M5 status 读回同书', !st.result?.isError && JSON.stringify(payload(st)).includes('MCP冒烟书'), st.result?.content?.[0]?.text?.slice(0, 160) ?? '');
        soft('M6 stderr ready 横幅', /ready: \d+ tools/.test(stderr), stderr.trim().slice(0, 120));
    } finally {
        child.kill();
    }
}

// ── 汇总 ────────────────────────────────────────────────────────────────
if (!fs.existsSync(DSH_BIN)) { console.error(`找不到 dsh 入口：${DSH_BIN}（可用 DSH_BIN 覆盖）`); process.exit(2); }
try {
    if (LAYER === 'web' || LAYER === 'all') await layerWeb();
    if (LAYER === 'mcp' || LAYER === 'all') await layerMcp();
} finally {
    if (!KEEP) fs.rmSync(base, { recursive: true, force: true });
    else console.log(`\n(--keep) 现场保留在 ${base}`);
}
console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
if (failures.length > 0) { console.log(failures.map((f) => `  ✘ ${f}`).join('\n')); process.exit(1); }
