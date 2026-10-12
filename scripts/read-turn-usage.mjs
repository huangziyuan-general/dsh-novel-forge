// scripts/read-turn-usage.mjs — 真机写章回合的用量与行为读取，两种模式：
//
// ① 会话取证（原有）：读 ~/.dsh/sessions 下 zstd 压缩的 session jsonl——
//    看未截断的工具出入参与逐步 token。用法：
//      node scripts/read-turn-usage.mjs <会话目录 | 会话父目录>
//
// ② 事件流门禁（0.16.3 后加）：读 real-turn-test.sh 落盘的 --json 事件流，算四项指标，
//    --assert 时越线 exit 1——把「真机回归从人眼看数」变成可重复门禁。阈值默认：
//    峰值上下文 ≤ 120k（健康 ~87k，死亡螺旋 183k）、退路读取 = 0、宿主拒收 = 0、步数 > 0。
//    用法：
//      node scripts/read-turn-usage.mjs --events <events.jsonl> [--assert]
//           [--max-peak-tokens N] [--max-fallback-reads N] [--max-rejections N]
//    阈值改动必须连同理由写进 real-turn-test.sh 的注释——不许失败后改阈值硬压。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

// ── 参数解析 ──────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
};
const eventsFile = flag('--events');
const assertMode = argv.includes('--assert');

if (!eventsFile) {
    const target = argv[0];
    if (!target) { console.error('用法：node scripts/read-turn-usage.mjs <会话目录|sessions 根> 或 --events <events.jsonl> [--assert]'); process.exit(2); }
    sessionMode(target);
} else {
    eventsMode(eventsFile, { assertMode, maxPeak: Number(flag('--max-peak-tokens') ?? 120000), maxReads: Number(flag('--max-fallback-reads') ?? 0), maxRej: Number(flag('--max-rejections') ?? 0) });
}

// ── 模式②：--json 事件流（real-turn-test.sh 的数据源）────────────────────────
function eventsMode(file, { assertMode, maxPeak, maxReads, maxRej }) {
    const evs = fs.readFileSync(file, 'utf8').trim().split('\n')
        .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const u = evs.filter((e) => e.phase === 'step_end').map((e) => e.usage).filter(Boolean);
    // 峰值上下文口径与 CHANGELOG 一致：cacheRead + input（不含 completion）。
    const ctx = (x) => (x.cacheReadTokens ?? 0) + (x.inputTokens ?? 0);
    const reads = evs.filter((e) => ['read', 'grep', 'glob'].includes(e.tool)).length;
    const rej = evs.filter((e) => String(e.result ?? '').includes('invalid output')).length;
    const search = evs.filter((e) => e.tool === 'novel_search').length;
    const writes = evs.filter((e) => e.tool === 'novel_write_chapter').length;
    const peak = u.length ? Math.max(...u.map(ctx)) : 0;
    const peakC = u.length ? Math.max(...u.map((x) => x.outputTokens ?? 0)) : 0;

    console.log(`[usage] 步数 ${u.length} | 峰值上下文 ${peak || '-'} | completion 峰值 ${peakC || '-'}`);
    console.log(`[行为] 宿主 read/grep/glob ${reads} 次（0 = 没退回去捞原文） | 检索调用 ${search} 次 | 工具被宿主拒收 ${rej} 次 | novel_write_chapter 尝试 ${writes} 次`);

    if (!assertMode) return;
    // 门禁：四项，任何一项越线 exit 1。0 步也是失败（空跑/启动即崩的形状）。
    const gates = [
        ['步数', u.length, '>', 0],
        ['峰值上下文', peak, '<=', maxPeak],
        ['宿主 read/grep/glob（退路读取）', reads, '<=', maxReads],
        ['工具被宿主拒收', rej, '<=', maxRej],
    ];
    const broken = gates.filter(([, v, op, t]) => (op === '>' ? !(v > t) : !(v <= t)));
    for (const [name, v, op, t] of gates) {
        const ok = !broken.includes(gates.find((g) => g[0] === name));
        console.log(`  ${ok ? '✔' : '✘'} ${name} = ${v}（门槛 ${op} ${t}）`);
    }
    if (broken.length > 0) {
        console.error(`✘ 真机门禁未过（${broken.length}/4）：这是死亡螺旋形状复发的信号。先修因，别改阈值硬压。`);
        process.exit(1);
    }
    console.log('✔ 真机门禁全过');
}

// ── 模式①：会话目录取证（原有逻辑，保持不动）────────────────────────────────
function sessionMode(target) {
    const isSessionDir = (p) => fs.existsSync(p) && fs.statSync(p).isDirectory()
        && fs.readdirSync(p).some((f) => f.endsWith('.jsonl.zstd'));

    function sessionDirs(p) {
        if (isSessionDir(p)) return [p];
        if (!fs.statSync(p).isDirectory()) return [];
        const out = [];
        for (const f of fs.readdirSync(p)) {
            const q = path.join(p, f);
            if (isSessionDir(q)) out.push(q);
            else out.push(...sessionDirs(q));
        }
        return out;
    }

    function events(dir) {
        const file = fs.readdirSync(dir).find((f) => f.endsWith('.jsonl.zstd'));
        const raw = fs.readFileSync(path.join(dir, file));
        const text = zlib.zstdDecompressSync(raw).toString('utf8');
        return text.split('\n').filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    }

    const num = (o, keys) => { for (const k of keys) { const v = Number(o?.[k]); if (Number.isFinite(v) && v > 0) return v; } return 0; };
    const P = ['prompt', 'promptTokens', 'input', 'inputTokens', 'prompt_tokens'];
    const C = ['completion', 'completionTokens', 'output', 'outputTokens', 'completion_tokens'];
    const CA = ['cached', 'cacheRead', 'cacheReadInputTokens', 'cached_tokens', 'cache_read_input_tokens'];

    const dirs = sessionDirs(target).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    if (dirs.length === 0) { console.error('没找到会话目录：', target); process.exit(1); }
    const evs = events(dirs[0]);
    console.log(`会话 ${path.basename(dirs[0])} · 事件 ${evs.length} 条`);

    const usages = [];
    const toolCalls = [];
    (function walk(o) {
        if (Array.isArray(o)) { o.forEach(walk); return; }
        if (!o || typeof o !== 'object') return;
        if (o.usage && (num(o.usage, P) || num(o.usage, C))) usages.push(o.usage);
        const name = o.name ?? o.toolName ?? (o.tool_call && o.tool_call.name);
        if (typeof name === 'string' && (o.arguments || o.args || o.input)) {
            const arg = o.arguments ?? o.args ?? o.input;
            let hint = '';
            try {
                const a = typeof arg === 'string' ? JSON.parse(arg) : arg;
                hint = ['path', 'file', 'file_path', 'book', 'chapter', 'action', 'q', 'query', 'to']
                    .map((k) => (a?.[k] !== undefined ? `${k}=${String(a[k]).slice(0, 40)}` : ''))
                    .filter(Boolean).join(' ');
            } catch { hint = String(arg).slice(0, 60); }
            toolCalls.push(`${name}${hint ? ` (${hint})` : ''}`);
        }
        Object.values(o).forEach(walk);
    })(evs);

    console.log(`\n[用量] 采样 ${usages.length} 次`);
    usages.forEach((u, i) => console.log(`  #${i + 1} prompt=${num(u, P)}  cached=${num(u, CA)}  completion=${num(u, C)}`));
    if (usages.length) {
        const maxP = Math.max(...usages.map((u) => num(u, P)));
        const maxC = Math.max(...usages.map((u) => num(u, C)));
        const maxCache = Math.max(...usages.map((u) => num(u, CA)));
        console.log(`  峰值：prompt=${maxP}（其中缓存 ${maxCache}，${maxP ? (100 * maxCache / maxP).toFixed(1) : 0}%）· completion=${maxC}`);
    }
    console.log(`\n[工具序列] ${toolCalls.length} 次`);
    for (const t of toolCalls) console.log('  ' + t);
    const reads = toolCalls.filter((t) => /^read\(/.test(t) || /正文\//.test(t));
    console.log(`\n[整章 read 迹象] ${reads.length} 次${reads.length ? '：' + reads.slice(0, 6).join(' | ') : '（无）'}`);
}
