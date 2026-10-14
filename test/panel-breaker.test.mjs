// test/panel-breaker.test.mjs — 面板保存与熔断解耦（skipBreaker）回归。
//
// 背景（审查 M，2026-10-14）：runChapterGates 的 recordRejection 在机审/账本拒绝
// throw 前落盘，面板路径（stageGate:false）同样计数——用户连点 3 次「保存」就触发
// 熔断（br.tripped），且解锁条件（聊天里 approve 细纲）对人工编辑不可达、force 又
// 顶不开熔断 → 无自救路径。修复：面板路由传 skipBreaker:true——不推进计数、不受
// tripped 拦截；模型/批量路径默认 false 行为一字不变；审计行照记。
// 用真 node:fs 后端（memIo 原子替身测不出异步窗口，且这里不需要模型调用）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runChapterGates } from '../lib/chapter-commit.js';
import { pathsFor } from '../lib/store.js';
import { createFsio } from '../lib/fsio.js';
import { createNodeFsBackend } from '../lib/mcp-standalone.js';

const TEST_CFG = { minChapterChars: 10, maxChapterChars: 5000, scanTopK: 8, repetitionWindow: 10, contextBudgetChars: 4000 };
const onePara = '雪夜码头一个人影站在灯下。'.repeat(4); // 52 字 1 段：字数过线、段落数不过

async function makeBook() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-breaker-'));
    const book = '熔断豁免书';
    const bdir = path.join(root, book);
    fs.mkdirSync(path.join(bdir, '大纲', '细纲'), { recursive: true });
    fs.writeFileSync(path.join(bdir, 'novel.json'), JSON.stringify({
        title: book, genre: '悬疑', logline: '', stage: 'chapter', phases: {},
        approvals: { outline: { 1: true } },
        chapters: {}, cast: [], proposals: [], gateFailures: {},
    }));
    fs.writeFileSync(path.join(bdir, '大纲', '细纲', '第1章.md'), '# 第1章\n\n- 场景一。\n- 场景二。\n- 场景三。');
    return { root, io: createFsio({ fs: createNodeFsBackend(root), emit() {}, logger: { info() {} } }, {}, root), p: pathsFor(book), book, bdir };
}

test('panel-breaker: 面板路径（skipBreaker）三连机审拦不推进计数、不触发熔断', async () => {
    const { root, io, p, book, bdir } = await makeBook();
    try {
        const novel = JSON.parse(fs.readFileSync(path.join(bdir, 'novel.json'), 'utf8'));
        for (let i = 0; i < 3; i += 1) {
            await assert.rejects(
                () => runChapterGates({
                    config: TEST_CFG, io, p, book, novel, n: 1, content: onePara,
                    force: false, committedBy: 'user', stageGate: false, skipBreaker: true,
                }),
                /机审未通过/,
                `第${i + 1}次面板保存应被机审 409 拦下`,
            );
        }
        // 第 4 次仍是机审文案，不是熔断锁死
        await assert.rejects(
            () => runChapterGates({
                config: TEST_CFG, io, p, book, novel, n: 1, content: onePara,
                force: false, committedBy: 'user', stageGate: false, skipBreaker: true,
            }),
            (e) => { assert.match(String(e.message), /机审未通过/); assert.doesNotMatch(String(e.message), /熔断|驳回 3 次|连续驳回/); return true; },
            '第 4 次面板保存不得被熔断锁死',
        );
        // 计数零推进：gateFailures 无该章键、br 未 tripped
        const saved = JSON.parse(fs.readFileSync(path.join(bdir, 'novel.json'), 'utf8'));
        assert.ok(!saved.gateFailures?.['1'], `面板路径不得写熔断计数，实际 ${JSON.stringify(saved.gateFailures)}`);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('panel-breaker: 默认（不传 skipBreaker）三连机审拦 → 熔断照常触发（模型路径行为不变）', async () => {
    const { root, io, p, book, bdir } = await makeBook();
    try {
        const novel = JSON.parse(fs.readFileSync(path.join(bdir, 'novel.json'), 'utf8'));
        let tripped = false;
        for (let i = 0; i < 4; i += 1) {
            try {
                // 与面板用例同 setup，只差 skipBreaker 不传（默认 false = 模型/批量路径形态）。
                // 熔断判定在每轮开头：3 次驳回计数后，第 4 次尝试才被 tripped 拦下
                //（真机 audit.jsonl 实证序列同构：三次驳回 → 第 4 次 breaker_tripped）。
                await runChapterGates({
                    config: TEST_CFG, io, p, book, novel, n: 1, content: onePara,
                    force: false, committedBy: 'agent', stageGate: false,
                });
                assert.fail('模型路径机审不过应拒绝');
            } catch (e) {
                if (/熔断|连续驳回/.test(String(e.message))) { tripped = true; break; }
                assert.match(String(e.message), /机审未通过/);
            }
        }
        assert.equal(tripped, true, '3 次驳回计数后第 4 次尝试应触发熔断（行为不变）');
        const saved = JSON.parse(fs.readFileSync(path.join(bdir, 'novel.json'), 'utf8'));
        assert.ok(Number(saved.gateFailures?.['1']) >= 3, `默认路径应推进熔断计数，实际 ${JSON.stringify(saved.gateFailures)}`);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
