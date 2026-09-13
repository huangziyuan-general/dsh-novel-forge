#!/usr/bin/env node
// scripts/build-client.mjs — 把 src/client/ 的 ESM 源码打包成 dsh 要求的
// lib/client.js（经典脚本 + __ModuleLoader__ CJS factory）。
//
// 为什么必须有这一步：dsh 的 client-modules 明确「宿主提供的是**已构建的**
// 客户端 bundle，启动前必须已产出每个 lib/client.js」。源码是 ESM，
// 浏览器经典脚本读不懂，dsh 也只认 package.json 的 exports["./client"]。
// —— 所以源文件改完不构建，改动等于没改。
//
// 产物形态（与官方插件一致）：
//   window.__ModuleLoader__.load({ id, factory: (require) => {...; return module.exports } })
// react 走 external，由宿主的 PLATFORM_MODULES 基座提供（不重复打包）。
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const entryRel = 'src/client/index.js';
const outRel = 'lib/client.js';

// ── 守卫：版本号单一来源 ──
// 源码里的 PLUGIN_VERSION 是运行时徽标，package.json 是发行版本；
// 两者不一致会出现「面板显示 v0.4.1、npm 上是 0.4.2」这类幽灵问题。
const entrySrc = fs.readFileSync(path.join(root, entryRel), 'utf8');
const versionMatch = entrySrc.match(/PLUGIN_VERSION\s*=\s*['"]([^'"]+)['"]/);
if (!versionMatch) {
	console.error(`✗ ${entryRel} 里找不到 PLUGIN_VERSION 字面量（构建需要一个可校验的版本号）`);
	process.exit(1);
}
if (versionMatch[1] !== pkg.version) {
	console.error(`✗ 版本漂移：${entryRel} 是 ${versionMatch[1]}，package.json 是 ${pkg.version}`);
	console.error('  改版本时两处必须同步（build 就是那道闸）。');
	process.exit(1);
}

// ── 包壳 ──
// banner 打开 factory 并备好 CJS 的 module/exports；
// footer 交回 module.exports —— esbuild 的 cjs 产物末尾会写 module.exports，
// 所以这里读到的就是入口模块的导出命名空间。
const banner = `// ⚠️ 自动生成，请勿直接编辑 —— 改 src/client/ 后跑 npm run build。
// 源码：src/client/index.js（+ forge-tab.js / session-watch.js / panel.js / views/*）
// 本产物是经典脚本：dsh 的 client-modules 按 CJS factory 执行它。
window.__ModuleLoader__.load({
	id: ${JSON.stringify(pkg.name)},
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
`;

const footer = `
		return module.exports;
	}
});
`;

await build({
	absWorkingDir: root,
	entryPoints: [entryRel],
	outfile: outRel,
	bundle: true,
	format: 'cjs',
	platform: 'browser',
	target: ['es2022'],
	// 宿主播种的模块表（官方 CHUNK_EXTERNALS / PLATFORM_MODULES）：
	//   react · react/jsx-runtime · react-dom · react-dom/client · cordis · ui-slots · ui-primitives
	// 一律 external，由宿主那份提供（也避免打出第二份 React 实例）。
	// ★ react-dom/client 必须在这里 —— createRoot 只有它有（react 核心包没有）。
	external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', 'cordis'],
	charset: 'utf8',          // 保留中文原样，别转成 \u 转义（便于阅读产物）
	legalComments: 'none',
	logLevel: 'warning',
	banner: { js: banner },
	footer: { js: footer },
});

const size = fs.statSync(path.join(root, outRel)).size;
console.log(`✓ ${outRel} 已生成 — v${pkg.version}，${(size / 1024).toFixed(1)} KB`);
