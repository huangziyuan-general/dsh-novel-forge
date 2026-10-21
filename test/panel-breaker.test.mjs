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

// 非成稿提交（T1/T3）的分界钉：清理 !nonDraft 死代码（它只在「④ 之后的分支」挂着，
// 而 nonDraft ⇒ chars < min/4 < min ⇒ 机审必不 ok ⇒ 早在 ④ 就抛了）不许顺手改掉这条
// 唯一的活路——低于下限四分之一仍照旧驳回、**不计熔断**，成稿写砸仍照旧计数。
test('★ 非成稿探针驳回不计熔断、文案是「这不是一章」；成稿写砸照常计数到熔断', async () => {
    const { root, io, p, book, bdir } = await makeBook();
    try {
        const novel = JSON.parse(fs.readFileSync(path.join(bdir, 'novel.json'), 'utf8'));
        const cfg = { ...TEST_CFG, minChapterChars: 400, maxChapterChars: 5000 }; // 成稿分界 = 100 字
        const gates = (content) => runChapterGates({
            config: cfg, io, p, book, novel, n: 1, content,
            force: false, committedBy: 'agent', stageGate: false,
        });
        const count = () => JSON.parse(fs.readFileSync(path.join(bdir, 'novel.json'), 'utf8')).gateFailures?.['1'];

        // 探针（3 字 ≪ 100 字成稿线）：驳回文案换「这不是一章」，且不计熔断——
        // 连投 5 次都不许把熔断额度烧掉（旧实现正是这里把模型解锁额度耗光的）
        for (let i = 1; i <= 5; i += 1) {
            await assert.rejects(() => gates('测试。'), /这不是一章/, `第 ${i} 次探针应是「这不是一章」`);
            assert.equal(count(), undefined, `第 ${i} 次探针不许推进熔断计数`);
        }

        // 成稿但写砸（114 字 > 100 字成稿线、仍 < 400 下限）：判定与文案走原样，照常计数
        const short = '他把灯芯又捻短了一截，屋子里亮了一些。'.repeat(6);
        for (let i = 1; i <= 3; i += 1) {
            await assert.rejects(() => gates(short), /机审未通过/, '成稿写砸走机审原文案');
            assert.equal(count(), i, `成稿写砸必须照常计数（第 ${i} 次）`);
        }
        await assert.rejects(() => gates(short), /熔断/, '满 3 次后第 4 次照样熔断（死代码清理不许连熔断一起清掉）');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

// ── skipBreaker 全分支豁免：panel 路径对机审 / 账本 / 内容门禁 / 细纲禁项四处都不推进熔断 ──
//
// 根因：chapter-commit.js 的四处 recordRejection 原本只有前两处（机审 / 账本冲突）带 `!skipBreaker`
// 守卫，后两处（内容门禁 / 细纲禁项）无条件计数——面板存违规稿会把熔断额度烧掉，面板自身因
// 跳过 tripped 不会锁死，模型下次跑同一个章就被熔断拦（污染模型路径）。补上后四处一致。
test('★ panel 路径（skipBreaker）命中细纲禁项 / 内容门禁 也不推进熔断', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-breaker-both-'));
    const book = '双豁免书';
    const bdir = path.join(root, book);
    fs.mkdirSync(path.join(bdir, '大纲', '细纲'), { recursive: true });
    // 细纲里直接声明禁项段 + 场景段，让 computeGateMetrics.available=true 且 bannedHits 命中
    fs.writeFileSync(path.join(bdir, 'novel.json'), JSON.stringify({
        title: book, genre: '悬疑', logline: '', stage: 'chapter', phases: {},
        approvals: { outline: { 1: true } },
        chapters: {}, cast: [], proposals: [], gateFailures: {},
    }));
    fs.writeFileSync(path.join(bdir, '大纲', '细纲', '第1章.md'), [
        '# 第1章',
        '',
        '## 本章必写场景',
        '- 场景一。',
        '- 场景二。',
        '',
        '## 本章禁止偏离项',
        '- 不许写 致命',  // 正文只要含「致命」就 bannedHits 命中
    ].join('\n'));
    const p = pathsFor(book);
    const io = createFsio({ fs: createNodeFsBackend(root), emit() {}, logger: { info() {} } }, {}, root);
    try {
        const novel = JSON.parse(fs.readFileSync(path.join(bdir, 'novel.json'), 'utf8'));
        const cfg = { ...TEST_CFG, minChapterChars: 400, maxChapterChars: 5000 };
        // 正文必须过机审（≥400 字）才能走到 ⑤.6 细纲禁项分支；含「致命」命中禁项。
        // 旧版本 content 只有 ~180 字，④ 机审先抛，永远走不到 ⑤.6——那条分支的 skipBreaker
        // 守卫因此未被覆盖。这条就是补它。
        const content = '他推门而入，致命一击砸在对方太阳穴，屋里没人，桌上茶还热着，留了一张字条，窗外雨下得很大。'.repeat(14);  // ≈ 462 字 ≥ 400
        for (let i = 0; i < 3; i += 1) {
            await assert.rejects(
                () => runChapterGates({
                    config: cfg, io, p, book, novel, n: 1, content,
                    force: false, committedBy: 'user', stageGate: false, skipBreaker: true,
                }),
                /机审未通过|细纲禁项/,
                `第${i + 1}次面板保存应被门禁拦下`,
            );
        }
        // 面板路径三连被拒后第 4 次仍是原门禁（不是熔断）
        await assert.rejects(
            () => runChapterGates({
                config: cfg, io, p, book, novel, n: 1, content,
                force: false, committedBy: 'user', stageGate: false, skipBreaker: true,
            }),
            (e) => { assert.doesNotMatch(String(e.message), /熔断|驳回 3 次/); return true; },
            '★ 面板路径三连拒后第 4 次仍不该被熔断锁死',
        );
        // 计数零推进：gateFailures 无该章键
        const saved = JSON.parse(fs.readFileSync(path.join(bdir, 'novel.json'), 'utf8'));
        assert.ok(!saved.gateFailures?.['1'], `★ 面板路径对细纲禁项/机审都不许写熔断计数，实际 ${JSON.stringify(saved.gateFailures)}`);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
