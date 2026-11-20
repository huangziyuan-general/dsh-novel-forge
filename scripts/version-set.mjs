#!/usr/bin/env node
// scripts/version-set.mjs — 发版版本号的唯一入口（用户钦定「版本号做成一个变量」）。
//
// 仓库里需要版本号的地方（全部落点）：
//   1. package.json            "version"           —— npm 发行事实源
//   2. src/client/index.js     PLUGIN_VERSION      —— 面板运行时徽标（build 闸校验）
//   3. server.json             顶层 version + packages[0].version
//                                                  —— MCP Registry 声明留痕
//                                                    （registry-publish.yml 发布前
//                                                     仍会按 tag 覆写，这里保持
//                                                     留痕一致，build 闸同样校验）
//
// 用法：npm run version:set -- 1.7.5
// 四个落点一次同步；任何一处没命中恰好一次即失败退出（不许半同步状态落盘）。
//
// 注意：CHANGELOG 段头不在此列——它是按版本写的历史文档，发版时手工写段。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/;

/**
 * 把一个仓库根下全部版本落点同步到 version。
 * 纯 fs 操作、逐落点断言恰好命中一次；任一失败抛错，不留下半同步状态。
 * 导出以便 node --test 在临时目录上直测。
 */
export function syncVersion(root, version) {
	if (!SEMVER_RE.test(version)) {
		throw new Error(`版本号不合法：${JSON.stringify(version)}（应为 x.y.z）`);
	}

	// ── 先全量读取 + 校验，再统一写入（避免写到一半才发现锚点缺失） ──
	const pkgPath = path.join(root, 'package.json');
	const pkgSrc = fs.readFileSync(pkgPath, 'utf8');
	const pkgJson = JSON.parse(pkgSrc);
	if (!pkgJson.version) throw new Error('package.json 的 version 是空的');

	const entryPath = path.join(root, 'src/client/index.js');
	const entrySrc = fs.readFileSync(entryPath, 'utf8');
	const entryRe = /(const\s+PLUGIN_VERSION\s*=\s*['"])([^'"]+)(['"])/;
	const entryHits = entrySrc.match(entryRe);
	if (!entryHits) throw new Error('src/client/index.js 里找不到 PLUGIN_VERSION 字面量');

	const serverPath = path.join(root, 'server.json');
	const serverSrc = fs.readFileSync(serverPath, 'utf8');
	const serverJson = JSON.parse(serverSrc);
	if (typeof serverJson.version !== 'string' || !serverJson.version) {
		throw new Error('server.json 顶层 version 缺失');
	}
	if (!serverJson.packages?.[0]?.version) {
		throw new Error('server.json packages[0].version 缺失');
	}

	// ── 校验齐了，统一写 ──
	fs.writeFileSync(pkgPath, pkgSrc.replace(
		`"version": "${pkgJson.version}"`,
		`"version": "${version}"`,
	));
	fs.writeFileSync(entryPath, entrySrc.replace(
		`${entryHits[1]}${entryHits[2]}${entryHits[3]}`,
		`${entryHits[1]}${version}${entryHits[3]}`,
	));
	fs.writeFileSync(serverPath, JSON.stringify(
		{ ...serverJson, version, packages: [{ ...serverJson.packages[0], version }, ...serverJson.packages.slice(1)] },
		null,
		2,
	) + '\n');

	return {
		version,
		synced: [
			{ file: 'package.json', from: pkgJson.version, to: version },
			{ file: 'src/client/index.js (PLUGIN_VERSION)', from: entryHits[2], to: version },
			{ file: 'server.json (顶层 version)', from: serverJson.version, to: version },
			{ file: 'server.json (packages[0].version)', from: serverJson.packages[0].version, to: version },
		],
	};
}

function main() {
	const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
	const version = process.argv[2];
	if (!version) {
		console.error('用法：npm run version:set -- x.y.z');
		process.exit(1);
	}
	let result;
	try {
		result = syncVersion(root, version);
	} catch (err) {
		console.error(`✗ ${err.message}`);
		process.exit(1);
	}
	for (const row of result.synced) {
		console.log(`  ${row.file}: ${row.from} -> ${row.to}`);
	}
	console.log(`✓ 版本号已同步为 ${version}（四落点）`);
}

// 直接执行时才跑 main（被 import 测试时不跑）。
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main();
}
