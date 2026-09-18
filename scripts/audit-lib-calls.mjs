// 静态审计②：lib/**.js 里所有 `alias.fn(` 跨模块（namespace import）调用
// 是否真实存在于被引模块的导出里。
// 防「assembleBook is not a function」类静默病灶复发——具名导入缺了会在
// boot 时抛错（结构性安全），namespace 导入缺了只有点击那一刻才炸，必须静态扫。
// 先剥注释再匹配：注释里引用的历史写法不算调用。
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)), 'lib');

const stripComments = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));

const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== 'node_modules') walk(p); }
    else if (p.endsWith('.js')) files.push(p);
  }
};
walk(root);

// 模块导出表：file -> Set(fn)
const exportsOf = new Map();
for (const f of files) {
  const src = stripComments(readFileSync(f, 'utf8'));
  const set = new Set();
  for (const m of src.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)) set.add(m[1]);
  for (const m of src.matchAll(/export\s+(?:const|let|var)\s+(\w+)/g)) set.add(m[1]);
  for (const m of src.matchAll(/export\s*\{([^}]+)\}/g)) {
    for (const piece of m[1].split(',')) {
      const name = piece.trim().split(/\s+as\s+/).pop()?.trim();
      if (name) set.add(name);
    }
  }
  exportsOf.set(f, set);
}

let bad = 0, checked = 0;
for (const f of files) {
  const src = stripComments(readFileSync(f, 'utf8'));
  const imports = new Map(); // alias -> 绝对路径
  for (const m of src.matchAll(/import\s+\*\s+as\s+(\w+)\s+from\s+'\.\/([\w/-]+)\.js'/g)) {
    imports.set(m[1], resolve(f, '..', `${m[2]}.js`));
  }
  if (!imports.size) continue;
  const seen = new Map(); // alias -> Set(fn)（去重，数量按对计）
  for (const m of src.matchAll(/\b(\w+)\.(\w+)\s*\(/g)) {
    const [, alias, fn] = m;
    if (imports.has(alias)) {
      if (!seen.has(alias)) seen.set(alias, new Set());
      seen.get(alias).add(fn);
    }
  }
  for (const [alias, target] of imports) {
    const exported = exportsOf.get(target);
    if (!exported) { console.log(`⚠️ ${alias} → ${target} 未收集到导出`); continue; }
    for (const fn of seen.get(alias) ?? []) {
      checked++;
      if (!exported.has(fn)) {
        console.log(`✗ ${f.replace(root + '/', '')}: ${alias}.${fn}() ← ${target.replace(root + '/', '')} 未导出`);
        bad++;
      }
    }
  }
}
console.log(`audit-lib-calls: ${checked} 个跨模块调用，${bad} 个悬空`);
process.exit(bad === 0 ? 0 : 1);
