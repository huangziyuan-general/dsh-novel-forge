// test/anchor-diff-tool.test.mjs — P5 锚点改写留痕的工具面（真走 bootPlugin）。
//
// 三条红线：
//   · 首写（无旧锚点）→ 回执不带 anchorDiff 键、audit 行不带 anchorOverwritten（零回归）；
//   · 覆盖改写方向性换血 → 回执带 anchorDiff{major:true} + note 点名，audit 行带
//     anchorMajor/anchorNote（事后「之前有没有改过、改成什么」可追溯）；
//   · 同题材小改 → 回执无 anchorDiff、audit 行 anchorOverwritten=true 但无 anchorMajor 旗标
//     （留痕了但不点名，不制造噪声）。

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { bootPlugin } = await import('./helpers/plugin.mjs');

const XIUXIAN = [
    '# 大纲',
    '## 卷一 青石镇（第1–30章）',
    '- 父子双穿、双系统上线，黑风寨战书压顶；师门功课涨修为，首战翻盘。',
    '## 卷二 县城（第31–70章）',
    '- 收徒扬名，三宗争抢天命师徒，修为线在县城连案。',
    '## 卷五 真相（第181章起）',
    '- 大货车之谜书内闭环回收，身份线收拢，父子和解。',
].join('\n');
const SHANGZHAN = [
    '# 大纲',
    '**修订说明**：修仙线搁置，本书实际走向为明清商战悬疑，以成稿为准。',
    '## 卷一 青石镇（第1–30章）',
    '- 度量衡与商战民生；粮船靠岸、开秤验砣，官仓商战线推进。',
    '## 卷二 县城（第31–70章）',
    '- 官仓验秤差事在县城立威，市行纠葛加深。',
    '## 卷五 收网（第181章起）',
    '- 银线案反杀结案，师徒倒挂身份摊牌，秤平灯亮。',
].join('\n');

test('★ 工具面：首写静默 / 换血点名句 / 小改留痕不点名', async () => {
    const p = await bootPlugin({});
    const { tool, exec, cleanup, read } = p;
    try {
        const B = '锚点留痕书';
        await tool('novel_project').execute({ action: 'init', book: B, title: B, genre: '玄幻' }, exec);

        // ① 首写：回执不带 anchorDiff 键，audit 无 anchorOverwritten
        const first = await tool('novel_outline').execute({ action: 'save_book', book: B, outline: XIUXIAN }, exec);
        assert.equal(first.anchorDiff, undefined, '首写不掺锚点 diff');
        let auditLog = read(`${B}/.novel/audit.jsonl`);
        const firstLine = auditLog.split('\n').filter((l) => l.includes('outline/save_book')).at(-1);
        assert.ok(!firstLine.includes('anchorOverwritten'), '首写 audit 无锚点改写旗标');

        // ② 方向性换血：回执 major + note，audit 带 anchorMajor/anchorNote
        const swap = await tool('novel_outline').execute({ action: 'save_book', book: B, outline: SHANGZHAN }, exec);
        assert.equal(swap.anchorDiff?.major, true, '换血回执出 major');
        assert.match(swap.note, /锚点方向性变更/, 'note 点名尺子被换');
        auditLog = read(`${B}/.novel/audit.jsonl`);
        const swapLine = auditLog.split('\n').filter((l) => l.includes('outline/save_book')).at(-1);
        assert.ok(swapLine.includes('anchorMajor'), 'audit 行带 anchorMajor');
        assert.ok(swapLine.includes('anchorNote'), 'audit 行带 anchorNote（可追溯改成什么）');

        // ③ 小改（同题材加一行）：留痕但不点名
        const tweak = await tool('novel_outline').execute({ action: 'save_book', book: B, outline: `${SHANGZHAN}\n- 补记：某节点校字。` }, exec);
        assert.equal(tweak.anchorDiff, undefined, '小改不出 major（不误报）');
        auditLog = read(`${B}/.novel/audit.jsonl`);
        const tweakLine = auditLog.split('\n').filter((l) => l.includes('outline/save_book')).at(-1);
        assert.ok(tweakLine.includes('anchorOverwritten'), '覆盖即留痕（哪怕不 major）');
        assert.ok(!tweakLine.includes('anchorNote'), '小改不点名');

        // ④ promise 写分支同款
        await tool('novel_project').execute({ action: 'promise', book: B, promise: XIUXIAN }, exec);
        const pSwap = await tool('novel_project').execute({ action: 'promise', book: B, promise: `**修订说明**：不再承诺修仙。\n${SHANGZHAN}` }, exec);
        assert.equal(pSwap.anchorDiff?.major, true, '承诺书换血同档点名');
        assert.match(pSwap.note, /承诺书是门禁参照物/, '回执指到承诺书锚点性质');
    } finally {
        cleanup();
    }
});
