// test/platform-review-fixes.test.mjs — 平台审稿四处修复的回归（T2/T3/T4/T5）。
//
// T2/T4 标签与窗口：first-3-faceslap 扫的是**本章全文**（纯函数不做跨章聚合），label 却写
//   「前 3 章必须有打脸/逆转」——第 1 章不可能知道第 3 章会不会打脸，而黄金三章的常态恰是
//   第 1 章立憋屈、第 3 章反打，于是合规结构被判 error 走返工。改为实话标签 + warn，
//   并把窗口口径写进 label/target（前 1000 字 vs 本章全文）。
// T3 不回显词：value 把命中的词拼进报告 = 给模型印了一份作弊指南（真机某 agent 读完报告
//   反编译出词表并要求「后续请直接按词表给词」）。所有 hitsOf 的 value 改成「命中 N 项/未检出」。
// T5 番茄超长：不足 1500 与超过 3000 同级 error（超 3000 才是完读率的实际杀手），起点分支不动。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { reviewForPlatform } from '../lib/platform-review.js';
import { charConfigForPlatform, platformLimitsText } from '../lib/store.js';

// 词表从源码单点解析：要断言「value 不含词表里的任何词」就得拿真词表，在测试里抄第二份
// 一定漂移。只读源码文本，不碰书稿。
const SRC = readFileSync(new URL('../lib/platform-review.js', import.meta.url), 'utf8');
function wordList(name) {
    const key = 'const ' + name + ' = [';
    const start = SRC.indexOf(key);
    assert.ok(start >= 0, name + ' 必须还在 platform-review.js 里（词表挪走时本用例要跟着改）');
    const from = start + key.length;
    const end = SRC.indexOf(']', from);
    return [...SRC.slice(from, end).matchAll(/'([^']+)'/g)].map((x) => x[1]);
}
const THRILL_WORDS = wordList('THRILL_WORDS');
const FACESLAP_WORDS = wordList('FACESLAP_WORDS');
const CONFLICT_WORDS = wordList('CONFLICT_WORDS');

const DIALOGUE_BLOCK = '“不可能。”赵擎冷笑一声，把合同摔在桌上。';
const PLAIN_BLOCK = '林晚没说话，她弯腰捡起那张纸，指尖压住签名栏，屋子里静得能听见呼吸。';
const HOOK_TAIL = '这单到底是谁签的？';

/** 造一段字数**精确**为 n 的正文（机器字数口径 = 去空白后的字符数）：短段 + 隔段对白。 */
function chapterOf(n) {
    const target = n - HOOK_TAIL.length;
    const paras = [];
    let chars = 0;
    while (chars < target) {
        const block = paras.length % 2 === 0 ? DIALOGUE_BLOCK : PLAIN_BLOCK;
        const take = block.slice(0, Math.min(block.length, target - chars));
        paras.push(take);
        chars += take.length;
    }
    return [...paras, HOOK_TAIL].join('\n\n');
}

function checkOf(r, key) {
    const c = r.checks.find((x) => x.key === key);
    assert.ok(c, '缺少判定项 ' + key);
    return c;
}

test('T5 番茄：超 3000 与不足 1500 同级 error，区间内通过（含边界）', () => {
    const over = reviewForPlatform({ content: chapterOf(3098), chapter: 4, platform: 'fanqie' });
    const len = checkOf(over, 'chapter-length');
    assert.equal(len.value, '3098 字', '造字口径必须与机器审计一致，否则后面全是空转');
    assert.equal(len.ok, false, '3098 字必须判失败');
    assert.equal(len.level, 'error', '超 3000 必须是 error 而不是 warn');
    assert.deepEqual(over.checks.filter((c) => !c.ok && c.level === 'error').map((c) => c.key), ['chapter-length'], '超长必须真的进 error 计数');
    assert.equal(over.errorCount, 1);
    assert.equal(over.passed, false, 'error 计数与 passed 口径必须自洽');

    const under = reviewForPlatform({ content: chapterOf(1499), chapter: 4, platform: 'fanqie' });
    assert.equal(checkOf(under, 'chapter-length').level, 'error', '不足 1500 仍是 error');

    for (const n of [1500, 2990, 3000]) {
        const r = reviewForPlatform({ content: chapterOf(n), chapter: 4, platform: 'fanqie' });
        const c = checkOf(r, 'chapter-length');
        assert.equal(c.ok, true, n + ' 字在区间内必须通过（value=' + c.value + '）');
        assert.equal(c.level, 'ok');
        assert.equal(r.errorCount, 0, n + ' 字不该出 error');
        assert.equal(r.passed, true, n + ' 字且无其他 error → passed');
    }
});

test('T5 起点分支保持原样：4000 以内通过，超 4000 仍是 warn', () => {
    const inRange = reviewForPlatform({ content: chapterOf(3098), chapter: 4, platform: 'qidian' });
    assert.equal(checkOf(inRange, 'chapter-length').ok, true, '起点 2000–4000，3098 字照旧通过');
    const long = reviewForPlatform({ content: chapterOf(4500), chapter: 4, platform: 'qidian' });
    const c = checkOf(long, 'chapter-length');
    assert.equal(c.ok, false);
    assert.equal(c.level, 'warn', '起点超 4000 仍是 warn——本次不改起点行为');
});

test('T3 判定项 value 不回显命中的词（报告不许是作弊指南）', () => {
    const f = reviewForPlatform({ content: chapterOf(2990), chapter: 1, platform: 'fanqie' });
    const q = reviewForPlatform({ content: chapterOf(2990), chapter: 1, platform: 'qidian' });
    // 先存证：这三项在造出来的正文里确实命中了词表——否则下面的断言是空转
    assert.equal(checkOf(f, 'first-1k-thrill').ok, true, '前 1000 字要命中爽点词');
    assert.equal(checkOf(f, 'first-3-faceslap').ok, true, '本章要命中打脸词');
    assert.equal(checkOf(q, 'opening-conflict').ok, true, '开篇 300 字要命中冲突词');
    const cases = [
        [checkOf(f, 'first-1k-thrill'), THRILL_WORDS],
        [checkOf(f, 'first-3-faceslap'), FACESLAP_WORDS],
        [checkOf(q, 'opening-conflict'), CONFLICT_WORDS],
    ];
    for (const [c, words] of cases) {
        assert.ok(words.length > 0, '词表解析不能是空数组（否则本条是空转）');
        for (const w of words) {
            assert.ok(!c.value.includes(w), c.key + '.value 回显了词表里的「' + w + '」：' + c.value);
        }
    }
});

test('T2/T4 first-3-faceslap：标签说实话 + 降为 warn + 窗口写清楚', () => {
    const noSlap = Array.from({ length: 40 }, (_, i) => '第' + (i + 1) + '节，林晚把账本翻过一页，把当天的数目记下来，窗外的雨一直没停。').join('\n\n');
    const f = reviewForPlatform({ content: noSlap, chapter: 1, platform: 'fanqie' });
    const c = checkOf(f, 'first-3-faceslap');
    assert.equal(c.ok, false, '无打脸词的正文本项不通过');
    assert.equal(c.level, 'warn', '第 1 章没打脸词是合格结构，不许判 error');
    assert.match(c.label, /前三章/, 'label 必须说明这是前三章的要求');
    assert.match(c.label, /本章/, 'label 必须写明窗口是本章');
    assert.match(c.target, /本章全文/, 'target 必须写明窗口口径');
    assert.match(c.advice, /第 1 章可先立憋屈/);
    assert.match(c.advice, /不是单章必须兑现/);
    assert.equal(c.value, '未检出', 'value 不得回显命中的词');

    // 口径并排可见：相邻的 first-1k-thrill 必须写明「前 1000 字」
    const thrill = checkOf(f, 'first-1k-thrill');
    assert.match(thrill.label, /前 1000 字/);
    assert.match(thrill.target, /前 1000 字/);

    // 第 4 章不再出这项（前三章窗口之外）；有打脸词时仍判 ok（判据没被削弱）
    const later = reviewForPlatform({ content: noSlap, chapter: 4, platform: 'fanqie' });
    assert.equal(later.checks.some((x) => x.key === 'first-3-faceslap'), false);
    const hit = reviewForPlatform({ content: chapterOf(2990), chapter: 1, platform: 'fanqie' });
    assert.equal(checkOf(hit, 'first-3-faceslap').ok, true);
});

// 晋江/七猫新平台（2026-10-23 真机事故回归）：REVIEWERS 分派表在模块求值时急切取值
// 四个标识符——映射里写了 jjwxc/qimao 而函数体没写 = import 即 ReferenceError，
// 插件激活失败又被 failOnStartupError:false 静默吞掉（GUI 照常起，面板/工具全消失）。
// 本文件顶部的 import 本身就是「模块必须可加载」的断言；下面补分派路径的判据钉。
const SUFFER_WORDS = wordList('SUFFER_WORDS');

function withoutHook(n) {
    return chapterOf(n).split('\n\n').slice(0, -1).join('\n\n');
}

test('晋江：订阅制区间 3000–6000 硬下限 + 黄金三章开篇忌虐', () => {
    const under = reviewForPlatform({ content: chapterOf(2800), chapter: 4, platform: 'jjwxc' });
    const len = checkOf(under, 'chapter-length');
    assert.equal(len.level, 'error', '订阅制下限是收入底线，不足必须 error');
    assert.match(len.target, /3000–6000/);

    const inRange = reviewForPlatform({ content: chapterOf(4500), chapter: 4, platform: 'jjwxc' });
    assert.equal(inRange.errorCount, 0);
    assert.equal(inRange.passed, true, '4500 字非黄金章应全绿');

    const sufferWord = SUFFER_WORDS[0];
    const badOpen = `她${sufferWord}了，低着头没敢出声。\n\n` + chapterOf(3200);
    const golden = reviewForPlatform({ content: badOpen, chapter: 1, platform: 'jjwxc' });
    assert.equal(checkOf(golden, 'opening-no-suffer').level, 'error', '黄金三章开篇虐主必须 error');
    const clean = reviewForPlatform({ content: chapterOf(3200), chapter: 1, platform: 'jjwxc' });
    assert.equal(checkOf(clean, 'opening-no-suffer').ok, true, '无压抑信号的开篇应通过');
});

test('七猫：免费流章末钩子是 error（对比番茄 warn），憋屈时长更狠（≤800）', () => {
    const bare = withoutHook(2500);
    const qm = reviewForPlatform({ content: bare, chapter: 4, platform: 'qimao' });
    assert.equal(checkOf(qm, 'ending-hook').level, 'error', '免费流打开率生死线，无钩子必须 error');
    const fq = reviewForPlatform({ content: bare, chapter: 4, platform: 'fanqie' });
    assert.equal(checkOf(fq, 'ending-hook').level, 'warn', '同一内容番茄口径仍是 warn——两平台分级不许混');

    const withHook = reviewForPlatform({ content: chapterOf(2500), chapter: 4, platform: 'qimao' });
    assert.equal(checkOf(withHook, 'ending-hook').ok, true);

    const under = reviewForPlatform({ content: chapterOf(1800), chapter: 4, platform: 'qimao' });
    assert.equal(checkOf(under, 'chapter-length').level, 'error', 'qimao 区间 2000–3500，1800 必 error');
});

// ── 飞卢（feilu）──────────────────────────────────────────────────────────────
// 单章区间是两段式（上架前 1500–2000 / 上架后 2500–5050），档案表存包络 1500–5050，
// 分带口径在 reviewFeilu 字数项里补：两带间隙（2001–2499）单独 warn，不冒充合格。

/** 纯叙述段造章（无对话块里的冲突/爽点/打脸词），用于打「未检出」的反向用例。 */
function plainChapter(n) {
    const paras = [];
    let chars = 0;
    while (chars < n - HOOK_TAIL.length) {
        paras.push(PLAIN_BLOCK);
        chars += PLAIN_BLOCK.length;
    }
    return [...paras, HOOK_TAIL].join('\n\n');
}

test('飞卢：双带字数 1800/2600 过、两带间隙 2200 warn、包络外 error；自定义档不分带', () => {
    for (const n of [1800, 2600]) {
        const r = reviewForPlatform({ content: chapterOf(n), chapter: 4, platform: 'feilu' });
        const c = checkOf(r, 'chapter-length');
        assert.equal(c.ok, true, n + ' 字落在带上必须通过（value=' + c.value + '）');
    }
    assert.match(platformLimitsText(), /飞卢 1500–5050/, 'platformLimitsText 自动枚举新档');
    const feiluConf = charConfigForPlatform({ minChapterChars: 2500, maxChapterChars: 4000 }, 'feilu');
    assert.deepEqual([feiluConf.minChapterChars, feiluConf.maxChapterChars], [1500, 5050], 'charConfigForPlatform 自动取飞卢包络档');

    const gap = reviewForPlatform({ content: chapterOf(2200), chapter: 4, platform: 'feilu' });
    const gc = checkOf(gap, 'chapter-length');
    assert.equal(gc.ok, false, '2200 在两带间隙，不许冒充合格');
    assert.equal(gc.level, 'warn', '间隙只 warn 不 error——它不踩任何硬规则');
    assert.match(gc.advice, /两带间隙/, 'advice 必须把间隙口径说破');

    const under = reviewForPlatform({ content: chapterOf(1200), chapter: 4, platform: 'feilu' });
    assert.equal(checkOf(under, 'chapter-length').level, 'error', '包络下限 1500，1200 必 error');

    // 本书自定义口径：区间是用户定的，只按自定义区间判，不再套平台双带
    const custom = reviewForPlatform({
        content: chapterOf(2200), chapter: 4, platform: 'feilu',
        charConfig: { minChapterChars: 2000, maxChapterChars: 4000 }, charSource: 'custom',
    });
    const cc = checkOf(custom, 'chapter-length');
    assert.equal(cc.ok, true, '自定义 2000–4000 下 2200 必须放行');
    assert.match(cc.label, /本书自定义/, 'label 要写明数字出处');
});

test('飞卢黄金三章：ch1 开篇出事、ch2 金手指、ch3 打脸（词法近似判 warn）', () => {
    const plain = reviewForPlatform({ content: plainChapter(2000), chapter: 1, platform: 'feilu' });
    const oc = checkOf(plain, 'opening-conflict');
    assert.equal(oc.ok, false, '纯叙述开篇无冲突信号，不通过');
    assert.equal(oc.level, 'error', '飞卢前 300 字出事是 error（编辑判慢热的硬标准）');

    const ch2 = reviewForPlatform({ content: chapterOf(2000), chapter: 2, platform: 'feilu' });
    const gf = checkOf(ch2, 'golden-finger');
    assert.equal(gf.ok, false, '无金手指词的第 2 章不通过');
    assert.equal(gf.level, 'warn', '词法近似不许判 error——误杀比漏报贵');
    assert.equal(gf.value, '未检出', 'value 不回显词表');
    const withGf = reviewForPlatform({ content: '系统提示音在他脑海里响起。\n\n' + chapterOf(2000), chapter: 2, platform: 'feilu' });
    assert.equal(checkOf(withGf, 'golden-finger').ok, true, '金手指词命中即通过（判据没被削弱）');

    const ch3 = reviewForPlatform({ content: chapterOf(2500), chapter: 3, platform: 'feilu' });
    const fs = checkOf(ch3, 'first-3-faceslap');
    assert.equal(fs.ok, true, '对白块自带打脸词，必须真命中');
    const ch4 = reviewForPlatform({ content: chapterOf(2500), chapter: 4, platform: 'feilu' });
    assert.equal(ch4.checks.some((x) => x.key === 'first-3-faceslap'), false, '第 4 章不再出黄金三章项');
});

test('飞卢：章末钩子 error + 爽点密度 error + 憋屈 ≤800（与七猫同档但不混用）', () => {
    const bare = withoutHook(2600);
    const fl = reviewForPlatform({ content: bare, chapter: 4, platform: 'feilu' });
    assert.equal(checkOf(fl, 'ending-hook').level, 'error', '飞卢章末必留钩子，无钩子 error');

    const quiet = reviewForPlatform({ content: plainChapter(2600), chapter: 4, platform: 'feilu' });
    assert.equal(checkOf(quiet, 'first-1k-thrill').level, 'error', '前 1000 字无爽点/推进反馈必 error');

    assert.equal(checkOf(fl, 'suffering-duration').ok, true, '常规造章无憋屈段，应通过');
    assert.equal(reviewForPlatform({ content: chapterOf(2600), chapter: 4, platform: 'feilu' }).platform, 'feilu', '分派路径自证');
});
