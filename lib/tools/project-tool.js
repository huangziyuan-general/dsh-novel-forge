// lib/tools/project-tool.js — novel_project（书目生命周期、阶段状态机、对账修复、一致性校验、承诺书）。
// 从 project-tools.js 按工具拆出；schema 与描述原样保留。

import { defineTool } from './define-tool.js';
import {
    defaultNovel, pathsFor, chapterRelPath, containedBookPath, newBookId,
    PLATFORM_IDS, parsePlatform, platformOf, platformNote,
    parseCharsSpec, charLimitsOf, charLimitsNote, charLimitsView,
} from '../store.js';
import { assertBookName, createFsio, sessionCwd, updateJson } from '../fsio.js';
import { audit, requireBook, saveBook, textBlock } from './common.js';
import { resetStage } from '../gate.js';
import { phaseBoard, enterPhase, renderPhaseBoard, phaseLabel } from '../phases.js';
import { loadPhaseFacts } from '../phase-io.js';
import { breakerDigest } from '../circuit-breaker.js';
import { validateContinuity } from '../continuity.js';
import { loadContinuityInputs } from '../continuity-io.js';
import { hasControlChars, stripControlChars, numericNullFields, ghostProposals } from '../health.js';
// 派生检索索引（书/.novel/index.db）的对账修复：索引落盘 io 收口在 index-store.js
import { pruneGhostIndex } from '../index-store.js';

/** 阶段看板行 → 输出 schema 形状（去掉 report 对象，展平成计数）。 */
function boardRow(b) {
    return {
        phase: b.phase, label: b.label, order: b.order, status: b.status,
        current: b.current, entryOk: b.entryOk, missing: b.missing,
        ...(b.report === null || b.report === undefined
            ? {}
            : { errorCount: b.report.errorCount, warningCount: b.report.warningCount }),
    };
}

export function defineProjectTool(ctx, config) {
    return defineTool({
        name: 'novel_project',
        description: '小说工程管理：init 创建一本书的本地工程（novel.json；正文/大纲/人物/设定/账本五个目录**随首次写入自动创建**，init 不建空目录——宿主 fs 没有 mkdir 公开能力），status 查看阶段/章节/账本/伏笔概况，repair 把 novel.json 索引与磁盘对账（清理失效文件引用、撤销无细纲批准、清掉检索索引里已删章的残留块），check 跑全书一致性校验（死人复活/伏笔倒挂/索引缺失，纯本地零 token），promise 读/写故事承诺书（本书对读者的承诺，每次写章自动注入上下文）。书 = 工作区内的一个目录。',
        parameters: {
            action: { type: 'string', required: true, enum: ['init', 'status', 'phase', 'set_stage', 'repair', 'check', 'promise', 'platform', 'chars'], description: 'init 创建新书；status 查看概况；phase 九阶段状态机（不给 stage 返回看板，给了则**带入场条件**地进入）；set_stage 无校验硬设阶段（纠正通道）；repair 索引-磁盘对账修复；check 全书一致性校验；promise 读/写故事承诺书；platform 读/写本书投放平台（决定默认字数口径与 novel_audit 的默认平台审稿）；chars 读/写**本书每章字数区间**（用户给的字数设置，优先级高于平台口径）。' },
            platform: { type: 'string', description: 'init / platform：本书投放平台，qidian（起点）/ fanqie（番茄）/ jjwxc（晋江）/ qimao（七猫）/ feilu（飞卢）；platform 不传＝读当前值，传空串＝清除（回到本插件默认字数口径）。缺省不设平台＝行为与旧版完全一致。' },
            chars: { type: 'string', description: 'init / chars：**用户给这本书定的每章字数区间**，写成「下限-上限」（如 "2500-3500"，也接受 ~ / – / 、/ 空格 分隔）。不传＝读当前值；传空串＝清除自定义（回落到平台口径或插件配置）。设了它，写章门禁/简报/细纲/提案/润色/审计全按这个区间判。' },
            force: { type: 'boolean', description: 'phase：入场条件未满足时强行进入（记审计）。' },
            book: { type: 'string', required: true, description: '书目名（工作区内的目录名，如「星海拾骨」）。' },
            title: { type: 'string', description: 'init：书名（默认与 book 相同）。' },
            genre: { type: 'string', description: 'init：题材，如 玄幻/悬疑/都市。' },
            logline: { type: 'string', description: 'init：一句话故事（立意层，之后每次写章都会随上下文包出现）。' },
            stage: { type: 'string', description: 'phase/set_stage：目标阶段。九阶段 topic/setting/character/outline/volume/chapter/writing/revision/done；兼容旧名 planning/outline/drafting/revising/done。phase 不给则返回看板。' },
            promise: { type: 'string', description: 'promise：故事承诺书 Markdown 正文（写就存、省略则读）。写清「本书向读者承诺什么」——爽点类型、感情线走向、绝不做的事。' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    book: { type: 'string', required: true },
                    action: { type: 'string', required: true },
                    title: { type: 'string' },
                    genre: { type: 'string' },
                    stage: { type: 'string' },
                    next: { type: 'string' },
                    forced: { type: 'boolean' },
                    phases: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
                        phase: { type: 'string', required: true }, label: { type: 'string', required: true },
                        order: { type: 'integer', required: true }, status: { type: 'string', required: true },
                        current: { type: 'boolean', required: true }, entryOk: { type: 'boolean', required: true },
                        missing: { type: 'array', items: { type: 'string' }, required: true },
                        errorCount: { type: 'integer' }, warningCount: { type: 'integer' },
                    } } },
                    breaker: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
                        chapter: { type: 'integer', required: true }, count: { type: 'integer', required: true },
                    } } },
                    chapters: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
                        chapter: { type: 'integer', required: true }, title: { type: 'string', required: true },
                        latest: { type: 'integer', required: true }, chars: { type: 'integer', required: true },
                        summary: { type: 'string' },
                    } } },
                    openForeshadows: { type: 'integer' },
                    factCount: { type: 'integer' },
                    approvedChapters: { type: 'integer' },
                    approvedVia: { type: 'object', additionalProperties: false, properties: {
                        tool: { type: 'integer', required: true }, panel: { type: 'integer', required: true },
                    } },
                    missing: { type: 'array', items: { type: 'string' } },
                    orphanFiles: { type: 'array', items: { type: 'string' } },
                    droppedApprovals: { type: 'integer' },
                    // repair 体检（方向2/3）：路径卫生 / 幽灵提案 / 数值 null 残留 / 派生索引陈旧
                    pathIssues: { type: 'array', items: { type: 'string' } },
                    missingProposals: { type: 'array', items: { type: 'string' } },
                    orphanProposals: { type: 'array', items: { type: 'string' } },
                    stateIssues: { type: 'array', items: { type: 'string' } },
                    indexGhostChapters: { type: 'array', items: { type: 'integer' } },
                    indexRemoved: { type: 'integer' },
                    indexNote: { type: 'string' },
                    promise: { type: 'string' },
                    hasPromise: { type: 'boolean' },
                    // 平台落库（T1）：不设置时省略该字段（而不是给 null），schema 只声明 string。
                    platform: { type: 'string' },
                    // 字数口径（自定义 > 平台 > 插件默认）：charLimits 只在设了自定义时出现；
                    // charMin/charMax/charSource 三件套恒在——回执必须说清「按哪个数、为什么」。
                    charLimits: { type: 'string' },
                    charMin: { type: 'integer' },
                    charMax: { type: 'integer' },
                    charSource: { type: 'string' },
                    charNote: { type: 'string' },
                    continuity: { type: 'object', additionalProperties: false, properties: {
                        ok: { type: 'boolean', required: true },
                        errors: { type: 'integer', required: true },
                        warnings: { type: 'integer', required: true },
                        issues: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
                            severity: { type: 'string', required: true },
                            code: { type: 'string', required: true },
                            where: { type: 'string', required: true },
                            message: { type: 'string', required: true },
                        } } },
                    } },
                },
            },
        },
        isConcurrencySafe: () => false,
        async execute(args, exec) {
            const book = assertBookName(args.book);
            const io = createFsio(ctx, exec, sessionCwd(exec));
            const p = pathsFor(book);

            if (args.action === 'init') {
                const existing = await io.readJson(p.meta);
                if (existing !== null) throw new Error(`书目已存在：「${book}」。换一个书名，或直接 status 查看。`);
                // 平台在 init 时若给了就一并落库；不设＝与旧版完全一致（字数口径按插件配置）。
                const initPlatform = args.platform === undefined ? '' : parsePlatform(args.platform);
                if (initPlatform === null) {
                    throw new Error(`不认识的平台：「${args.platform}」。可选 ${PLATFORM_IDS.join(' / ')}。`);
                }
                // 用户给的每章字数区间（开书时收集，落库成事实）：给了就在**第一次写盘**里带上，
                // 免得出现「书已建好、区间还没落地」的窗口（那期间写的章按默认口径放行）。
                const initChars = parseCharsSpec(args.chars);
                if (!initChars.ok) throw new Error(`每章字数区间不合法：${initChars.error}`);
                const novel = defaultNovel({
                    title: args.title ?? book,
                    genre: args.genre ?? '未分类',
                    logline: args.logline ?? '',
                    session: io.sessionId,
                    platform: initPlatform,
                    charLimits: initChars.limits ?? null,
                });
                await io.writeJson(p.meta, novel, 'create');
                await audit(io, p, 'init', {
                    book, title: novel.title, genre: novel.genre,
                    platform: initPlatform, charLimits: charLimitsOf(novel),
                });
                return {
                    book, action: 'init', title: novel.title, genre: novel.genre,
                    ...(initPlatform === '' ? {} : { platform: initPlatform }),
                    ...charLimitsView(config, novel),
                    next: '依次：novel_outline save_book 存全书大纲 → novel_character save 建人物卡 → novel_worldbook add 固化设定 → novel_outline save_chapter+approve 批准细纲 → novel_write_chapter 写章',
                    charNote: charLimitsNote(config, novel),
                };
            }

            // status
            if (args.action === 'status') {
                const { novel } = await requireBook(io, book);
                const facts = (await io.readJson(p.facts)) ?? [];
                const foreshadows = (await io.readJson(p.foreshadows)) ?? [];
                const chapters = Object.entries(novel.chapters ?? {})
                    .map(([k, c]) => ({ chapter: Number(k), title: c.title, latest: c.latest, chars: c.chars, summary: c.summary ?? '' }))
                    .sort((a, b) => a.chapter - b.chapter);
                // 0.19.0：批准通道归属——自批占比是看板可见性数字（《开局觉醒加特林》
                // 168/168 工具自批是大纲漂移的第一缺口，先让 status 能看见它）。
                const via = novel.approvals?.outlineVia && typeof novel.approvals.outlineVia === 'object'
                    ? novel.approvals.outlineVia : {};
                const approvedNums = Object.keys(novel.approvals?.outline ?? {})
                    .map(Number).filter(Number.isInteger);
                const panelApproved = approvedNums.filter((n) => via[String(n)] === 'panel').length;
                return {
                    book, action: 'status', title: novel.title, genre: novel.genre, stage: novel.stage,
                    chapters, openForeshadows: foreshadows.filter((f) => f.payoffChapter === null).length,
                    factCount: facts.length,
                    approvedChapters: approvedNums.length,
                    approvedVia: { tool: approvedNums.length - panelApproved, panel: panelApproved },
                    // 概况里顺带回显生效字数口径（含出处）——status 是用户/模型查这本书
                    // 设置的第一站，设置藏在看不到的地方等于没设。
                    platform: platformOf(novel),
                    ...charLimitsView(config, novel),
                };
            }

            // phase —— 九阶段状态机（F1）：不给 stage 看板；给了则带入场条件地进入。
            // 「设定没定就想写大纲」「大纲没过就想写正文」在这里被拦住。
            if (args.action === 'phase') {
                const { novel } = await requireBook(io, book);
                const facts = await loadPhaseFacts(io, p, novel);
                const bd = breakerDigest(novel);
                if (args.stage === undefined || String(args.stage).trim() === '') {
                    return {
                        book, action: 'phase', stage: novel.stage,
                        phases: phaseBoard(novel, facts).map(boardRow), breaker: bd.rows,
                    };
                }
                // 同 platform/chars：推进阶段是「改一个字段」，走 updateJson 冲突重放，
                // 不在旧快照上整份回写（窗口期别人的章节索引/会话归属会被抹掉）。
                let res = null;
                let board = null;
                await updateJson(io, p.meta, (latest) => {
                    if (!latest || typeof latest !== 'object') return undefined;
                    const r = enterPhase(latest, args.stage, { force: args.force === true, facts, actor: 'agent' });
                    if (!r.ok) {
                        // 非版本类错误照旧冒出去（updateJson 不吞），语义与旧实现一致
                        throw new Error(r.reason + '\n（确要强行推进用 force:true，将记入审计）');
                    }
                    res = r;
                    latest.updatedAt = new Date().toISOString();
                    board = phaseBoard(latest, facts).map(boardRow);
                    return { value: latest };
                });
                if (res === null) throw new Error(`阶段推进未落盘：书目不存在或无变化（${book}）`);
                await audit(io, p, res.forced ? 'phase/forced' : 'phase/enter', { phase: res.phase, missing: res.missing });
                return {
                    // stage 回显**归一后的阶段 id**（res.phase），不是入参 args.stage：
                    // 入参可能是旧别名（planning→topic、drafting→writing…），照原样回显会让
                    // 模型以为落库的是 planning、实际盘上写的是 topic——两处对不上。
                    book, action: 'phase', stage: res.phase, forced: res.forced,
                    phases: board ?? [], breaker: bd.rows,
                };
            }

            // platform —— 本书投放平台（落库事实）：写章字数门禁与 novel_audit 的默认口径都从它派生。
            // 不给 platform 就只读；给空串清除；给了新值就写。允许对**已有书**补设（真机有书就是
            // 没平台建起来的，于是写作门禁按起点口径放行、平台审稿按番茄口径判死，两边打架）。
            if (args.action === 'platform') {
                const { novel } = await requireBook(io, book);
                const current = platformOf(novel);
                if (args.platform === undefined) {
                    return {
                        book, action: 'platform',
                        ...(current === '' ? {} : { platform: current }),
                        ...charLimitsView(config, novel),
                        next: platformNote(current),
                    };
                }
                const want = String(args.platform).trim() === '' ? null : parsePlatform(args.platform);
                if (String(args.platform).trim() !== '' && want === null) {
                    throw new Error(`不认识的平台：「${args.platform}」。可选 ${PLATFORM_IDS.join(' / ')}，或传空串清除。`);
                }
                // 读-改-写走 updateJson 冲突重放：设平台是「改一个字段」，不该顺手抹掉
                // 窗口期内别人写进去的章节索引/会话归属/熔断计数。旧实现读一次再整份回写
                // （saveBook），版本是写前一刻才 stat 的——REST 面板同期存过章，这里就会
                // 静默覆盖（幽灵提案、计数清零、归属丢失）。与 REST 面 projects.js 同形。
                const { written: platformWritten, result: platformView } = await updateJson(io, p.meta, (latest) => {
                    if (!latest || typeof latest !== 'object') return undefined;
                    if (want === null) delete latest.platform; else latest.platform = want;
                    latest.updatedAt = new Date().toISOString();
                    return {
                        value: latest,
                        // 回显必须在**重读后的最新内容**上算，不能在旧快照上算
                        result: { ...charLimitsView(config, latest), next: platformNote(want === null ? '' : want) },
                    };
                });
                // 未落盘守卫（同 phase/set_stage 的「未落盘」）：mutator 见 latest 缺失返回 undefined
                // → written:false、platformView 为 undefined。旧实现把 undefined 当成功返回，
                // 于是「书目在并发里被删」时回执缺 charMin/charMax 却报 ok——静默半失败。
                if (!platformWritten) throw new Error(`平台设置未落盘：书目不存在或无变化（${book}）`);
                await audit(io, p, 'project/platform', { platform: want });
                return {
                    book, action: 'platform',
                    ...(want === null ? {} : { platform: want }),
                    // 平台一改，生效区间就跟着改——把新数字当场回显（含出处），
                    // 免得调用方以为「设了平台但门禁没变」。
                    ...platformView,
                };
            }

            // chars —— 本书每章字数区间（用户钦定的字数设置，优先级高于平台口径）。
            // 落库在 novel.json.charLimits：它是**事实**，不是每次调用手传的参数——
            // 只有落库，写章门禁/简报/细纲/提案/润色/审计六条链才可能算出同一个区间。
            if (args.action === 'chars') {
                const { novel } = await requireBook(io, book);
                if (args.chars === undefined) {
                    return {
                        book, action: 'chars',
                        ...charLimitsView(config, novel),
                        next: charLimitsNote(config, novel),
                    };
                }
                const parsed = parseCharsSpec(args.chars);
                if (!parsed.ok) throw new Error(`每章字数区间不合法：${parsed.error}`);
                // 同上：字数区间也是「改一个字段」，走 updateJson 冲突重放，不整份回写
                const { written: charsWritten, result: charsView } = await updateJson(io, p.meta, (latest) => {
                    if (!latest || typeof latest !== 'object') return undefined;
                    if (parsed.limits === null) delete latest.charLimits; else latest.charLimits = parsed.limits;
                    latest.updatedAt = new Date().toISOString();
                    return {
                        value: latest,
                        result: { ...charLimitsView(config, latest), next: charLimitsNote(config, latest) },
                    };
                });
                // 未落盘守卫同 platform：并发里书目被删时 mutator 返回 undefined，
                // 不能当成「设置成功」返回缺字段的回执。
                if (!charsWritten) throw new Error(`字数区间未落盘：书目不存在或无变化（${book}）`);
                await audit(io, p, 'project/chars', { charLimits: parsed.limits });
                return {
                    book, action: 'chars',
                    ...charsView,
                };
            }

            // set_stage —— 显式阶段重置/纠正通道（默认 advanceStage 只前进，无撤回口）
            if (args.action === 'set_stage') {
                await requireBook(io, book);
                // 同 phase/platform/chars：改阶段是「改一个字段」，走 updateJson 冲突重放。
                // 旧实现整份回写旧快照，窗口期内别人登记的新章/会话归属会被抹掉。
                // resetStage 对未知阶段抛错（非版本类），照旧直接冒到调用方。
                let stage = null;
                await updateJson(io, p.meta, (latest) => {
                    if (!latest || typeof latest !== 'object') return undefined;
                    resetStage(latest, args.stage);
                    latest.updatedAt = new Date().toISOString();
                    stage = latest.stage;
                    return { value: latest };
                });
                if (stage === null) throw new Error(`阶段设置未落盘：书目不存在或无变化（${book}）`);
                await audit(io, p, 'project/set_stage', { stage });
                return { book, action: 'set_stage', stage, next: `阶段已设为 ${stage}` };
            }

            // repair —— novel.json 索引与磁盘对账：文件被手工删除/移动后的自愈通道
            if (args.action === 'repair') {
                const { novel } = await requireBook(io, book);
                const missing = [];
                // 方向4：老书补稳定 id（此前建的书没有 id，同名/改名后身份不可判）
                if (typeof novel.id !== 'string' || novel.id === '') novel.id = newBookId();
                // 方向2：路径卫生——含控制字符的章节路径先归一化再对账（否则好章被判「整章丢失」误删）
                const pathIssues = [];
                for (const rec of Object.values(novel.chapters ?? {})) {
                    for (const f of rec?.files ?? []) {
                        if (hasControlChars(f?.file)) { pathIssues.push(f.file); f.file = stripControlChars(f.file); }
                    }
                    if (hasControlChars(rec?.path)) { pathIssues.push(rec.path); rec.path = stripControlChars(rec.path); }
                }
                for (const [k, rec] of Object.entries(novel.chapters ?? {})) {
                    const files = [];
                    for (const f of rec.files ?? []) {
                        // 路径收口（跟进项①）：repair 是对账工具——越书路径视为「该文件不可达」，
                        // 进 missing 清单随对账清出索引，而不是把外来文件读进来当好章。
                        if (containedBookPath(book, f?.file) === null) { missing.push(f?.file ?? ''); continue; }
                        if ((await io.readText(f.file)) !== null) files.push(f);
                        else missing.push(f.file);
                    }
                    if (files.length === 0) { delete novel.chapters[k]; continue; } // 整章丢失 → 移除记录
                    rec.files = files;
                    rec.versions = [...new Set(files.map((f) => f.version))].sort((a, b) => a - b);
                    rec.latest = rec.versions[rec.versions.length - 1];
                    const lastFile = files[files.length - 1].file;
                    if (rec.path !== lastFile) rec.path = lastFile;
                    const content = await io.readText(rec.path);
                    if (content !== null) rec.chars = content.replace(/\s/g, '').length;
                }
                novel.chapters = Object.fromEntries(
                    Object.entries(novel.chapters ?? {}).sort(([a], [b]) => Number(a) - Number(b)),
                );
                let droppedApprovals = 0;
                const approvals = novel.approvals?.outline ?? {};
                for (const k of Object.keys(approvals)) {
                    if ((await io.readText(p.chapterOutline(Number(k)))) === null) {
                        delete approvals[k];
                        droppedApprovals += 1;
                    }
                }
                // 孤儿正文扫描：**必须在上面的对账之后**——被整条移除的记录留下的正文，
                // 此刻才真的成为孤儿（扫在前面会漏报）。判据是「索引是否还在用它」：
                // files[] 与 rec.path 都算在用（path 优先是 chapterRelPath 的读取语义，
                // 手工把 path 改指到别处时那个文件仍在被读，不是孤儿）。
                // 只**报告**不删：这类文件可能另有用途（提案重放中途失败留下的版本稿等）。
                const referenced = new Set();
                for (const rec of Object.values(novel.chapters ?? {})) {
                    for (const f of rec.files ?? []) referenced.add(f.file.split('/').pop());
                    const used = chapterRelPath(rec, book);
                    if (used) referenced.add(used.split('/').pop());
                }
                const onDisk = await io.listNames(p.chaptersDir);
                const orphanFiles = onDisk
                    .filter((name) => name.endsWith('.md') && !referenced.has(name))
                    .sort();
                // 方向3：幽灵提案——「索引有文件无」（面板点开必失败）/「文件有索引无」（冷归档）。
                // 只报告不删：文件缺失可能是同步未落盘，把索引清掉就再也找不回这条提案。
                const proposalIds = (novel.proposals ?? []).map((x) => x?.id).filter((id) => typeof id === 'string');
                const proposalFilesOnDisk = (await io.listNames(p.proposalsDir))
                    .filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -5));
                const { missing: missingProposals, orphan: orphanProposals } = ghostProposals(proposalIds, proposalFilesOnDisk);
                // 方向2：数值字段落成 null 的体检（NaN→null 的盘面残留）
                const styleBaseline = await io.readJson(p.styleBaseline).catch(() => null);
                const stateIssues = numericNullFields(novel, styleBaseline);
                // 方向2：派生检索索引对账——删章后索引会残留「查无此文」的幽灵块。
                // 索引是派生物（删了重跑 build 即得），所以这里**真删**；不可用则记 reason 不阻断。
                const indexResult = await pruneGhostIndex(io, p, Object.keys(novel.chapters ?? {}));
                await saveBook(io, p, novel);
                await audit(io, p, 'project/repair', {
                    missingFiles: missing.length, droppedApprovals, orphan: orphanFiles.length,
                    pathFixed: pathIssues.length, missingProposals: missingProposals.length,
                    orphanProposals: orphanProposals.length, stateIssues: stateIssues.length,
                    indexGhosts: indexResult.ghostChapters.length, indexRemoved: indexResult.removed,
                    chapters: Object.keys(novel.chapters).length,
                });
                const facts = (await io.readJson(p.facts)) ?? [];
                const foreshadows = (await io.readJson(p.foreshadows)) ?? [];
                // 文案只列前 20 个：长书残留上百个时整份塞进返回值既烧 token 也没法读，
                // 全量列表在 orphanFiles 数组里给面板/调用方。
                const shown = orphanFiles.slice(0, 20);
                const orphanText = orphanFiles.length > 0
                    ? `发现 ${orphanFiles.length} 个未被索引引用的正文文件（仅报告，本工具不删除任何正文；确认可弃后请交给系统回收站）：${shown.join('、')}${orphanFiles.length > shown.length ? `…另有 ${orphanFiles.length - shown.length} 个` : ''}；`
                    : '';
                // 方向2/3 体检文案：只在命中时append，保持清账路径的 next 简短
                const health = [
                    pathIssues.length > 0 ? `已修正 ${pathIssues.length} 条含控制字符的路径（\r/\n 等会让 fs file not found）` : '',
                    missingProposals.length > 0 ? `幽灵提案：${missingProposals.length} 条索引登记但提案文件不在（面板点开会失败）——${missingProposals.slice(0, 10).join('、')}` : '',
                    orphanProposals.length > 0 ? `冷归档提案：${orphanProposals.length} 份提案文件已不在索引中（不删，仅报告）` : '',
                    stateIssues.length > 0 ? `状态体检：${stateIssues.length} 处数值字段为 null（NaN→null 残留）——${stateIssues.slice(0, 6).join('、')}` : '',
                    indexResult.ghostChapters.length > 0
                        ? `检索索引：已清掉第 ${indexResult.ghostChapters.join('、')} 章的 ${indexResult.removed} 个残留块（这些章已从书里删除，不清的话 novel_search 会把这些旧段落当成素材找回来）`
                        : '',
                    !indexResult.ok ? `检索索引这次没对账：${indexResult.reason}（不影响写作；想恢复检索时跑 novel_search build 重建索引）` : '',
                ].filter((x) => x !== '');
                return {
                    book, action: 'repair', stage: novel.stage, missing, droppedApprovals, orphanFiles,
                    pathIssues,
                    ...(missingProposals.length > 0 ? { missingProposals } : {}),
                    ...(orphanProposals.length > 0 ? { orphanProposals } : {}),
                    ...(stateIssues.length > 0 ? { stateIssues } : {}),
                    ...(indexResult.ghostChapters.length > 0 ? { indexGhostChapters: indexResult.ghostChapters, indexRemoved: indexResult.removed } : {}),
                    ...(indexResult.ok ? {} : { indexNote: `检索索引未对账：${indexResult.reason}` }),
                    chapters: Object.entries(novel.chapters).map(([k, c]) => ({ chapter: Number(k), title: c.title, latest: c.latest, chars: c.chars, summary: c.summary ?? '' })),
                    openForeshadows: foreshadows.filter((f) => f.payoffChapter === null).length,
                    factCount: facts.length,
                    next: `对账完成：清理 ${missing.length} 个失效文件引用，撤销 ${droppedApprovals} 个无细纲批准；${orphanText}现余 ${Object.keys(novel.chapters).length} 章。`
                        + (health.length > 0 ? `体检：${health.join('；')}。` : ''),
                };
            }

            // check —— 全书一致性校验（纯函数，零 token）：死人复活 / 伏笔倒挂 / 索引缺失 / 账本冲突
            if (args.action === 'check') {
                const { novel } = await requireBook(io, book);
                const inputs = await loadContinuityInputs(io, p, novel);
                const c = validateContinuity(inputs);
                await audit(io, p, 'project/check', { errors: c.stats.errors, warnings: c.stats.warnings });
                return {
                    book, action: 'check',
                    continuity: { ok: c.ok, errors: c.stats.errors, warnings: c.stats.warnings, issues: c.issues },
                    next: c.ok
                        ? `一致性校验通过（${c.stats.chapters} 章 / ${c.stats.facts} 条账本 / ${c.stats.foreshadows} 条伏笔 / 死亡实体 ${c.stats.deaths}）。`
                        : `发现 ${c.stats.errors} 处硬伤、${c.stats.warnings} 处警告——修完再往后写；索引类问题可试 repair 对账。`,
                };
            }

            // promise —— 故事承诺书：写清「本书向读者承诺什么」，每次写章自动注入上下文
            if (args.action === 'promise') {
                await requireBook(io, book);
                const incoming = args.promise === undefined ? '' : String(args.promise).trim();
                if (incoming === '') {
                    const cur = (await io.readText(p.promise)) ?? '';
                    return { book, action: 'promise', promise: cur, hasPromise: cur.trim() !== '' };
                }
                await io.writeText(p.promise, `${incoming}\n`, 'auto');
                await audit(io, p, 'promise/save', { chars: incoming.replace(/\s/g, '').length });
                return {
                    book, action: 'promise', promise: incoming, hasPromise: true,
                    next: '承诺书已保存——之后每次写章都会随上下文包注入；正文若与承诺冲突，内容门禁/审稿环节会指出来。',
                };
            }
        },
        render: (_args, v) => textBlock(
            v.action === 'init'
                ? `已创建《${v.title}》（${v.genre}）。下一步：${v.next}`
                : v.action === 'phase'
                    ? renderPhaseBoard(v.phases, { current: phaseLabel(v.stage) })
                        + (v.breaker.length > 0
                            ? `\n\n熔断计数：${v.breaker.map((b) => `第${b.chapter}章 ×${b.count}`).join('、')}（≥3 即拒绝再写，改细纲或场景契约可解除）`
                            : '')
                        + (v.forced ? '\n（force 放行：入场条件未满足仍推进，已记审计）' : '')
                : v.action === 'repair'
                    ? `${v.next}`
                    : v.action === 'check'
                        ? `一致性校验：${v.continuity.ok ? '未发现硬伤 ✓' : `${v.continuity.errors} 处硬伤`}（${v.continuity.warnings} 处警告）\n`
                            + (v.continuity.issues.length === 0
                                ? '全部检查项通过。'
                                : v.continuity.issues.map((i) => `${i.severity === 'error' ? '✗' : '⚠'} [${i.where}] ${i.message}`).join('\n'))
                        : v.action === 'promise'
                            ? (v.hasPromise
                                ? `故事承诺书（${String(v.promise ?? '').replace(/\s/g, '').length} 字）：\n${v.promise}`
                                : '故事承诺书尚未建立——novel_project promise 写入后，每次写章都会注入上下文（承诺写了才有人看）。')
                            : v.action === 'set_stage'
                                ? String(v.next ?? '')
                                : `《${v.title}》 stage=${v.stage}；章节 ${v.chapters.length}；账本 ${v.factCount} 条；未回收伏笔 ${v.openForeshadows}。`
        ),
    });
}
