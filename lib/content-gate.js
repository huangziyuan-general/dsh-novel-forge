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
/* 0.19.1 收窄（真机《第七夜班》ch37/ch39 两次复发）：裸「待补/待写/待填」会命中
 * 行文正常词组（剧情小字「环环待补」=「每一环都当补上」的叙事，不是草稿标记）——
 * 工具黑名单篡改剧情语义。中文标记词改为只认**标记形态**：
 *   · 括号包裹：（待补）/【待写】/（待填）；
 *   · 句读定位：「待补：」紧跟在句首/句号/分号/换行之后（「环环待补」的前字是
 *     汉字，不命中）。
 * 英文 TODO/FIXME/TBD/XXX/??? 无汉字边界问题，保留裸匹配。 */
const PLACEHOLDER_RE = /(TODO|FIXME|\bTBD\b|XXX|\?\?\?|此处省略|此处略|留白待|(?:[（【\[]\s*待(?:补|写|填|插入)\s*[）】\]])|(?:^|[。！？!?；;（【\[\n])\s*待(?:补|写|填|插入)\s*[:：])/;
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
        // 1.0.1（真机终章假阳性）：终结性回看段豁免——整章回看宿簿/账册时逐页列举
        // 已完结账目（「某某，一笔账，讫」），死者名字出现 ≠ 复活。判定：该死者在
        // 本章**每一次**出现都落在含结词指纹（讫/一笔勾销/账已平）的句子里，降级为
        // warning 请人工确认；任一次出现不带结词则维持阻断（真复活仍拦）。
        const sentenceAt = (t, idx) => {
            const before = t.slice(0, idx);
            const start = Math.max(before.lastIndexOf('\n'), before.lastIndexOf('。'), before.lastIndexOf('！'), before.lastIndexOf('？'), before.lastIndexOf('”')) + 1;
            let end = idx;
            while (end < t.length && !/[。！？\n]/.test(t[end])) end++;
            if (end < t.length && /[。！？]/.test(t[end])) end++;
            return t.slice(start, end);
        };
        const idxs = [];
        for (let i = text.indexOf(h.name); i !== -1; i = text.indexOf(h.name, i + h.name.length)) idxs.push(i);
        const allSettled = idxs.length > 0 && idxs.every((ix) => /讫|一笔勾销|账已平/.test(sentenceAt(text, ix)));
        if (allSettled) {
            warnings.push({
                code: 'dead-character-mention',
                message: `「${h.name}」（第${h.deadAt}章${h.value}）在本章仅出现于结账回看句（含「讫」等结词）——判定为回顾性提及非复活，请人工确认`,
            });
        } else {
            blocking.push({
                code: 'dead-character-present',
                message: `「${h.name}」已在第${h.deadAt}章${h.value}，本章正文却出现——死亡人物复活。确为闪回/回忆请在细纲或正文开头写明「回忆」标记后 force 放行`,
            });
        }
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

    // ⑤ 开钩未登记（0.19.0）：《某连载本》105 章审校实证——伏笔.json 止于第 33 章，
    // 此后约 15 个大钩子零登记，写前简报的「未回收伏笔」注入从此失效，模型写新章根本
    // 看不见自己埋的钩子，偏离自我加速。检测：章末检出语义钩子（hookKind 非空）但伏笔
    // 台账没有本章 setup 条目 → 非阻断警告（收束/呼应旧线的章末钩不算新钩，由作者判断），
    // 但每章都可见——「登记」这件事从自愿调用变成每次开钩都被点名。
    const hookUnregistered = hookKind !== null
        && !(foreshadows ?? []).some((f) => f && Number.isInteger(f.chapter) && f.chapter === chapter);
    if (hookUnregistered) {
        debtCheck.newHookUnregistered = true;
        warnings.push({
            code: 'open-hook-unregistered',
            message: `本章章末检出钩子（${hookKind}）但伏笔台账没有本章登记——若这是新钩（新人物/新谜团/新悬念），立即 novel_ledger foreshadow_setup 登记（带 plan 预计回收章）：未登记的钩子写前简报看不见，后文必忘。收束/呼应旧线的章末钩可忽略本条。`,
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
    // 判定单位是【连续叙述段的声音】，不是全章代词计数。两层真机教训（真机导入书监控）：
    // ① 引语里的「他/她/我」是角色在说话——先剥对话跨度（「…」/"…"，同行有闭引号才剥）；
    // ② 叙述句首的「他」也常是第一人称笔法：「。他把钥匙放到桌上」是叙述者转述他人动作，
    //    甚至可以有整段无「我」的场景交代段——按段/按章数他/她都必然误报。
    // 真信号是【意外切换】：第三人称叙述要成串才有意义——「连续 ≥3 段句首他/她且段内无我」
    // 与第一人称叙述并存才算混用；孤立的转述段/交代段（被「我」段隔开）是正常笔法。
    const narrationParas = String(text).split(/\n\s*\n/)
        .map((p) => p.split('\n').map((l) => l.replace(/[「"][^」"]*[」"]/g, '')).join('\n').trim())
        .filter((p) => p !== '');
    const firstCount = (narrationParas.join('\n').match(new RegExp(FIRST_PERSON.source, 'g')) ?? []).length;
    let thirdCount = 0;
    let thirdRun = 0;
    let maxThirdRun = 0;
    for (const p of narrationParas) {
        if (THIRD_PERSON.test(p) && !p.includes('我')) {
            thirdCount += 1;
            thirdRun += 1;
            if (thirdRun > maxThirdRun) maxThirdRun = thirdRun;
        } else {
            thirdRun = 0;
        }
    }
    let personCheck = { firstCount, thirdCount, thirdRun: maxThirdRun, mixed: false };
    if (firstCount >= 5 && maxThirdRun >= 3) {
        personCheck.mixed = true;
        warnings.push({
            code: 'person-mixed',
            message: `章内出现连续 ${maxThirdRun} 段第三人称叙述（段内无叙述者「我」），与第一人称叙述（${firstCount} 处）并存——若视角应当统一请改稿；多视角切换请确认是有意为之`,
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
