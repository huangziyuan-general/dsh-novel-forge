// scripts/read-turn-usage.mjs — 读一次真机 headless 会话的落盘记录，回答两个问题：
//   ① 逐步 token 用量（prompt / cached / completion）——「输入是不是被自己读爆的」；
//   ② 工具调用序列（尤其有没有 read 整章正文）——「摘要窗口 + 索引自动续建有没有生效」。
// 会话持久化是 zstd 压缩的 jsonl（session.v4.jsonl.zstd），Node 26 的 zlib 自带解码。
// 用法：node scripts/read-turn-usage.mjs <会话目录 | 会话父目录>
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const target = process.argv[2];
if (!target) { console.error('用法：node scripts/read-turn-usage.mjs <会话目录或 sessions 根>'); process.exit(2); }

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
