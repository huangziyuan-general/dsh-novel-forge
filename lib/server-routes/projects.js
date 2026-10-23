// lib/server-routes/projects.js — 书目生命周期路由（列表 / 认领 / 创建 / 详情 /
// 每章字数设置 / 要素 / 导出 / 删除 / 改名 / 克隆）。
//
// 从 server-api.js 按域拆出；每条路由的入口条件、fence 校验位置、响应体逐字保留。
// handle() 返回 true 表示已处理（含 403/404/500 等错误响应），false 表示本域不认这条请求。

import { sessionFatigue } from '../health.js';

/**
 * @param {object} req 请求
 * @param {object} res 响应
 * @param {string[]} segments 路径段
 * @param {object} api 共享依赖（http 基元 + workspace 索引 + 库）
 * @returns {Promise<boolean>} 是否已处理
 */
/** 交接摘要：疲劳横幅「复制交接摘要」按钮的内容——新会话粘一句即可续写
 *  （书的状态全在盘上，换会话零损失；会话归属由 rememberSession 第一次触到书时自动补，
 *  无需任何显式交接动作）。 */
const handoffText = (novel) => {
    const chapters = Object.keys(novel?.chapters ?? {}).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
    const latest = chapters.length > 0 ? chapters[chapters.length - 1] : 0;
    const rec = latest > 0 ? novel.chapters[String(latest)] : null;
    const pending = Array.isArray(novel?.proposals) ? novel.proposals.filter((x) => x?.status === 'pending').length : 0;
    const next = latest + 1;
    return [
        `继续《${novel?.title ?? novel?.id ?? '未命名'}》：已写至第 ${latest} 章${rec ? `（最近一章 ${rec.chars ?? '?'} 字）` : ''}。`,
        ...(pending > 0 ? [`待批提案 ${pending} 个——先 novel_propose list 查看，应用由用户在面板操作。`] : []),
        `下一步：第 ${next} 章——novel_outline save_chapter（第${next}章）→ novel_outline approve → novel_briefing（chapter=${next}）→ 按简报字数目标写正文 → novel_write_chapter 落盘。`,
    ].join('\n');
};

export async function handle(req, res, segments, api) {
    const {
        writeJson, readJsonBody, trusted, fail, parseQuery, safeDecode, validBookId,
        locateBook, scanAllBooks, collectRoots, makeFsio,
        store, bookConsole, updateJson, auditLine, assertBookName, cloneProject, exportLib, config, requestSession,
    } = api;

    // GET /projects[?session=<id>][&scope=unclaimed|all] — 列出书
    //
    // 「项目跟会话走」：给了 session 就只返回该会话的书（sessions 归属集），
    // scope=unclaimed 返回未归属的旧书（供面板认领）。两个都没给 = 全量，
    // 方便 curl 直接调试。
    if (req.method === 'GET' && segments[0] === 'projects' && segments.length === 1) {
        if (!trusted(req)) { fail(res, 403, 'FORBIDDEN', 'missing fence header'); return true; }
        try {
            const query = parseQuery(req.url);
            const session = query.get('session');
            const scope = query.get('scope');
            // 传 session 进扫描：同名书多根并存时，取**该会话名下**的那份拷贝参与过滤与
            // 展示（与 locateBook 同一判据）。不传的话列表恒看 cwd 根那份，会出现
            // 「书卡按会话过滤掉了 / 显示 A 拷贝章数、点进去读 B 拷贝」的分家现象。
            const scanned = await scanAllBooks({ session: session ?? '' });
            const picked = scope === 'unclaimed'
                ? scanned.filter((b) => store.isUnclaimed(b.novel))
                : scope === 'all' || !session
                    ? scanned
                    : scanned.filter((b) => store.bookInSession(b.novel, session));
            const out = [];
            for (const b of picked) {
                const factsText = await b.fsio.readText(`${b.name}/账本/facts.json`).catch(() => null);
                const foreshadowsText = await b.fsio.readText(`${b.name}/账本/伏笔.json`).catch(() => null);
                const summary = bookConsole.summarizeBook({ name: b.name, novel: b.text, facts: factsText, foreshadows: foreshadowsText });
                if (typeof b.novel?.id === 'string') summary.id = b.novel.id;
                // 方向4：同名书在多根下重复时显式标注，面板据此提示「同类另有 N 份」
                if (b.duplicates !== undefined) { summary.duplicates = b.duplicates; summary.duplicateRoots = b.duplicateRoots; }
                out.push(summary);
            }
            // 「面板无书」诊断：扫到书但被过滤空 = 会话归属问题（书在别的会话名下）；
            // 全空 = 扫描根本身没找到书（配合上方「扫描根更新」行定位）
            if (picked.length === 0 && scanned.length > 0) {
                console.info(`[novel-forge] 扫到 ${scanned.length} 本书但本次返回 0（session=${session ?? '-'} scope=${scope ?? '-'}）——书可能在其它会话名下；让本会话 agent 调一次该书的 novel_* 工具即可补录归属`);
            } else if (picked.length === 0) {
                console.info(`[novel-forge] 未发现任何书——确认书目录（含 novel.json）位于上方「扫描根更新」列出的工作区内`);
            }
            writeJson(res, 200, { ok: true, value: out });
        } catch (error) {
            fail(res, 500, 'IO_FAILURE', String(error));
        }
        return true;
    }

    // POST /projects/claim — 把未归属的旧书认领到本会话
    // body: { session, ids?: string[] }（ids 省略 = 认领全部未归属）
    if (req.method === 'POST' && segments[0] === 'projects' && segments[1] === 'claim' && segments.length === 2) {
        if (!trusted(req)) { fail(res, 403, 'FORBIDDEN', 'missing fence header'); return true; }
        try {
            const body = await readJsonBody(req);
            const session = String(body.session ?? '').trim();
            if (!session) { fail(res, 400, 'INVALID_FIELD', '缺少 session（认领需要知道归给哪个会话）'); return true; }
            const only = Array.isArray(body.ids) ? new Set(body.ids.map(String)) : null;
            // 同上：认领也按会话挑拷贝——会话在某根下已有归属的同名书，不能再去认领
            // 另一根下那份未归属的（否则一本书被同一个会话认两份）。
            const scanned = await scanAllBooks({ session });
            const claimed = [];
            for (const { name, fsio } of scanned) {
                if (only && !only.has(name)) continue;
                // 读时捕获版本 + 冲突重放（快照上的 isUnclaimed 判断必须在
                // **重读后的最新内容**上做，否则会把别人刚写好的索引抹掉）
                const { written } = await updateJson(fsio, `${name}/novel.json`, (novel) => {
                    if (novel === undefined) return undefined;              // 期间被删
                    if (!store.isUnclaimed(novel)) return undefined;         // 已有归属的不动（别抢别人的书）
                    store.addBookSession(novel, session);
                    return { value: novel };
                });
                if (!written) continue;
                // L14：认领也留审计（谁在何时把这本书归到了哪个会话）
                await fsio.appendLine(`${name}/.novel/audit.jsonl`, auditLine('rest/claim', { session, book: name }, 'user'));
                claimed.push(name);
            }
            writeJson(res, 200, { ok: true, value: { claimed } });
        } catch (error) {
            fail(res, 500, 'IO_FAILURE', String(error));
        }
        return true;
    }

    // POST /projects — 创建新书
    if (req.method === 'POST' && segments[0] === 'projects' && segments.length === 1) {
        if (!trusted(req)) { fail(res, 403, 'FORBIDDEN', 'missing fence header'); return true; }
        try {
            const body = await readJsonBody(req);
            // create 不截断：超长/非法书名必须 400（R2c 契约），截断会让非法输入静默变合法
            const title = String(body.title ?? '').trim();
            if (!title) { fail(res, 400, 'INVALID_FIELD', '书名不能为空'); return true; }
            // 与工具侧默认（project-tools 的 init）对齐用中文；'fantasy' 时代已经过去
            const genre = String(body.genre ?? '').trim() || '未分类';
            // L2：slug 与工具侧同规校验（空名/非法字符/超长在入口就拒，别等落盘炸）。
            // 校验失败是**请求的问题**，必须 400 —— 掉进外层 catch 会变成 500 IO_FAILURE。
            let slug;
            try {
                slug = assertBookName(title.replace(/[\/\\:*?"<>|]/g, '_'));
            } catch (error) {
                fail(res, 400, 'BAD_BOOK', String(error?.message ?? error)); return true;
            }
            // 创建根：优先 body.workspace（面板知道当前会话的工作区），
            // 缺省回进程 cwd —— 工具建书走的是会话 cwd，面板建书跟它对齐。
            // H4 修复：workspace 只收**扫描根集合**内的路径（collectRoots），
            // 不再是任意绝对路径写文件。
            const ws = String(body.workspace ?? '').trim();
            if (ws !== '') {
                const roots = collectRoots();
                if (!roots.includes(ws)) {
                    fail(res, 403, 'WORKSPACE_FORBIDDEN', 'workspace 不在允许列表内（会话工作区或配置根）'); return true;
                }
            }
            const root = ws || (config.workspaceRoot || process.cwd());
            const fsio = makeFsio(root);
            // 归属落盘：面板只列本会话创建的书，所以创建时就打上会话戳
            const session = String(body.session ?? '').trim();
            // 开书时收集的两项设置（用户 2026-10-20）：每章字数区间 + 投放平台。
            // 语法/取值不合法是**请求的问题** → 400，绝不能静默丢弃（丢了就等于
            // 用户以为设好了，实际按默认口径跑了几十章）。
            const charsSpec = store.parseCharsSpec(body.chars === undefined ? undefined : body.chars);
            if (!charsSpec.ok) { fail(res, 400, 'INVALID_FIELD', `每章字数区间不合法：${charsSpec.error}`); return true; }
            const platformRaw = body.platform === undefined ? '' : String(body.platform).trim();
            const platform = platformRaw === '' ? '' : store.parsePlatform(platformRaw);
            if (platform === null) {
                fail(res, 400, 'INVALID_FIELD', `不认识的平台：「${platformRaw}」（可选 ${store.PLATFORM_IDS.join(' / ')}）`); return true;
            }
            const novel = store.defaultNovel({
                title, genre, session: session || null,
                platform, charLimits: charsSpec.limits ?? null,
            });
            // 'create'：与工具侧 init 同规——**同名书已存在必须响亮拒绝**。
            // 用默认的 auto 会把已有书的章节索引/会话归属/阶段整体覆盖掉，
            // 正文文件沦成孤儿（REST 面「永不覆盖」不变量的又一处落点）。
            try {
                await fsio.writeText(`${slug}/novel.json`, `${JSON.stringify(novel, null, 2)}\n`, 'create');
            } catch (error) {
                if (error?.code === 'FS_NOT_OBSERVED') {
                    fail(res, 409, 'BOOK_EXISTS', `书目已存在：${slug}`); return true;
                }
                throw error;
            }
            writeJson(res, 200, { ok: true, value: { id: slug, title, genre, ...store.charLimitsView(config, novel) } });
        } catch (error) {
            fail(res, 500, 'IO_FAILURE', String(error));
        }
        return true;
    }

    // POST /projects/:id/chars — 设置/清除**本书每章字数区间**（面板「本章字数」输入框）。
    // 落库到 novel.json.charLimits，与工具面 novel_project action=chars 同一份真相：
    // 写章门禁/简报/细纲/提案/润色/审计六条链都从它派生（谁都不再拿插件默认值说事）。
    if (req.method === 'POST' && segments[0] === 'projects' && segments[2] === 'chars' && segments.length === 3) {
        if (!trusted(req)) { fail(res, 403, 'FORBIDDEN', 'missing fence header'); return true; }
        const bookId = safeDecode(segments[1]);
        if (!validBookId(bookId)) { fail(res, 400, 'BAD_BOOK', 'invalid book id'); return true; }
        let body;
        try {
            body = await readJsonBody(req);
        } catch (error) {
            fail(res, 400, 'BAD_BODY', `请求体不是合法 JSON：${String(error?.message ?? error)}`); return true;
        }
        // 缺省语义必须与工具面（novel_project action=chars 不传＝读现值）**同向**，
        // 但这里是显式写入端点：缺字段多半是调用方拼错了请求体。旧实现把 undefined
        // 当「清除」，等于一次拼错的请求会**静默抹掉**用户设好的区间（不变量 #11 禁止静默）；
        // 而 null 会漏过 `=== null` 判据、在 else 分支读 undefined.min 抛成 500。
        // 两条都堵死：缺省/null 一律响亮 400，只有字符串才进解析——要清除就显式传空串。
        if (body.chars === undefined || body.chars === null) {
            fail(res, 400, 'INVALID_FIELD', '缺少 chars 字段：要设置请给「下限-上限」（如 2500-3500），要清除请传空串 ""。');
            return true;
        }
        const spec = store.parseCharsSpec(body.chars);
        if (!spec.ok) { fail(res, 400, 'INVALID_FIELD', `每章字数区间不合法：${spec.error}`); return true; }
        try {
            // 归属判据与列表/阅读一致（面板带 session）
            const found = await locateBook(bookId, { session: requestSession(req, body) });
            if (!found) { fail(res, 404, 'NOT_FOUND', '书不存在'); return true; }
            const { fsio } = found;
            let updated = null;
            // 读-改-写走守卫（重读重放）：改一个字数设置不该顺手抹掉窗口期内别人写进去的章节索引
            await updateJson(fsio, `${bookId}/novel.json`, (novel) => {
                if (novel === undefined) throw new Error(`书目不存在：${bookId}`);
                store.migrateNovel(novel);
                if (spec.limits === null) delete novel.charLimits;
                else novel.charLimits = { min: spec.limits.min, max: spec.limits.max };
                novel.updatedAt = new Date().toISOString();
                updated = novel;
                return { value: novel };
            });
            await fsio.appendLine(`${bookId}/.novel/audit.jsonl`,
                auditLine('rest/chars', { book: bookId, charLimits: spec.limits }, 'user'));
            writeJson(res, 200, { ok: true, value: { id: bookId, ...store.charLimitsView(config, updated) } });
        } catch (error) {
            fail(res, 500, 'IO_FAILURE', String(error));
        }
        return true;
    }

    // GET /projects/:id — 书详情
    if (req.method === 'GET' && segments[0] === 'projects' && segments.length === 2) {
        if (!trusted(req)) { fail(res, 403, 'FORBIDDEN', 'missing fence header'); return true; }
        const bookId = safeDecode(segments[1]);
        if (!validBookId(bookId)) { fail(res, 400, 'BAD_BOOK', 'invalid book id'); return true; }
        try {
            // ?session= 双用途：既做疲劳聚合，也做 locateBook 的归属判据（多根同名书
            // 时详情/阅读必须落在列表给用户看的那份拷贝上，两边不能分家）
            const sid = parseQuery(req.url).get('session');
            const found = await locateBook(bookId, { session: sid ?? '' });
            if (!found) { fail(res, 404, 'NOT_FOUND', '书不存在'); return true; }
            const { fsio, text } = found;
            const novel = JSON.parse(text);
            // 会话疲劳（0.15.1 引入，0.18.0 重写判据，1.0.5 加体量判据与会话归属兜底）：
            // **无条件**聚合（不再以面板给不给 ?session= 为前提）——面板会话 id 可能与工具面
            // 记账 id 不同源甚至缺失（0.13.2 老病；2026-10-23 外部用户实证：42 章连写写爆
            // 上下文，横幅与「创建新会话并交接」整个缺席）。sessionFatigue 内部对「id 没命中
            // 记账行 + 全书单会话」兜底；多会话书无法归因 → 仍不出 session 字段（宁缺不假）。
            let fatigueView = null;
            {
                try {
                    const auditText = await fsio.readText(`${bookId}/.novel/audit.jsonl`);
                    const fatigue = sessionFatigue(auditText, sid ?? null, { briefingChars: api.config?.contextBudgetChars });
                    if (fatigue.sessionFirstAvg !== null) {
                        fatigueView = {
                            chapters: fatigue.sessionChapters,
                            firstAvg: fatigue.sessionFirstAvg,
                            firstSeries: fatigue.sessionFirstSeries,
                            bookFirstAvg: fatigue.bookFirstAvg ?? 0,
                            referenceChapters: fatigue.referenceChapters,
                            ...(fatigue.warn ? { warn: fatigue.warn, level: fatigue.level } : {}),
                            ...(fatigue.contextEst ? { contextEst: fatigue.contextEst } : {}),
                            ...(fatigue.scopeNote ? { scopeNote: fatigue.scopeNote } : {}),
                            handoff: handoffText(novel),
                            // 能力位由运行时探测决定（不等于恒真）：canCreate=「创建新会话并交接」按钮，
                            // rotate=create+archive 全有才亮（当前宿主 archive 不可见，恒 false）
                            canCreate: Boolean(api.sessionProbe?.().sessions),
                            rotate: Boolean(api.sessionProbe?.().full),
                        };
                    }
                } catch (error) { console.warn(`[novel-forge] 疲劳块构建失败（横幅退场）book=${bookId}: ${String(error)}`); }
            }
            // 批量断点（0.16.0）：存在就把检查点带给面板——「继续上次批量」按钮的数据源
            let batchCheckpoint = null;
            try { batchCheckpoint = await fsio.readJson(store.pathsFor(bookId).batchCheckpoint); } catch { /* 无检查点不阻断详情 */ }
            // bookId（目录名）必须在 ...novel **之后**：novel.json 里的 id 是内部 id（nb_…），
            // 会把同名键覆盖掉。而所有按「书」定位的路由（locateBook / requireBook / 认领）
            // 认的都是目录名——「创建新会话并交接」正是拿 detail.id 当 book 传，于是书根定位与
            // 认领双双落空（真机实测：新会话创建成功、落点靠旧会话兜底、claimed:false，
            // 新会话面板书列表 0 本）。两个键各司其职：id=内部 id 保持旧契约，bookId=目录名。
            // charView：服务端算好的「生效字数区间 + 出处」——面板只展示派生结果，
            // 不在浏览器里重算一遍优先级（两处算出不同区间，就是本轮要消灭的那类病）。
            writeJson(res, 200, {
                ok: true,
                value: {
                    id: bookId,
                    ...(fatigueView ? { session: fatigueView } : {}),
                    ...(batchCheckpoint !== null ? { batchCheckpoint } : {}),
                    ...novel,
                    bookId,
                    charView: store.charLimitsView(config, novel),
                },
            });
        } catch (error) {
            fail(res, 500, 'IO_FAILURE', String(error));
        }
        return true;
    }

    // GET /projects/:id/elements — 小说基本要素（基本信息标签：档案/大纲/角色卡/设定/账本时间线）
    if (req.method === 'GET' && segments[0] === 'projects' && segments[2] === 'elements' && segments.length === 3) {
        if (!trusted(req)) { fail(res, 403, 'FORBIDDEN', 'missing fence header'); return true; }
        const bookId = safeDecode(segments[1]);
        if (!validBookId(bookId)) { fail(res, 400, 'BAD_BOOK', 'invalid book id'); return true; }
        try {
            const found = await locateBook(bookId, { session: requestSession(req) });
            if (!found) { fail(res, 404, 'NOT_FOUND', '书不存在'); return true; }
            const { fsio, text } = found;
            const novel = JSON.parse(text);
            /** 读文本，不存在/失败返回 null（要素缺失是常态，不是错误）。 */
            const pick = async (p) => {
                try { return (await fsio.readText(p)) ?? null; } catch { return null; }
            };
            const parseJson = async (p, fallback) => {
                const raw = await pick(p);
                if (raw == null || raw === '') return fallback;
                try { return JSON.parse(raw); } catch { return fallback; }
            };
            // 角色卡：人物/ 目录下的 .md（listNames 只回目录，列文件用 listEntries）
            const characters = [];
            try {
                const files = (await fsio.listEntries(`${bookId}/人物`))
                    .filter((e) => e.type === 'file' && e.name.endsWith('.md'));
                for (const f of files) {
                    characters.push({ name: f.name.replace(/\.md$/, ''), text: (await fsio.readText(`${bookId}/人物/${f.name}`)) ?? '' });
                }
            } catch { /* 没有人物目录 = 还没有角色卡 */ }
            // 细纲文件名（数量级展示）
            let chapterOutlines = [];
            try {
                chapterOutlines = (await fsio.listEntries(`${bookId}/大纲/细纲`))
                    .filter((e) => e.type === 'file' && e.name.endsWith('.md'))
                    .map((e) => e.name);
            } catch { /* 没有细纲 */ }
            const facts = await parseJson(`${bookId}/账本/facts.json`, []);
            const foreshadows = await parseJson(`${bookId}/账本/伏笔.json`, []);
            const worldbook = await parseJson(`${bookId}/设定/世界书.json`, []);
            const glossary = await parseJson(`${bookId}/设定/术语表.json`, []);
            writeJson(res, 200, {
                ok: true,
                value: {
                    meta: {
                        title: novel.title ?? bookId,
                        genre: novel.genre ?? '',
                        logline: novel.logline ?? '',
                        stage: novel.stage ?? '',
                        createdAt: novel.createdAt ?? null,
                        updatedAt: novel.updatedAt ?? null,
                        cast: Array.isArray(novel.cast) ? novel.cast : [],
                    },
                    outline: {
                        full: await pick(`${bookId}/大纲/全书大纲.md`),
                        chapterOutlines,
                    },
                    characters,
                    worldbookCount: Array.isArray(worldbook) ? worldbook.length : 0,
                    glossaryCount: Array.isArray(glossary) ? glossary.length : 0,
                    facts: Array.isArray(facts) ? facts : [],
                    foreshadows: Array.isArray(foreshadows) ? foreshadows : [],
                },
            });
        } catch (error) {
            fail(res, 500, 'IO_FAILURE', String(error));
        }
        return true;
    }

    // POST /projects/:id/export — 导出
    if (req.method === 'POST' && segments[0] === 'projects' && segments[2] === 'export' && segments.length === 3) {
        if (!trusted(req)) { fail(res, 403, 'FORBIDDEN', 'missing fence header'); return true; }
        const bookId = safeDecode(segments[1]);
        if (!validBookId(bookId)) { fail(res, 400, 'BAD_BOOK', 'invalid book id'); return true; }
        try {
            const found = await locateBook(bookId, { session: requestSession(req) });
            if (!found) { fail(res, 404, 'NOT_FOUND', '书不存在'); return true; }
            const { fsio, text } = found;
            const novel = JSON.parse(text);
            const body = await readJsonBody(req);
            const format = body.format === 'markdown' ? 'md' : 'txt';
            // 0.5.x 起这里调的是不存在的 exportLib.assembleBook(fsio, novel, …) —— 导出按钮一直是 500。
            // 正确链路：章节索引 → collectBookChapters 逐章读当前正文 → assembleBookText 拼整本。
            const chapters = await exportLib.collectBookChapters(fsio, novel, bookId);
            const content = exportLib.assembleBookText(chapters, format);
            const fileName = `${novel?.title ?? bookId}.${format}`;
            writeJson(res, 200, { ok: true, value: { fileName, content, stats: exportLib.bookStats(chapters) } });
        } catch (error) {
            fail(res, 500, 'IO_FAILURE', String(error));
        }
        return true;
    }

    // DELETE /projects/:id — 删除书
    if (req.method === 'DELETE' && segments[0] === 'projects' && segments.length === 2) {
        if (!trusted(req)) { fail(res, 403, 'FORBIDDEN', 'missing fence header'); return true; }
        const bookId = safeDecode(segments[1]);
        if (!validBookId(bookId)) { fail(res, 400, 'BAD_BOOK', 'invalid book id'); return true; }
        try {
            // 删除必须删在「用户看到的」那份拷贝上——归属判据与列表/阅读一致
            const found = await locateBook(bookId, { session: requestSession(req) });
            if (!found) { fail(res, 404, 'NOT_FOUND', '书不存在'); return true; }
            // 删除 novel.json（标记为非书）—— 必须写在书真正所在的工作区根
            // L14：先留审计再抹身份（.novel/ 目录不受删除影响，账可查）
            await found.fsio.appendLine(`${bookId}/.novel/audit.jsonl`, auditLine('rest/delete_book', { book: bookId }, 'user'));
            await found.fsio.writeText(`${bookId}/novel.json`, '');
            writeJson(res, 200, { ok: true, value: { deleted: bookId } });
        } catch (error) {
            fail(res, 500, 'IO_FAILURE', String(error));
        }
        return true;
    }

    // POST /projects/:id/rename — 改名
    // 目录名（bookId）是这本书的**稳定身份**（章节/世界书/账本路径都挂在它下面），
    // 改名只改 novel.json.title，不挪目录——与删除同样走「软操作」模型，零数据丢失风险。
    if (req.method === 'POST' && segments[0] === 'projects' && segments[2] === 'rename' && segments.length === 3) {
        if (!trusted(req)) { fail(res, 403, 'FORBIDDEN', 'missing fence header'); return true; }
        const bookId = safeDecode(segments[1]);
        if (!validBookId(bookId)) { fail(res, 400, 'BAD_BOOK', 'invalid book id'); return true; }
        try {
            const body = await readJsonBody(req);
            const title = String(body.title ?? '').trim().slice(0, 64);
            if (!title) { fail(res, 400, 'INVALID_FIELD', '书名不能为空'); return true; }
            const found = await locateBook(bookId, { session: requestSession(req, body) });
            if (!found) { fail(res, 404, 'NOT_FOUND', '书不存在'); return true; }
            const { fsio } = found;
            // 读-改-写走守卫（重读重放）：改一个标题不该顺手抹掉窗口期内
            // 别人写进去的章节索引/会话归属
            let prev;
            await updateJson(fsio, `${bookId}/novel.json`, (novel) => {
                if (novel === undefined) throw new Error(`书目不存在：${bookId}`);
                store.migrateNovel(novel);   // 旧书借这次写盘补上 schemaVersion 与结构锚点
                prev = novel.title ?? bookId;
                novel.title = title;
                return { value: novel };
            });
            // L14：改名留审计（bookId 不变，title 变更历史可查）
            await fsio.appendLine(`${bookId}/.novel/audit.jsonl`, auditLine('rest/rename', { book: bookId, prev, title }, 'user'));
            writeJson(res, 200, { ok: true, value: { id: bookId, prev, title } });
        } catch (error) {
            fail(res, 500, 'IO_FAILURE', String(error));
        }
        return true;
    }

    // POST /projects/:id/clone — 克隆为模板
    // 复制规则全在 lib/clone.js（与 novel_clone_project 工具共用一份）。
    // 克隆进**源书所在根**（资产同根才完整）；归属打当前会话（body.session）。
    if (req.method === 'POST' && segments[0] === 'projects' && segments[2] === 'clone' && segments.length === 3) {
        if (!trusted(req)) { fail(res, 403, 'FORBIDDEN', 'missing fence header'); return true; }
        const fromBook = safeDecode(segments[1]);
        if (!validBookId(fromBook)) { fail(res, 400, 'BAD_BOOK', 'invalid book id'); return true; }
        try {
            const body = await readJsonBody(req);
            const newBook = String(body.newBook ?? '').trim();
            if (!newBook) { fail(res, 400, 'INVALID_FIELD', '新书目名不能为空'); return true; }
            const session = requestSession(req, body);
            // 克隆源书也按归属判据定位：会话名下哪份就克哪份
            const found = await locateBook(fromBook, { session });
            if (!found) { fail(res, 404, 'NOT_FOUND', '书不存在'); return true; }
            const v = await cloneProject(found.fsio, {
                fromBook, newBook,
                title: String(body.title ?? '').trim(),
                session: session || null,
                actor: 'user',
            });
            writeJson(res, 200, { ok: true, value: v });
        } catch (error) {
            fail(res, 400, 'CLONE_FAILED', String(error?.message ?? error));
        }
        return true;
    }

    return false;
}