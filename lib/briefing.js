// lib/briefing.js — 写前上下文包的组装（供给侧）。
//
// 从 novel_briefing 工具里抽出来，因为现在有**第二个消费者**：D2 并发批量起草。
// 批量起草的每一章都要一份上下文包，若各写一份，场景契约裁剪（B3）、语言基因卡（E3）、
// 悬念洗白这些保护就会在批量路径上悄悄失效 —— 那正是并发最危险的地方。
//
// 一句话：**上下文包的组装只有一个实现**。

import { pathsFor, chapterRelPath } from './store.js';
import { buildContextPack, matchWorldEntries, renderPack } from './contextpack.js';
import { factsDigest, foreshadowDigest, overdueForeshadows } from './ledger.js';
import { termsDigest } from './glossary.js';
import { extractAnchors, styleFingerprintLine } from './style.js';
import { contractFor, resolveSceneCast, renderContractSection, contractDigest, scrubHiddenNames } from './scene-contract.js';
import { normalizeVoice, renderVoiceCard } from './voice.js';
import { detectHookKind } from './hook.js';
import { chapterCharTarget, paragraphSpecRange, CHAR_MARGIN, PARAGRAPH_SPEC_MAX } from './audit.js';
import { firstDraftByChapter } from './health.js';
import { sceneCharBudget } from './gate-metrics.js';
import { computeBasis } from './basis.js';
// 索引新鲜度只读收口（create:false，简报绝不凭空造索引）
import { readIndexedChapters } from './index-store.js';

/**
 * 组装第 n 章的写前上下文包。
 *
 * @param config.scanTopK / config.contextBudgetChars 生效
 * @param io     fsio
 * @param p      pathsFor(book)（缺省时按 book 现算）
 * @param novel  novel.json
 * @param n      章号
 * @param castNames 显式指定出场人物；缺省用工程 cast 前 8
 * @param audience 'session'（默认：会话里模型自己写章，带会话纪律段）|
 *                 'batch'（D2 旁路引擎单发起草：没有工具可调、不向用户汇报，不注入会话纪律段）
 * @returns {chapter, sections, totalChars, dropped, rendered, warnings, contract, hiddenCount, droppedCast, voiceCount, contractDigest, basis}
 */
export async function buildBriefing({ config, io, book, novel, n, castNames = null, audience = 'session', p = pathsFor(book) }) {
    if (!Number.isInteger(n) || n < 1) throw new Error('chapter 必须是正整数');
    if (audience !== 'session' && audience !== 'batch') throw new Error(`audience 只能是 'session' 或 'batch'（收到 ${String(audience)}）`);
    const warnings = [];

    const chapterOutline = (await io.readText(p.chapterOutline(n))) ?? '';
    if (chapterOutline === '') warnings.push(`第${n}章细纲不存在——写章会被门禁拦下，先 novel_outline save_chapter`);
    const bookOutline = (await io.readText(p.bookOutline)) ?? '';
    if (bookOutline === '') warnings.push('全书大纲不存在（novel_outline save_book）');

    // 场景契约（B3）：有契约时只注入出场人物、按白名单挑世界书条目。
    const contracts = (await io.readJson(p.sceneContracts)) ?? {};
    const contract = contractFor(contracts, n);
    const requestedCast = castNames !== null ? castNames : (novel.cast ?? []).slice(0, 8);
    const sceneCast = resolveSceneCast({ contract, cast: requestedCast });
    const names = sceneCast.inject;
    if (sceneCast.contradictions.length > 0) {
        warnings.push(`场景契约里「${sceneCast.contradictions.join('、')}」同时是出场与隐藏——按隐藏优先处理，本章不注入`);
    }
    if (contract !== null && sceneCast.dropped.length > 0) {
        warnings.push(`场景契约生效：只注入 ${names.length} 人的卡（未注入：${sceneCast.dropped.join('、')}）——需要谁出场就 novel_scene save 更新契约`);
    }
    if (names.length === 0) warnings.push('未指定出场人物且工程 cast 为空——人物卡不会被注入');
    const castCards = [];
    for (const name of names) {
        const card = await io.readText(p.character(name));
        if (card === null) warnings.push(`人物卡缺失：${name}（novel_character save）——该人物将以无卡状态写章`);
        else castCards.push({ name, card });
    }

    // 语言基因卡（E3）：防「千人一腔」的供给侧——有卡就结构化注入，没建的不强求。
    const voicesRaw = (await io.readJson(p.voices)) ?? {};
    const voiceCards = [];
    for (const name of names) {
        const card = renderVoiceCard(name, normalizeVoice(voicesRaw[name]));
        if (card !== '') voiceCards.push({ name, card });
    }
    if (voiceCards.length === 0 && names.length >= 2) {
        warnings.push(`本章 ${names.length} 人同台，但没有语言基因卡——多角色对话容易「千人一腔」（novel_character voice 建卡）`);
    }

    const entries = (await io.readJson(p.worldbook)) ?? [];
    let worldEntries;
    if (contract !== null && contract.settings.length > 0) {
        // 契约白名单：只注入点名的条目（省预算、防无关设定干扰）
        const missing = contract.settings.filter((id) => !entries.some((e) => e.id === id));
        if (missing.length > 0) warnings.push(`契约世界书白名单里的 ${missing.join('、')} 不存在（novel_worldbook list 查 id）`);
        worldEntries = entries.filter((e) => contract.settings.includes(e.id));
    } else {
        worldEntries = matchWorldEntries(entries, [chapterOutline, names.join('、'), novel.logline ?? '']);
    }
    const facts = (await io.readJson(p.facts)) ?? [];
    const glossaries = (await io.readJson(p.glossary)) ?? [];
    const foreshadows = (await io.readJson(p.foreshadows)) ?? [];

    const prev = novel.chapters?.[String(n - 1)];
    let prevTail = '';
    if (prev?.path !== undefined) {
        const prevText = await io.readText(prev.path);
        if (prevText !== null) prevTail = prevText.trimEnd().slice(-600);
    } else if (n > 1) {
        warnings.push(`第${n - 1}章尚未写——没有上一章结尾可衔接`);
    }

    // 锚包：从最近已写的 3 章里挑味道样本（对话段/叙述段各一），有基线再附指纹行。
    let anchors = [];
    let fingerprint = '';
    if (n > 1) {
        const recentTexts = [];
        for (let k = n - 1; k >= Math.max(1, n - 3) && recentTexts.length < 3; k -= 1) {
            // 路径收口（跟进项①）：锚段样本只从书内文件取，越书路径按缺章跳过。
            const rel = chapterRelPath(novel.chapters?.[String(k)], book);
            if (rel === null) continue;
            const t = await io.readText(rel);
            if (t !== null) recentTexts.push(t);
        }
        anchors = extractAnchors(recentTexts);
        const baselineRaw = await io.readJson(p.styleBaseline);
        if (baselineRaw?.baseline !== undefined) fingerprint = styleFingerprintLine(baselineRaw.baseline);
    }

    const summaries = Object.entries(novel.chapters ?? {})
        .filter(([k]) => Number(k) < n)
        .sort(([a], [b]) => Number(a) - Number(b))
        .map(([k, c]) => `第${k}章《${c.title}》：${c.summary ?? ''}`);

    const overdue = overdueForeshadows(foreshadows, n);
    if (overdue.length > 0) {
        warnings.push(`伏笔超期未回收：${overdue.map((f) => `${f.id}（预计第${f.plan}章收，第${f.chapter}章埋）`).join('、')}——考虑本章或近期回收，别让读者忘了`);
    }

    // 0.19.0：上一章「开钩未登记」的跨轮可见——审校报告实证的漂移放大器：模型埋钩不
    // 登记（foreshadow_setup 是自愿调用），写前简报只认伏笔.json，新钩对后续所有章节
    // 不可见（《某连载本》33 章后 15 钩零登记、86 章召的人到 105 章没到场）。
    // 这里对上一章重算：章末检出语义钩 + 台账无该章 setup → 在本章简报里点名。
    if (n > 1 && prevTail !== '') {
        const prevHook = detectHookKind(prevTail);
        if (prevHook !== null
            && !(foreshadows ?? []).some((f) => f && Number.isInteger(f.chapter) && f.chapter === n - 1)) {
            warnings.push(`第${n - 1}章章末是钩子（${prevHook}）但伏笔台账没有该章登记——若是新钩（新人物/新谜团），先 novel_ledger foreshadow_setup（chapter: ${n - 1}，带 plan 预计回收章）再写本章：未登记的钩子后续简报看不见，必忘。收束/呼应旧线的章末钩可忽略。`);
        }
    }

    const promise = (await io.readText(p.promise)) ?? '';

    // ── 检索侧「能不能不整章读」的实况（建议#4 的另一半）────────────────────
    // 落盘后自动续建管住了新章；这条管的是老书 / 索引被删 / 换机器：索引一落后，
    // 「用摘录代替整章 read」就落空，模型只能退回捞正文（真机 in_tok 13 万级的来源）。
    // 如实告警比让它自己猜「大概没建吧」靠谱。只读打开（create:false）——简报绝不凭空造索引。
    if (audience === 'session') {
        try {
            const written = Object.keys(novel.chapters ?? {}).map(Number).filter((k) => Number.isInteger(k) && k >= 1);
            if (written.length > 0) {
                const indexed = await readIndexedChapters(io, p);
                if (!indexed.ok) {
                    warnings.push('检索索引不可用/尚未建立——回溯前文先 novel_search build，别整章 read 正文（会挤爆本回合输出预算）');
                } else {
                    const missing = written.filter((k) => !indexed.chapters.includes(k));
                    if (missing.length > 0) {
                        warnings.push(`检索索引落后 ${missing.length} 章（第 ${missing.slice(0, 5).join('、')}${missing.length > 5 ? '…' : ''} 未入库）——先 novel_search build 再摘录`);
                    }
                }
            }
        } catch { /* 旁证缺失不阻断简报（索引是派生物） */ }
    }

    const pack = buildContextPack({
        chapter: n,
        chapterOutline,
        bookOutline,
        promise,
        sceneContract: renderContractSection(contract),
        castCards,
        voiceCards,
        worldEntries,
        factsDigest: factsDigest(facts, names),
        glossaryDigest: termsDigest(glossaries, 40),
        foreshadowDigest: foreshadowDigest(foreshadows, 8, n),
        prevTail,
        anchors,
        fingerprint,
        summaries,
        budget: config.contextBudgetChars,
    });
    // 派生泄漏兜底：账本摘要/伏笔台账/前文摘要里也可能躺着隐藏人物的痕迹（实测踩过——
    // 契约的 notes 里写「X 的身份本章不揭」就等于把名字送进上下文）。
    const scrubbed = scrubHiddenNames(pack.sections, sceneCast.hidden);
    if (scrubbed.scrubbed > 0) {
        warnings.push(`悬念保护：已屏蔽 ${scrubbed.scrubbed} 行涉及未登场人物的上下文（档案/账本/摘要中的痕迹一并擦除）`);
    }
    // 衔接被预算挤掉时，buildContextPack 生成找回指令（丢弃 ≠ 缺席，更不许凭记忆续写）。
    // 走 warnings 而不是包区块：指令是元信息，不该吃上下文预算。
    for (const note of pack.recoveryNotes ?? []) warnings.push(note);
    const sections = scrubbed.sections;
    // ── 会话纪律段（只对 audience==='session' 注入）────────────────────────
    // 这三段与「本章字数目标」都推在 buildContextPack **之后**：这样它们不会被上下文预算裁掉，
    // 且计入 totalChars（预算统计必须如实，否则面板显示的字数比模型看到的少一截）。
    // 这三段管的是「模型作为会话执笔人怎么发起调用、怎么收尾、怎么报数」。D2 批量起草的读者
    // 是旁路引擎的单次补全（draftSystem 第 1 条硬要求「只输出正文，不要任何解释/前言」）：
    // 它手上没有任何 novel_* 工具可调用，也不向用户汇报。把「每一步直接发起调用」拼进它的
    // 提示词，等于指挥它去调它调不到的工具（诱导假工具调用/自说自话），还每章白烧几百字输入。
    // 上下文包只有一个实现（这条不变），变的只是给谁看。
    if (audience === 'session') {
        // 提案队列实况（防「陈旧复述」）：模型在章末交付里爱复述「X 枚提案待审」，
        // 但那是它历史消息里的旧数字——提案被面板应用后它照样抄（实测：P45/P48/P49
        // 应用两天后，第 50–57 章交付仍写「三枚待审」）。把**当下**的 pending 数
        // 注进简报，模型报数时以这一行为准，抄来的旧数会与简报自相矛盾。
        const proposals = Array.isArray(novel.proposals) ? novel.proposals : [];
        const pending = proposals.filter((x) => x?.status === 'pending');
        sections.push({
            name: '待批提案（唯一真相）',
            content: (pending.length === 0
                ? '当前待批提案：0 条 —— 没有任何提案在等审，不要在交付里声称有「N 枚提案待审」。'
                : `当前待批提案：${pending.length} 条 —— ${pending.map((x) => `${x.id}（第${x.chapter}章）`).join('、')}；由用户在面板点「应用／丢弃」处理。`)
                + '\n本行是提案队列的实时状态。历史章交付里出现过的「X 枚待审」可能已被应用或丢弃——一律以本行为准，不得照抄。',
        });
        // 未覆盖场景（0.20.0，openGates）：历史章 gate.missedScenes 非空 = 细纲声明的
        // 必写场景正文没落实。以前它只是落盘时的 softWarning，模型不接就一直悬着
        // （真机 ch4/ch8 两个真缺口悬了 20+ 章）。进简报后每次写章都被看见——
        // 要么在下一章顺手补上，要么明确告诉用户「走 novel_propose 补写」，不许再装没看见。
        const openGates = Object.entries(novel.chapters ?? {})
            .map(([k, rec]) => ({ n: Number(k), missed: rec?.gate?.missedScenes ?? [] }))
            .filter((x) => Number.isInteger(x.n) && x.missed.length > 0)
            .slice(0, 8);
        if (openGates.length > 0) {
            sections.push({
                name: '未覆盖场景（历史章欠账）',
                content: `以下章节的细纲必写场景在正文中未落实（gate 漏写）：${openGates.map((x) => `第${x.n}章〔${x.missed.join('、')}〕`).join('；')}。`
                    + '处理规则：与本章剧情相关且能自然带入的，在本章写透（这是最优先的补法）；'
                    + '带不进去的，不要硬塞进本章——交付时明确建议用户走 novel_propose 单独补写。不要沉默跳过。',
            });
        }
        // 书根草稿残留（1.0.2 实证）：模型爱先用宿主 write 在书根写 `.draft-chN.md`
        // 再「搬」进 novel_write_chapter——那一步绕过了门禁、版本记录与账本联动，
        // 搬完还常常不删，书根越堆越乱（新书第 1 章的 .draft-ch1.md 至今还在）。
        // 每次简报扫一次，让「还有残留」这件事持续对模型可见，直到它不再这么干。
        // 只扫书根、只看 .draft 前缀，且目录列举失败一律当没有（旁证缺失不阻断简报）。
        // try/catch + ?? 覆盖三种形态：① io 没有 listNames（可选链把整条 `?.(book).catch`
        // 一起短路成 undefined，`await undefined` 安全，?? 兜成 []）；② listNames 是 async
        // 但列举 reject（沙箱/权限）；③ listNames 存在却**同步抛**（非 async 实现——
        // `.catch` 挂在同步异常上不生效）。原写法 `?.(book).catch(...)` 漏了第③种，
        // 且依赖「可选链短路 .catch」这条反直觉的语言特性；显式 try/catch 两条都兜住。
        let rootEntries = [];
        try {
            rootEntries = (await io.listNames?.(book)) ?? [];
        } catch { /* 列举失败/能力缺失/同步抛：当没有残留，绝不阻断简报 */ }
        const draftFiles = rootEntries.filter((nm) => String(nm).startsWith('.draft'));
        if (draftFiles.length > 0) {
            warnings.push(`书根还有 ${draftFiles.length} 个草稿残留（${draftFiles.slice(0, 2).join('、')}${draftFiles.length > 2 ? '…' : ''}）——`
                + '正文草稿直接用 novel_write_chapter 落盘（自带门禁/版本/账本），不要先用宿主 write 写到书根再搬。');
        }
        // 标点规范（引号硬约束的模型侧）：代码侧（punctuation.js）在所有正文入库口
        // 把直角引号转弯引号，但下笔就写对才不打断语感——每章简报注入一次。
        sections.push({
            name: '标点规范（引号）',
            content: '正文引号一律用国标弯引号——一层“”，二层‘’（嵌套交替），禁用直角引号「」『』'
                + '（GB/T 15834—2011 横排文稿标准；RLHF 养成的直角引号偏好在这里不适用）。'
                + '写章/提案落盘时会自动转换并在 warnings 计数，但那是兜底，不要依赖。',
        });
        // 交付纪律（防「收尾死锁」）：模型的收尾自计划爱写成「present（预期失败→跳过）→ fence 汇报 → STOP」
        // ——present 是宿主工具，自拼路径真机 85/108 次夹带连续 CR 而失败，且生成该参数时会陷入
        // CR 重复退化（单步 32K 输出全是空白，turn 判 max-tokens）。真机孙宇会话连续四轮死在同一处：
        // 每次继续都先「补完收尾链路」→ 烧穿 → 截断。必须在计划成形时刻（写前简报）明说：
        // 收尾=纯文字汇报，present 这一步根本不存在。
        sections.push({
            name: '交付纪律（收尾怎么走）',
            content: '本章写完的收尾 = novel_write_chapter 落盘后直接用纯文字向用户汇报（本章要点 + 下一章建议）。'
                + '正文落盘即送达（面板章节列表立即可见），【禁止调用宿主 present 交付章节】——不需要、也不存在「先 present 再汇报」的链路，'
                + '不要把 present 写进收尾计划，也不要生成「预期失败→跳过」的占位步骤。收尾汇报不需要任何 genui 组件，纯文本即可。',
        });
        // 输出预算纪律（与收尾纪律同族：都是「输出预算被非正文文本吃掉」的病）。
        // 真机 2026-10-10 实测：写章回合开头先输出大段「原因说明」再调工具，前置说明 + 正文
        // 逼近单回合输出上限，中途截断、工具调用发不出去（discussion #3，200 章大书集中爆发——
        // 输入越大预算越小）。同时回合内整章 read 前文会把 in_tok 堆到 13 万级（97 章新会话
        // 第一回合实测），进一步压小输出预算。这条禁令的**前提**是本简报真的给够了前文——
        // 摘要窗口修好之前（0.16.2 及以前只注入第 1–10 章），整章 read 是模型的合理自救。
        sections.push({
            name: '输出预算纪律（回合怎么开）',
            content: '调 novel_write_chapter 的这个回合：【回合开头直接调工具，一个字的前置说明都不写】——'
                + '细纲、approve、场景契约、简报、写章每一步直接发起调用，要解释的话放在落盘成功后的收尾汇报里。'
                + '衔接所需的前文本简报已给够（上一章结尾 + 开篇与最近若干章的摘要）；回合内进一步核对【优先 '
                + 'novel_search query 摘录与 novel_ledger status_at/timeline 时点值，不要整章 read 正文】——'
                + '回合开头读进来的大块文本会挤占本回合后续所有步骤的输出预算。前置说明 + 正文挤爆预算 = 工具调用中途截断、整回合白跑。',
        });
    }
    // 章节字数标准（网文连载常规）：模型天然爱写短，目标必须明说——
    // 机审下限只是拒绝线，这段才是「照着写」的目标。放在预算统计之前，让 totalChars 如实。
    // 段落规格是给模型的可执行换算：它对「3000 字」无感，但对「这一段写 60–150 字」有操作性。
    // 真机病根：一句一段 + 空行，62 段平均 31 字（25 段不足 25 字、11 段不足 12 字），
    // 四个场景只有约 15 个拍 → 结构上限锁死在 1900 字，怎么"加厚"都过不了 2000。
    const charsTarget = chapterCharTarget(config);
    // 逐场景字数预算（0.18.0）：真机 151 章实测「一次写够」只有 79%，失败的全是整章重写
    // 2–3 轮补字数。模型对「本章 3000 字」无感，对「这一场 ≈500 字、约 4 段」有操作性——
    // 预算由细纲声明的场景现算，与本章结构逐条对齐。
    const budget = sceneCharBudget({ outline: chapterOutline, target: charsTarget, minChars: config.minChapterChars });
    // E5 首稿实况锚定（真机 40 章实证：首稿均长 1881±10、稳定低于下限 2000）：模型对
    // 中文字数系统性估短 30–40%，抽象的「目标 N 字」拦不住首稿贴线——把本书自己的
    // 审计实测注进字数目标段：「你这本书的首稿就是写不够」比通用目标有约束力，且数字
    // 随审计自更新。健康书（首稿均长 ≥ 下限+余量）或样本不足静默；读不到审计不阻断。
    let firstDraft = null;
    try {
        const auditText = await io.readText(p.audit);
        if (typeof auditText === 'string' && auditText !== '') {
            const vals = [...firstDraftByChapter(auditText).values()].map((v) => v.chars).filter((x) => Number.isFinite(x));
            if (vals.length >= 3) {
                const avg = Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
                if (avg < config.minChapterChars + CHAR_MARGIN) firstDraft = { avg, count: vals.length };
            }
        }
    } catch { /* 首稿实况是旁证：读不到审计不阻断简报 */ }
    sections.push({
        name: '本章字数目标',
        content: charTargetSection({ config, charsTarget, budget, firstDraft }),
    });
    const totalChars = sections.reduce((acc, sec) => acc + sec.content.length + sec.name.length + 4, 0);

    // 依据指纹（④）：对「本章的写作依据」取内容哈希——细纲 / 场景契约 / 世界书。
    // 写章提交时服务端重算同一组哈希并比对：简报生成后这三样被改过 → 落盘的是
    // 旧依据的产物 → 明确告警（见 lib/basis.js 与 lib/chapter-commit.js）。
    const basis = computeBasis({
        outline: chapterOutline,
        contract,
        worldbook: entries,
        facts,
    });

    return {
        chapter: n,
        sections,
        totalChars,
        dropped: pack.dropped,
        rendered: renderPack({ sections }),
        warnings,
        chapterOutline,
        contract,
        hiddenCount: contract === null ? 0 : contract.hidden.length,
        contractDigest: contract === null ? null : contractDigest(contract),
        droppedCast: sceneCast.dropped,
        voiceCount: voiceCards.length,
        castNames: names,
        basis,
    };
}

/**
 * 「本章字数目标」段（纯函数导出，直测口径说明；buildBriefing 调它）。
 * 1.0.1：补机审字数口径说明——真机监控发现自查与机审两种口径同稿差 45–76 字
 * （自查脚本自己剥标题/估字），「过下限但差目标」的判断随口径漂移。口径写死：
 * 含标题全文、剥 markdown 强调标记后按非空白字符计数（标点计入）。
 */
export function charTargetSection({ config, charsTarget, budget = null, firstDraft = null }) {
    // 段落规格只有一份算式（lib/audit.js）：简报与机审驳回文案必须报同一个区间，
    // 各处再抄一遍 `round(min/30/10)*10–150` 就是第四张漂移的副本。
    // 「全章约 X–Y 段」的 Y 分母＝spec.max/2（按半段长算段数上限），同样从这里派生——
    // 别把 75 抄成字面量，PARAGRAPH_SPEC_MAX 一改它就是第五张漂移的副本。
    const spec = paragraphSpecRange({ minChapterChars: config.minChapterChars });
    // E5 首稿实况（buildBriefing 从本书审计现算；健康书/样本不足/读不到审计为 null 静默）：
    // 把「模型估字系统性偏短」从体感变成本书数字，配方给到段数与单段量级——与真机
    // 验证过的写作纪律（按段硬铺、写完数段落再提交）同款，只是从 persona 自觉前移到简报。
    const fd = firstDraft === null
        ? ''
        : `\n首稿实况（本书审计 ${firstDraft.count} 章实测，均长 ${firstDraft.avg} 字）：比「下限+余量 ${config.minChapterChars + CHAR_MARGIN} 字」还差 ${config.minChapterChars + CHAR_MARGIN - firstDraft.avg} 字——照这个历史规律，首稿照常写必被机审退稿。动笔就把段数堆够：至少 ${Math.ceil((config.minChapterChars + CHAR_MARGIN) / PARAGRAPH_SPEC_MAX)} 段、每段写到 ${PARAGRAPH_SPEC_MAX} 字量级；写完按机审口径数一遍，≥${config.minChapterChars + CHAR_MARGIN} 字再提交，不要「先交一版再补」。`;
    return `单章 ${config.minChapterChars}–${config.maxChapterChars} 字，目标 ${charsTarget} 字左右（正常网络小说连载单章的篇幅）。不足下限会被机审直接退稿；字数不够就把细纲里的场景写细写透（动作、环境、对话拉满），不要注水凑字；超过上限主动收在章末钩子处。`
        + `【不足目标 85%（约 ${Math.floor(charsTarget * 0.85)} 字）不许收尾】——过下限即停真机反复出现（真机导入书 v1 稿 2150/2268 字对目标 3000，全靠润色提案补齐）：机审下限只是拒绝线，写到目标才算完稿。`
        + `\n机审字数口径（1.0.1）：含标题全文、剥 markdown 强调标记（** 等）后按非空白字符计数（标点计入；省略号「……」与破折号「——」各按 2 字符计）——提交前自查请按同口径数，不要自己剥标题、不要估字。`
        + `\n段落规格（照这个写才写得够）：单段 ${Math.max(1, spec.min)}–${spec.max} 字（约 3–8 句），全章约 ${Math.round(charsTarget / spec.max)}–${Math.round(charsTarget / (spec.max / 2))} 段。`
        + `**不要一句一段**、不要每句后面空行——短句单独成段会让全章字数天然停在 1000 出头；一个场景用 3–5 个自然段展开，段内把动作、环境、对话写具体。`
        + fd
        + ((!budget || budget.length === 0) ? '' : `\n本章逐场景字数预算（按细纲「必写场景」顺序，写到每个场景的建议字数就够）：`
            + `${budget.map((b) => `${b.no}「${b.title}」≈${b.suggested} 字`).join('；')}。`
            + `合计 ≈${budget.reduce((a, b) => a + b.suggested, 0)} 字。哪个场景写薄了，细纲覆盖率指标会算出来。`);
}
