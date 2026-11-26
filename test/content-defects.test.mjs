// 正文缺陷四连（1.6.x）：截断 / AI 自述 / 工程词泄漏 / 章内逐字复读 + 元叙述词表扩张。
// 判据一律「先剥引号内对白」——角色台词里的合法用法不误报。

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    contentGate, detectVerbatimRepeat, maskQuotedText, quotedRanges,
} from '../lib/content-gate.js';
import { computeAudit, auditVerdict } from '../lib/audit.js';

const codes = (g) => g.blocking.map((b) => b.code);

test('截断：可见长度达标且末字不是句末标点 → 阻断；正常收尾/纯短稿不报', () => {
    const mid = '他沿着长街走了很久，'.repeat(10); // 100 字，收在逗号上
    const truncated = contentGate({ content: mid, chapter: 1 });
    assert.equal(truncated.ok, false);
    assert.ok(codes(truncated).includes('truncated-draft'));
    assert.ok(truncated.blocking.find((b) => b.code === 'truncated-draft').message.includes('很久，'));

    const finished = contentGate({ content: `${mid}然后他停下。`, chapter: 1 });
    assert.ok(!codes(finished).includes('truncated-draft'), '句号收尾不报');

    const quotedEnd = contentGate({ content: `${mid}“你终于来了。”`, chapter: 1 });
    assert.ok(!codes(quotedEnd).includes('truncated-draft'), '引号收口也不算截断');

    const short = contentGate({ content: '他推门，然后', chapter: 1 });
    assert.ok(!codes(short).includes('truncated-draft'), '短稿交给机审字数下限，不在这里重复报');
});

test('AI 自述/拒答：叙述里命中阻断，引号内台词不误报', () => {
    const leak = contentGate({ content: '他推门进来。作为AI，我无法继续创作这段故事。', chapter: 1 });
    assert.ok(codes(leak).includes('ai-self-narration'));
    assert.ok(leak.blocking.find((b) => b.code === 'ai-self-narration').message.includes('作为AI'));

    const refused = contentGate({ content: '灯还亮着。我无法提供这部分内容。', chapter: 1 });
    assert.ok(codes(refused).includes('ai-self-narration'), '拒答同样拦');

    const dialogue = contentGate({ content: '他推门进来。\n\n“作为AI，我无法继续。”她说。', chapter: 1 });
    assert.ok(!codes(dialogue).includes('ai-self-narration'), '角色台词里的合法用法不误报');
});

test('工程词泄漏：叙述里出现细纲/prompt 等阻断，引号内不误报', () => {
    const leak = contentGate({ content: '他推门进来。\n\n这一笔要按细纲里的情节点写。', chapter: 1 });
    assert.ok(codes(leak).includes('engineering-term-leak'));
    const msg = leak.blocking.find((b) => b.code === 'engineering-term-leak').message;
    assert.ok(msg.includes('细纲') && msg.includes('第3行'), '文案给命中词与行号');

    const prompt = contentGate({ content: '灯灭了。\n\n系统提示词里写着：不要出戏。', chapter: 1 });
    assert.ok(codes(prompt).includes('engineering-term-leak'));

    const dialogue = contentGate({ content: '他推门进来。\n\n“细纲是什么？能吃吗？”她问。', chapter: 1 });
    assert.ok(!codes(dialogue).includes('engineering-term-leak'), '引号内合法对白不误报');
});

test('章内逐字复读：相邻同段 ≥8 字、同句 ≥12 字 ×3 阻断；引号内重复与两次重复放行', () => {
    const para = '灯灭了，屋里只剩呼吸声。';
    const dupPara = contentGate({ content: `${para}\n\n${para}`, chapter: 1 });
    assert.ok(codes(dupPara).includes('verbatim-repeat'));

    const sentence = '他知道这一夜不会再有人来。';
    const dupSentence = contentGate({ content: `${sentence}\n\n${sentence}\n\n${sentence}`, chapter: 1 });
    assert.ok(codes(dupSentence).includes('verbatim-repeat'));

    const twice = contentGate({ content: `${sentence}\n\n中间隔了一段别的话。\n\n${sentence}`, chapter: 1 });
    assert.ok(!codes(twice).includes('verbatim-repeat'), '两次不判');

    const dialogue = contentGate({
        content: '“这一夜不会再有人来了。”\n\n“这一夜不会再有人来了。”\n\n“这一夜不会再有人来了。”',
        chapter: 1,
    });
    assert.ok(!codes(dialogue).includes('verbatim-repeat'), '引号内重复台词不误报');

    assert.deepEqual(detectVerbatimRepeat('他推门进来，把灯挑亮。'), []);
});

test('引号剥离：成对区间被遮住、未闭合引号不遮（截断判定要看得见结尾）', () => {
    const text = '他说：“别走。”然后关门。';
    assert.equal(maskQuotedText(text).includes('别走'), false);
    assert.equal(maskQuotedText(text).includes('然后关门'), true);
    assert.deepEqual(quotedRanges('他说：“别走。”'), [[3, 8]]);
    assert.deepEqual(quotedRanges('他说：“别走'), [], '未闭合不剥');
});

test('嵌套引号：外层对白不会因内层区间回退而重新暴露', () => {
    const dialogue = '「他先说“细纲”只是旧时书名，随后又提到细纲。」';
    const masked = maskQuotedText(`${dialogue}叙述继续。`);
    assert.equal(masked.includes('细纲'), false);
    assert.equal(masked.includes('只是旧时书名'), false);
    assert.equal(masked.includes('叙述继续。'), true);
    assert.ok(!codes(contentGate({ content: dialogue, chapter: 1 })).includes('engineering-term-leak'));
});

test('audit 元叙述词表：强工程词与软叙述层词都计入同一计数并出警告', () => {
    const eng = computeAudit({ content: '他推门进来。按细纲，这一章该收尾了。' });
    assert.ok(eng.metaNarrative >= 2, '细纲 + 这一章 都要计入');
    const verdict = auditVerdict(eng, { minChapterChars: 1, maxChapterChars: 99999 });
    assert.ok(verdict.warnings.some((w) => w.includes('工程词')), '警告文案要说明工程词');

    const clean = computeAudit({ content: '他推门进来，把包袱放下。' });
    assert.equal(clean.metaNarrative, 0);
});

// ── P2/P4 内容门禁新维度（⑩ 题材承诺条款 / ⑪ 词汇禁区，warning 档 report-only 不拦）────
test('★ ⑩ 题材承诺条款：脱靶出 promise-term-below 警告；达标/无条款全静默', () => {
    const terms = [{ name: '师徒互动', keywords: ['师傅', '徒弟', '拜师'], minHits: 2 }];
    // 命中 1 次（师傅×1）< 需 2 → 脱靶 warning
    const g = contentGate({ content: '师傅推门进来，说今天不练剑。', chapter: 7, promiseTerms: terms });
    assert.equal(g.ok, true, 'warning 不拦（报信号不判死刑）');
    assert.ok(g.warnings.some((w) => w.code === 'promise-term-below'));
    assert.match(g.warnings.find((w) => w.code === 'promise-term-below').message, /师徒互动/);
    // 达标（师傅×1 + 徒弟×1 = 2）→ 本维静默
    const ok = contentGate({ content: '师傅对徒弟说：今日练剑。', chapter: 7, promiseTerms: terms });
    assert.ok(!ok.warnings.some((w) => w.code === 'promise-term-below'), '达标不出警告');
    assert.deepEqual(ok.checks.promiseChecks[0].below, false);
    // 无条款（存量承诺书无结构化段）→ 整维零噪声
    const none = contentGate({ content: 'x', chapter: 1 });
    assert.deepEqual(none.checks.promiseChecks, []);
    assert.ok(!none.warnings.some((w) => w.code === 'promise-term-below'));
});

test('★ ⑪ 词汇禁区：异域词命中出 world-forbidden-word 警告；无禁词行全静默', () => {
    const world = [{ kind: 'forbiddenWords', domain: '历史', forbiddenWords: ['平粜', '户房'] }];
    const g = contentGate({ content: '朝廷下诏平粜，户房领粮。', chapter: 9, worldRules: world });
    assert.equal(g.ok, true, 'report-only 不拦');
    assert.ok(g.warnings.some((w) => w.code === 'world-forbidden-word'));
    assert.match(g.warnings.find((w) => w.code === 'world-forbidden-word').message, /词汇禁区「历史」/);
    assert.deepEqual(g.checks.forbiddenHits, [{ domain: '历史', hits: 2 }], 'counts 逐域计总命中');
    // 正文无异域词 → 本维静默
    const clean = contentGate({ content: '少年负剑行于山门。', chapter: 9, worldRules: world });
    assert.ok(!clean.warnings.some((w) => w.code === 'world-forbidden-word'));
    // 台账无禁词行（只有史实域行）→ 零噪声
    const his = contentGate({
        content: '朝廷下诏平粜。', chapter: 9,
        worldRules: [{ domain: '历史', subdomain: '官制', historicalAnchors: '', fictionalAdaptations: '', priority: 'balanced' }],
    });
    assert.ok(!his.warnings.some((w) => w.code === 'world-forbidden-word'), '非禁词行不走本维（与史实域扫描分工对称）');
    // 缺省（未传台账）→ 整维静默
    assert.deepEqual(contentGate({ content: '朝廷下诏平粜。', chapter: 9 }).checks.forbiddenHits, []);
});
