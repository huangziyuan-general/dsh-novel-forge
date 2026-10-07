// lib/server-routes/projects.js — 书目生命周期路由（列表 / 认领 / 创建 / 详情 / 要素 /
// 导出 / 删除 / 改名 / 克隆）。
//
// 从 server-api.js 按域拆出；每条路由的入口条件、fence 校验位置、响应体逐字保留。
// handle() 返回 true 表示已处理（含 403/404/500 等错误响应），false 表示本域不认这条请求。

import { bookCharBaseline, sessionFatigue } from '../health.js';

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
        store, bookConsole, updateJson, auditLine, assertBookName, cloneProject, exportLib, config,
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
            const scanned = await scanAllBooks();
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
            const scanned = await scanAllBooks();
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
            const novel = store.defaultNovel({ title, genre, session: session || null });
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
            writeJson(res, 200, { ok: true, value: { id: slug, title, genre } });
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
            const found = await locateBook(bookId);
            if (!found) { fail(res, 404, 'NOT_FOUND', '书不存在'); return true; }
            const { fsio, text } = found;
            const novel = JSON.parse(text);
            // 会话疲劳（0.15.1）：?session=<id> 时按该会话聚合首稿趋势，面板渲染横幅 +
            // 「复制交接摘要」按钮。审计行里的 session 由工具面写入（0.15.1 起）——面板
            // 自己存章的行不带 session（REST 无 exec），不计入：退化场景是 agent 长会话
            // 连写，面板单章保存不堆积。读不到审计/该会话无写章记录 → 不出 session 字段
            // （面板无横幅）。
            const sid = parseQuery(req.url).get('session');
            let fatigueView = null;
            if (sid) {
                try {
                    const auditText = await fsio.readText(`${bookId}/.novel/audit.jsonl`);
                    const fatigue = sessionFatigue(auditText, sid, bookCharBaseline(novel));
                    if (fatigue.sessionFirstAvg !== null) {
                        fatigueView = {
                            chapters: fatigue.sessionChapters,
                            firstAvg: fatigue.sessionFirstAvg,
                            baselineAvg: fatigue.baselineAvg ?? 0,
                            ...(fatigue.warn ? { warn: fatigue.warn } : {}),
                            handoff: handoffText(novel),
                            // 一键轮换按钮只在宿主暴露 create/archive 时出现（运行时探测，不等于恒真）
                            rotate: Boolean(api.sessionProbe?.().full),
                        };
                    }
                } catch (error) { console.warn(`[novel-forge] 疲劳块构建失败（横幅退场）book=${bookId}: ${String(error)}`); }
            }
            writeJson(res, 200, { ok: true, value: { id: bookId, ...(fatigueView ? { session: fatigueView } : {}), ...novel } });
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
            const found = await locateBook(bookId);
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
            const found = await locateBook(bookId);
            if (!found) { fail(res, 404, 'NOT_FOUND', '书不存在'); return true; }
            const { fsio, text } = found;
            const novel = JSON.parse(text);
            const body = await readJsonBody(req);
            const format = body.format === 'markdown' ? 'md' : 'txt';
            // 0.5.x 起这里调的是不存在的 exportLib.assembleBook(fsio, novel, …) —— 导出按钮一直是 500。
            // 正确链路：章节索引 → collectBookChapters 逐章读当前正文 → assembleBookText 拼整本。
            const chapters = await exportLib.collectBookChapters(fsio, novel);
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
            const found = await locateBook(bookId);
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
            const title = String(body.title ?? '').trim();
            if (!title) { fail(res, 400, 'INVALID_FIELD', '书名不能为空'); return true; }
            const found = await locateBook(bookId);
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
            const found = await locateBook(fromBook);
            if (!found) { fail(res, 404, 'NOT_FOUND', '书不存在'); return true; }
            const session = String(body.session ?? '').trim();
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