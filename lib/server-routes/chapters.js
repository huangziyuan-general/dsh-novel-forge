// lib/server-routes/chapters.js — 章节路由（目录 / 读正文 / 保存 / 一键写章占位 /
// 一键润色 / 一键机械校对）。
//
// 从 server-api.js 按域拆出；每条路由的入口条件、fence 校验位置、响应体逐字保留。
// runChapterRevision 是 polish/proofread 共用的实现（原样从 registerServerApi 内搬出）。

/**
 * 发布前把模型拉进回路（D1 的 REST 面）。
 *
 * 两个端点共用一条实现：polish=按病灶清单整章改写，proofread=机械校对。
 * 三条纪律：
 *   ① 产物一律是**提案**（用户点「应用」才生成新版本）——旁路不能成为绕过提案制的后门；
 *   ② 引擎失败回**人话**（code + message + advice）+ 语义化状态码，不再裸 501；
 *   ③ actor 记 'user'——这是面板按钮触发的，不是模型自己发起的。
 */
async function runChapterRevision(req, res, bookId, chapterNo, mode, api) {
    const { engine, config, writeJson, readJsonBody, fail, locateBook, store, polishIssues, sectionOf, parseBanRules, runRevisionTask } = api;
    if (engine === null) {
        return fail(res, 503, 'ENGINE_UNAVAILABLE', '模型引擎未就绪：本进程没有可用的模型服务');
    }
    try {
        const body = await readJsonBody(req).catch(() => ({}));
        const found = await locateBook(bookId);
        if (!found) return fail(res, 404, 'NOT_FOUND', '书不存在');
        const { fsio } = found;
        const novel = JSON.parse(found.text);
        const rec = novel.chapters?.[String(chapterNo)];
        const recRel = store.chapterRelPath(rec, bookId);
        if (!recRel) return fail(res, 400, 'NO_CHAPTER', `第${chapterNo}章尚未保存，无可修订内容`);
        const content = (await fsio.readText(recRel).catch(() => null)) ?? '';
        if (content.trim() === '') return fail(res, 400, 'EMPTY_CHAPTER', `第${chapterNo}章正文为空`);

        const p = store.pathsFor(bookId);
        const outline = (await fsio.readText(p.chapterOutline(chapterNo)).catch(() => null)) ?? '';
        const issues = mode === 'polish'
            ? polishIssues(content, { top: Math.max(1, config.scanTopK) })
            : [];
        const banSection = sectionOf(outline, ['本章禁止偏离项', '禁止偏离']);
        const forbidden = mode === 'polish' ? parseBanRules(banSection).banned : [];

        const result = await runRevisionTask(engine, fsio, bookId, {
            mode, chapter: chapterNo, title: rec.title, content, issues, forbidden, actor: 'user',
            sessionId: typeof body.session === 'string' && body.session !== '' ? body.session : undefined,
            // 候选链：书的归属会话（创建它的会话 agent 大概率活着、工作区必然对）
            sessionCandidates: Array.isArray(novel.sessions) ? novel.sessions.filter((s) => typeof s === 'string' && s !== '') : [],
        });

        if (!result.ok) {
            const code = result.error?.code ?? 'ENGINE_FAILURE';
            const status = code === 'ENGINE_UNAVAILABLE' ? 503
                : code === 'NO_ROUTE' ? 409
                    : code === 'GUARD_BLOCKED' ? 422
                        : code === 'ABORTED' ? 499
                            : 502;
            return writeJson(res, status, {
                ok: false,
                error: { code, message: result.error?.message ?? '引擎调用失败', advice: result.error?.advice ?? '' },
                value: {
                    mode, chapter: chapterNo, attempts: result.attempts,
                    blocked: result.blocked ?? null,
                    warnings: result.warnings ?? [],
                },
            });
        }
        return writeJson(res, 200, {
            ok: true,
            value: {
                mode: result.mode, chapter: result.chapter, proposalId: result.proposalId,
                chars: result.chars, deltaChars: result.deltaChars,
                attempts: result.attempts,
                route: result.route === null ? null : { provider: result.route.provider, model: result.route.model, source: result.route.source },
                warnings: result.warnings,
                next: `提案 ${result.proposalId} 已登记——到「待批准提案」里点应用才生成新版本`,
            },
        });
    } catch (error) {
        return fail(res, 500, 'IO_FAILURE', String(error));
    }
}

/**
 * @param {object} req 请求
 * @param {object} res 响应
 * @param {string[]} segments 路径段
 * @param {object} api 共享依赖（http 基元 + workspace 索引 + 库）
 * @returns {Promise<boolean>} 是否已处理
 */
export async function handle(req, res, segments, api) {
    const {
        writeJson, readJsonBody, trusted, fail, safeDecode, validBookId, locateBook,
        store, versioning, isVersionConflict, updateJson, auditLine,
    } = api;

    // GET /projects/:id/chapters — 章节目录（听书 / 列表用）
    if (req.method === 'GET' && segments[0] === 'projects' && segments[2] === 'chapters' && segments.length === 3) {
        if (!trusted(req)) { fail(res, 403, 'FORBIDDEN', 'missing fence header'); return true; }
        const bookId = safeDecode(segments[1]);
        if (!validBookId(bookId)) { fail(res, 400, 'BAD_BOOK', 'invalid book id'); return true; }
        try {
            const found = await locateBook(bookId);
            if (!found) { fail(res, 404, 'NOT_FOUND', '书不存在'); return true; }
            const { text } = found;
            const novel = JSON.parse(text);
            const list = Object.entries(novel.chapters ?? {})
                .map(([no, rec]) => ({
                    no: Number(no),
                    title: rec?.title ?? `第 ${no} 章`,
                    chars: rec?.chars ?? 0,
                    version: rec?.version ?? 0,
                }))
                .sort((a, b) => a.no - b.no);
            writeJson(res, 200, { ok: true, value: list });
        } catch (error) {
            fail(res, 500, 'IO_FAILURE', String(error));
        }
        return true;
    }

    // GET /projects/:id/chapters/:no — 读章节正文
    if (req.method === 'GET' && segments[0] === 'projects' && segments[2] === 'chapters' && segments.length === 4) {
        if (!trusted(req)) { fail(res, 403, 'FORBIDDEN', 'missing fence header'); return true; }
        const bookId = safeDecode(segments[1]);
        if (!validBookId(bookId)) { fail(res, 400, 'BAD_BOOK', 'invalid book id'); return true; }
        const chapterNo = Number(segments[3]);
        // 与 POST 同款守卫：NaN 当键查恒返回空串，看着像「这章没内容」，
        // 而真相是请求写错了——响亮 400 比静默空值好。
        if (!Number.isInteger(chapterNo) || chapterNo < 1) { fail(res, 400, 'BAD_CHAPTER', '章节号必须为正整数'); return true; }
        try {
            const found = await locateBook(bookId);
            if (!found) { fail(res, 404, 'NOT_FOUND', '书不存在'); return true; }
            const { fsio, text } = found;
            const novel = JSON.parse(text);
            const rec = novel.chapters?.[String(chapterNo)];
            // 章节记录 schema 只认 path / files[].file（都含书目前缀）——
            // 0.13.1 曾读不存在的 rec.file 还另拼一层 bookId/正文/ → 阅读器恒空。
            const rel = store.chapterRelPath(rec, bookId);
            if (!rel) { writeJson(res, 200, { ok: true, value: '' }); return true; }
            const content = await fsio.readText(rel).catch(() => '');
            writeJson(res, 200, { ok: true, value: content ?? '' });
        } catch (error) {
            fail(res, 500, 'IO_FAILURE', String(error));
        }
        return true;
    }

    // POST /projects/:id/chapters/:no — 保存章节
    if (req.method === 'POST' && segments[0] === 'projects' && segments[2] === 'chapters' && segments.length === 4) {
        if (!trusted(req)) { fail(res, 403, 'FORBIDDEN', 'missing fence header'); return true; }
        const bookId = safeDecode(segments[1]);
        if (!validBookId(bookId)) { fail(res, 400, 'BAD_BOOK', 'invalid book id'); return true; }
        const chapterNo = Number(segments[3]);
        if (!Number.isInteger(chapterNo) || chapterNo < 1) { fail(res, 400, 'BAD_CHAPTER', '章节号必须为正整数'); return true; }
        try {
            const body = await readJsonBody(req);
            const title = String(body.title ?? `第 ${chapterNo} 章`);
            const content = String(body.text ?? '');
            const found = await locateBook(bookId);
            if (!found) { fail(res, 404, 'NOT_FOUND', '书不存在'); return true; }
            const { fsio } = found;
            // 读时捕获版本 + 冲突重放：版本号（prev.latest + 1）必须从**重读后的
            // 最新索引**推出来。原实现是「先读一次 → 末尾 writeTextIfVersion」，
            // 而那是写前一刻才 stat，版本永远匹配 —— 读-改-写窗口里别人刚落的
            // 新版本会被抹掉，还会算出同一个 vN 覆盖别人的正文文件。
            let rec;
            await updateJson(fsio, `${bookId}/novel.json`, async (novel) => {
                if (novel === undefined) throw new Error(`书目不存在：${bookId}`);
                store.migrateNovel(novel);   // 旧书借这次写盘补上 schemaVersion 与结构锚点
                const prev = novel.chapters?.[String(chapterNo)];
                const version = (prev?.latest ?? 0) + 1;
                const rel = `${bookId}/正文/${versioning.chapterFileName(chapterNo, title, version)}`;
                try {
                    await fsio.writeText(rel, content, 'create');    // 永不覆盖已有版本
                } catch (error) {
                    // 撞上自己上一轮重放写的那一份（逐字相同）→ 认领；否则是别人的版本
                    if (!isVersionConflict(error) || (await fsio.readText(rel)) !== content) throw error;
                }
                rec = store.chapterRecord(prev, {
                    title, version, file: rel, chars: content.replace(/\s/g, '').length,
                });
                if (!novel.chapters) novel.chapters = {};
                novel.chapters[String(chapterNo)] = rec;
                return { value: novel };
            });
            // 审计断档修复（H5）：面板改的每一版正文也要在审计链上可查
            await fsio.appendLine(`${bookId}/.novel/audit.jsonl`,
                auditLine('rest/chapter_save', { chapter: chapterNo, version: rec.latest, title, chars: rec.chars }, 'user'));
            writeJson(res, 200, { ok: true, value: { chapter: rec, text: content } });
        } catch (error) {
            fail(res, 500, 'IO_FAILURE', String(error));
        }
        return true;
    }

    // POST /projects/:id/chapters/:no/write — 一键写章（调用 briefing + write_chapter 工具逻辑）
    if (req.method === 'POST' && segments[0] === 'projects' && segments[2] === 'chapters' && segments[4] === 'write' && segments.length === 5) {
        if (!trusted(req)) { fail(res, 403, 'FORBIDDEN', 'missing fence header'); return true; }
        // 写章需要模型参与，从 HTTP 端无法直接调用
        // 返回 501 提示用户通过聊天调用 novel_write_chapter
        fail(res, 501, 'NOT_IMPLEMENTED', '一键写章需要模型参与，请在聊天中调用 novel_write_chapter');
        return true;
    }

    // POST /projects/:id/chapters/:no/polish — 一键润色（D1 旁路引擎：出提案，不落正文）
    if (req.method === 'POST' && segments[0] === 'projects' && segments[2] === 'chapters' && segments[4] === 'polish' && segments.length === 5) {
        if (!trusted(req)) { fail(res, 403, 'FORBIDDEN', 'missing fence header'); return true; }
        const bookId = safeDecode(segments[1]);
        if (!validBookId(bookId)) { fail(res, 400, 'BAD_BOOK', 'invalid book id'); return true; }
        // runChapterRevision 经 writeJson/fail 收口（两者返回 undefined）——dispatch 契约是
        // 「本分支已处理必须回 true」，直接 return 它的 undefined 会落到 404 二次写响应
        // （ERR_HTTP_HEADERS_SENT，真机症状是润色/校对面板只收到半截错）。
        await runChapterRevision(req, res, bookId, Number(segments[3]), 'polish', api);
        return true;
    }

    // POST /projects/:id/chapters/:no/proofread — 一键机械校对（D1 旁路引擎：守卫更严）
    if (req.method === 'POST' && segments[0] === 'projects' && segments[2] === 'chapters' && segments[4] === 'proofread' && segments.length === 5) {
        if (!trusted(req)) { fail(res, 403, 'FORBIDDEN', 'missing fence header'); return true; }
        const bookId = safeDecode(segments[1]);
        if (!validBookId(bookId)) { fail(res, 400, 'BAD_BOOK', 'invalid book id'); return true; }
        await runChapterRevision(req, res, bookId, Number(segments[3]), 'proofread', api);
        return true;
    }

    return false;
}