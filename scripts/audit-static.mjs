// scripts/audit-static.mjs — 客户端静态自检（两道，都是"构建与单测照不到的静默故障"）。
//
// 为什么需要它：
//  ① `src/client/` 少一个 import，**构建不报错**（打包成 factory 后是运行时 ReferenceError），
//     单测只覆盖控制器、不覆盖视图渲染 —— 整块视图变空白却全程绿灯
//     （0.13.0 的 overview.js 少导入 KV 就是这么漏过去的）。
//  ② 视图写的属性名与控制器读的**对不上**时同样静默：`dataset.no` 全项目没人写、
//     读出来是 undefined → Number(undefined) = NaN → 播放器转一圈回原位，界面"点了没反应"
//     （0.13.0 听书整列「▶」失效，183 个用例全绿）。
//
// 两道检查都**先剥注释与字符串**再扫 —— 否则注释里提一句 `Btn({...})` 就会被误报
// （踩过：注释里写 `KV(...)` / `Btn(...)` 直接让自检变红灯）。
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'src/client';

/** 剥掉注释与字符串字面量，只留"真代码"。 */
function strip(src) {
	let out = '';
	let i = 0;
	const n = src.length;
	while (i < n) {
		const c = src[i];
		const c2 = src[i + 1];
		// 行注释
		if (c === '/' && c2 === '/') { while (i < n && src[i] !== '\n') i++; continue; }
		// 块注释
		if (c === '/' && c2 === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
		// 字符串：原样保留（属性名就在里面），但把内容里的引号"吃掉"，避免误判边界
		if (c === '"' || c === "'" || c === '`') {
			const q = c; i++; out += q;
			while (i < n && src[i] !== q) {
				if (src[i] === '\\') { out += src[i] + (src[i + 1] ?? ''); i += 2; continue; }
				out += src[i]; i++;
			}
			out += q; i++; continue;
		}
		out += c; i++;
	}
	return out;
}

function walk(dir) {
	if (!fs.existsSync(dir)) return [];
	const out = [];
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, e.name);
		if (e.isDirectory()) out.push(...walk(full));
		else if (e.name.endsWith('.js')) out.push(full);
	}
	return out;
}

const files = walk(ROOT);
const raw = new Map(files.map((f) => [f, fs.readFileSync(f, 'utf8')]));
const code = new Map([...raw].map(([f, s]) => [f, strip(s)]));

let failures = 0;

// ─────────────────────────────────────────────────────────────
// 检查 ①：调用了但没导入/声明（以及导入了但没用）
// ─────────────────────────────────────────────────────────────
const GLOBALS = new Set([
	'String', 'Number', 'Boolean', 'Object', 'Array', 'Map', 'Set', 'Promise', 'Error', 'TypeError',
	'JSON', 'Math', 'Date', 'RegExp', 'URL', 'URLSearchParams', 'Infinity', 'NaN', 'AbortController',
	'Blob', 'FormData', 'TextEncoder', 'TextDecoder', 'Intl', 'Symbol', 'WeakMap', 'WeakSet', 'Function',
]);

console.log('── ① 导入 / 调用一致性');
let importIssues = 0;
for (const file of files) {
	const src = code.get(file);
	const imported = new Set();
	for (const m of raw.get(file).matchAll(/import\s*\{([^}]*)\}\s*from/g)) {
		for (const name of m[1].split(',').map((s) => s.trim().split(/\s+as\s+/).pop()).filter(Boolean)) imported.add(name);
	}
	const declared = new Set([...src.matchAll(/(?:function|const|let|class)\s+([A-Za-z0-9_$]+)/g)].map((m) => m[1]));
	const called = new Set([...src.matchAll(/\b([A-Z][A-Za-z0-9_$]*)\s*\(/g)].map((m) => m[1]));
	const missing = [...called].filter((x) => !imported.has(x) && !declared.has(x) && !GLOBALS.has(x));

	const body = src.replace(/^import[\s\S]*?from\s*['"][^'"]*['"];?/gm, '');
	const unused = [...imported].filter((x) => !new RegExp('\\b' + x + '\\b').test(body));

	if (missing.length) { console.log(`  \u2717 ${file}：调用了但没导入/声明 → ${missing.join(', ')}`); importIssues += missing.length; }
	if (unused.length) console.log(`  \u00b7 ${file}：导入但没用到 → ${unused.join(', ')}`);
}
if (!importIssues) console.log('  （无）');
failures += importIssues;

// ─────────────────────────────────────────────────────────────
// 检查 ②：dataset 读写一致性
//  控制器 `target.dataset.X` 读的每个名字，必须有地方真的写出 `data-X`；
//  否则读出来恒 undefined（→ NaN / 空串 / 找不到条目），表现为"按钮点了没反应"。
//  两个写入来源：
//   · 视图里显式写的 `'data-X': ...` 字面量；
//   · ui.js 的 Btn 原语：action → data-action、id → data-id、field → data-field。
// ─────────────────────────────────────────────────────────────
console.log('');
console.log('── ② dataset 读写一致性');
const writers = new Set();
for (const file of files) {
	for (const m of code.get(file).matchAll(/'data-([a-zA-Z]+)'\s*:/g)) writers.add(m[1]);
}
// Btn 的属性 → DOM 属性名（这是 Btn 的契约，改 Btn 记得改这里）
for (const prop of ['action', 'id', 'field']) writers.add(prop);

const reads = new Map();
for (const file of files) {
	for (const m of code.get(file).matchAll(/dataset\??\.([a-zA-Z]+)/g)) {
		if (!reads.has(m[1])) reads.set(m[1], new Set());
		reads.get(m[1]).add(file);
	}
}
const orphans = [...reads].filter(([name]) => !writers.has(name));
if (orphans.length) {
	for (const [name, where] of orphans) {
		console.log(`  \u2717 dataset.${name} 被 ${[...where].join(', ')} 读取，但**没有任何地方写出 data-${name}**`);
		console.log(`     → 读出来恒 undefined（NaN / 空串 / 匹配不到），界面表现为「点了没反应」`);
	}
	failures += orphans.length;
} else {
	console.log(`  （无孤儿读取；已知写入面：${[...writers].sort().join(', ')}）`);
}

console.log('');
console.log(`═══ 静态自检结束：硬故障 ${failures} 处 ═══`);
if (failures > 0) process.exitCode = 1;
