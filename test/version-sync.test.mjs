// test/version-sync.test.mjs — 版本号单一变量（scripts/version-set.mjs）的行为锁定。
// 用例跑在临时目录副本上，不触碰仓库真实落点。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncVersion } from '../scripts/version-set.mjs';

function makeRepo() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-ver-'));
	fs.mkdirSync(path.join(root, 'src/client'), { recursive: true });
	fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
		name: 'fake-forge',
		version: '1.2.3',
		scripts: {},
	}, null, 2) + '\n');
	fs.writeFileSync(path.join(root, 'src/client/index.js'),
		"const PLUGIN_VERSION = '1.2.3';\nexport const id = 'fake';\n");
	fs.writeFileSync(path.join(root, 'server.json'), JSON.stringify({
		name: 'io.example/fake',
		version: '1.2.3',
		packages: [{ registryType: 'npm', identifier: 'fake', version: '1.2.3', transport: { type: 'stdio' } }],
	}, null, 2) + '\n');
	return root;
}

function readAll(root) {
	return {
		pkg: JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')),
		entry: fs.readFileSync(path.join(root, 'src/client/index.js'), 'utf8'),
		server: JSON.parse(fs.readFileSync(path.join(root, 'server.json'), 'utf8')),
	};
}

test('version:set 一次同步四落点', () => {
	const root = makeRepo();
	const r = syncVersion(root, '2.3.4');
	assert.equal(r.version, '2.3.4');
	assert.equal(r.synced.length, 4);
	const a = readAll(root);
	assert.equal(a.pkg.version, '2.3.4');
	assert.match(a.entry, /const PLUGIN_VERSION = '2\.3\.4';/);
	assert.equal(a.server.version, '2.3.4');
	assert.equal(a.server.packages[0].version, '2.3.4');
});

test('server.json 的多包结构与缩进保持（只动 version 字段）', () => {
	const root = makeRepo();
	fs.writeFileSync(path.join(root, 'server.json'), JSON.stringify({
		name: 'io.example/fake',
		title: '标题中文',
		version: '1.2.3',
		packages: [
			{ registryType: 'npm', identifier: 'fake', version: '1.2.3', transport: { type: 'stdio' } },
			{ registryType: 'npm', identifier: 'second', version: '9.9.9' },
		],
	}, null, 2) + '\n');
	syncVersion(root, '4.5.6');
	const s = JSON.parse(fs.readFileSync(path.join(root, 'server.json'), 'utf8'));
	assert.equal(s.version, '4.5.6');
	assert.equal(s.title, '标题中文');
	assert.equal(s.packages[0].version, '4.5.6', '首包跟随');
	assert.equal(s.packages[1].version, '9.9.9', '其余包不动');
	const raw = fs.readFileSync(path.join(root, 'server.json'), 'utf8');
	assert.match(raw, /"标题中文"/, '中文不转义');
});

test('锚点缺失响亮失败且不写盘', () => {
	const root = makeRepo();
	fs.writeFileSync(path.join(root, 'src/client/index.js'), "export const id = 'no version';\n");
	assert.throws(() => syncVersion(root, '2.0.0'), /PLUGIN_VERSION/);
	const a = readAll(root);
	assert.equal(a.pkg.version, '1.2.3', 'package.json 未被半同步改掉');
	assert.equal(a.server.version, '1.2.3', 'server.json 未被半同步改掉');
});

test('非法版本号拒绝', () => {
	const root = makeRepo();
	assert.throws(() => syncVersion(root, 'latest'), /版本号不合法/);
	assert.throws(() => syncVersion(root, ''), /版本号不合法/);
	assert.throws(() => syncVersion(root, '1.2'), /版本号不合法/);
	// 预发布号合法
	const r = syncVersion(root, '2.0.0-rc.1');
	assert.equal(r.version, '2.0.0-rc.1');
});
