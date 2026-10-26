// 平台落库（H4）与场景契约 hidden 提示（M4）的回归护栏。
//
// H4 的原状：同一章的字数合格区间在三处不同——写章门禁按插件配置（真机 2000）、
// 番茄平台审 1500–3000、起点平台审 2000–4000，而 novel_project 根本不存 platform，
// 于是「写的时候按起点放行、审的时候按番茄判死」，真机 4 章里 3 章撞线重写。
// 修法是把「这本书投哪个平台」变成 novel.json 的落库事实，门禁与审计都从它派生。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { charConfigForPlatform, PLATFORM_PROFILES, charLimitsNote } from '../lib/store.js';

const CFG = {
    minChapterChars: 300,
    maxChapterChars: 5000,
    contextBudgetChars: 4000,
    scanTopK: 8,
    repetitionWindow: 10,
    skipPresetDeploy: true, // 测试绝不碰 ~/.dsh
};

let root;
let ctx;
let exec;

before(async () => {
    const { apply } = await import('../lib/index.js');
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-forge-platform-'));
    const backend = {
        async resolve(p, opts) {
            const abs = path.isAbsolute(p) ? p : path.join(opts?.cwd ?? root, p);
            return { targetKey: 'key:' + abs, displayPath: path.relative(root, abs) };
        },
        async stat(target) {
            const abs = target.targetKey.slice(4);
            try {
                const s = fs.statSync(abs);
                return {
                    version: 'v:' + abs,
                    type: s.isDirectory() ? 'directory' : (s.isFile() ? 'file' : 'other'),
                    size: s.size,
                };
            } catch {
                return undefined;
            }
        },
        async readText(target) {
            return fs.readFileSync(target.targetKey.slice(4), 'utf8');
        },
        async readBytes(target, _signal, maxBytes) {
            const buf = fs.readFileSync(target.targetKey.slice(4));
            if (maxBytes !== undefined && buf.length > maxBytes) {
                const error = new Error('FS_TOO_LARGE');
                error.code = 'FS_TOO_LARGE';
                throw error;
            }
            return new Uint8Array(buf);
        },
        async listDir(target) {
            const abs = target.targetKey.slice(4);
            return fs.readdirSync(abs, { withFileTypes: true }).map((d) => ({
                name: d.name,
                type: d.isDirectory() ? 'directory' : (d.isFile() ? 'file' : 'other'),
                target: { targetKey: 'key:' + path.join(abs, d.name) },
            }));
        },
        async writeText(target, text, intent) {
            const abs = target.targetKey.slice(4);
            const exists = fs.existsSync(abs);
            if (intent?.kind === 'createIfAbsent' && exists) {
                const error = new Error('FS_NOT_OBSERVED: ' + abs);
                error.code = 'FS_NOT_OBSERVED';
                throw error;
            }
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            const before = exists ? fs.readFileSync(abs, 'utf8') : null;
            fs.writeFileSync(abs, text);
            return { operation: exists ? 'update' : 'create', version: 'v:' + abs + ':2', before, after: text };
        },
    };
    const registered = [];
    const sections = [];
    ctx = {
        fs: backend,
        emit() {},
        logger: { info() {} },
        tools: { register: (t) => registered.push(t) },
        systemPrompt: { section: (s) => sections.push(s) },
        inject: (deps, fn) => fn(ctx),
        effect: (fn) => fn(),
        webServer: { register: () => () => {} },
        _registered: registered,
        _sections: sections,
    };
    exec = { signal: new AbortController().signal, agent: { session: { header: { cwd: root, id: 'sess-P' } } } };
    apply(ctx, CFG);
});

after(() => {
    if (root !== undefined) fs.rmSync(root, { recursive: true, force: true });
});

function tool(name) {
    const t = ctx._registered.find((x) => x.name === name);
    if (t === undefined) throw new Error('工具未注册：' + name);
    return t;
}

test('★ init 时指定平台就落库，platform 动作读得回来', async () => {
    await tool('novel_project').execute({ action: 'init', book: '番茄书', title: '番茄书', platform: 'fanqie' }, exec);
    const got = await tool('novel_project').execute({ action: 'platform', book: '番茄书' }, exec);
    assert.equal(got.platform, 'fanqie');
    assert.match(got.next ?? '', /番茄/);
});

test('未设平台的书行为与旧版一致：不落 platform 字段，回执说明按插件配置', async () => {
    await tool('novel_project').execute({ action: 'init', book: '无平台书', title: '无平台书' }, exec);
    const got = await tool('novel_project').execute({ action: 'platform', book: '无平台书' }, exec);
    assert.equal(got.platform, undefined, '未设置时不带 platform 字段（schema 只声明 string）');
    assert.match(got.next ?? '', /未设置平台/);
    // 结构性保证：未设置平台时 charConfigForPlatform 原样返回同一个引用
    assert.equal(charConfigForPlatform(CFG, ''), CFG);
});

test('★ 已有书可以补设平台（真机那本书就是没平台建起来的）', async () => {
    await tool('novel_project').execute({ action: 'platform', book: '无平台书', platform: 'qidian' }, exec);
    const got = await tool('novel_project').execute({ action: 'platform', book: '无平台书' }, exec);
    assert.equal(got.platform, 'qidian');
    const novel = JSON.parse(fs.readFileSync(path.join(root, '无平台书', 'novel.json'), 'utf8'));
    assert.equal(novel.platform, 'qidian', '平台是 novel.json 的落库事实，不是每次调用手传的参数');
});

test('平台口径派生：番茄 1500–3000，起点 2000–4000，未设置不动配置', () => {
    const fanqie = charConfigForPlatform(CFG, 'fanqie');
    assert.equal(fanqie.minChapterChars, PLATFORM_PROFILES.fanqie.minChapterChars);
    assert.equal(fanqie.maxChapterChars, PLATFORM_PROFILES.fanqie.maxChapterChars);
    assert.equal(CFG.minChapterChars, 300, '原始配置不被就地改写');
    const qidian = charConfigForPlatform(CFG, 'qidian');
    assert.equal(qidian.minChapterChars, 2000);
    assert.equal(qidian.maxChapterChars, 4000);
});

test('平台值收口：不认识的平台报错且不改动落库值；空串清除', async () => {
    await assert.rejects(
        () => tool('novel_project').execute({ action: 'platform', book: '番茄书', platform: 'zhihu' }, exec),
        /不认识的平台/,
    );
    const still = await tool('novel_project').execute({ action: 'platform', book: '番茄书' }, exec);
    assert.equal(still.platform, 'fanqie', '报错不得把已有平台改坏');
    const cleared = await tool('novel_project').execute({ action: 'platform', book: '番茄书', platform: '' }, exec);
    assert.equal(cleared.platform, undefined);
    const novel = JSON.parse(fs.readFileSync(path.join(root, '番茄书', 'novel.json'), 'utf8'));
    assert.equal(novel.platform, undefined, '清除是真删字段，不是留个空串');
});

test('★ 场景契约漏配 hidden 要提示（M4）：显式传空串则不提示', async () => {
    const miss = await tool('novel_scene').execute({ action: 'save', book: '番茄书', chapter: 1, participants: '测试角色' }, exec);
    assert.ok((miss.warnings ?? []).some((w) => w.includes('未声明 hidden')), '漏配隐藏人物要当场提示');
    const explicit = await tool('novel_scene').execute(
        { action: 'save', book: '番茄书', chapter: 2, participants: '测试角色', hidden: '' }, exec,
    );
    assert.equal((explicit.warnings ?? []).filter((w) => w.includes('未声明 hidden')).length, 0, '显式传空串＝确实没有');
});

test('写章与细纲描述都写明了平台口径（文案不漂移）', () => {
    for (const name of ['novel_write_chapter', 'novel_outline']) {
        const d = tool(name).description ?? '';
        assert.match(d, /平台/, name + ' 的描述要说明字数口径随平台切换');
        assert.match(d, /1500–3000/, name + ' 的描述要列出番茄区间');
    }
});

test('字数口径回执引用的参数名真实存在（文案不漂移）', () => {
    // 回执是模型可见面：引用不存在的参数名（曾经的 chars_min/chars_max——工具 schema、
    // REST、面板都只收单个 chars 字符串），模型照着传就撞非法入参。
    const note = charLimitsNote(CFG, { platform: 'fanqie' });
    assert.match(note, /chars[：:]/, '要写明参数名是 chars（单个「下限-上限」字符串）');
    assert.doesNotMatch(note, /chars_min|chars_max/, '不许引用不存在的参数名');
});
