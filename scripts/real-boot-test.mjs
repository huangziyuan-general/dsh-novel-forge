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
import http from 'node:http';
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
    // ② 插件 config：workspaceRoot 指到 ws（spawn cwd=decoy ⇒ 写 ws 只有绑定根覆写才救得回来）；
    //    allowedHosts 带一个探测域名（issue #7 真接线：Host 白名单放行/拒绝走真 apply() 管道）；
    //    draft 通道钉到不存在的 provider——批量起草测试要的是「引擎快速失败」，
    //    绝不能继承真 profile 的默认路由去烧真模型（S8e 靠它拿到确定性的 generate 失败留痕）。
    patch += `\n- id: dsh-novel-forge\n  config:\n    workspaceRoot: ${ws}\n    allowedHosts: ['forge.probe.example']\n    engine:\n      channels:\n        draft:\n          provider: nonexistent-probe\n          model: probe-model\n          maxTokens: 4096\n          timeoutMs: 20000\n          retries: 0\n`;
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
    // 裸体请求：错误分类测试要发**非法 JSON / 超大请求体**，req() 的 JSON.stringify 包不了这个形状
    const reqRaw = async (method, p, rawBody) => {
        const res = await fetch(baseUrl + p, {
            method,
            headers: { ...FENCE, ...(rawBody ? { 'content-type': 'application/json' } : {}) },
            body: rawBody,
        });
        const text = await res.text();
        let json = null; try { json = JSON.parse(text); } catch { /* 保留原文 */ }
        return { status: res.status, json, text };
    };

    try {
        // S1 mount + 自家 fence（不带头的 403 必须来自插件，不是宿主的 401）
        const noFence = await req('GET', q('projects'), { fence: false });
        check('S1a 无 fence 头被拒（401/403 任一防线成立）', noFence.status === 403 || noFence.status === 401, `status=${noFence.status}`);
        const withFence = await req('GET', q('projects'));
        check('S1b 真容器里插件已 mount（fence 头 → 200 + ok:true）', withFence.status === 200 && withFence.json?.ok === true, `status=${withFence.status} body=${withFence.text.slice(0, 120)}`);

        // S1c–S1e 面板引导配置 + Host 白名单（issue #7/#8 真机接线）：fetch 改不了 Host 头，
        // 用 node:http 真发——这正是 DNS rebinding 防线的攻击面口径（Host 是浏览器不可伪造面）。
        const panelCfg = await req('GET', q('panel-config'));
        check('S1c GET /panel-config：默认配置 → ok:true + autoOpenPanel:true',
            panelCfg.status === 200 && panelCfg.json?.ok === true && panelCfg.json?.value?.autoOpenPanel === true,
            `status=${panelCfg.status} body=${panelCfg.text.slice(0, 120)}`);
        const { port: probePort } = new URL(baseUrl);
        const reqHost = (host, p) => new Promise((resolve) => {
            const r = http.request({
                hostname: '127.0.0.1', port: Number(probePort), path: p, method: 'GET',
                headers: { Host: host, 'x-dsh-novel-forge': '1' },
            }, (res) => {
                let body = ''; res.on('data', (c) => { body += c; });
                res.on('end', () => { let json = null; try { json = JSON.parse(body); } catch { /* 原文 */ } resolve({ status: res.statusCode, json, body }); });
            });
            r.on('error', (e) => resolve({ status: 0, body: String(e) }));
            r.end();
        });
        const allowHit = await reqHost('forge.probe.example', q('projects'));
        check('S1d allowedHosts 真接线：Host=forge.probe.example（带端口）→ 放行 200', allowHit.status === 200, `status=${allowHit.status} body=${allowHit.body.slice(0, 120)}`);
        const denyHit = await reqHost('evil.probe.example', q('projects'));
        check('S1e 白名单外 Host → 403 FORBIDDEN_HOST 且消息带 allowedHosts 指引（已配置白名单 ⇒ 提示在场）',
            denyHit.status === 403 && denyHit.json?.error?.code === 'FORBIDDEN_HOST' && denyHit.body.includes('allowedHosts'),
            `status=${denyHit.status} body=${denyHit.body.slice(0, 160)}`);

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

        // S3 存章（REST 直存通道）+ 读回——正文必须 ≥2100 字且按空行分段（≥15 段）：
        // REST 存章与 write_chapter 同链过机审（600 字/单段都会被 GATE_REJECTED 拦下——门禁工作是设计行为）
        // fixture 纪律：每句全章唯一（带序号）——7040f9d 起「章内逐字复读」是 critical 门禁，
        // 重复凑字 fixture 会被正确拦截（那是门禁在工作，不是产品 bug）。
        const smokePara = (i) => `第${i}夜，长街尽头亮着一盏灯，灯下坐着守夜人。他数着更漏，把每一个走过巷口的人都记进册子：挑夫${i}号、货郎${i}号，还有一个不肯说姓名的旅人。墨迹干了又湿，册页翻动${i}次，灯芯剪了又剪，直到鸡鸣把灯吹熄，他才合上册子，往灶膛里添了一把柴，把冷掉的茶泼在地上。`;
        const text = Array.from({ length: 20 }, (_, i) => smokePara(i + 1)).join('\n\n');
        const saved = await req('POST', q('projects/真机冒烟书/chapters/1'), { body: { title: '真机首章', text } });
        check('S3a 存章 200', saved.status === 200, `status=${saved.status} body=${saved.text.slice(0, 200)}`);
        const chapDir = path.join(ws, '真机冒烟书', '正文');
        const chapFile = fs.existsSync(chapDir) ? fs.readdirSync(chapDir).find((f) => f.includes('真机首章')) : null;
        check('S3b 章节文件落盘（正文/第1章-真机首章-v1.md 形态）', Boolean(chapFile), chapDir);
        const back = await req('GET', q('projects/真机冒烟书/chapters/1'));
        const got = String(back.json?.value ?? '');
        // 存盘规范形：content.trimEnd() + '\n'（lib/server-routes/chapters.js 存段与冲突比较同源），
        // GET 读回按磁盘字节原样返回——round-trip 契约是「归一后逐字一致」，不是原文逐字。
        const stored = `${text.trimEnd()}\n`;
        let diverge = -1;
        if (got !== stored) for (let i = 0; i < Math.min(stored.length, got.length); i += 1) if (stored[i] !== got[i]) { diverge = i; break; }
        check('S3c 读回正文与存储一致（GET 单元件返回裸文本 value，存盘规范形 trimEnd+\\n）', back.status === 200 && got === stored,
            `status=${back.status} len ${got.length}≠${stored.length} 首异点=${diverge} got=${JSON.stringify(got.slice(Math.max(0, diverge - 20), diverge + 20))} want=${JSON.stringify(stored.slice(Math.max(0, diverge - 20), diverge + 20))}`);

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
        // S6 导出含正文（真磁盘章节被读通）
        const exp = await req('POST', q('projects/真机冒烟书/export'), { body: { format: 'markdown' } });
        check('S6 导出含正文（真磁盘章节被读通）', exp.status === 200 && (exp.json?.value?.content ?? '').includes('长街尽头'), `status=${exp.status}`);

        // ── S8 本轮特性真机接线：REST 错误分类 / 单换行段路口径 / 批量逐章留痕 ──
        // S8a/S8b 错误分类先于引擎：非法 JSON 必须是 typed 400 BAD_BODY，
        // 修订端点不再 .catch(()=>({})) 吞解析错（吞掉后会拿空体去跑引擎/500）。
        const badBatch = await reqRaw('POST', q('projects/真机冒烟书/draft-batch'), '{"from":');
        check('S8a draft-batch 非法 JSON → 400 BAD_BODY（先于引擎 503）',
            badBatch.status === 400 && badBatch.json?.error?.code === 'BAD_BODY', `status=${badBatch.status} body=${badBatch.text.slice(0, 160)}`);
        const badPolish = await reqRaw('POST', q('projects/真机冒烟书/chapters/1/polish'), '{"issues":');
        check('S8b polish 非法 JSON → 400 BAD_BODY（修订端点不再吞解析错）',
            badPolish.status === 400 && badPolish.json?.error?.code === 'BAD_BODY', `status=${badPolish.status} body=${badPolish.text.slice(0, 160)}`);
        // S8c 超 4MiB → 413 BODY_TOO_LARGE；连接未被销毁的真机证据 = 客户端完整收到了
        // typed 响应（旧版先 destroy 连接，客户端只会看到连接重置，错误码根本送不到）。
        const oversized = await reqRaw('POST', q('projects/真机冒烟书/draft-batch'), 'x'.repeat(4 * 1024 * 1024 + 1));
        check('S8c 超 4MiB → 413 BODY_TOO_LARGE 且连接可读（不 destroy）',
            oversized.status === 413 && oversized.json?.error?.code === 'BODY_TOO_LARGE', `status=${oversized.status} body=${oversized.text.slice(0, 160)}`);
        // S8d 段路口径统一（lib/paragraphs.js）：单换行正文旧版整章算 1 段必被机审
        // 拦成 GATE_REJECTED（段数门禁），新版按换行分段放行——docx 导入稿的真机形状。
        const mkSingle = await req('POST', q('projects'), { body: { title: '真机单换行书', session: 'realboot-1' } });
        check('S8d-0 建单换行测试书', mkSingle.status === 200, `status=${mkSingle.status}`);
        const singleText = Array.from({ length: 20 }, (_, i) => smokePara(i + 1)).join('\n');
        const single = await req('POST', q('projects/真机单换行书/chapters/1'), { body: { title: '单换行首章', text: singleText } });
        check('S8d-1 单换行正文（2700 字 20 行零空行）过机审存章（旧版整章 1 段必驳回）',
            single.status === 200, `status=${single.status} body=${single.text.slice(0, 200)}`);
        const singleDir = path.join(ws, '真机单换行书', '正文');
        check('S8d-2 单换行章真磁盘落盘', single.status === 200
            && fs.existsSync(singleDir) && fs.readdirSync(singleDir).some((f) => f.includes('单换行首章')), singleDir);
        // S8e 批量逐章留痕：种子细纲+批准 → draft-batch（draft 通道已钉到坏 provider，
        // S9 前置播种：保留策略真机组需要存量脏数据。真宿主 fsio 有 deleteFile ⇒
        // canHardDelete=true ⇒ 硬删路径端到端（memIo 单测替身没有 deleteFile，走的是软墓碑——
        // 真机这组是唯一能证明「真删」的通道）。sweep 触发点：带 nonce 写回执成功后
        // （invocations）与 recorder.finish()（recovery）。保留语义是并集（keep =
        // 条数内 OR 30 天内），所以超龄但未超量的回执**应保留**；recovery 的 committed
        // 候选无条件清出。recovery 播 21 个超龄候选（39.0→41.0 天递减）：
        // keepNewest=20 ⇒ 排序后 index 20（最旧 retire-rec-20）超量且超龄 ⇒ 真删。
        const isoAgo = (d) => new Date(Date.now() - d * 86400000).toISOString();
        const invDir = path.join(ws, '真机冒烟书', '.novel', 'invocations');
        const recDir = path.join(ws, '真机冒烟书', '.novel', 'recovery');
        fs.mkdirSync(invDir, { recursive: true });
        fs.mkdirSync(recDir, { recursive: true });
        const seedReceipt = (nonce, ageDays) => fs.writeFileSync(path.join(invDir, `${nonce}.json`), JSON.stringify({
            version: 1, nonce, status: 'done', operation: 'draft-batch', payload: {},
            createdAt: isoAgo(ageDays), response: { value: { checkpoint: { records: [] } } },
        }));
        seedReceipt('retire-me-0001', 40);
        seedReceipt('keep-me-0001', 1);
        for (let i = 0; i <= 20; i += 1) {
            fs.writeFileSync(path.join(recDir, `retire-rec-${String(i).padStart(2, '0')}.json`), JSON.stringify({
                id: `retire-rec-${String(i).padStart(2, '0')}`, kind: 'draft', chapter: 9, status: 'failed',
                partialText: `第 ${i} 号四十天前的失败残稿。`, createdAt: isoAgo(39 + i * 0.1), updatedAt: isoAgo(39 + i * 0.1),
            }));
        }
        fs.writeFileSync(path.join(recDir, 'rec-committed-01.json'), JSON.stringify({
            id: 'rec-committed-01', kind: 'draft', chapter: 9, status: 'committed',
            partialText: '', createdAt: isoAgo(1), updatedAt: isoAgo(0.5),
        }));

        // 引擎快速失败、零真模型调用）→ 失败章的 stage/code/原因/指标进 records 并落盘。
        fs.mkdirSync(path.join(ws, '真机冒烟书', '大纲', '细纲'), { recursive: true });
        fs.writeFileSync(path.join(ws, '真机冒烟书', '大纲', '细纲', '第2章.md'),
            '# 第2章 灯下\n\n- 灯下人影：长街尽头的灯下站着没打伞的人\n- 问路：他向柜上问起白日那桩事\n- 收账：柜上交出一枚铜牌\n- 门外：敲门声在数到第七下时响起\n- 决定：明早去城东查册\n');
        const novelNow = JSON.parse(fs.readFileSync(novelPath, 'utf8'));
        novelNow.approvals = { ...(novelNow.approvals ?? {}), outline: { ...(novelNow.approvals?.outline ?? {}), 2: true } };
        fs.writeFileSync(novelPath, JSON.stringify(novelNow, null, 2));
        const batch = await req('POST', q('projects/真机冒烟书/draft-batch'), { body: { from: 2, count: 1 } });
        check('S8e-0 draft-batch 200（引擎快速失败路径，不等真模型）', batch.status === 200, `status=${batch.status} body=${batch.text.slice(0, 200)}`);
        const cp = batch.json?.value?.checkpoint ?? {};
        const rec2 = (cp.records ?? []).find((r) => Number(r.chapter) === 2);
        check('S8e-1 失败章留痕：stage=generate + failed + 错误码/原因在场',
            rec2?.status === 'failed' && rec2?.stage === 'generate' && typeof rec2?.code === 'string' && rec2.code !== '' && typeof rec2?.reason === 'string' && rec2.reason !== '',
            JSON.stringify(rec2)?.slice(0, 240));
        check('S8e-2 调用指标落库：attempts 为非负整数 + durationMs 数值（boot 宿主无模型服务 → 路由解析前即败 attempts:0 也算如实留痕）',
            Number.isInteger(rec2?.attempts) && rec2.attempts >= 0 && typeof rec2?.durationMs === 'number' && rec2.durationMs >= 0
            && (rec2?.route === null || rec2?.route === undefined || rec2?.route?.provider === 'nonexistent-probe'),
            JSON.stringify({ attempts: rec2?.attempts, durationMs: rec2?.durationMs, route: rec2?.route })?.slice(0, 200));
        const cpDiskPath = path.join(ws, '真机冒烟书', '.novel', 'batch-checkpoint.json');
        const cpDisk = fs.existsSync(cpDiskPath) ? JSON.parse(fs.readFileSync(cpDiskPath, 'utf8')) : null;
        check('S8e-3 断点真磁盘落盘：.novel/batch-checkpoint.json records 与响应一致（重开面板仍可看）',
            Array.isArray(cpDisk?.records) && cpDisk.records.some((r) => Number(r.chapter) === 2 && r.stage === 'generate' && r.status === 'failed'),
            JSON.stringify(cpDisk?.records)?.slice(0, 240));

        // ── S9 保留策略真机组（本轮新特性；真宿主 deleteFile 端到端）──────────
        // 带 nonce 的 draft-batch 成功路径：写回执 → 顺手 sweep（lastAt=0 首写即扫）
        // → invocations 超龄但未超量 ⇒ 并集保留；recovery finish sweep ⇒ committed
        // 无条件清出 + 最旧超量且超龄候选真删。S8e 的调用不带 nonce（不写回执不触发
        // sweep），所以 sweep 的真机触发点全在本组。
        const s9body = { from: 2, count: 1, invocationNonce: 'probe-batch-1' };
        const s9first = await req('POST', q('projects/真机冒烟书/draft-batch'), { body: s9body });
        check('S9a 带 nonce draft-batch 200 且 receiptStored:true（真宿主回执真落盘）',
            s9first.status === 200 && s9first.json?.value?.receiptStored === true,
            `status=${s9first.status} body=${s9first.text.slice(0, 200)}`);
        check('S9b 超龄回执（40 天）未超量 → 并集保留（30 天语义只在超量时生效，不误删）',
            fs.existsSync(path.join(invDir, 'retire-me-0001.json')), fs.readdirSync(invDir).join('、'));
        check('S9c 新鲜回执保留（未误删）', fs.existsSync(path.join(invDir, 'keep-me-0001.json')));
        const s9receipt = fs.existsSync(path.join(invDir, 'probe-batch-1.json'))
            ? JSON.parse(fs.readFileSync(path.join(invDir, 'probe-batch-1.json'), 'utf8')) : null;
        check('S9d 本次回执落盘且 status=done',
            s9receipt?.status === 'done' && s9receipt?.nonce === 'probe-batch-1', JSON.stringify(s9receipt)?.slice(0, 160));
        const s9replay = await req('POST', q('projects/真机冒烟书/draft-batch'), { body: s9body });
        check('S9e 同 nonce 同 body 重放 → 幂等 done 回放（不重跑引擎，结果逐字一致）',
            s9replay.status === 200
            && JSON.stringify(s9replay.json?.value?.checkpoint?.records) === JSON.stringify(s9first.json?.value?.checkpoint?.records),
            `status=${s9replay.status} body=${s9replay.text.slice(0, 120)}`);
        check('S9f committed 恢复候选被无条件清出（finish sweep，防占 keepNewest 名额）',
            !fs.existsSync(path.join(recDir, 'rec-committed-01.json')), fs.readdirSync(recDir).join('、'));
        check('S9g 最旧超龄候选（41 天，index≥20）被真删（宿主 deleteFile 端到端，非墓碑）',
            !fs.existsSync(path.join(recDir, 'retire-rec-20.json')), fs.readdirSync(recDir).join('、'));
        check('S9h 条数内超龄候选（39 天，index<20）保留（并集语义，不误删）',
            fs.existsSync(path.join(recDir, 'retire-rec-00.json')));
        const s9list = await req('GET', q('projects/真机冒烟书/recovery-candidates'));
        check('S9i 恢复候选列表 200 且不含已清候选', s9list.status === 200 && (s9list.json?.value?.candidates ?? []).every((r) => r.id !== 'retire-rec-20' && r.id !== 'rec-committed-01'),
            `status=${s9list.status} body=${s9list.text.slice(0, 160)}`);
        const s9miss = await req('GET', q('projects/真机冒烟书/recovery-candidates/never-was-00001'));
        check('S9j 不存在的候选 → 404 RECOVERY_NOT_FOUND（不是 PRUNED）',
            s9miss.status === 404 && s9miss.json?.error?.code === 'RECOVERY_NOT_FOUND',
            `status=${s9miss.status} body=${s9miss.text.slice(0, 120)}`);

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

        // S10 会话交接全自动链（0.16.1 后：prompt 直发 + 延迟归档 + 自动认领）——全是真宿主会话服务。
        // 限流预算：本节 4 次会话路由调用 < 6 次/分。
        const handoffText = '真机冒烟交接摘要：请用 novel_briefing 拿上下文包，然后写第 2 章。';
        const sc = await req('POST', q('session/create'), { body: { session: 'realboot-1', book: '真机冒烟书', bookTitle: '真机冒烟书', handoff: handoffText, deferArchive: true } });
        const v = sc.json?.value ?? {};
        check('S10a /session/create 200（prompt 直发不拖垮创建）', sc.status === 200 && v.created === true, `status=${sc.status} body=${sc.text.slice(0, 200)}`);
        check('S10b 新会话命名 书名-YYMMDDHHmm', /^真机冒烟书-\d{10}$/.test(v.title ?? ''), JSON.stringify({ title: v.title, id: v.createdSessionId }));
        check('S10c 交接摘要直发被真宿主接受（prompted:true；queue 形状真机成立）', v.prompted === true, v.promptError ?? '（无错误）');
        check('S10d 自动认领 claimed:true（locateBook→updateJson→addBookSession 真机链）', v.claimed === true, v.claimError ?? '（无错误）');
        check('S10e deferArchive 生效：内联归档被跳过（archived:false 且无 archiveError）', v.archived === false && v.archiveError === undefined, JSON.stringify({ archived: v.archived, archiveError: v.archiveError }));
        check('S10f 工作区登记 accounted 如实上报（布尔）', typeof v.accounted === 'boolean', JSON.stringify({ accounted: v.accounted }));
        const novelAfter = JSON.parse(fs.readFileSync(novelPath, 'utf8'));
        check('S10g 真磁盘对账：novel.json.sessions 落了新会话 id', (novelAfter.sessions ?? []).includes(v.createdSessionId), JSON.stringify(novelAfter.sessions));
        const mineNew = await req('GET', q('projects') + `?session=${encodeURIComponent(v.createdSessionId)}`);
        check('S10h 面板视角：新会话立即见书（认领→bookInSession 闭环）', mineNew.status === 200 && (mineNew.json?.value ?? []).some((b) => b.name === '真机冒烟书'), `status=${mineNew.status} body=${mineNew.text.slice(0, 120)}`);
        // 延迟归档闭环：再开一个最小草稿会话（无书无摘要——不产生 agent/认领），用 /session/archive 归档它，
        // 验证宿主 archiveSession 形状链（对象→裸值）真机成立；不动刚 prompt 过的会话（agent 可能在跑）。
        const sc2 = await req('POST', q('session/create'), { body: { session: 'realboot-1' } });
        const tmpId = sc2.json?.value?.createdSessionId ?? null;
        check('S10i 最小草稿会话创建（归档靶子）', sc2.status === 200 && Boolean(tmpId), `status=${sc2.status}`);
        if (tmpId) {
            const arch = await req('POST', q('session/archive'), { body: { session: tmpId } });
            check('S10j /session/archive 真机归档成功（archived:true）', arch.status === 200 && arch.json?.value?.archived === true, arch.json?.value?.archiveError ?? `status=${arch.status}`);
        }
        const archBad = await req('POST', q('session/archive'), { body: { session: 'realboot-nonexistent-1' } });
        check('S10k 归档不存在的会话：archived:false + 错误原文如实（不假成功）',
            archBad.status === 200 && archBad.json?.value?.archived === false && typeof archBad.json?.value?.archiveError === 'string' && archBad.json.value.archiveError !== '',
            `status=${archBad.status} body=${archBad.text.slice(0, 200)}`);
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
        check('M2 tools/list：全部 novel_* 前缀（工具数 ≥24，novel_extract 已注册）',
            names.length >= 24 && names.every((n) => n.startsWith('novel_')) && names.includes('novel_extract'), `${names.length} 个`);
        const res = await send('tools/call', { name: 'novel_project', arguments: { action: 'init', book: 'MCP冒烟书', title: 'MCP冒烟书' } });
        const out = payload(res);
        check('M3 novel_project init 成功且无 isError', !res.result?.isError, res.result?.content?.[0]?.text?.slice(0, 160) ?? '');
        const bookJson = path.join(mcprs, 'MCP冒烟书', 'novel.json');
        check('M4 真磁盘产物 novel.json', fs.existsSync(bookJson) && JSON.parse(fs.readFileSync(bookJson, 'utf8')).title === 'MCP冒烟书');
        const st = await send('tools/call', { name: 'novel_project', arguments: { action: 'status', book: 'MCP冒烟书' } });
        check('M5 status 读回同书', !st.result?.isError && JSON.stringify(payload(st)).includes('MCP冒烟书'), st.result?.content?.[0]?.text?.slice(0, 160) ?? '');
        soft('M6 stderr ready 横幅', /ready: \d+ tools/.test(stderr), stderr.trim().slice(0, 120));

        // ── M7：《遗物手账》全书监控九项修复真机回归 ──────────────────────────
        // 真 MCP 通道（真 server.mjs + 真磁盘）复演监控报告的故障形状：
        // ① 范围括号禁项章必须放行（旧版必拦 outline-banned，白烧一整轮生成）；
        // ② 直引号对话必须计入 dialogueRatio（旧版四章全 0%）；
        // ③ 倒计时/打断式章末钩子必须检出（旧版强钩子报「无」）；
        // ④ 纯第一人称 + 引语里的「他」不得误报人称混用；
        // ⑤ briefing 带「不足目标 85% 不许收尾」；⑥ save_chapter 带上一章契约提醒。
        const m7 = async (name, args) => {
            const r = await send('tools/call', { name, arguments: args });
            return { isError: r.result?.isError === true, text: r.result?.content?.[0]?.text ?? '', out: payload(r) };
        };
        const BK = '遗物手账回归';
        const paras = [
            '雨停在后半夜。我提着灯走进殡房，账本摊在第三十七页，墨迹还没干透，纸边卷了毛。',
            '陈嘉树站在门边，手里捏着那枚黄铜钥匙，指节发白。他把钥匙放到桌上，正压住一页潦草的字。',
            '"这到底是什么？"我问。他没有立刻回答，只把灯芯捻亮了一些，影子在土墙上晃了晃。',
            '死者的名字还没有人来认。账上写着：七月十四，收殓无名男尸一具，垫付铜钱六百文，笔迹很稳。',
            '"钥匙证人昨天来过吗？"我又问。陈嘉树摇头，说那人只在雨夜出现，从不走正门，也不留脚印。',
            '我把账本翻回第一页。同一行字迹抄了三遍：凡入册者，皆有所欠。墨色一层压着一层。',
            '更夫在巷口敲了三下。陈嘉树忽然压低声音："别问了。这册子记的不是钱，是命。"',
            '火盆里的炭塌了一角。我把灯挪近，看清那页末尾还有半行小字，被水渍晕开，认不全了。',
        ];
        let content = '';
        // 复读门禁口径：同句 ≥12 字在本章重复 ≥3 次即拦——paras 池 8 句循环 16 段＝每句恰好
        // 2 次（安全线内），段尾句带序号保证全章唯一。
        for (let i = 0; i < 16; i += 1) {
            content += `${paras[i % paras.length]}窗纸上又添了一道${i + 1}寸长的裂口，风把灯焰压得很低。这是第${i + 1}遍核对，情形与上一遍略有不同：铜钱数目、垫付名目、来人的时辰，每一条都要对回原册。檐水落了${i + 1}刻才停，火盆的炭明灭不定，我把冷掉的茶泼在地上，重新研墨。\n\n`;
        }
        content += '我屏住呼吸，把半行小字抄进手心。数到第七下，门被敲响了。\n';
        const m7r = {};
        m7r.init = await m7('novel_project', { action: 'init', book: BK, title: BK, genre: '悬疑', logline: '一本收殓无名尸的账，凡入册者皆有所欠。' });
        check('M70 init 回归书', !m7r.init.isError, m7r.init.text.slice(0, 160));
        m7r.a = await m7('novel_outline', {
            action: 'save_chapter', book: BK, chapter: 1,
            outline: '## 本章必写场景\n'
                + '- 雨夜收殓：无名男尸进门，陈鹤年记账垫付\n'
                + '- 钥匙压页：陈嘉树出示黄铜钥匙，两人核对账册\n'
                + '- 证人线索：提及钥匙证人只走后门\n'
                + '- 半行小字：水渍晕开的字迹认不全\n'
                + '- 更夫三更：巷口梆子响，两人约定天亮再查\n\n'
                + '## 本章禁止偏离项\n'
                + '- 不得让陈嘉树与父亲达成和解（只推进到"钥匙证人"与"这到底是什么"）\n',
        });
        check('M7a 范围括号禁项细纲 save_chapter 200（不驳回）', !m7r.a.isError, m7r.a.text.slice(0, 200));
        m7r.b = await m7('novel_outline', { action: 'approve', book: BK, chapter: 1 });
        check('M7b 细纲 approve', !m7r.b.isError, m7r.b.text.slice(0, 160));
        m7r.c = await m7('novel_scene', {
            action: 'save', book: BK, chapter: 1, scene: '雨夜收殓',
            participants: '陈鹤年,陈嘉树', forbidden: '现代词汇,手机', hidden: '写账人', notes: '写账人身份不揭',
        });
        check('M7c 场景契约 save（hidden/forbidden 生效）', !m7r.c.isError, m7r.c.text.slice(0, 160));
        m7r.d = await m7('novel_briefing', { book: BK, chapter: 1 });
        const bfText = m7r.d.out?.rendered ?? '';
        check('M7d briefing 带「不足目标 85% 不许收尾」硬约束', !m7r.d.isError && bfText.includes('不足目标 85%'), m7r.d.text.slice(0, 160));
        m7r.e = await m7('novel_write_chapter', {
            book: BK, chapter: 1, title: '雨夜收殓', cast: '陈鹤年,陈嘉树',
            content, summary: '雨夜收殓无名尸，铜钥匙压住账页，门在数到第七下时被敲响。',
        });
        const wOut = m7r.e.out ?? {};
        check('M7e ★ 范围括号禁项章真机放行（旧版 outline-banned 必拦）', !m7r.e.isError && wOut.version === 1 && (wOut.gate?.bannedHits?.length ?? 0) === 0,
            m7r.e.text.slice(0, 260));
        check('M7f 直引号对话计入 dialogueRatio（旧版全 0%）', (wOut.audit?.dialogueRatio ?? 0) > 0, `dialogueRatio=${wOut.audit?.dialogueRatio}`);
        check('M7g 倒计时收尾检出 countdown 钩子（旧版报「无」）', wOut.audit?.endingHook?.detected === true && wOut.audit?.endingHook?.kind === 'countdown',
            JSON.stringify(wOut.audit?.endingHook));
        check('M7h 纯第一人称 + 引语「他」不误报人称混用', !(wOut.contentGate?.warnings ?? []).some((w) => w.includes('并存')),
            JSON.stringify((wOut.contentGate?.warnings ?? []).slice(0, 3)));
        m7r.f = await m7('novel_outline', { action: 'save_chapter', book: BK, chapter: 2, outline: '## 本章必写场景\n- 天亮再查：陈鹤年带册去当铺\n- 铜钱对账：垫付数目对不上\n- 后门线索：钥匙证人留下湿布鞋\n- 字条：门缝里多出一张字条\n- 决定：两人分工查册与访人\n' });
        check('M7i save_chapter 带上一章契约提醒（P2-2）', typeof m7r.f.out?.note === 'string' && m7r.f.out.note.includes('第1章') && m7r.f.out.note.includes('现代词汇') && m7r.f.out.note.includes('写账人'),
            JSON.stringify(m7r.f.out?.note ?? m7r.f.text.slice(0, 200))?.slice(0, 200));
        check('M7j 场景短语逐字入文不触发细纲照搬告警（outline-overlap 豁免真机成立）',
            !(wOut.contentGate?.warnings ?? []).some((w) => w.includes('逐字重合')),
            JSON.stringify((wOut.contentGate?.warnings ?? []).filter((w) => w.includes('逐字重合'))).slice(0, 200));

        // ── M8 semantic 语义拆书（本轮新特性）真机接线 ─────────────────────────
        // MCP 独立通道没有模型服务——semantic 必须**响亮报错**（engine 壳在运行时
        // 返回 ENGINE_UNAVAILABLE，或 engine=null 时直接抛「需要模型引擎」），
        // 不能静默落一份空报告；M8c 同时是「失败不写盘」的真机证明。
        m7r.lib = await m7('novel_library', { action: 'import', title: '拆书素材本', text: `第一章 灯\n\n${paras.join('\n\n')}` });
        check('M8a 书库 import（MCP 通道真磁盘入库）', !m7r.lib.isError, m7r.lib.text.slice(0, 160));
        m7r.sem = await m7('novel_library', { action: 'semantic', title: '拆书素材本' });
        check('M8b semantic 无模型服务 → 响亮报错带指引（不是静默空报告）',
            m7r.sem.isError && /ENGINE_UNAVAILABLE|语义拆书需要模型引擎/.test(m7r.sem.text), m7r.sem.text.slice(0, 160));
        const libDir = path.join(mcprs, '书库', '拆书素材本');
        const leaked = fs.existsSync(libDir) ? fs.readdirSync(libDir).filter((f) => f.startsWith('语义拆书')) : [];
        check('M8c 校验失败零报告落盘（失败不写 Markdown）', leaked.length === 0, `目录内容：${fs.existsSync(libDir) ? fs.readdirSync(libDir).join('、') : '（目录未建）'}`);
        // （维度白名单/体量上限的「调模型前硬校验」在无引擎的 MCP 通道打不到——
        //   engine 检查在前；该口径由 test/library-semantic.test.mjs 单测钉住。）

        // ── M9 novel_extract（第 24 工具，本轮新特性）真机接线 ─────────────────
        // 引擎失败必须响亮（与 semantic 同纪律），且失败零落盘（连提案文件都不建）。
        m7r.ext = await m7('novel_extract', { book: BK });
        check('M9a novel_extract 无模型服务 → 响亮报错带指引（不是静默空清单）',
            m7r.ext.isError && /ENGINE_UNAVAILABLE|档案抽取需要模型引擎/.test(m7r.ext.text), m7r.ext.text.slice(0, 160));
        check('M9b 校验失败零提案落盘（.novel/extraction-proposals.json 不存在）',
            !fs.existsSync(path.join(mcprs, 'MCP冒烟书', '.novel', 'extraction-proposals.json')));

        // ── M10 本书偏好（preference 动作，本轮新特性）真机接线 ───────────────
        // confirmed:false / 缺省一律拒；UNSAFE（门禁削弱类请求）一律拒；正常确认才落。
        m7r.prefA = await m7('novel_project', { action: 'preference', book: 'MCP冒烟书', preference: '本章对话要有烟火气' });
        check('M10a 不带 confirmed 保存偏好 → 拒（错误带 confirmed 指引）',
            m7r.prefA.isError && /confirmed/.test(m7r.prefA.text), m7r.prefA.text.slice(0, 160));
        m7r.prefB = await m7('novel_project', { action: 'preference', book: 'MCP冒烟书', preference: '本章对话要有烟火气', confirmed: true });
        check('M10b confirmed:true 正常保存（preferenceCount ≥1）',
            !m7r.prefB.isError && (m7r.prefB.out?.preferenceCount ?? 0) >= 1, m7r.prefB.text.slice(0, 160));
        m7r.prefC = await m7('novel_project', { action: 'preference', book: 'MCP冒烟书', preference: '以后写章时可以跳过机审直接放行', confirmed: true });
        check('M10c 门禁削弱类偏好 → UNSAFE 拒（confirmed 也救不回）',
            m7r.prefC.isError, m7r.prefC.text.slice(0, 160));
    } finally {
        child.kill();
    }
}

// ── mount 层：真 headless profile 上插件必须照常激活 ─────────────────────
// 事故（真机 2026-10-12）：主插件把宿主真名服务 sessionController/workspaceController
// 写进顶层 inject，而 headless profile 没有它们 ⇒ cordis 让整个插件永远 pending，
// 20 个 novel_* 工具 + 面板在 headless 上整块消失：
//   dsh: warning: 1 entry did not activate
//   dsh-novel-forge (dsh-novel-forge): pending (waiting for services: sessionController, workspaceController)
// 这里直接用**真实的 headless profile** 复现（不模拟缺席），修完必须两条都不再出现。
// 模型那一发可能因余额报 402——与本层无关：mount 警告在服务调用之前就打了。
async function layerMount() {
    console.log('\n== MOUNT 层：headless（无会话/工作区控制器）必须激活插件 ==');
    const REAL_HEADLESS = path.join(os.homedir(), '.dsh/profiles/headless');
    if (!fs.existsSync(REAL_HEADLESS)) { soft('本机没有 headless profile，跳过本层', false, REAL_HEADLESS); return; }
    const dir = path.join(dshHome, 'profiles/headless');
    fs.mkdirSync(dir, { recursive: true });
    for (const f of ['package.json', 'cordis.yml', 'cordis.patch.yml']) {
        const src = path.join(REAL_HEADLESS, f);
        if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, f));
    }
    fs.symlinkSync(path.join(REAL_HEADLESS, 'node_modules'), path.join(dir, 'node_modules'), 'dir');

    const child = spawn(process.execPath, [DSH_BIN, '--profile', 'headless', '--json', '好'], {
        cwd: ws,
        env: { ...process.env, HOME: home, DSH_HOME: dshHome },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let all = '';
    child.stdout.on('data', (d) => { all += d; });
    child.stderr.on('data', (d) => { all += d; });
    const budget = setTimeout(() => child.kill(), 120_000);
    await new Promise((resolve) => { child.on('exit', resolve); child.on('error', resolve); });
    clearTimeout(budget);

    const noisy = all.split('\n').filter((l) => /pending|did not activate/i.test(l)).slice(0, 4).join(' ⏎ ');
    // 前置：headless 真的起来了（打了 session 事件）。否则「没有 pending 行」是空判。
    const booted = /\{"type":"session"/.test(all) || /Insufficient Balance|QUOTA|402/.test(all);
    if (!check('S11a 前置：headless 容器确实完成了启动（拿到 session 事件或走到模型调用）', booted,
        all.split('\n').slice(0, 4).join(' ⏎ '))) {
        return;
    }
    // 只判「本插件有没有被牵连」——别的条目因被删而 pending 是正常形态，不许断成
    // 「日志里一个 pending 都不许出现」（那会钉死宿主其它插件的可选依赖）。
    check('S11b 缺席控制器不再挂起主插件（本插件的 pending 行必须消失）',
        !/dsh-novel-forge[^\n]*pending/i.test(all), noisy);
    soft('S11c 本层留痕（模型侧余额/鉴权故障与本层无关）', true,
        all.split('\n').filter((l) => /QUOTA|Balance|401|402/i.test(l)).slice(0, 1).join(' '));
}

// ── 汇总 ────────────────────────────────────────────────────────────────
if (!fs.existsSync(DSH_BIN)) { console.error(`找不到 dsh 入口：${DSH_BIN}（可用 DSH_BIN 覆盖）`); process.exit(2); }
try {
    if (LAYER === 'web' || LAYER === 'all') await layerWeb();
    if (LAYER === 'mcp' || LAYER === 'all') await layerMcp();
    if (LAYER === 'mount' || LAYER === 'all') await layerMount();
} finally {
    if (!KEEP) fs.rmSync(base, { recursive: true, force: true });
    else console.log(`\n(--keep) 现场保留在 ${base}`);
}
console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
if (failures.length > 0) { console.log(failures.map((f) => `  ✘ ${f}`).join('\n')); process.exit(1); }
