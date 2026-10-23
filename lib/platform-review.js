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
// 平台字数区间的唯一真相在 lib/store.js（写作门禁与面板设置读的是同一张表）。
// 这里反向 import 而不是另抄一份：两处的 1500/2000/3000/4000 一旦漂移，
// 就回到本轮要消灭的那个病——同一章在「写」和「审」得到相反结论。
import { PLATFORM_PROFILES } from './store.js';

/** 支持的平台（口味说明只在这里；数字区间取自 store 的档案表）。 */
export const PLATFORMS = {
    qidian: { id: 'qidian', name: '起点', hint: '长线伏笔 + 均订逻辑：结构稳、信息密、章末必留钩子' },
    fanqie: { id: 'fanqie', name: '番茄', hint: '前 1000 字给爽点 + 完读率优先：段落短、对话密、憋屈不过夜' },
    jjwxc: { id: 'jjwxc', name: '晋江', hint: '订阅制按千字计费：字数足额、开篇忌虐、情绪浓度与关系张力优先，前三章定收藏' },
    qimao: { id: 'qimao', name: '七猫', hint: '免费流广告分成：强情绪快节奏、章末必留钩子，慢热铺垫没有流量' },
    feilu: { id: 'feilu', name: '飞卢', hint: '极快节奏强爽感：前 300 字出事、第二章亮金手指、第三章打脸，章末必留钩子，虐主与慢热是平台级雷区' },
};

export const PLATFORM_IDS = Object.keys(PLATFORMS);

/** 平台 → 审稿函数（加平台 = 加一条映射 + 一个 reviewXxx，别再往分派里塞三元链）。
 *  ⚠️ 映射表在模块求值时就急切取值各平台标识符——函数提升只救「已声明」的函数，
 *  写了映射没写函数体 = import 即 ReferenceError。而插件的 bundle 行声明了
 *  failOnStartupError:false，激活失败会被宿主静默吞掉：GUI 照常启动，工具、
 *  客户端半区、右侧栏面板全部凭空消失（2026-10-23 真机事故）。改完必须
 *  node -e "import('./lib/index.js')" 自证可加载，再重启宿主。 */
const REVIEWERS = {
    qidian: reviewQidian,
    fanqie: reviewFanqie,
    jjwxc: reviewJjwxc,
    qimao: reviewQimao,
    feilu: reviewFeilu,
};

/** 爽点信号词（兑现感：反转/打脸/突破/扬眉吐气）。 */
const THRILL_WORDS = ['打脸', '反转', '翻盘', '惊艳', '震惊', '轰动', '哗然', '傻眼', '目瞪口呆', '不可能', '怎么可能', '突破', '晋级', '碾压', '秒杀', '绝杀', '暴涨', '一鸣惊人', '技惊四座', '当众', '跪', '求饶', '认输', '扬眉吐气', '爽'];
/** 打脸/逆转信号词（番茄前 3 章的核心）。 */
const FACESLAP_WORDS = ['打脸', '耳光', '脸都绿', '脸色煞白', '傻眼', '目瞪口呆', '说不出话', '跪下', '求饶', '认错', '嘲笑', '不屑', '看轻', '瞧不起', '笑话', '当众', '轻蔑', '冷笑', '后悔', '想不到'];
/** 冲突信号词（开篇 300 字必须把冲突摆上桌）。
 *  三类：动作性冲突（摔/砸/抢/夺）、言语冲突（冷笑/质问/威胁/嘲讽）、危机（死/血/危机/破产）。 */
const CONFLICT_WORDS = ['突然', '猛地', '骤然', '不对', '危机', '死', '杀', '血', '敌', '恨', '急', '吼', '砸', '摔', '碎', '断', '爆', '逃', '追', '刀', '枪', '威胁', '冷笑', '质问', '翻脸', '瞪', '背叛', '退婚', '离婚', '开除', '破产', '索赔', '抢', '夺'];
/** 憋屈信号词（压抑/受气/被压制的段落）。 */
const SUFFER_WORDS = ['委屈', '羞辱', '屈辱', '忍着', '咬牙', '不敢', '低头', '沉默', '苦笑', '无力', '绝望', '认命', '挨', '受气', '冷眼', '嘲讽', '讥讽', '排挤', '打压', '抬不起头', '眼泪'];
/** 金手指信号词（飞卢黄金三章的核心：第二章必须亮出「他凭什么赢」）。
 *  覆盖常见形态：系统流/面板流/穿越重生开局/觉醒绑定/签到外挂——词法近似，判 warn 不判 error。 */
const GOLDEN_FINGER_WORDS = ['系统', '面板', '金手指', '穿越', '重生', '觉醒', '绑定', '签到', '外挂', '异能', '空间', '传承'];

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

// 判定项 value 的**安全摘要**：只说有没有命中/命中几项，绝不回显命中的词。
// 工具返回值是模型可见面——回显词等于把词表印成作弊指南（真机：某 agent 读完报告
// 就反编译出词表并要求「后续请直接按词表给词」）。所有基于 hitsOf 的 value 都走这里。
function hitSummary(hits) {
    return hits.length > 0 ? `命中 ${hits.length} 项` : '未检出';
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
 * 判定用的字数区间：默认取平台档案表，**给了本书生效口径就按本书口径判**。
 *
 * 为什么审稿必须认自定义档：写作门禁的优先链是「本书自定义 > 投放平台 > 插件配置」
 * （`store.effectiveCharConfig` 是这条链的唯一实现）。审稿此前只读静态平台档案，
 * 于是同一章会出现「写的时候按 3000–6000 放行、审的时候按番茄 1500–3000 判死」——
 * 而漏掉的恰恰是优先级最高的那一档。写审一致的另一半在这里补上。
 * @param {string} pid 平台 id
 * @param {{minChapterChars:number, maxChapterChars:number}|null} charConfig 本书生效口径
 */
function limitsFor(pid, charConfig) {
    const base = PLATFORM_PROFILES[pid];
    const lo = Number.isFinite(charConfig?.minChapterChars) ? charConfig.minChapterChars : base.minChapterChars;
    const hi = Number.isFinite(charConfig?.maxChapterChars) ? charConfig.maxChapterChars : base.maxChapterChars;
    // 倒挂（min > max）会让「区间内」永远为假：宁可交换，也不要一条恒死的判定项
    return lo <= hi ? { minChapterChars: lo, maxChapterChars: hi } : { minChapterChars: hi, maxChapterChars: lo };
}

/**
 * 平台体检表（纯函数）。
 * @param inputs { content, chapter = 1, platform = 'qidian',
 *                 charConfig = null（本书生效口径：{minChapterChars,maxChapterChars}，缺省走平台档案表）,
 *                 charSource = 'platform'（'custom' 时文案写「本书自定义」，让人知道数字哪来的） }
 */
export function reviewForPlatform({ content, chapter = 1, platform = 'qidian', charConfig = null, charSource = 'platform' } = {}) {
    const pid = String(platform).toLowerCase();
    if (!PLATFORM_IDS.includes(pid)) {
        throw new Error(`未知平台：${platform}（可用：${PLATFORM_IDS.join(' / ')}）`);
    }
    const text = String(content ?? '');
    const a = computeAudit({ content: text });
    const mood = measureMood(text);
    const st = measureStyleMetrics(text);
    const n = Number.isInteger(chapter) && chapter > 0 ? chapter : 1;
    const limits = limitsFor(pid, charConfig);
    // 数字出处写进文案：判的是哪套区间必须一眼可见，否则用户改了自定义档却看见
    // 平台数字，只会以为「设了没生效」。
    const who = charSource === 'custom' ? '本书自定义' : PLATFORMS[pid].name;

    // 函数声明有提升，模块求值时映射表里拿到的都是已声明的函数体；
    // pid 在上面已校验过，这里不可能落空。
    // charSource 只给需要分带口径的审稿函数用（飞卢双带区间在本书自定义时不生效）。
    return REVIEWERS[pid]({ text, a, mood, st, n, limits, who, charSource });
}

function reviewQidian({ text, a, mood, st, n, limits, who = '起点' }) {
    const checks = [];
    const golden = n <= 3;
    const { minChapterChars, maxChapterChars } = limits;
    // 黄金三章的额外要求（起点签约判据）——只抬下限，上限仍走档案表。
    // 用 max 而不是直接取 2500：本书自定义下限高于 2500 时（比如 3000–6000），
    // 黄金三章不该反过来把下限压到 2500——「只抬不压」才是这句注释的意思。
    const minChars = golden ? Math.max(2500, minChapterChars) : minChapterChars;

    checks.push(mkCheck('chapter-length', `单章字数（${who} ${minChapterChars}–${maxChapterChars}${golden ? `，黄金三章 ${minChars} 起` : ''}）`, a.chars >= minChars && a.chars <= maxChapterChars, {
        value: `${a.chars} 字`, target: `${minChars}–${maxChapterChars}`,
        level: a.chars < minChars ? 'error' : 'warn',
        advice: a.chars < minChars ? '起点按字数算订阅，单章偏短吃亏；把细纲场景写实而不是灌水' : `超 ${maxChapterChars} 字考虑拆章，章末钩子才不会被稀释`,
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
            value: hitSummary(ch), target: '至少一个冲突词',
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

function reviewFanqie({ text, a, mood, st, n, limits, who = '番茄' }) {
    const checks = [];
    const { minChapterChars, maxChapterChars } = limits;

    const tooShort = a.chars < minChapterChars;
    const tooLong = a.chars > maxChapterChars;
    checks.push(mkCheck('chapter-length', `单章字数（${who} ${minChapterChars}–${maxChapterChars}）`, !tooShort && !tooLong, {
        value: `${a.chars} 字`, target: `${minChapterChars}–${maxChapterChars}`,
        // 超上限与不足下限同级 error：番茄按完读率给量，超长把后半段完读率拖垮，
        // 是完读率的实际杀手（本项 advice 自己就这么写）。此前超长只给 warn，
        // 真机 3098 字被判 warn，agent 读成「机审全过」继续推进。起点分支不受影响。
        level: 'error',
        advice: tooShort
            ? '番茄按完读率给量，章太短完读率虚高但信息不足，读者不留存'
            : `超 ${maxChapterChars} 字完读率会被后半段拖垮，宁拆不合（建议落点 ${PLATFORM_PROFILES.fanqie.landing}）`,
    }));

    const head1k = headChars(text, 1000);
    const thrillHead = hitsOf(head1k, THRILL_WORDS);
    const moodHead = measureMood(head1k);
    const ok1k = thrillHead.length > 0 || (moodHead.axes.thrill ?? 0) > 0;
    checks.push(mkCheck('first-1k-thrill', '前 1000 字窗口：给一个小爽点', ok1k, {
        // 窗口写进 label/target：与下一项（扫本章全文）并排显示，口径必须各自写明。
        value: thrillHead.length > 0 ? hitSummary(thrillHead) : (ok1k ? '氛围信号命中' : '未检出'),
        target: '前 1000 字内至少一次兑现/反转',
        level: 'error', advice: '番茄算法看前 1000 字的完读——开门见山给甜头，别等铺垫完再爽',
    }));

    if (n <= 3) {
        const fs = hitsOf(text, FACESLAP_WORDS);
        checks.push(mkCheck('first-3-faceslap', '前三章内本章须含打脸/逆转（窗口：本章全文）', fs.length > 0, {
            // 本项扫的是**本章全文**（跨章聚合在纯函数里做不到，也不该做——读别的章会破坏
            // 纯函数边界），所以它是「前三章累计要求」的单章近似，不是单章硬指标：
            // 黄金三章的常态是第 1 章立憋屈、第 3 章反打，第 1 章本身没打脸词是合格结构。
            // 旧实现把这条写成 error 且 label 谎称「前 3 章必须有」，真机第 1 章因此被判 error
            // 走返工——标签说谎比判据松更贵。降为 warn，并把窗口与口径写进 label/target。
            value: hitSummary(fs), target: '本章全文出现打脸/逆转/扬眉吐气信号',
            level: 'warn', advice: '第 1 章可先立憋屈，第 3 章前补齐即可；这是前三章的累计要求，不是单章必须兑现',
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

/** 晋江：订阅制按千字计费——字数足额是收入底线（下限硬），开篇忌虐、前三章定收藏。 */
function reviewJjwxc({ text, a, mood, st, n, limits, who = '晋江' }) {
    const checks = [];
    const golden = n <= 3;
    const { minChapterChars, maxChapterChars } = limits;
    // 订阅制下限是硬的：字数即收入，短章是读者实亏与高频差评源（profile 注释口径）。
    checks.push(mkCheck('chapter-length', `单章字数（${who} ${minChapterChars}–${maxChapterChars}，订阅制下限是硬的）`, a.chars >= minChapterChars && a.chars <= maxChapterChars, {
        value: `${a.chars} 字`, target: `${minChapterChars}–${maxChapterChars}`,
        level: 'error',
        advice: a.chars < minChapterChars
            ? '晋江按千字订阅，单章不足额读者实亏、差评率高——把细纲场景写实把字数写够，别灌水'
            : `超 ${maxChapterChars} 字手机端掉追读，宁拆章不合`,
    }));

    if (golden) {
        const head1k = headChars(text, 1000);
        const sufferHead = hitsOf(head1k, SUFFER_WORDS);
        checks.push(mkCheck('opening-no-suffer', '黄金三章：开篇 1000 字忌虐主', sufferHead.length === 0, {
            value: hitSummary(sufferHead), target: '开篇窗口无压抑/受气信号',
            level: 'error', advice: '晋江前三章定收藏——开篇虐主直接劝退，先立人物魅力与关系张力，虐放后面',
        }));
    }

    const dr = a.dialogueRatio;
    checks.push(mkCheck('dialogue-ratio', '对话占比 20%–50%（关系张力走对话）', dr >= 0.2 && dr <= 0.5, {
        value: `${Math.round(dr * 100)}%`, target: '20%–50%',
        level: dr < 0.2 ? 'warn' : 'info',
        advice: dr < 0.2 ? '晋江读者为人物关系留存——把张力落到对手戏与对话上，别全靠叙述交代' : '对话过密挤掉情绪铺陈，穿插内心与环境',
    }));

    checks.push(mkCheck('mobile-paragraph', '平均段长 ≤ 200 字（移动端）', a.avgParagraphChars > 0 && a.avgParagraphChars <= 200, {
        value: `${a.avgParagraphChars} 字/段`, target: '≤200',
        level: 'warn', advice: '晋江移动端阅读为主，长段是劝退墙，拆段',
    }));

    checks.push(mkCheck('ending-hook', '章末钩子', a.endingHook.detected === true, {
        value: a.endingHook.detected ? a.endingHook.kind : '无', target: '问句/悬念/省略/转折',
        level: 'warn', advice: '晋江读者因人物留存，钩子不似免费流生死线——但 VIP 章末留未解张力保追读',
    }));

    const cv = sentenceCv(text);
    checks.push(mkCheck('sentence-rhythm', '句式节奏（句长方差 ≥ 0.35，情绪浓度需要起伏）', cv >= 0.35, {
        value: String(cv), target: '≥0.35',
        level: 'info', advice: '情绪浓度靠节奏起伏托——长短句交错，通篇同长读不出情绪',
    }));

    return finalize(checks, { platform: 'jjwxc', chapter: n, chars: a.chars });
}

/** 七猫：免费流广告分成——强情绪快节奏、章末必留钩子，慢热铺垫没有流量。 */
function reviewQimao({ text, a, mood, st, n, limits, who = '七猫' }) {
    const checks = [];
    const { minChapterChars, maxChapterChars } = limits;

    checks.push(mkCheck('chapter-length', `单章字数（${who} ${minChapterChars}–${maxChapterChars}）`, a.chars >= minChapterChars && a.chars <= maxChapterChars, {
        value: `${a.chars} 字`, target: `${minChapterChars}–${maxChapterChars}`,
        level: 'error',
        advice: a.chars < minChapterChars
            ? '免费流按完读/时长给量，章太短广告分成上不去、信息也不足'
            : `超 ${maxChapterChars} 字后半段完读率被拖垮，日更 4000 惯例拆两章写`,
    }));

    const head1k = headChars(text, 1000);
    const thrillHead = hitsOf(head1k, THRILL_WORDS);
    const moodHead = measureMood(head1k);
    const ok1k = thrillHead.length > 0 || (moodHead.axes.thrill ?? 0) > 0;
    checks.push(mkCheck('first-1k-thrill', '前 1000 字窗口：给一个爽点或强情绪', ok1k, {
        value: thrillHead.length > 0 ? hitSummary(thrillHead) : (ok1k ? '氛围信号命中' : '未检出'),
        target: '前 1000 字内至少一次兑现/强情绪',
        level: 'error', advice: '免费流算法看前 1000 字留人——开门给强情绪，慢热铺垫没有流量',
    }));

    if (n <= 3) {
        const fs = hitsOf(text, FACESLAP_WORDS);
        checks.push(mkCheck('first-3-faceslap', '前三章内本章须含打脸/逆转（窗口：本章全文）', fs.length > 0, {
            value: hitSummary(fs), target: '本章全文出现打脸/逆转/扬眉吐气信号',
            level: 'warn', advice: '前三章的累计要求：第 1 章可先立憋屈，第 3 章前补齐反打即可',
        }));
    }

    const suffer = longestSufferingRun(text);
    checks.push(mkCheck('suffering-duration', '憋屈时长 ≤ 800 字（免费流比番茄更狠）', suffer <= 800, {
        value: `${suffer} 字`, target: '≤800',
        level: 'error', advice: '免费流读者零耐心——压抑段落连写 800 字就划走，中途必须插反击或转机',
    }));

    const dr = a.dialogueRatio;
    const avg = a.avgParagraphChars;
    const completion = avg > 0 && avg <= 150 && dr >= 0.25;
    checks.push(mkCheck('completion-rate', '完读率友好（段长 ≤150 字 且 对话 ≥25%）', completion, {
        value: `段均 ${avg} 字 / 对话 ${Math.round(dr * 100)}%`, target: '段均 ≤150 且 对话 ≥25%',
        level: 'warn', advice: '短段 + 多对话是免费流完读率的基本盘',
    }));

    checks.push(mkCheck('ending-hook', '章末钩子', a.endingHook.detected === true, {
        value: a.endingHook.detected ? a.endingHook.kind : '无', target: '问句/悬念/省略/转折',
        level: 'error', advice: '免费流打开率看章末钩子——没有钩子下一章就没流量，这是生死线不是建议',
    }));

    return finalize(checks, { platform: 'qimao', chapter: n, chars: a.chars });
}

/** 飞卢：极快节奏强爽感——前 300 字出事、第二章亮金手指、第三章打脸、章末必留钩子；
 *  虐主/长期憋屈是平台级雷区（绿帽/舔狗/接盘/主角长期受气，读者三秒定弃书）。
 *  单章区间是两段式（上架前 1500–2000 / 上架后 2500–5050，档案表存的是包络 1500–5050），
 *  分带口径在本函数的字数项里补：两带间隙（2001–2499）单独 warn，不冒充合格。 */
function reviewFeilu({ text, a, mood, st, n, limits, who = '飞卢', charSource = 'platform' }) {
    const checks = [];
    const golden = n <= 3;
    const { minChapterChars, maxChapterChars } = limits;
    // 本书自定义口径时区间是用户自己定的，只按包络判、不再套平台双带。
    const custom = charSource === 'custom';

    // 字数项（双带）：包络外 error；包络内的两带间隙 warn（上架前嫌长、上架后嫌短）。
    const inEnvelope = a.chars >= minChapterChars && a.chars <= maxChapterChars;
    const inGap = !custom && a.chars >= 2001 && a.chars <= 2499;
    checks.push(mkCheck('chapter-length', `单章字数（${who}${custom ? ` ${minChapterChars}–${maxChapterChars}` : ' 双带：上架前 1500–2000 / 上架后 2500–5050'}）`, inEnvelope && !inGap, {
        value: `${a.chars} 字`, target: custom ? `${minChapterChars}–${maxChapterChars}` : '1500–2000 / 2500–5050',
        level: inGap ? 'warn' : 'error',
        advice: !inEnvelope
            ? `包络 ${minChapterChars}–${maxChapterChars} 之外：上架前按 1500–2000 写、上架后按 2500–5050 写（VIP 章不满 1000 字不计费、不计全勤，日更保底 4000、全勤 6000）`
            : '落在两带间隙（2001–2499）：上架前嫌长、上架后嫌短——按上架阶段归带，上架后建议写到 2500+ 让计费字数足额',
    }));

    if (golden) {
        // 前 300 字出事（飞卢编辑判慢热的硬标准；「500 字内主角出场」靠词法测不可靠，写在 advice 里让人自查）。
        const head = headChars(text, 300);
        const ch = hitsOf(head, CONFLICT_WORDS);
        checks.push(mkCheck('opening-conflict', '黄金三章：开篇 300 字内出事', ch.length > 0, {
            value: hitSummary(ch), target: '至少一个冲突信号',
            level: 'error', advice: '飞卢不写天气、不写家族史——第一段就让主角陷进困境（被羞辱/被退婚/系统激活/穿越险境），顺带自查主角是否 500 字内出场',
        }));
    }

    if (n === 2) {
        const gf = hitsOf(text, GOLDEN_FINGER_WORDS);
        checks.push(mkCheck('golden-finger', '第二章亮金手指（窗口：本章全文，词法近似）', gf.length > 0, {
            value: hitSummary(gf), target: '本章出现金手指/系统/觉醒等核心优势信号',
            level: 'warn', advice: '飞卢读者第 2 章就要看到「他凭什么赢」——金手指压到第 3 章以后是平台级慢热，判死风险高；词法只是近似，确实写了就用证据自行复核',
        }));
    }

    if (n === 3) {
        const fs = hitsOf(text, FACESLAP_WORDS);
        checks.push(mkCheck('first-3-faceslap', '第三章用金手指打脸（窗口：本章全文）', fs.length > 0, {
            value: hitSummary(fs), target: '本章全文出现打脸/逆转/扬眉吐气信号',
            level: 'warn', advice: '飞卢黄金三章定式：第一章出事、第二章亮牌、第三章打脸——用金手指解决第一个危机并抛出更大悬念',
        }));
    }

    const head1k = headChars(text, 1000);
    const thrillHead = hitsOf(head1k, THRILL_WORDS);
    const moodHead = measureMood(head1k);
    const ok1k = thrillHead.length > 0 || (moodHead.axes.thrill ?? 0) > 0;
    checks.push(mkCheck('first-1k-thrill', '前 1000 字窗口：给一个爽点或推进反馈', ok1k, {
        value: thrillHead.length > 0 ? hitSummary(thrillHead) : (ok1k ? '氛围信号命中' : '未检出'),
        target: '前 1000 字内至少一次兑现/推进',
        level: 'error', advice: '飞卢爽点密度全网最高：3 章一小爽、10 章一大爽，本章也别让读者空手——没有兑现至少给剧情推进',
    }));

    const suffer = longestSufferingRun(text);
    checks.push(mkCheck('suffering-duration', '憋屈时长 ≤ 800 字（虐主是平台级雷区）', suffer <= 800, {
        value: `${suffer} 字`, target: '≤800',
        level: 'error', advice: '绿帽/送女/舔狗/主角长期憋屈，飞卢读者最敏感——压抑段必须速写速收，中途插反击或转机',
    }));

    const dr = a.dialogueRatio;
    const avg = a.avgParagraphChars;
    const completion = avg > 0 && avg <= 150 && dr >= 0.25;
    checks.push(mkCheck('completion-rate', '完读率友好（段长 ≤150 字 且 对话 ≥25%）', completion, {
        value: `段均 ${avg} 字 / 对话 ${Math.round(dr * 100)}%`, target: '段均 ≤150 且 对话 ≥25%',
        level: 'warn', advice: '飞卢移动端短段密对话是行文标配——设定轰炸（开篇堆世界观/等级/势力）正是编辑拒稿理由，设定融进事件讲',
    }));

    checks.push(mkCheck('ending-hook', '章末钩子', a.endingHook.detected === true, {
        value: a.endingHook.detected ? a.endingHook.kind : '无', target: '问句/悬念/省略/转折',
        level: 'error', advice: '飞卢章末必留钩子——没有钩子下一章就没打开，这是节奏定式不是建议',
    }));

    return finalize(checks, { platform: 'feilu', chapter: n, chars: a.chars });
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
