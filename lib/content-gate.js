// lib/content-gate.js — 四维内容门禁（纯函数，零 token）。
//
// 来源：dsh-tool-writing 的 gate 四维（事实矛盾 / 违背承诺书 / 欠账未回应 / 物理硬伤），
// 以及多核协同的「欠账不还禁开新钩」。**适配**为本插件能代码判定的部分：
//
//   ① 事实：死亡实体再现（复用 continuity 的死亡推演）+ 过期状态词（账本旧值仍被使用）
//   ② 承诺：欠账未回应（plan 到期的未回收伏笔在本章零命中）—— 本章还开新钩子则**阻断**
//   ③ 完成度：占位符 / 未完成稿（TODO、待补、此处省略…）—— **阻断**
//   ④ 视角：人称混用（第一人称与第三人称叙述并存，低置信 → 只警告）
//
// 判定权归属：能算的一律代码算（不靠模型自报「我检查过了」）；算不了的（物理硬伤、
// 创意类承诺违背）留给模型+人，本模块不假装能判。

import { detectHookKind } from './hook.js';
import { deathTimeline } from './continuity.js';
import { hiddenLeakCheck } from './scene-contract.js';

/** 未完成稿标记——这些出现在正文里，说明交的是草稿不是成稿。 */
/* 整词匹配；不带括号前缀（（待/【待 之类）——那会误伤「（待续）」这类合法连载标记。 */
/* 「待定/略去」不进阻断表：『后续安排待定』『细节略去不表』是正常叙事措辞（略去不表甚至是传统套语），
 *  拦它们只会制造假阳性熔断。降级为软警告（M4）。 */
const PLACEHOLDER_RE = /(TODO|FIXME|\bTBD\b|待补|待写|待填|待插入|此处省略|此处略|留白待|XXX|\?\?\?)/;
const PLACEHOLDER_SOFT_RE = /(待定|略去)/;
/** 中文虚词——用于过滤关键词候选，避免「的/了」这种噪声命中。 */
const STOP_CHARS = new Set('的了是在和与之有个被把就都也很会能要不这那你我他她它们着过又还没从向对为以于而但其此所述等再更最只么呢吧啊'.split(''));
/** 人称代词。句边界补 ASCII !?——「他!」「她?」也是句首（0.13.6）。 */
const FIRST_PERSON = /(?:^|[。！？…!?\n])\s*我(?!们)/;
const THIRD_PERSON = /(?:^|[。！？…!?\n])\s*(?:他|她)(?!们)/;

/** 从伏笔描述里提取 2-4 字关键词候选（滑窗 + 虚词过滤）。宽松匹配：宁多勿漏。 */
export function setupKeywords(setup, { min = 2, max = 4 } = {}) {
    const t = String(setup ?? '').replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '');
    const out = new Set();
    for (let len = min; len <= max; len += 1) {
        for (let i = 0; i + len <= t.length; i += 1) {
            const seg = t.slice(i, i + len);
            // 丢掉以虚词开头/结尾的片段（「的下」「的来」这类不是有效关键词）
            if (STOP_CHARS.has(seg[0]) || STOP_CHARS.has(seg[seg.length - 1])) continue;
            out.add(seg);
        }
    }
    return [...out];
}

/** 账本的「当前值 / 历史值」推演：截至第 n 章，每个 entity·key 的最新值与曾用值。 */
export function factStatesAt(facts, n) {
    const map = new Map(); // entity·key -> { value, chapter, history:[{value, chapter}] }
    for (const f of facts ?? []) {
        if (!Number.isInteger(f?.chapter) || f.chapter > n) continue;
        const k = `${f.entity}\u0000${f.key}`;
        const cur = map.get(k);
        if (cur === undefined) {
            map.set(k, { entity: f.entity, key: f.key, value: String(f.value), chapter: f.chapter, history: [] });
            continue;
        }
        if (cur.value !== String(f.value)) {
            cur.history.push({ value: cur.value, chapter: cur.chapter });
            cur.value = String(f.value);
            cur.chapter = f.chapter;
        }
    }
    return map;
}

/**
 * 四维内容门禁。
 *
 * @param inputs {
 *   content,                  // 本章正文（必有）
 *   chapter,                  // 章号
 *   facts = [],               // 账本
 *   foreshadows = [],         // 伏笔台账
 *   cast = [],                // 本章出场人物（可选）
 *   actorNames = [],          // 已知实体名（cast + 账本 entity），用于死亡再现扫描
 *   contract = null,          // 场景契约（可为归一后对象或 { hidden:[...] }）——悬念保护
 *   minChapterChars,          // 可选：低于此字数提示（机审已有一道，这里不重复拦）
 * }
 * @returns { ok, blocking:[], warnings:[], checks:{...}, stats }
 *   ok=false 表示存在 blocking 项 —— 调用方（novel_write_chapter）应拒绝落盘，除非 force。
 */
export function contentGate({
    content,
    chapter,
    facts = [],
    foreshadows = [],
    cast = [],
    actorNames = [],
    contract = null,
} = {}) {
    const text = String(content ?? '');
    const blocking = [];
    const warnings = [];

    // ①a 死亡实体再现（事实/连续性里最硬的一条）
    const deaths = deathTimeline(facts);
    const names = [...new Set([...(cast ?? []), ...(actorNames ?? []), ...deaths.keys()])].filter((x) => typeof x === 'string' && x.trim() !== '');
    const deadHits = [];
    for (const name of names) {
        const d = deaths.get(name);
        if (d === undefined) continue;
        if (d.chapter >= chapter) continue; // 本章（或更晚）才死的，本章出现正常
        if (!text.includes(name)) continue;
        deadHits.push({ name, deadAt: d.chapter, value: d.value });
    }
    for (const h of deadHits) {
        blocking.push({
            code: 'dead-character-present',
            message: `「${h.name}」已在第${h.deadAt}章${h.value}，本章正文却出现——死亡人物复活。确为闪回/回忆请在细纲或正文开头写明「回忆」标记后 force 放行`,
        });
    }

    // ①b 过期状态词：账本里已被更新覆盖的旧值仍然出现在正文
    const states = factStatesAt(facts, chapter);
    const staleHits = [];
    for (const s of states.values()) {
        if (s.history.length === 0) continue;
        for (const old of s.history) {
            // 只查有辨识度的值（≥2 字，且与新值不同）——短词/数字误报率高
            if (String(old.value).length < 2 || old.value === s.value) continue;
            if (!text.includes(old.value)) continue;
            staleHits.push({ entity: s.entity, key: s.key, old: old.value, now: s.value, since: s.chapter });
            break;
        }
    }
    for (const h of staleHits) {
        warnings.push({
            code: 'stale-state',
            message: `正文出现「${h.entity}·${h.key}」的旧值「${h.old}」（第${h.since}章起已更新为「${h.now}」）——若不是刻意回忆，属于穿了旧状态`,
        });
    }

    // ② 欠账未回应（C3 检查侧）
    const dueDebts = (foreshadows ?? []).filter((f) => f && f.payoffChapter === null
        && Number.isInteger(f.plan) && f.plan <= chapter && Number.isInteger(f.chapter) && f.chapter < chapter);
    const hookKind = detectHookKind(text);
    const unanswered = [];
    for (const d of dueDebts) {
        const kws = setupKeywords(d.setup);
        if (!kws.some((k) => text.includes(k))) unanswered.push(d);
    }
    let debtCheck = { due: dueDebts.length, unanswered: unanswered.length, newHook: hookKind };
    if (unanswered.length > 0 && hookKind !== null) {
        blocking.push({
            code: 'debt-unanswered-with-new-hook',
            message: `追读铁律：第${unanswered.map((d) => d.id).join('、')}号伏笔已到预计回收章（${unanswered.map((d) => `第${d.plan}章`).join('、')}）却在本章零回应，本章还开了新钩子（${hookKind}）——欠账未还禁开新钩，先还旧账（回应或在 novel_ledger foreshadow_payoff 登记回收）`,
        });
    } else if (unanswered.length > 0) {
        warnings.push({
            code: 'debt-unanswered',
            message: `第${unanswered.map((d) => d.id).join('、')}号伏笔已到期未回收，本章也没提到——建议近期安排回收，别让读者忘了`,
        });
    }

    // ③ 未完成稿占位符
    const ph = text.match(PLACEHOLDER_RE);
    if (ph !== null) {
        blocking.push({
            code: 'placeholder',
            message: `正文含未完成稿标记「${ph[1]}」——草稿不能落盘，补完再交`,
        });
    }
    const phSoft = text.match(PLACEHOLDER_SOFT_RE);
    if (phSoft !== null) {
        warnings.push({
            code: 'placeholder-soft',
            message: `正文出现「${phSoft[1]}」——若为叙事修辞（如「略去不表」）可忽略；若为未完成标记请补完后再交`,
        });
    }

    // ④ 人称混用（低置信，只警告）
    const firstCount = (text.match(new RegExp(FIRST_PERSON.source, 'g')) ?? []).length;
    const thirdCount = (text.match(new RegExp(THIRD_PERSON.source, 'g')) ?? []).length;
    let personCheck = { firstCount, thirdCount, mixed: false };
    if (firstCount >= 5 && thirdCount >= 5) {
        personCheck.mixed = true;
        warnings.push({
            code: 'person-mixed',
            message: `章内第一人称叙述（${firstCount} 处）与第三人称叙述（${thirdCount} 处）并存——若视角应当统一请改稿；多视角切换请确认是有意为之`,
        });
    }

    // ⑤ 悬念保护：契约声明的隐藏人物出现在正文（B3）
    const hiddenNames = Array.isArray(contract?.hidden) ? contract.hidden : [];
    const hiddenLeaks = hiddenNames.length === 0 ? [] : hiddenLeakCheck({ content: text, hidden: hiddenNames });
    for (const name of hiddenLeaks) {
        blocking.push({
            code: 'hidden-character-leaked',
            message: `「${name}」被场景契约声明为本章隐藏人物，正文却出现了其名——揭晓前不该有任何痕迹（这是泄底，读者一旦看到名字后面的反转就废了一半）。`
                + '若本章确实要揭晓，先 novel_scene save 把该人物移出 hidden 再写',
        });
    }

    return {
        ok: blocking.length === 0,
        blocking, warnings,
        checks: { deadHits, staleHits, debtCheck, placeholder: ph === null ? null : ph[1], personCheck, hiddenLeaks },
        stats: { chars: text.replace(/\s/g, '').length, blocking: blocking.length, warnings: warnings.length },
    };
}

/** 一行摘要（供工具 render）。 */
export function contentGateDigest(gate) {
    if (gate.blocking.length === 0 && gate.warnings.length === 0) return '内容门禁：通过 ✓';
    const lines = [
        ...gate.blocking.map((b) => `✗ ${b.message}`),
        ...gate.warnings.map((w) => `⚠ ${w.message}`),
    ];
    return `内容门禁${gate.ok ? '' : '（不通过）'}：\n${lines.join('\n')}`;
}
