// lib/server-routes/insights.js — 只读体检 / 结构诊断 / 并发批量起草。
//
// 从 server-api.js 按域拆出；每条路由的入口条件、fence 校验位置、响应体逐字保留。
// continuity 与 diagnose 都是纯本地零 token；draft-batch 需要模型引擎（D2 并发起草）。

/**
 * @param {object} req 请求
 * @param {object} res 响应
 * @param {string[]} segments 路径段
 * @param {object} api 共享依赖（http 基元 + workspace 索引 + 库）
 * @returns {Promise<boolean>} 是否已处理
 */
export async function handle(req, res, segments, api) {
    const {
        engine, config, writeJson, readJsonBody, trusted, fail, safeDecode, validBookId, locateBook,
        store, continuity, loadContinuityInputs, healthIssues, readIndexedChapters,
        diagnoseIntro, runDraftBatch,
    } = api;

    // GET /projects/:id/continuity — 全书一致性校验（面板体检用；纯函数零 token）
    if (req.method === 'GET' && segments[0] === 'projects' && segments[2] === 'continuity' && segments.length === 3) {
        if (!trusted(req)) { fail(res, 403, 'FORBIDDEN', 'missing fence header'); return true; }
        const bookId = safeDecode(segments[1]);
        if (!validBookId(bookId)) { fail(res, 400, 'BAD_BOOK', 'invalid book id'); return true; }
        try {
            const found = await locateBook(bookId);
            if (!found) { fail(res, 404, 'NOT_FOUND', '书不存在'); return true; }
            const { fsio, text } = found;
            const novel = JSON.parse(text);
            const p = store.pathsFor(bookId);
            const inputs = await loadContinuityInputs(fsio, p, novel);
            const result = continuity.validateContinuity(inputs);
            // 方向2：把「存储健康度」体检（控制字符路径 / NaN→null 残留 / 幽灵提案 /
            // 检索索引陈旧块）合并进全书体检——与 novel_project repair 共用 lib/health.js，
            // 面板零改动即可见。
            const styleBaseline = await fsio.readJson(p.styleBaseline).catch(() => null);
            const proposalFilesOnDisk = (await fsio.listNames(p.proposalsDir))
                .filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -5));
            // 派生检索索引的陈旧块（删章后索引残留）：只读诊断，不修改（清理走 repair）。
            // 索引不可用时 chapters 为 []，不会误报。
            const { chapters: indexedChapters } = await readIndexedChapters(fsio, p);
            const issues = continuity.sortIssues([
                ...result.issues,
                ...healthIssues({
                    novel, styleBaseline,
                    proposalIds: (novel.proposals ?? []).map((x) => x?.id),
                    proposalFilesOnDisk,
                    indexedChapters,
                }),
            ]);
            const errors = issues.filter((i) => i.severity === 'error').length;
            const warnings = issues.filter((i) => i.severity === 'warning').length;
            writeJson(res, 200, {
                ok: true,
                value: { ok: errors === 0, stats: { ...result.stats, errors, warnings }, issues },
            });
        } catch (error) {
            fail(res, 500, 'IO_FAILURE', String(error));
        }
        return true;
    }

    // GET /projects/:id/diagnose — 黄金三章确定性诊断（novel_diagnose 同款算法，零 token）
    // 面板的「结构诊断」此前引导去会话、文案误称"需要模型判断"——其实 diagnoseIntro
    // 是纯词表打分（lib/diagnose.js），REST 直接跑，与 /continuity 同类。
    if (req.method === 'GET' && segments[0] === 'projects' && segments[2] === 'diagnose' && segments.length === 3) {
        if (!trusted(req)) { fail(res, 403, 'FORBIDDEN', 'missing fence header'); return true; }
        const bookId = safeDecode(segments[1]);
        if (!validBookId(bookId)) { fail(res, 400, 'BAD_BOOK', 'invalid book id'); return true; }
        try {
            const found = await locateBook(bookId);
            if (!found) { fail(res, 404, 'NOT_FOUND', '书不存在'); return true; }
            const { fsio, text } = found;
            const novel = JSON.parse(text);
            const limit = 3; // 黄金三章
            const keys = Object.keys(novel.chapters ?? {}).map(Number).filter((k) => k >= 1).sort((a, b) => a - b).slice(0, limit);
            const chapters = [];
            for (const k of keys) {
                const rec = novel.chapters[String(k)];
                const rel = store.chapterRelPath(rec, bookId);
                if (!rel) continue;
                const content = await fsio.readText(rel);
                if (content !== null) chapters.push({ chapter: k, title: rec.title, content });
            }
            const outline = (await fsio.readText(store.pathsFor(bookId).bookOutline)) ?? '';
            const d = diagnoseIntro({ chapters, outline, logline: novel.logline ?? '' });
            writeJson(res, 200, { ok: true, value: { ...d, sampled: chapters.length } });
        } catch (error) {
            fail(res, 500, 'IO_FAILURE', String(error));
        }
        return true;
    }

    // POST /projects/:id/draft-batch — 并发批量起草（D2）
    //
    // 并发生成 → **串行提交**（同一条 chapter-commit 硬约束链：机审/账本/
    // 内容门禁/契约指标一个都不少）。失败不整批回滚：1 章挂了其余照落盘。
    // 并发默认 1，上限 4，且只在有场景契约裁过上下文的书上放开。
    if (req.method === 'POST' && segments[0] === 'projects' && segments[2] === 'draft-batch' && segments.length === 3) {
        if (!trusted(req)) { fail(res, 403, 'FORBIDDEN', 'missing fence header'); return true; }
        const bookId = safeDecode(segments[1]);
        if (!validBookId(bookId)) { fail(res, 400, 'BAD_BOOK', 'invalid book id'); return true; }
        try {
            const found = await locateBook(bookId);
            if (!found) { fail(res, 404, 'NOT_FOUND', '书不存在'); return true; }
            const novel = JSON.parse(found.text);
            const body = await readJsonBody(req);
            let from = Number(body.from ?? 1);
            let count = Number(body.count ?? 1);
            let force = body.force === true;
            let resumed = false;
            // 断点续跑：resume=true 时参数取上次批量的检查点（.novel/batch-checkpoint.json，
            // runDraftBatch 每章提交后更新）。已落盘的章由 planDraftBatch 自动挡掉，只重试未完成的。
            if (body.resume === true) {
                const pCk = store.pathsFor(bookId);
                const ck = await found.fsio.readJson(pCk.batchCheckpoint);
                if (ck === null) { fail(res, 400, 'NO_CHECKPOINT', '没有可续的批量检查点（先跑一次批量起草）'); return true; }
                if (ck.status === 'done') { fail(res, 409, 'BATCH_DONE', `上次批量已完成（第${ck.from}–${Number(ck.from) + Number(ck.count) - 1} 章），无断点可续`); return true; }
                from = Number.isInteger(ck.from) ? ck.from : from;
                count = Number.isInteger(ck.count) ? ck.count : count;
                force = ck.force === true || force;
                resumed = true;
            }
            if (!Number.isInteger(from) || from < 1) { fail(res, 400, 'BAD_RANGE', 'from 必须是正整数'); return true; }
            if (!Number.isInteger(count) || count < 1 || count > 20) { fail(res, 400, 'BAD_RANGE', 'count 必须是 1–20'); return true; }
            // 引擎检查放在请求形状校验之后：resume/NO_CHECKPOINT 这类 4xx 不该被 503 抢答
            if (engine === null) { fail(res, 503, 'ENGINE_UNAVAILABLE', '模型引擎未就绪：本进程没有可用的模型服务'); return true; }
            const result = await runDraftBatch({
                engine, config, io: found.fsio, p: store.pathsFor(bookId), book: bookId, novel,
                from, count,
                concurrency: Number(body.concurrency ?? 1),
                force,
                sessionId: typeof body.session === 'string' && body.session !== '' ? body.session : undefined,
                // 候选链：书的归属会话（创建它的会话 agent 大概率活着、工作区必然对）
                sessionCandidates: Array.isArray(novel.sessions) ? novel.sessions.filter((s) => typeof s === 'string' && s !== '') : [],
            });
            writeJson(res, 200, {
                ok: true,
                value: {
                    resumed,
                    concurrency: result.concurrency,
                    stats: result.stats,
                    warnings: result.warnings,
                    items: result.items,
                    results: result.results.map((r) => ({
                        chapter: r.chapter, ok: r.ok, committed: r.committed,
                        ...(r.title === undefined ? {} : { title: r.title }),
                        ...(r.chars === undefined ? {} : { chars: r.chars }),
                        ...(r.version === undefined ? {} : { version: r.version }),
                        ...(r.stage === undefined ? {} : { stage: r.stage }),
                        ...(r.reason === undefined ? {} : { reason: r.reason }),
                        ...(r.contentGate === undefined ? {} : { contentGate: r.contentGate }),
                        ...(r.noai === undefined ? {} : { noai: r.noai }),
                    })),
                },
            });
        } catch (error) {
            fail(res, 500, 'IO_FAILURE', String(error));
        }
        return true;
    }

    return false;
}