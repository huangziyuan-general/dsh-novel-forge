// scripts/rest-real-check.mjs — REST 数据面真机回归（可重复跑）。
//
// 背景：2026-10-14 审查批的面板保存修复，444 绿测不出两类真机问题——
//   ① memIo（同步 Map）是原子替身，真 backend 的异步交错才有竞态窗口；
//   ② fetch 替身让「按 code 分流」逻辑永远跑不到。
// 本脚本用独立进程起 server-api 真数据面（createNodeFsBackend 含 containment）+
// 真 http server + 真 fetch，在临时工作区走完整保存链，跑完即删：不碰真书、
// 不依赖宿主进程。跑法：`node scripts/rest-real-check.mjs`，全 PASS 退出码 0。
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerServerApi } from '../lib/server-api.js';
import { createNodeFsBackend } from '../lib/mcp-standalone.js';
import { sessionFatigue, firstDraftByChapter } from '../lib/health.js';

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const results = [];
const check = (name, ok, detail = '') => {
    results.push({ name, ok });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-forge-real-'));
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-forge-home-'));
const backend = createNodeFsBackend(root);
const registrations = [];
const ctx = {
    fs: backend,
    emit() {},
    logger: { info() {} },
    inject: (_deps, fn) => { fn(ctx); },
    effect: (fn) => { const cleanup = fn(); return typeof cleanup === 'function' ? cleanup : () => {}; },
    webServer: { register: (def) => { registrations.push(def); return () => {}; } },
};
registerServerApi(ctx, { workspaceRoot: root, scanTopK: 8, minChapterChars: 10, maxChapterChars: 5000 }, {
    homedir: fakeHome,
    sessionProbe: () => ({ sessions: null, workspace: null, full: false }),
});
const server = http.createServer((req, res) => registrations[0].handler(req, res));
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/api/novel-forge`;
const j = async (url, body, method = 'POST') => {
    const res = await fetch(`${base}${url}`, {
        method,
        headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${server.address().port}`, 'x-dsh-novel-forge': '1' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null; try { json = await res.json(); } catch { /* 404 空体 */ }
    return { status: res.status, json };
};

try {
    // ── 建测试书（数据布局最小集）────────────────────────────────────────────
    const book = '真机验证书';
    const bdir = path.join(root, book);
    fs.mkdirSync(path.join(bdir, '大纲', '细纲'), { recursive: true });
    fs.writeFileSync(path.join(bdir, 'novel.json'), JSON.stringify({
        title: book, genre: '悬疑', logline: '', stage: 'chapter', phases: {},
        approvals: { outline: { 1: true } },
        chapters: {}, cast: [], proposals: [], gateFailures: {},
    }));
    fs.writeFileSync(path.join(bdir, '大纲', '细纲', '第1章.md'), '# 第1章 雪夜\n\n- 码头相遇：她在雾里认出暗号。\n- 灯下验货：木匣的锁被换过。\n- 尾声钩子：来人自称是她弟弟。');
    const ch = (n) => `/projects/${encodeURIComponent(book)}/chapters/${n}`;
    const para = ['雾从水面漫上来，她在灯下认出那道暗号。', '木匣的锁被换过，铜色新得刺眼。', '来人自称是她弟弟，可弟弟三年前就死了。'].join('\n\n');
    const onePara = '雪夜码头一个人影站在灯下。'.repeat(4);

    // ① 空稿 → 400 EMPTY_CHAPTER（修复：空稿不再落 0 字章节）
    {
        const r = await j(ch(1), { text: '   ' });
        check('① 空稿 400 EMPTY_CHAPTER', r.status === 400 && r.json?.error?.code === 'EMPTY_CHAPTER', `status=${r.status} code=${r.json?.error?.code}`);
        check('① 盘上无 0 字章节', !fs.existsSync(path.join(bdir, '正文')), '正文/ 目录未被创建');
    }

    // ② 单段稿 → 409 GATE_REJECTED（机审），不是 500
    {
        const r = await j(ch(1), { text: onePara });
        check('② 单段稿 409 GATE_REJECTED（机审）', r.status === 409 && r.json?.error?.code === 'GATE_REJECTED', `status=${r.status} code=${r.json?.error?.code}`);
    }

    // ③ force:true + 机审不过 → 仍 409（字数线/段落线连 force 也顶不开）
    {
        const r = await j(ch(1), { text: onePara, force: true });
        check('③ force 顶不开机审 → 仍 409', r.status === 409 && r.json?.error?.code === 'GATE_REJECTED', `status=${r.status}`);
        check('③ 盘上仍无该章版本', !fs.existsSync(path.join(bdir, '正文')), '无正文文件');
    }

    // ④ 合规稿 → 200 落盘，chars 为机审口径
    {
        const r = await j(ch(1), { text: para });
        check('④ 合规稿 200 落盘', r.status === 200 && r.json?.ok === true, `status=${r.status} chars=${r.json?.value?.chars}`);
        check('④ chars 为机审口径（数字）', typeof r.json?.value?.chars === 'number' && r.json.value.chars > 0, `chars=${r.json?.value?.chars}`);
        check('④ version v1', r.json?.value?.version === 1, `version=${r.json?.value?.version}`);
    }

    // ⑤⑥ 标题保护：显式标题生效；省略 title 沿用原标题（不被「第 1 章」抹掉）
    {
        const r2 = await j(ch(1), { text: `${para}\n\n补一段。`, title: '雪夜遇袭' });
        const r3 = await j(ch(1), { text: `${para}\n\n再补一段。` });
        check('⑤ 显式标题生效', r2.json?.value?.chapter?.title === '雪夜遇袭', `title=${r2.json?.value?.chapter?.title}`);
        check('⑥ 省略 title 沿用原标题', r3.json?.value?.chapter?.title === '雪夜遇袭', `title=${r3.json?.value?.chapter?.title}`);
    }

    // ⑦ GET 章节非空（R3b 真机面）
    {
        const r = await j(ch(1), undefined, 'GET');
        check('⑦ GET 章节返回正文', r.status === 200 && String(r.json?.value ?? '').includes('雾从水面'), `status=${r.status} len=${String(r.json?.value ?? '').length}`);
    }

    // ⑧ 并发双存同章 × 3 组 → 全部 2xx、版本单调递增、无丢更新
    //（真机竞态实证：memIo 替身测不出，真 backend 异步交错曾 3/10 失败）
    {
        let allOk = true; let detail = '';
        for (let i = 0; i < 3; i += 1) {
            const [a, b] = await Promise.all([
                j(ch(1), { text: `${para}（第${i}轮甲线补笔。`.padEnd(0) } ),
                j(ch(1), { text: `${para}（第${i}轮乙线补笔。` }),
            ]);
            if (a.status !== 200 || b.status !== 200) {
                allOk = false;
                detail = `第${i}组 a=${a.status} b=${b.status} ${JSON.stringify([a, b].filter((x) => x.status !== 200).map((x) => x.json?.error))}`;
            }
        }
        const files = fs.existsSync(path.join(bdir, '正文')) ? fs.readdirSync(path.join(bdir, '正文')).length : 0;
        check('⑧ 并发双存 ×3 组全 2xx（无互抢 500/截断误报）', allOk, detail);
        check('⑧ 正文版本文件 ≥ 7（v1-v3 + 每组两版，无覆盖丢失）', files >= 7, `files=${files}`);
    }

    // ⑨ 世界书自定义 id（无触发词）→ 兜底落盘，不再抛错
    {
        const r = await j(`/worldbook/${encodeURIComponent(book)}`, { id: 'power_map', name: '权力地图', content: '三城权柄的分布图，随剧情逐步揭示。' });
        check('⑨ 自定义 id 世界书条目落盘（兜底）', r.status === 200 || r.status === 201, `status=${r.status}`);
    }

    // ⑩ 疲劳新算法回放：有 audit.jsonl 就回放（CI/无数据时跳过不判失败）
    {
        const auditPath = process.env.REAL_CHECK_AUDIT;
        if (auditPath && fs.existsSync(auditPath)) {
            const auditText = fs.readFileSync(auditPath, 'utf8');
            const firsts = firstDraftByChapter(auditText);
            const sid = [...new Set([...firsts.values()].map((v) => v.session).filter(Boolean))][0];
            const f = sessionFatigue(auditText, sid);
            const warn = String(f?.warn ?? '');
            check('⑩ 首稿序列抽出', firsts.size >= 20, `chapters=${firsts.size}`);
            check('⑩ 无旧算法比值误报', !/比值/.test(warn), `warn=${warn.slice(0, 50)}`);
            check('⑩ 文案不宣称「稀释输出质量」', !warn.includes('会稀释输出质量'), `warn=${warn.slice(0, 50)}`);
        } else {
            console.log('SKIP  ⑩ 疲劳回放（未给 REAL_CHECK_AUDIT=audit.jsonl 路径）');
        }
    }
} finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(fakeHome, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n═══ REST 真机回归：${results.length - failed.length}/${results.length} PASS${failed.length ? `，${failed.length} FAIL` : ''} ═══`);
process.exitCode = failed.length ? 1 : 0;
