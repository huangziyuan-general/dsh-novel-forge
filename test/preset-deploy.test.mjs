// test/preset-deploy.test.mjs — 预设部署的版本感知与用户改动保护。
//
// 这块是「融合 F2 节奏铁律能真正生效」的前提：旧的「存在即跳过」会让
// 插件升级带的 persona 永远到不了用户盘上。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deployPreset, PRESET_ID } from '../lib/preset-deploy.js';

/** 每个用例独占一个 DSH_HOME，避免互相污染。 */
function withHome(fn) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-forge-preset-'));
    const prev = process.env.DSH_HOME;
    process.env.DSH_HOME = home;
    try {
        return fn(home);
    } finally {
        if (prev === undefined) delete process.env.DSH_HOME;
        else process.env.DSH_HOME = prev;
        fs.rmSync(home, { recursive: true, force: true });
    }
}

const targetOf = (home) => path.join(home, '.agent-presets', PRESET_ID);

test('预设部署：首次部署 + 同版本跳过', () => {
    withHome((home) => {
        const first = deployPreset({});
        assert.equal(first.deployed, true);
        assert.equal(first.skipped, false);
        assert.match(first.reason, /首次部署/);
        assert.ok(fs.existsSync(path.join(targetOf(home), 'agent.cordis.yml')));

        const second = deployPreset({});
        assert.equal(second.deployed, false);
        assert.equal(second.skipped, true, '同版本应跳过');
        assert.ok(fs.existsSync(path.join(targetOf(home), '.deploy.json')), '应留下部署清单');
    });
});

test('预设部署：版本变化时自动升级（persona 纪律能生效的关键）', () => {
    withHome((home) => {
        deployPreset({});
        const manifestPath = path.join(targetOf(home), '.deploy.json');
        // 伪造成旧版本部署（模拟「插件升级了」）
        const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        m.version = '0.0.1';
        delete m.files['agent.cordis.yml'];
        fs.writeFileSync(manifestPath, JSON.stringify(m));

        const up = deployPreset({});
        assert.equal(up.deployed, true, '版本不同必须重新部署');
        assert.match(up.reason, /升级到/);
        const after = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        assert.notEqual(after.version, '0.0.1');
    });
});

test('预设部署：用户手改过的文件先备份再更新，不静默吞掉', () => {
    withHome((home) => {
        deployPreset({});
        const f = path.join(targetOf(home), 'agent.cordis.yml');
        fs.writeFileSync(f, `${fs.readFileSync(f, 'utf8')}\n# 用户自己加的一行\n`);
        const manifestPath = path.join(targetOf(home), '.deploy.json');
        const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        m.version = '0.0.1';
        fs.writeFileSync(manifestPath, JSON.stringify(m));

        const up = deployPreset({});
        assert.equal(up.deployed, true);
        assert.ok(up.backups.some((b) => b.endsWith('.user.bak')), '应备份用户改动');
        const bak = fs.readFileSync(`${f}.user.bak`, 'utf8');
        assert.ok(bak.includes('用户自己加的一行'), '备份必须保留用户内容');
        assert.ok(!fs.readFileSync(f, 'utf8').includes('用户自己加的一行'), '目标文件应更新为随包版本');
    });
});

test('预设部署：SKIP_DEPLOY=1 时完全不碰盘', () => {
    withHome((home) => {
        process.env.DSH_NOVEL_FORGE_SKIP_DEPLOY = '1';
        try {
            const r = deployPreset({});
            assert.equal(r.skipped, true);
            assert.ok(!fs.existsSync(targetOf(home)), '跳过时不该创建目录');
        } finally { delete process.env.DSH_NOVEL_FORGE_SKIP_DEPLOY; }
    });
});
