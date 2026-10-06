// lib/server-routes/proposals.js — 提案端点（融合第一批 · A1）。
//
// 从 server-api.js 按域拆出；每条路由的入口条件、fence 校验位置、响应体逐字保留。
//
// 提案的「应用 / 丢弃 / 清理」是**用户主权动作**，刻意不进工具面
// （见 lib/tools/propose-tools.js 的 enum 只有 propose/list）。
// 面板通过这几个端点操作，审计里 actor 一律记 'user' ——
// 于是「谁批准的修订」在 audit.jsonl 里可查，模型无法自己批准自己。

/**
 * @param {object} req 请求
 * @param {object} res 响应
 * @param {string[]} segments 路径段
 * @param {object} api 共享依赖（http 基元 + workspace 索引 + 库）
 * @returns {Promise<boolean>} 是否已处理
 */
export async function handle(req, res, segments, api) {
    const { writeJson, trusted, fail, safeDecode, validBookId, locateBook, proposals } = api;

    // GET /projects/:id/proposals — 列出提案
    if (req.method === 'GET' && segments[0] === 'projects' && segments[2] === 'proposals' && segments.length === 3) {
        if (!trusted(req)) { fail(res, 403, 'FORBIDDEN', 'missing fence header'); return true; }
        const bookId = safeDecode(segments[1]);
        if (!validBookId(bookId)) { fail(res, 400, 'BAD_BOOK', 'invalid book id'); return true; }
        try {
            const found = await locateBook(bookId);
            if (!found) { fail(res, 404, 'NOT_FOUND', '书不存在'); return true; }
            const value = await proposals.listProposals(found.fsio, bookId);
            writeJson(res, 200, { ok: true, value });
        } catch (error) {
            fail(res, 500, 'IO_FAILURE', String(error));
        }
        return true;
    }

    // GET /projects/:id/proposals/:pid — 单条提案全文（应用前让人看清改了什么）
    if (req.method === 'GET' && segments[0] === 'projects' && segments[2] === 'proposals' && segments.length === 4) {
        if (!trusted(req)) { fail(res, 403, 'FORBIDDEN', 'missing fence header'); return true; }
        const bookId = safeDecode(segments[1]);
        if (!validBookId(bookId)) { fail(res, 400, 'BAD_BOOK', 'invalid book id'); return true; }
        try {
            const found = await locateBook(bookId);
            if (!found) { fail(res, 404, 'NOT_FOUND', '书不存在'); return true; }
            const value = await proposals.readProposal(found.fsio, bookId, safeDecode(segments[3]));
            writeJson(res, 200, { ok: true, value });
        } catch (error) {
            fail(res, 404, 'PROPOSAL_NOT_FOUND', String(error?.message ?? error));
        }
        return true;
    }

    // POST /projects/:id/proposals/prune — 清理已终态提案索引
    if (req.method === 'POST' && segments[0] === 'projects' && segments[2] === 'proposals' && segments[3] === 'prune' && segments.length === 4) {
        if (!trusted(req)) { fail(res, 403, 'FORBIDDEN', 'missing fence header'); return true; }
        const bookId = safeDecode(segments[1]);
        if (!validBookId(bookId)) { fail(res, 400, 'BAD_BOOK', 'invalid book id'); return true; }
        try {
            const found = await locateBook(bookId);
            if (!found) { fail(res, 404, 'NOT_FOUND', '书不存在'); return true; }
            const value = await proposals.pruneProposals(found.fsio, bookId, 'user');
            writeJson(res, 200, { ok: true, value });
        } catch (error) {
            fail(res, 400, 'PROPOSAL_REJECTED', String(error?.message ?? error));
        }
        return true;
    }

    // POST /projects/:id/proposals/:pid/apply — 应用提案（生成新版本，旧版保留）
    if (req.method === 'POST' && segments[0] === 'projects' && segments[2] === 'proposals' && segments[4] === 'apply' && segments.length === 5) {
        if (!trusted(req)) { fail(res, 403, 'FORBIDDEN', 'missing fence header'); return true; }
        const bookId = safeDecode(segments[1]);
        if (!validBookId(bookId)) { fail(res, 400, 'BAD_BOOK', 'invalid book id'); return true; }
        const proposalId = safeDecode(segments[3]);
        try {
            const found = await locateBook(bookId);
            if (!found) { fail(res, 404, 'NOT_FOUND', '书不存在'); return true; }
            const value = await proposals.applyProposal(found.fsio, bookId, proposalId, api.config, 'user');
            writeJson(res, 200, { ok: true, value });
        } catch (error) {
            // 提案不存在 / 状态非 pending / 文件缺失 都是业务性拒绝，不是服务故障。
            fail(res, 400, 'PROPOSAL_REJECTED', String(error?.message ?? error));
        }
        return true;
    }

    // POST /projects/:id/proposals/:pid/discard — 丢弃提案（正文不动）
    if (req.method === 'POST' && segments[0] === 'projects' && segments[2] === 'proposals' && segments[4] === 'discard' && segments.length === 5) {
        if (!trusted(req)) { fail(res, 403, 'FORBIDDEN', 'missing fence header'); return true; }
        const bookId = safeDecode(segments[1]);
        if (!validBookId(bookId)) { fail(res, 400, 'BAD_BOOK', 'invalid book id'); return true; }
        const proposalId = safeDecode(segments[3]);
        try {
            const found = await locateBook(bookId);
            if (!found) { fail(res, 404, 'NOT_FOUND', '书不存在'); return true; }
            const value = await proposals.discardProposal(found.fsio, bookId, proposalId, 'user');
            writeJson(res, 200, { ok: true, value });
        } catch (error) {
            fail(res, 400, 'PROPOSAL_REJECTED', String(error?.message ?? error));
        }
        return true;
    }

    return false;
}