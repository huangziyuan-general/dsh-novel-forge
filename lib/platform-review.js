// lib/platform-review.js — 平台审稿（C4，纯函数，零 token）。
//
// 通用质量 ≠ 平台口味。起点吃长线伏笔与结构，番茄吃前 1000 字的爽点与完读率——
// 同一章在两家可能一个能过、一个扑街。这里把两家的「编辑口味」写成可计算的条目，
// 输出一张体检表（每条带 value/target/advice），改稿时直接照着改。
//
// 判定用的是本插件已有的三个纯函数：computeAudit（字数/段落/对话/钩子）、
// measureMood（12 轴氛围，取 thrill 爽感 / oppressive 压抑）、measureStyleMetrics
// （句法/动作密度）。不新增模型调用。

import { computeAudit } from './audit.js';
import { measureMood, measureStyleMetrics, splitSentences } from './style.js';

/** 支持的平台。 */
export const PLATFORMS = {
    qidian: { id: 'qidian', name: '起点', hint: '长线伏笔 + 均订逻辑：结构稳、信息密、章末必留钩子' },
    fanqie: { id: 'fanqie', name: '番茄', hint: '前 1000 字给爽点 + 完读率优先：段落短、对话密、憋屈不过夜' },
};

export const PLATFORM_IDS = Object.keys(PLATFORMS);

/** 爽点信号词（兑现感：反转/打脸/突破/扬眉吐气）。 */
const THRILL_WORDS = ['打脸', '反转', '翻盘', '惊艳', '震惊', '轰动', '哗然', '傻眼', '目瞪口呆', '不可能', '怎么可能', '突破', '晋级', '碾压', '秒杀', '绝杀', '暴涨', '一鸣惊人', '技惊四座', '当众', '跪', '求饶', '认输', '扬眉吐气', '爽'];
/** 打脸/逆转信号词（番茄前 3 章的核心）。 */
const FACESLAP_WORDS = ['打脸', '耳光', '脸都绿', '脸色煞白', '傻眼', '目瞪口呆', '说不出话', '跪下', '求饶', '认错', '嘲笑', '不屑', '看轻', '瞧不起', '笑话', '当众', '轻蔑', '冷笑', '后悔', '想不到'];
/** 冲突信号词（开篇 300 字必须把冲突摆上桌）。
 *  三类：动作性冲突（摔/砸/抢/夺）、言语冲突（冷笑/质问/威胁/嘲讽）、危机（死/血/危机/破产）。 */
const CONFLICT_WORDS = ['突然', '猛地', '骤然', '不对', '危机', '死', '杀', '血', '敌', '恨', '急', '吼', '砸', '摔', '碎', '断', '爆', '逃', '追', '刀', '枪', '威胁', '冷笑', '质问', '翻脸', '瞪', '背叛', '退婚', '离婚', '开除', '破产', '索赔', '抢', '夺'];
/** 憋屈信号词（压抑/受气/被压制的段落）。 */
const SUFFER_WORDS = ['委屈', '羞辱', '屈辱', '忍着', '咬牙', '不敢', '低头', '沉默', '苦笑', '无力', '绝望', '认命', '挨', '受气', '冷眼', '嘲讽', '讥讽', '排挤', '打压', '抬不起头', '眼泪'];

function countOccurrences(text, term) {
    if (term === '') return 0;
    let n = 0;
    let i = text.indexOf(term);
    while (i !== -1) { n += 1; i = text.indexOf(term, i + term.length); }
    return n;
}

function hitsOf(text, words) {
    const hit = [];
    for (const w of new Set(words)) {
        const c = countOccurrences(text, w);
        if (c > 0) hit.push({ term: w, count: c });
    }
    return hit.sort((a, b) => b.count - a.count);
}

/** 取正文前 n 个「非空白字符」（标题行不计）。 */
export function headChars(text, n = 1000) {
    const body = String(text ?? '').replace(/^#{1,6}[ \t]+[^\n]*\n?/gm, '');
    const clean = body.replace(/\s/g, '');
    return clean.slice(0, n);
}

/**
 * 最长「连续憋屈段」字数：逐段打分（含憋屈词 → 段落计入），
 * 求连续计分段的累计字数最大值（以空行分段，与审计口径一致）。
 */
export function longestSufferingRun(content) {
    const paras = String(content ?? '').split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p.length > 0);
    let best = 0;
    let run = 0;
    for (const p of paras) {
        const chars = p.replace(/\s/g, '').length;
        if (hitsOf(p, SUFFER_WORDS).length > 0) {
            run += chars;
            if (run > best) best = run;
        } else {
            run = 0;
        }
    }
    return best;
}

/** 句长变异系数（长短句交错的量化：通篇同长 → 接近 0）。 */
export function sentenceCv(text) {
    const lens = splitSentences(String(text ?? '').replace(/^#{1,6}[ \t]+[^\n]*\n?/gm, ''))
        .map((s) => s.replace(/\s/g, '').length).filter((n) => n > 0);
    if (lens.length < 3) return 0;
    const mu = lens.reduce((a, b) => a + b, 0) / lens.length;
    if (mu === 0) return 0;
    const vari = lens.reduce((a, b) => a + (b - mu) ** 2, 0) / lens.length;
    return Math.round((Math.sqrt(vari) / mu) * 100) / 100;
}

function mkCheck(key, label, ok, { value, target, level = 'warn', advice = '' } = {}) {
    return { key, label, ok, value: value === undefined ? '' : String(value), target: target ?? '', level: ok ? 'ok' : level, advice };
}

function finalize(checks, { platform, chapter, chars }) {
    const errorCount = checks.filter((c) => !c.ok && c.level === 'error').length;
    const warningCount = checks.filter((c) => !c.ok && c.level === 'warn').length;
    let score = 100 - errorCount * 15 - warningCount * 6;
    score = Math.max(0, Math.min(100, score));
    return {
        platform, name: PLATFORMS[platform].name, chapter, chars,
        score, passed: errorCount === 0 && score >= 70,
        errorCount, warningCount, checks,
    };
}

/**
 * 平台体检表（纯函数）。
 * @param inputs { content, chapter = 1, platform = 'qidian' }
 */
export function reviewForPlatform({ content, chapter = 1, platform = 'qidian' } = {}) {
    const pid = String(platform).toLowerCase();
    if (!PLATFORM_IDS.includes(pid)) {
        throw new Error(`未知平台：${platform}（可用：${PLATFORM_IDS.join(' / ')}）`);
    }
    const text = String(content ?? '');
    const a = computeAudit({ content: text });
    const mood = measureMood(text);
    const st = measureStyleMetrics(text);
    const n = Number.isInteger(chapter) && chapter > 0 ? chapter : 1;

    return pid === 'qidian' ? reviewQidian({ text, a, mood, st, n }) : reviewFanqie({ text, a, mood, st, n });
}

function reviewQidian({ text, a, mood, st, n }) {
    const checks = [];
    const golden = n <= 3;
    const minChars = golden ? 2500 : 2000;

    checks.push(mkCheck('chapter-length', '单章字数（起点 2000–4000，黄金三章 2500 起）', a.chars >= minChars && a.chars <= 4000, {
        value: `${a.chars} 字`, target: golden ? '2500–4000' : '2000–4000',
        level: a.chars < minChars ? 'error' : 'warn',
        advice: a.chars < minChars ? '起点按字数算订阅，单章偏短吃亏；把细纲场景写实而不是灌水' : '超 4000 字考虑拆章，章末钩子才不会被稀释',
    }));

    checks.push(mkCheck('ending-hook', '章末钩子', a.endingHook.detected === true, {
        value: a.endingHook.detected ? a.endingHook.kind : '无', target: '问句/悬念/省略/转折',
        level: 'error', advice: '起点追读看章末——末段必须留一个未解问题或反转预告',
    }));

    const dr = a.dialogueRatio;
    checks.push(mkCheck('dialogue-ratio', '对话占比 15%–45%', dr >= 0.15 && dr <= 0.45, {
        value: `${Math.round(dr * 100)}%`, target: '15%–45%',
        level: dr < 0.15 ? 'warn' : 'info',
        advice: dr < 0.15 ? '通篇叙述读者会疲——至少让关键冲突落到对话上' : '对话过密会稀释信息密度，穿插环境与动作',
    }));

    checks.push(mkCheck('mobile-paragraph', '平均段长 ≤ 200 字（移动端）', a.avgParagraphChars > 0 && a.avgParagraphChars <= 200, {
        value: `${a.avgParagraphChars} 字/段`, target: '≤200',
        level: 'warn', advice: '起点 App 阅读为主，长段在手机上是一堵墙，拆段',
    }));

    if (golden) {
        const head = headChars(text, 300);
        const ch = hitsOf(head, CONFLICT_WORDS);
        checks.push(mkCheck('opening-conflict', '黄金三章：开篇 300 字内立冲突', ch.length > 0, {
            value: ch.length > 0 ? ch.slice(0, 3).map((x) => x.term).join('、') : '未见冲突信号', target: '至少一个冲突词',
            level: 'error', advice: '前三章决定签约——第一段就把矛盾/危机摆在读者眼前，别做背景铺陈',
        }));
    }

    const thrill = mood.axes.thrill ?? 0;
    const needThrill = n % 3 === 0;
    checks.push(mkCheck('thrill-cadence', '爽点节奏（每 3 章一次兑现）', thrill > 0, {
        value: `${thrill}/千字`, target: needThrill ? '本章为每 3 章节点，务必有兑现' : '>0',
        level: needThrill ? 'warn' : 'info',
        advice: '承诺→兑现的节奏断档是均订下滑主因；本章可安排一次小兑现',
    }));

    checks.push(mkCheck('info-density', '信息密度（动作密度 ≥ 8/千字）', (st.action ?? 0) >= 8, {
        value: String(st.action ?? 0), target: '≥8/千字',
        level: 'warn', advice: '叙述里动作/事件太少＝信息稀释，读者会跳读——把设定融进事件里讲',
    }));

    checks.push(mkCheck('volume-length', '章数进度（起点长篇按卷推进）', true, {
        value: `第${n}章`, target: '按卷收放',
        level: 'info', advice: '每卷末做一次全局复盘：伏笔回收率、势力变化、主角成长刻度',
    }));

    return finalize(checks, { platform: 'qidian', chapter: n, chars: a.chars });
}

function reviewFanqie({ text, a, mood, st, n }) {
    const checks = [];

    checks.push(mkCheck('chapter-length', '单章字数（番茄 1500–3000）', a.chars >= 1500 && a.chars <= 3000, {
        value: `${a.chars} 字`, target: '1500–3000',
        level: a.chars < 1500 ? 'error' : 'warn',
        advice: a.chars < 1500 ? '番茄按完读率给量，章太短完读率虚高但信息不足，读者不留存' : '超 3000 字完读率会被后半段拖垮，宁拆不合',
    }));

    const head1k = headChars(text, 1000);
    const thrillHead = hitsOf(head1k, THRILL_WORDS);
    const moodHead = measureMood(head1k);
    const ok1k = thrillHead.length > 0 || (moodHead.axes.thrill ?? 0) > 0;
    checks.push(mkCheck('first-1k-thrill', '前 1000 字内给一个小爽点', ok1k, {
        value: thrillHead.length > 0 ? thrillHead.slice(0, 3).map((x) => x.term).join('、') : '未检出', target: '千字内至少一次兑现/反转',
        level: 'error', advice: '番茄算法看前 1000 字的完读——开门见山给甜头，别等铺垫完再爽',
    }));

    if (n <= 3) {
        const fs = hitsOf(text, FACESLAP_WORDS);
        checks.push(mkCheck('first-3-faceslap', '前 3 章必须有打脸/逆转', fs.length > 0, {
            value: fs.length > 0 ? fs.slice(0, 3).map((x) => x.term).join('、') : '未检出', target: '打脸/逆转/扬眉吐气',
            level: 'error', advice: '番茄签的第一判据就是前三章的爽感——把「被小看 → 反打」套路做实',
        }));
    }

    const dr = a.dialogueRatio;
    const avg = a.avgParagraphChars;
    const completion = avg > 0 && avg <= 150 && dr >= 0.25;
    checks.push(mkCheck('completion-rate', '完读率友好（段长 ≤150 字 且 对话 ≥25%）', completion, {
        value: `段均 ${avg} 字 / 对话 ${Math.round(dr * 100)}%`, target: '段均 ≤150 且 对话 ≥25%',
        level: 'warn', advice: '番茄读者在碎片时间读——短段 + 多对话是完读率的基本盘',
    }));

    const suffer = longestSufferingRun(text);
    checks.push(mkCheck('suffering-duration', '憋屈时长 ≤ 1200 字', suffer <= 1200, {
        value: `${suffer} 字`, target: '≤1200',
        level: 'error', advice: '憋屈不过夜：压抑段落连写过长，读者直接划走——中途插一个小反击',
    }));

    checks.push(mkCheck('ending-hook', '章末钩子', a.endingHook.detected === true, {
        value: a.endingHook.detected ? a.endingHook.kind : '无', target: '问句/悬念/省略/转折',
        level: 'warn', advice: '章末留钩是为了下一章的打开率——一句未解的问题就够',
    }));

    const cv = sentenceCv(text);
    checks.push(mkCheck('sentence-rhythm', '句式节奏（句长方差 ≥ 0.35，防念经）', cv >= 0.35, {
        value: String(cv), target: '≥0.35',
        level: 'info', advice: '长短句交错才有呼吸感，通篇同长度读起来像说明书',
    }));

    return finalize(checks, { platform: 'fanqie', chapter: n, chars: a.chars });
}

/** 体检表 → 终端文本。 */
export function platformReviewDigest(r) {
    const head = `【${r.name}】审稿 ${r.passed ? '通过 ✓' : '需改'}（${r.score}/100，第${r.chapter}章 ${r.chars} 字）`;
    const lines = r.checks.map((c) => {
        const mark = c.ok ? '✓' : (c.level === 'error' ? '✗' : '⚠');
        return `${mark} ${c.label}：${c.value}${c.target ? `（目标 ${c.target}）` : ''}${c.ok || c.advice === '' ? '' : `\n    → ${c.advice}`}`;
    });
    return [head, ...lines].join('\n');
}
