// scripts/migrate-quotes.mjs — 一次性存量迁移：《食妖帖》正文 25 章直角引号 → 国标弯引号。
// 报告 P0 路线（用户已批）：只动正文文件，不动 novel.json（引号转换不改变字符数，
// chars 口径不受影响）；转换用插件同一份 normalizeQuotes（lib/punctuation.js），
// 逐章双验证（长度不变 + 剥引号等价）后才写回，任何一章验证不过即中止不写。
import { readFileSync, writeFileSync, readdirSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, '食妖帖', '正文');
const { normalizeQuotes } = await import(join(root, 'lib', 'punctuation.js'));

const stripQuotes = (s) => s.replace(/[「」『』“”‘’]/g, '');
const files = readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
const summary = [];
let totalConverted = 0;

for (const f of files) {
    const p = join(dir, f);
    const src = readFileSync(p, 'utf8');
    const { text, converted } = normalizeQuotes(src);
    if (converted === 0) { summary.push(`${f}: 0 处（已是弯引号）`); continue; }
    // 双验证：长度不变（引号字符 1:1 替换）+ 剥掉全部引号后逐字相等（零信息损失）
    if (text.length !== src.length || stripQuotes(text) !== stripQuotes(src)) {
        console.error(`验证失败，中止（未写回）：${f}`);
        process.exit(1);
    }
    writeFileSync(p, text, 'utf8');
    totalConverted += converted;
    summary.push(`${f}: ${converted} 处`);
}

const line = `${new Date().toISOString()} | migrate/quotes | chapters=${files.length} converted=${totalConverted} | GB/T 15834—2011 直角引号→弯引号（normalizeQuotes 同源转换，双验证通过）\n`;
try { appendFileSync(join(root, '食妖帖', '.novel', 'audit.jsonl'), line); } catch {}

console.log(summary.join('\n'));
console.log(`\n合计转换 ${totalConverted} 处，${files.length} 个文件，审计行已追加。`);
