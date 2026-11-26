// lib/promise-terms.js — 题材承诺可机判条款（纯函数，零 IO、零模型调用）。
//
// 承诺书每次写章都注入（briefing 读 设定/故事承诺书.md），但内容门禁的
// 「违背承诺书」维在演化中被收窄成「欠账未回应」——题材承诺（「每章爆笑」「师徒互动」）
// 没有任何确定性检查，长篇温水式漂移在逐章视角下全部单章全绿。本模块把「可核验的题材承诺」从自由
// 散文里抽成**结构化条款**，让词频计数能确定性判定「承诺要素这一章到底有没有」。
//
// 纪律（同写法规则台账 / 细纲契约段先例）：
//   · 条款是**作者/模型开书时登记的**——「每章爆笑」该数什么词只有作者知道，派生词表猜不出；
//   · 段落写在承诺书 Markdown 里（人类文档，不变量 6），解析出机器条款（单一来源）；
//   · **报信号不判死刑**：词频≠题材（「师傅/徒弟」命中≠有互动），单章脱靶只 warning，
//     裁决留给人；连续脱靶才升级（P3 批次漂移债，落既有 debt 通道）。
//   · 坏行进 errors 不炸整批（静默吞行 = 作者以为登记了其实没有）。
//
// 段落形制（与细纲「## 本章必写场景」同一先例）：
//   ## 可核验条款
//   师徒互动|师傅,徒弟,拜师|1
//   每章爆笑|笑,乐,哈,逗|2
//   行式「要素名|关键词1,关键词2|每章最低命中」；后段可省（最低命中缺省 1）；
//   # 开头为注释、空行跳过。

import { countAll } from './noai.js';

/** 条款段落标题（可核验条款 / 机判条款 两口径都认，取出现的第一段）。 */
export const PROMISE_TERM_HEADINGS = ['可核验条款', '机判条款'];

/**
 * 从承诺书 Markdown 抽出可核验条款（纯函数）。
 * @param {string} markdown 承诺书全文
 * @returns {{ terms: Array<{name, keywords:string[], minHits:number}>, errors:string[] }}
 *   段落不存在/空 → terms 空（调用方整段省略，旧书零回归）。
 */
export function parsePromiseTerms(markdown) {
    const lines = String(markdown ?? '').split('\n');
    const terms = [];
    const errors = [];
    let inSection = false;
    for (const raw of lines) {
        const line = raw.trim();
        if (/^#{1,6}\s/.test(line)) {
            const title = line.replace(/^#{1,6}\s*/, '').trim();
            inSection = PROMISE_TERM_HEADINGS.some((h) => title.includes(h));
            continue;
        }
        if (!inSection || line === '' || line.startsWith('#')) continue;
        const cells = line.split('|').map((c) => c.trim());
        const name = cells[0] ?? '';
        if (name === '') {
            errors.push(`条款缺要素名（「${line.slice(0, 16)}…」）——行式「要素|关键词|每章最低命中」`);
            continue;
        }
        const keywords = (cells[1] ?? '').split(/[,，、]/).map((k) => k.trim()).filter((k) => k !== '');
        if (keywords.length === 0) {
            errors.push(`条款「${name}」缺关键词——关键词集空则无从计数`);
            continue;
        }
        const minHitsRaw = cells[2] ?? '';
        const minHits = minHitsRaw === '' ? 1 : Number.parseInt(minHitsRaw, 10);
        if (!Number.isInteger(minHits) || minHits < 1) {
            errors.push(`条款「${name}」最低命中「${minHitsRaw}」无效——须 ≥1 的整数（可省，缺省 1）`);
            continue;
        }
        terms.push({ name, keywords, minHits });
    }
    return { terms, errors };
}

/** 一条条款在正文里的命中总数（各关键词出现次数之和，逐字匹配，共享 noai 计数器单一口径）。 */
export function countTermHits(content, term) {
    const t = String(content ?? '');
    if (t === '') return 0;
    return term.keywords.reduce((sum, kw) => sum + countAll(t, kw), 0);
}

/**
 * 单章承诺条款检查（P2 内容门禁第⑩维的数据源，report-only 不拦）。
 * @returns {Array<{name, hits, minHits, below}>}——below=true 的条款即「本章脱靶」。
 */
export function checkPromiseTerms(content, terms) {
    const t = Array.isArray(terms) ? terms.filter((x) => x && Array.isArray(x.keywords)) : [];
    return t.map((term) => {
        const hits = countTermHits(content, term);
        const minHits = Number.isInteger(term.minHits) ? term.minHits : 1;
        return { name: term.name, hits, minHits, below: hits < minHits };
    });
}

/**
 * P3 批次漂移：把逐章承诺覆盖率拉成 10 章一批的时间线，检测「开书强、收尾塌」的温水漂移。
 * @param {Array<{no:number, content:string}>} chapters 已写章节（按章号升序）
 * @param {Array} terms 条款
 * @param {{window?:number}} opts 批窗（缺省 10 章）
 * @returns {{ series: Array<{from, to, covered, total, rate}>, baseline: number, floor: number, drifted: boolean, drop: number }}
 *   批窗内某章无该条款命中（below）= 该章该条款未覆盖；rate = 覆盖章/总章。
 *   baseline = 前半段批次平均 rate，floor = 末批 rate；drifted = 起步强（baseline≥0.6）
 *   而收尾塌（floor 比 baseline 掉 ≥0.4 且 floor<0.5）——「每章偏一点、累计面目全非」的机器信号。
 */
export function promiseDriftSeries(chapters, terms, { window = 10 } = {}) {
    const rows = (Array.isArray(chapters) ? chapters : [])
        .filter((c) => c && Number.isInteger(c.no) && typeof c.content === 'string')
        .sort((a, b) => a.no - b.no); // 批窗切分按章号升序（调用方的 history 可能是倒序）
    const win = Math.max(1, Number.isInteger(window) ? window : 10);
    const checked = rows.map((c) => checkPromiseTerms(c.content, terms));
    // 每章覆盖数 = 该章「命中≥minHits」的条款数；覆盖率 = 覆盖条款/总条款（无条款批记 1.0 不掺噪声）
    const perCh = checked.map((terms_, i) => {
        const total = terms_.length;
        if (total === 0) return { no: rows[i].no, covered: 1, total: 1, rate: 1 };
        const covered = terms_.filter((t) => !t.below).length;
        return { no: rows[i].no, covered, total, rate: covered / total };
    });
    const series = [];
    for (let i = 0; i < perCh.length; i += win) {
        const chunk = perCh.slice(i, i + win);
        const from = chunk[0].no;
        const to = chunk[chunk.length - 1].no;
        // 批内 rate = 各章 rate 均值（条款数按批内最大 total 归一，缺条款的章按 1.0 计不拉低）
        const rate = chunk.reduce((s, c) => s + c.rate, 0) / chunk.length;
        series.push({ from, to, rate: Math.round(rate * 1000) / 1000 });
    }
    if (series.length === 0) return { series, baseline: 1, floor: 1, drifted: false, drop: 0 };
    const half = Math.floor(series.length / 2);
    const early = series.slice(0, Math.max(1, half));
    const baseline = early.reduce((s, b) => s + b.rate, 0) / early.length;
    const floor = series[series.length - 1].rate;
    const drop = Math.round((baseline - floor) * 1000) / 1000;
    const drifted = baseline >= 0.6 && floor < 0.5 && drop >= 0.4;
    return { series, baseline: Math.round(baseline * 1000) / 1000, floor, drifted, drop };
}

/**
 * 简报追加段渲染（P2「承诺条款状态」位）：无条款返回 ''（整段省略，旧书零回归）；
 * 有则列各条款当前脱靶/达标，封顶 12 条。不吃 pack 预算（同样稿/写法规则段先例）。
 */
export function renderPromiseTermSection(terms, chapters, { maxTerms = 12 } = {}) {
    const valid = (Array.isArray(terms) ? terms : []).filter((t) => t && t.name).slice(0, maxTerms);
    if (valid.length === 0) return '';
    const latest = chapters.length > 0 ? chapters[chapters.length - 1] : null;
    const lines = [];
    if (latest !== null) {
        const chk = checkPromiseTerms(latest.content, valid);
        lines.push(`最近一章（第${latest.no}章）承诺条款：`);
        for (const c of chk) {
            lines.push(`  ${c.below ? '⚠ 脱靶' : '✓'} ${c.name}（命中 ${c.hits} / 需 ≥${c.minHits}）`);
        }
    }
    lines.push('——题材承诺的可机判位：脱靶只报信号不判死刑（词频≠题材），裁决留给人；连续多章脱靶会落批次漂移债。');
    return lines.join('\n');
}

/**
 * P2/P3 债判定（纯函数，单一实现——写章链 ⑩.5 批界记账走它，不内联第二份）：
 *  给本章正文 + 前章（升序）+ 条款，判本章该落哪些题材承诺债。
 *   · P2 minor（promise-term-below）：近 3 章（含本章）≥2 章任一条款词频脱靶。
 *     单章脱靶只走内容门禁第⑩维 warning（「报信号不判死刑」），信号攒够才成债；
 *     前章正文缺失（缺章/越书路径被跳）= 该章不参与计数，不假装它达标。
 *   · P3 major（promise-drift）：仅每 10 章批界跑——批次漂移「起步强、收尾塌」
 *     （promiseDriftSeries.drifted），温水式换轨的机器信号（长篇连载在第 2-3 批就该亮灯）。
 * @returns {Array<{code, message}>}（0–2 条；无条款/未触发 = 空数组）
 */
export function promiseDebtItems({ content = '', chapter = 0, history = [], terms = [] } = {}) {
    const valid = (Array.isArray(terms) ? terms : []).filter((t) => t && t.name);
    if (valid.length === 0 || !Number.isInteger(chapter) || chapter < 1) return [];
    const prevRows = (Array.isArray(history) ? history : [])
        .filter((h) => h && Number.isInteger(h.no) && h.no < chapter && typeof h.content === 'string')
        .sort((a, b) => a.no - b.no);
    // P2：近 3 章（含本章）脱靶计数（前 2 章 = 最近两章，升序取尾）
    const belowNow = checkPromiseTerms(content, valid).some((c) => c.below);
    const recentPrev = prevRows.slice(-2);
    const belowPrev = recentPrev.filter((row) => checkPromiseTerms(row.content, valid).some((c) => c.below)).length;
    const belowWindow = (belowNow ? 1 : 0) + belowPrev;
    const items = [];
    if (belowWindow >= 2) {
        items.push({
            code: 'promise-term-below',
            message: `题材承诺条款连续脱靶（近 3 章 ${belowWindow} 章有词频未达标）——题材在悄悄换轨：回头核对承诺书条款，或改条款口径（novel_project promise 重写「## 可核验条款」段）`,
        });
    }
    // P3：仅 10 章批界（批界外不重复报——同批的漂移 10 章内只落一条债）
    if (chapter % 10 === 0) {
        const pd = promiseDriftSeries([...prevRows, { no: chapter, content }], valid);
        if (pd.drifted) {
            items.push({
                code: 'promise-drift',
                message: `题材承诺批次漂移：覆盖率时间线前批均值 ${Math.round(pd.baseline * 100)}% → 末批 ${Math.round(pd.floor * 100)}%（起步强、收尾塌）——温水式换轨信号。回头核对：承诺书条款 / 全书大纲 / 本书题材是否还在同一本书里（novel_project check fullscan 看批次时间线）`,
            });
        }
    }
    return items;
}
