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

// ── 发行漂移对账（方向4）────────────────────────────────────────────────────
//
// 预设（agent.cordis.yml）在 persona 里点名 `novel_*` 工具与动作，让模型照着调。
// 工具或动作被改名/删除时，预设文案**不会报错**——模型照着叫，工具找不到，
// 或动作落进默认分支，表现为「模型说的动作没生效」。这与 PLUGIN_VERSION 那条
// 同类：源码改了但发行物没跟上，只能靠对账在 CI 期拦下。
//
// 判据来源是**源码真值**（每个工具定义里的 name 与 action enum），不是手写清单。

const TOOLS_DIR = path.join(import.meta.dirname, '..', 'lib', 'tools');
const PRESET_DIR = path.join(import.meta.dirname, '..', 'lib', 'preset', PRESET_ID);

/** 从工具源码解析出 { 工具名 → Set(动作名) }（按 `name: 'novel_` 切块，块内取 action 的 enum）。 */
function toolRegistry() {
    const map = new Map();
    for (const file of fs.readdirSync(TOOLS_DIR).filter((n) => n.endsWith('.js'))) {
        const src = fs.readFileSync(path.join(TOOLS_DIR, file), 'utf8');
        for (const block of src.split(/(?=name:\s*'novel_)/)) {
            const nm = /name:\s*'(novel_[a-z_]+)'/.exec(block);
            if (!nm) continue;
            const actions = new Set();
            const m = /action:\s*\{[^}]*?enum:\s*\[([^\]]*)\]/s.exec(block);
            if (m) for (const a of m[1].matchAll(/'([^']+)'/g)) actions.add(a[1]);
            map.set(nm[1], actions);
        }
    }
    return map;
}

function presetText() {
    return fs.readdirSync(PRESET_DIR).filter((n) => n.endsWith('.yml'))
        .map((n) => fs.readFileSync(path.join(PRESET_DIR, n), 'utf8')).join('\n');
}

test('★ 预设引用的 novel_* 工具名与动作名必须真实存在（发行漂移对账）', () => {
    const registry = toolRegistry();
    // 覆盖哨兵：工具被漏注册/漏解析时，下面的子集断言会假绿 —— 先钉住规模
    const indexSrc = fs.readFileSync(path.join(import.meta.dirname, '..', 'lib', 'index.js'), 'utf8');
    const registerCount = (indexSrc.match(/ctx\.tools\.register\(/g) ?? []).length;
    assert.equal(registry.size, registerCount,
        `工具定义数（${registry.size}）与 index.js 注册数（${registerCount}）不符——有工具定义了没注册，或解析漏了`);
    assert.ok(registry.size >= 20, `工具注册表规模异常：${registry.size}`);

    const text = presetText();
    const tokens = [...text.matchAll(/\b(novel_[a-z_]+)\b/g)].map((m) => m[1]);
    assert.ok(tokens.length > 0, '预设里应至少引用一个 novel_* 工具名（否则这条用例是空跑）');

    const unknown = [...new Set(tokens)].filter((t) => !registry.has(t));
    assert.deepEqual(unknown, [], `预设点名了不存在的工具：${unknown.join(', ')}`);

    // 动作对账：`novel_X <word>` 里的 word 若命中「任意工具的动作名」，它就该属于 X。
    // 只对「像命令的标识符」判——后面跟中文/标点（纯叙述）一律跳过，避免误杀；
    // `voice`/`platform` 这类**参数名**不在任何动作集里，天然被跳过（它们是 flag，不是动作）。
    const allActions = new Set([...registry.values()].flatMap((s) => [...s]));
    const mismatches = [];
    for (const m of text.matchAll(/\b(novel_[a-z_]+)\s+([a-z_][a-z_0-9]*)/g)) {
        const [, tool, word] = m;
        if (!registry.has(tool)) continue;             // 工具名问题上面已单独报
        if (!allActions.has(word)) continue;           // 不是动作词（叙述/参数名）
        if (!registry.get(tool).has(word)) {
            mismatches.push(`${tool} 无动作「${word}」（现有：${[...registry.get(tool)].join('/') || '无'}）`);
        }
    }
    assert.deepEqual([...new Set(mismatches)], [], `预设动作名与实际注册不符：\n${[...new Set(mismatches)].join('\n')}`);
});
