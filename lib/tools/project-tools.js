// lib/tools/project-tools.js — novel_project / novel_outline / novel_character / novel_worldbook。
// 书目生命周期与「设定资产」管理。所有可变写都带版本守卫（fsio 'auto'），
// 审批落 novel.json.approvals（写章门禁读取），全部动作记 audit.jsonl。

import { defineTool } from './define-tool.js';
import { defaultNovel, normalizeWorldEntry, pathsFor } from '../store.js';
import { assertBookName, createFsio, sessionCwd } from '../fsio.js';
import { audit, requireBook, saveBook, parseList, textBlock } from './common.js';
import { resetStage } from '../gate.js';
import { phaseBoard, enterPhase, renderPhaseBoard, phaseLabel } from '../phases.js';
import { loadPhaseFacts } from '../phase-io.js';
import { breakerDigest, clearBreaker } from '../circuit-breaker.js';
import { validateContinuity } from '../continuity.js';
import { loadContinuityInputs } from '../continuity-io.js';
import { serializeWorldbook, parseWorldbookImport } from '../worldbook-io.js';
import { normalizeVoice, isEmptyVoice, VOICE_FIELDS } from '../voice.js';

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
        description: '小说工程管理：init 创建一本书的本地工程（novel.json + 目录骨架），status 查看阶段/章节/账本/伏笔概况，repair 把 novel.json 索引与磁盘对账（清理失效文件引用、撤销无细纲批准），check 跑全书一致性校验（死人复活/伏笔倒挂/索引缺失，纯本地零 token），promise 读/写故事承诺书（本书对读者的承诺，每次写章自动注入上下文）。书 = 工作区内的一个目录。',
        parameters: {
            action: { type: 'string', required: true, enum: ['init', 'status', 'phase', 'set_stage', 'repair', 'check', 'promise'], description: 'init 创建新书；status 查看概况；phase 九阶段状态机（不给 stage 返回看板，给了则**带入场条件**地进入）；set_stage 无校验硬设阶段（纠正通道）；repair 索引-磁盘对账修复；check 全书一致性校验；promise 读/写故事承诺书。' },
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
                    missing: { type: 'array', items: { type: 'string' } },
                    orphanFiles: { type: 'array', items: { type: 'string' } },
                    droppedApprovals: { type: 'integer' },
                    promise: { type: 'string' },
                    hasPromise: { type: 'boolean' },
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
                const novel = defaultNovel({
                    title: args.title ?? book,
                    genre: args.genre ?? '未分类',
                    logline: args.logline ?? '',
                    session: io.sessionId,
                });
                await io.writeJson(p.meta, novel, 'create');
                await audit(io, p, 'init', { book, title: novel.title, genre: novel.genre });
                return {
                    book, action: 'init', title: novel.title, genre: novel.genre,
                    next: '依次：novel_outline save_book 存全书大纲 → novel_character save 建人物卡 → novel_worldbook add 固化设定 → novel_outline save_chapter+approve 批准细纲 → novel_write_chapter 写章',
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
                return {
                    book, action: 'status', title: novel.title, genre: novel.genre, stage: novel.stage,
                    chapters, openForeshadows: foreshadows.filter((f) => f.payoffChapter === null).length,
                    factCount: facts.length,
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
                const res = enterPhase(novel, args.stage, { force: args.force === true, facts, actor: 'agent' });
                if (!res.ok) {
                    throw new Error(res.reason + '\n（确要强行推进用 force:true，将记入审计）');
                }
                await saveBook(io, p, novel);
                await audit(io, p, res.forced ? 'phase/forced' : 'phase/enter', { phase: res.phase, missing: res.missing });
                return {
                    book, action: 'phase', stage: novel.stage, forced: res.forced,
                    phases: phaseBoard(novel, facts).map(boardRow), breaker: bd.rows,
                };
            }

            // set_stage —— 显式阶段重置/纠正通道（默认 advanceStage 只前进，无撤回口）
            if (args.action === 'set_stage') {
                const { novel } = await requireBook(io, book);
                resetStage(novel, args.stage);
                await saveBook(io, p, novel);
                await audit(io, p, 'project/set_stage', { stage: novel.stage });
                return { book, action: 'set_stage', stage: novel.stage, next: `阶段已设为 ${novel.stage}` };
            }

            // repair —— novel.json 索引与磁盘对账：文件被手工删除/移动后的自愈通道
            if (args.action === 'repair') {
                const { novel } = await requireBook(io, book);
                // 孤儿正文扫描：盘上「正文/」里有、但 novel.json.files 未引用的 .md。
                // 这类文件无索引引用、读写都不走它（如提案重放中途失败留下的版本文件），
                // 只**报告**不删——可能另有用途；列出来供人决定，并给出手动清理提示。
                const referenced = new Set();
                for (const rec of Object.values(novel.chapters ?? {})) {
                    for (const f of rec.files ?? []) referenced.add(f.file.split('/').pop());
                }
                const onDisk = await io.listNames(`${book}/正文`);
                const orphanFiles = onDisk
                    .filter((name) => name.endsWith('.md') && !referenced.has(name))
                    .sort();
                const missing = [];
                for (const [k, rec] of Object.entries(novel.chapters ?? {})) {
                    const files = [];
                    for (const f of rec.files ?? []) {
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
                await saveBook(io, p, novel);
                await audit(io, p, 'project/repair', { missingFiles: missing.length, droppedApprovals, orphan: orphanFiles.length, chapters: Object.keys(novel.chapters).length });
                const facts = (await io.readJson(p.facts)) ?? [];
                const foreshadows = (await io.readJson(p.foreshadows)) ?? [];
                return {
                    book, action: 'repair', stage: novel.stage, missing, droppedApprovals, orphanFiles,
                    chapters: Object.entries(novel.chapters).map(([k, c]) => ({ chapter: Number(k), title: c.title, latest: c.latest, chars: c.chars, summary: c.summary ?? '' })),
                    openForeshadows: foreshadows.filter((f) => f.payoffChapter === null).length,
                    factCount: facts.length,
                    next: `对账完成：清理 ${missing.length} 个失效文件引用，撤销 ${droppedApprovals} 个无细纲批准；${orphanFiles.length > 0 ? `发现 ${orphanFiles.length} 个无索引引用的正文文件（仅报告，如需删除手动 rm/清理）：${orphanFiles.join('、')}；` : ''}现余 ${Object.keys(novel.chapters).length} 章。`,
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

export function defineOutlineTool(ctx, config) {
    return defineTool({
        name: 'novel_outline',
        description: '大纲与细纲：save_book 存全书大纲；save_chapter 保存第N章细纲；approve 批准该章细纲——未批准的章节 novel_write_chapter 会直接拒绝（阶段门禁）。',
        parameters: {
            action: { type: 'string', required: true, enum: ['save_book', 'save_chapter', 'approve'], description: 'save_book 存全书大纲；save_chapter 存第N章细纲；approve 批准第N章细纲。' },
            book: { type: 'string', required: true, description: '书目名。' },
            chapter: { type: 'integer', description: 'save_chapter / approve 必填：章号。' },
            outline: { type: 'string', description: 'save_book / save_chapter 必填：Markdown 正文。' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    book: { type: 'string', required: true },
                    action: { type: 'string', required: true },
                    chapter: { type: 'integer' },
                    path: { type: 'string' },
                    approved: { type: 'boolean' },
                },
            },
        },
        isConcurrencySafe: () => false,
        async execute(args, exec) {
            const book = assertBookName(args.book);
            const io = createFsio(ctx, exec, sessionCwd(exec));
            const p = pathsFor(book);
            // L11 修复：save_book / save_chapter 此前不查书是否存在——对不存在的书
            // 调用会静默写出幽灵目录。requireBook 先行（approve 本来就有）。
            const { novel } = await requireBook(io, book);

            if (args.action === 'save_book') {
                if (!args.outline || args.outline.trim() === '') throw new Error('save_book 需要 outline 正文');
                const rel = p.bookOutline;
                await io.writeText(rel, `${args.outline.trim()}\n`, 'auto');
                await audit(io, p, 'outline/save_book', { chars: args.outline.length });
                return { book, action: 'save_book', path: rel };
            }
            if (!Number.isInteger(args.chapter) || args.chapter < 1) throw new Error('save_chapter / approve 需要正整数 chapter');
            if (args.action === 'save_chapter') {
                if (!args.outline || args.outline.trim() === '') throw new Error('save_chapter 需要 outline 正文（含本章出场人物与必须覆盖的情节点）');
                const rel = p.chapterOutline(args.chapter);
                await io.writeText(rel, `${args.outline.trim()}\n`, 'auto');
                await audit(io, p, 'outline/save_chapter', { chapter: args.chapter, chars: args.outline.length });
                return { book, action: 'save_chapter', chapter: args.chapter, path: rel };
            }
            // approve
            const rel = p.chapterOutline(args.chapter);
            if ((await io.readText(rel)) === null) throw new Error(`第${args.chapter}章细纲文件不存在：先 save_chapter 再 approve`);
            // 防御：旧版 clone 产物或手工编辑过的 novel.json 可能缺 approvals.outline
            novel.approvals = novel.approvals ?? { outline: {} };
            novel.approvals.outline = novel.approvals.outline ?? {};
            novel.approvals.outline[String(args.chapter)] = true;
            // 熔断解除通道之一：细纲重批＝重新校准，清零该章连续驳回计数
            clearBreaker(novel, args.chapter);
            await saveBook(io, p, novel);
            await audit(io, p, 'outline/approve', { chapter: args.chapter });
            return { book, action: 'approve', chapter: args.chapter, approved: true };
        },
        render: (_args, v) => textBlock(
            v.action === 'approve'
                ? `第${v.chapter}章细纲已批准，可以 novel_write_chapter。`
                : `已保存：${v.path}`
        ),
    });
}

export function defineCharacterTool(ctx, config) {
    return defineTool({
        name: 'novel_character',
        description: '人物卡：save 保存/更新「人物/<名>.md」（外在底色、隐性欲望——写章时自动注入上下文包）；'
            + '可选 voice 参数建**语言基因卡**（句长习惯/逻辑风格/口头禅/绝不说/标志性小动作/语域，单独结构化存储，写章时单独注入成醒目区块）：'
            + '多角色同台时防「千人一腔」的关键——口癖与禁忌词是代码可查的，novel_audit voice:true 会核对。list 列出已建人物。',
        parameters: {
            action: { type: 'string', required: true, enum: ['save', 'list'], description: 'save 保存人物卡；list 列出。' },
            book: { type: 'string', required: true, description: '书目名。' },
            name: { type: 'string', description: 'save 必填：人物名。' },
            card: { type: 'string', description: 'save 必填：人物卡 Markdown 正文（外在底色/隐性欲望/心理阈值/关系网）。' },
            voice: { type: 'string', description: 'save 可选：语言基因卡，多行「键|值」，如「句长|短句为主，很少超10字」「口头禅|呵,行吧」「禁忌|人家,小女子」「动作|摸左耳」。可用键：句长/逻辑/口头禅/禁忌/动作/语域。' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    book: { type: 'string', required: true },
                    action: { type: 'string', required: true },
                    name: { type: 'string' },
                    path: { type: 'string' },
                    cast: { type: 'array', items: { type: 'string' } },
                    voiceFields: { type: 'array', items: { type: 'string' } },
                    voiced: { type: 'array', items: { type: 'string' } },
                },
            },
        },
        isConcurrencySafe: () => false,
        async execute(args, exec) {
            const book = assertBookName(args.book);
            const io = createFsio(ctx, exec, sessionCwd(exec));
            const p = pathsFor(book);
            const { novel } = await requireBook(io, book);
            novel.cast = novel.cast ?? [];

            if (args.action === 'list') {
                const voices = (await io.readJson(p.voices)) ?? {};
                const voiced = novel.cast.filter((nm) => !isEmptyVoice(normalizeVoice(voices[nm])));
                return { book, action: 'list', cast: [...novel.cast], voiceFields: [], voiced };
            }
            if (!args.name || !args.card || args.card.trim() === '') throw new Error('save 需要 name 与 card 正文');
            const name = args.name.trim();
            // L10 修复：纯空白名此前会溜过去（'  ' 非空 → trim 后空串 → 写出「人物/.md」幽灵文件）；
            // 名字里带路径分隔符会越出「人物/」目录，一并拒掉
            if (name === '') throw new Error('人物名不能为空白');
            if (/[\\/]/.test(name) || name.startsWith('.')) throw new Error(`人物名不合法：「${name}」（不含 / \\ 与 . 前缀）`);
            // 语言基因卡先解析校验（解析不出就整单失败，避免只写半张卡）
            const voice = args.voice === undefined ? null : normalizeVoice(args.voice);
            if (voice !== null && isEmptyVoice(voice)) {
                throw new Error(`voice 解析不出任何字段——请用「键|值」行；可用键：${VOICE_FIELDS.map((f) => f.label).join('、')}`);
            }
            const rel = p.character(args.name);
            await io.writeText(rel, `${args.card.trim()}\n`, 'auto');
            if (!novel.cast.includes(name)) novel.cast.push(name);
            await saveBook(io, p, novel);
            await audit(io, p, 'character/save', { name, chars: args.card.length });
            let voiceFields = [];
            if (voice !== null) {
                const voices = (await io.readJson(p.voices)) ?? {};
                voices[name] = voice;
                await io.writeJson(p.voices, voices);
                voiceFields = Object.keys(voice);
                await audit(io, p, 'character/voice', { name, fields: voiceFields });
            }
            return { book, action: 'save', name, path: rel, cast: [...novel.cast], voiceFields };
        },
        render: (_args, v) => textBlock(v.action === 'list'
            ? `已建人物 ${v.cast.length}：${v.cast.length === 0 ? '（无）' : v.cast.join('、')}`
                + `\n有语言基因卡：${v.voiced.length === 0 ? '（无——多角色同台建议补）' : v.voiced.join('、')}`
            : `人物卡已保存：${v.path}；当前 cast ${v.cast.length} 人`
                + (v.voiceFields.length > 0
                    ? `；语言基因卡已建 ${v.voiceFields.length} 个字段（写章时会单独注入）`
                    : '（未建语言基因卡——novel_character voice 可补，防千人一腔）')),
    });
}

export function defineWorldbookTool(ctx, config) {
    return defineTool({
        name: 'novel_worldbook',
        description: '世界书（lorebook）：add 固化一条设定（关键词触发或 always 常驻，写章时按细纲/出场人物自动注入）；list 列出；remove 按 id 删除。设定崩坏的解药——设定只认这里。',
        parameters: {
            action: { type: 'string', required: true, enum: ['add', 'update', 'list', 'remove', 'import', 'export'], description: 'add 新增；update 按 id 合并更新；list 列出；remove 删除；import 批量导入（JSON 数组或 关键词|内容 行）；export 导出 JSON。' },
            book: { type: 'string', required: true, description: '书目名。' },
            id: { type: 'string', description: 'add 可自定义 id；update / remove 必填。' },
            keywords: { type: 'string', description: 'add/update：触发关键词，逗号/顿号分隔（如「灵潮,溯回者」）；always=true 时可省。' },
            priority: { type: 'integer', description: 'add/update：注入优先级 0-100（默认 50）。预算不足时高优先级条目先入上下文。' },
            content: { type: 'string', description: 'add 必填；update 可选：设定内容（是什么+为什么+对故事的影响）。' },
            always: { type: 'boolean', description: 'add/update：true = 常驻注入（仅限全书级核心设定，省预算）。' },
            payload: { type: 'string', description: 'import 必填：批量导入内容。' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    book: { type: 'string', required: true },
                    action: { type: 'string', required: true },
                    removed: { type: 'string' },
                    count: { type: 'integer', required: true },
                    entries: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
                        id: { type: 'string', required: true }, keywords: { type: 'array', items: { type: 'string' }, required: true },
                        always: { type: 'boolean', required: true }, priority: { type: 'integer', required: true },
                        content: { type: 'string', required: true },
                    } } },
                    entry: { type: 'object', additionalProperties: false, properties: {
                        id: { type: 'string', required: true }, keywords: { type: 'array', items: { type: 'string' }, required: true },
                        always: { type: 'boolean', required: true }, priority: { type: 'integer', required: true },
                        content: { type: 'string', required: true },
                    } },
                    payload: { type: 'string' },
                    errors: { type: 'array', items: { type: 'string' } },
                },
            },
        },
        isConcurrencySafe: () => false,
        async execute(args, exec) {
            const book = assertBookName(args.book);
            const io = createFsio(ctx, exec, sessionCwd(exec));
            const p = pathsFor(book);
            await requireBook(io, book);
            const entries = (await io.readJson(p.worldbook)) ?? [];

            if (args.action === 'add') {
                const entry = normalizeWorldEntry({
                    id: args.id, keywords: parseList(args.keywords), content: args.content,
                    always: args.always === true, priority: args.priority,
                }, entries);
                entries.push(entry);
                await io.writeJson(p.worldbook, entries);
                await audit(io, p, 'worldbook/add', { id: entry.id });
                return { book, action: 'add', entry, count: entries.length };
            }
            if (args.action === 'list') {
                return { book, action: 'list', entries, count: entries.length };
            }
            if (args.action === 'update') {
                const idx = entries.findIndex((e) => e.id === args.id);
                if (idx === -1) throw new Error(`世界书条目不存在：${args.id}`);
                const old = entries[idx];
                if (args.content === undefined && args.keywords === undefined && args.always === undefined && args.priority === undefined) {
                    throw new Error('update 至少需要 content / keywords / priority / always 之一');
                }
                const merged = normalizeWorldEntry({
                    id: args.id,
                    keywords: args.keywords !== undefined ? parseList(args.keywords) : old.keywords,
                    content: args.content !== undefined ? args.content.trim() : old.content,
                    always: args.always !== undefined ? args.always === true : old.always,
                    priority: args.priority !== undefined ? args.priority : old.priority,
                }, entries.filter((e) => e.id !== args.id));
                entries[idx] = merged;
                await io.writeJson(p.worldbook, entries);
                await audit(io, p, 'worldbook/update', { id: args.id });
                return { book, action: 'update', entry: merged, count: entries.length };
            }
            if (args.action === 'export') {
                return { book, action: 'export', entries, count: entries.length, payload: serializeWorldbook(entries) };
            }
            if (args.action === 'import') {
                if (!args.payload || String(args.payload).trim() === '') throw new Error('import 需要 payload');
                const parsed = parseWorldbookImport(args.payload, entries);
                let next = entries;
                for (const e of parsed.entries) {
                    const i = next.findIndex((x) => x.id === e.id);
                    if (i === -1) next.push(e); else next[i] = e;
                }
                await io.writeJson(p.worldbook, next);
                await audit(io, p, 'worldbook/import', { accepted: parsed.entries.length, errors: parsed.errors.length });
                return { book, action: 'import', count: next.length, entries: next, errors: parsed.errors };
            }
            const rest = entries.filter((e) => e.id !== args.id);
            if (rest.length === entries.length) throw new Error(`世界书条目不存在：${args.id}`);
            await io.writeJson(p.worldbook, rest);
            await audit(io, p, 'worldbook/remove', { id: args.id });
            return { book, action: 'remove', removed: args.id, count: rest.length };
        },
        render: (_args, v) => textBlock(
            v.action === 'list' || v.action === 'import' || v.action === 'export'
                ? `世界书 ${v.count} 条${v.action === 'export' ? '\n' + v.payload : ''}${v.action === 'import' && v.errors?.length ? `（${v.errors.length} 行跳过）` : ''}`
                : v.action === 'add' ? `已固化设定 ${v.entry.id}（触发词：${v.entry.keywords.join('、') || '常驻'}）；世界书共 ${v.count} 条`
                : v.action === 'update' ? `已更新 ${v.entry.id}；世界书 ${v.count} 条`
                : `已删除 ${v.removed}；剩余 ${v.count} 条`),
    });
}
