#!/usr/bin/env node
// scripts/demo.mjs — 端到端演示：用覆盖临时目录的假 fs 把插件主链路完整跑一遍，
// 打印每一步的关键输出。用来人工验证「硬约束真的会拦人、放行真的会留痕」。
// 运行前先 npm run setup-dev。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../lib/index.js';
import { applyProposal } from '../lib/proposals.js';
import { createFsio } from '../lib/fsio.js';

const c = (s) => `\x1b[36m${s}\x1b[0m`;
const g = (s) => `\x1b[32m${s}\x1b[0m`;
const y = (s) => `\x1b[33m${s}\x1b[0m`;
const r = (s) => `\x1b[31m${s}\x1b[0m`;
const say = (title, lines) => {
    console.log(`\n${c(`━━ ${title}`)}`);
    for (const l of lines) console.log(`  ${l}`);
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-forge-demo-'));
const backend = {
    async resolve(p, opts) {
        const abs = path.isAbsolute(p) ? p : path.join(opts?.cwd ?? root, p);
        return { targetKey: `key:${abs}`, displayPath: path.relative(root, abs) };
    },
    async stat(target) {
        const abs = target.targetKey.slice(4);
        try {
            const s = fs.statSync(abs);
            return { version: `v:${abs}`, type: s.isDirectory() ? 'directory' : 'file', size: s.size };
        } catch { return undefined; }
    },
    async readText(target) { return fs.readFileSync(target.targetKey.slice(4), 'utf8'); },
    async writeText(target, content, intent) {
        const abs = target.targetKey.slice(4);
        const exists = fs.existsSync(abs);
        if (intent?.kind === 'createIfAbsent' && exists) {
            const error = new Error('FS_NOT_OBSERVED'); error.code = 'FS_NOT_OBSERVED'; throw error;
        }
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content);
        return { operation: exists ? 'update' : 'create', version: 'v:2', before: null, after: content };
    },
};
const registered = [];
const ctx = {
    fs: backend, emit() {}, logger: { info() {} },
    tools: { register: (t) => registered.push(t) },
    systemPrompt: { section: () => {} },
    // server-api / 氛围基线等新通道在 apply() 里会经 ctx.inject / ctx.effect 挂载
    inject: (deps, fn) => { fn({ effect: (f) => f(), webServer: { register: () => () => {} } }); },
    effect: (f) => f(),
};
const exec = { signal: new AbortController().signal, agent: { session: { header: { cwd: root } } } };

apply(ctx, { minChapterChars: 150, maxChapterChars: 5000, contextBudgetChars: 4000, scanTopK: 5, repetitionWindow: 10, skipPresetDeploy: true });
const T = (name) => registered.find((t) => t.name === name);

const CHAPTER = [
    '林晚把最后一枚铜钱按进香炉，灰烬腾起来，呛得她直咳嗽。',
    '',
    '院门吱呀一声开了条缝。她没有回头，只是把刀往膝盖边挪了半寸。',
    '',
    '「进来吧，别站在风口上。」她说。',
    '',
    '来客没有进门。他在门槛外蹲下来，慢条斯理地重新系了一遍鞋带。',
    '',
    '「义庄的后墙，昨夜塌了个角。」他说，「棺材板翻出来三口，都是空的。」',
    '',
    '林晚盯着那只湿透的布鞋看了两息。鞋底沾的红泥，是城西乱葬岗才有的颜色。',
    '',
    '她忽然吹熄了灯。',
].join('\n');

try {
    const init = await T('novel_project').execute({ action: 'init', book: '星海拾骨', genre: '东方玄幻', logline: '捡骨人逆改星图' }, exec);
    say('① 创建书目工程', [g(`init：《${init.title}》（${init.genre}）→ ${path.basename(root)}/星海拾骨/`)]);

    await T('novel_character').execute({ action: 'save', book: '星海拾骨', name: '林晚', card: '外在：拾骨人，寡言。隐性欲望：查清师父死因。语言基因：短句、反问、从不先下结论。' }, exec);
    await T('novel_worldbook').execute({ action: 'add', book: '星海拾骨', keywords: '乱葬岗,红泥', content: '城西乱葬岗的红泥遇水不散，是识尸标记。' }, exec);
    await T('novel_outline').execute({ action: 'save_chapter', book: '星海拾骨', chapter: 1, outline: '第1章：雨夜来客。出场：林晚。事件：来客留下乱葬岗红泥布鞋（伏笔）。' }, exec);

    say('② 阶段门禁（细纲未批准就写章）', []);
    try {
        await T('novel_write_chapter').execute({ book: '星海拾骨', chapter: 1, title: '雨夜来客', content: CHAPTER, summary: 'x' }, exec);
        say('', [r('  ✗ 不应到达这里')]);
    } catch (e) {
        say('', [r(`  ✗ 被拒绝：${e.message}`)]);
    }

    await T('novel_outline').execute({ action: 'approve', book: '星海拾骨', chapter: 1 }, exec);
    say('③ 批准后写章（机审→账本→版本化）', []);
    const w = await T('novel_write_chapter').execute({
        book: '星海拾骨', chapter: 1, title: '雨夜来客', content: CHAPTER,
        summary: '林晚雨夜收殓，来客留下乱葬岗红泥布鞋。', cast: '林晚',
        facts_updates: '林晚|位置|城南义庄\n布鞋|持有|门槛来客',
    }, exec);
    say('', [
        g(`  ✓ 保存 ${w.path}（v${w.version}，${w.chars} 字）`),
        `  机审：章末钩子=${w.audit.endingHook.kind}；对话占比 ${w.audit.dialogueRatio}；落账 ${w.addedFacts.length} 条`,
        `  去AI味：${w.noai.level}（${w.noai.score}/100）`,
    ]);

    say('④ 账本硬约束（同章改值）', []);
    const CH2 = [
        '天亮前最黑的那阵，林晚到了城西。塌墙处果然露出三口棺材，棺盖朝天翻着，内里干干净净。',
        '',
        '她蹲下去捻了一撮红泥。泥是湿的，可昨夜之后并没有再下过雨。',
        '',
        '「所以你半夜跑来，就为了告诉我这个？」身后有人说话。林晚没有回头。',
        '',
        '「我来看看，」她说，「你到底想让我看见什么。」',
        '',
        '回去的路上她绕开了大路。只有城门口的乞丐看见她翻墙进去，也没吭声——上个月，她替他收殓了冻死的小孙子。',
    ].join('\n\n');
    try {
        await T('novel_write_chapter').execute({
            book: '星海拾骨', chapter: 2, title: '试探', force: true, content: CH2, summary: 'x',
            facts_updates: '林晚|位置|城北\n林晚|位置|城西',
        }, exec);
    } catch (e) {
        say('', [r(`  ✗ 被拒绝：${e.message.slice(0, 72)}…`)]);
    }

    const a = await T('novel_audit').execute({ book: '星海拾骨', chapter: 1 }, exec);
    say('⑤ 确定性审计（模型审稿必须引用这些数字）', [
        `  字数 ${a.chars}｜段 ${a.paragraphCount}｜对话占比 ${a.dialogueRatio}｜钩子 ${a.endingHook.kind}｜与前文重合 ${a.repetition.jaccard}`,
        `  判定：${a.verdict.ok ? g('通过') : r('不通过')}，警告 ${a.verdict.warnings.length}`,
    ]);

    const p = await T('novel_propose').execute({ action: 'propose', book: '星海拾骨', chapter: 1, content: `${CHAPTER}\n\n她把那只鞋收进了棺材底下。`, reason: '补收束动作' }, exec);
    // apply 是面板上的用户主权动作（工具面已移除）；这里经 proposals 库模拟面板点击。
    const io = createFsio(ctx, exec, root);
    const ap = await applyProposal(io, '星海拾骨', p.id, { minChapterChars: 150, maxChapterChars: 5000, repetitionWindow: 10 }, 'user');
    say('⑥ 提案制修订（apply=面板用户主权；旧版永不覆盖）', [
        `  提案 ${p.id} → 面板应用 → ${ap.path}`,
        `  v1 仍在：${fs.existsSync(path.join(root, '星海拾骨', '正文', '第1章-雨夜来客-v1.md')) ? g('是') : r('否')}`,
    ]);

    say('⑦ 审计日志（.novel/audit.jsonl）', fs.readFileSync(path.join(root, '星海拾骨', '.novel', 'audit.jsonl'), 'utf8')
        .trim().split('\n').slice(-6).map((l) => `  ${y('·')} ${JSON.parse(l).action}`));
} finally {
    fs.rmSync(root, { recursive: true, force: true });
}
console.log(`\n${g('演示完成（临时目录已清理）。npm test 跑全部断言级用例。')}\n`);
