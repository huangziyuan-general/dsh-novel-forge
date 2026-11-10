// lib/server-routes/proposals.js — 提案端点（融合第一批 · A1）。
//
// 从 server-api.js 按域拆出；每条路由的入口条件、响应体逐字保留。

import { applyExtractionProposal, listExtractionProposals } from '../extraction-io.js';
// fence 校验已中央收口到 server-api.js 派发层（2026-10-28），路由内不再各自检查。
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
    const { writeJson, readJsonBody, fail, failError, safeDecode, validBookId, locateBook, proposals, requestSession, store } = api;

    // GET /projects/:id/proposals — 列出提案
    if (req.method === 'GET' && segments[0] === 'projects' && segments[2] === 'proposals' && segments.length === 3) {
        const bookId = safeDecode(segments[1]);
        if (!validBookId(bookId)) { fail(res, 400, 'BAD_BOOK', 'invalid book id'); return true; }
        try {
            const found = await locateBook(bookId, { session: requestSession(req) });
            if (!found) { fail(res, 404, 'NOT_FOUND', '书不存在'); return true; }
            const value = await proposals.listProposals(found.fsio, bookId);
            const extractionProposals = await listExtractionProposals(found.fsio, store.pathsFor(bookId));
            writeJson(res, 200, { ok: true, value: { ...value, extractionProposals } });
        } catch (error) {
            failError(res, error);
        }
        return true;
    }

    // GET /projects/:id/proposals/:pid — 单条提案全文（应用前让人看清改了什么）
    if (req.method === 'GET' && segments[0] === 'projects' && segments[2] === 'proposals' && segments.length === 4) {
        const bookId = safeDecode(segments[1]);
        if (!validBookId(bookId)) { fail(res, 400, 'BAD_BOOK', 'invalid book id'); return true; }
        try {
            const found = await locateBook(bookId, { session: requestSession(req) });
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
        const bookId = safeDecode(segments[1]);
        if (!validBookId(bookId)) { fail(res, 400, 'BAD_BOOK', 'invalid book id'); return true; }
        try {
            const found = await locateBook(bookId, { session: requestSession(req) });
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
        const bookId = safeDecode(segments[1]);
        if (!validBookId(bookId)) { fail(res, 400, 'BAD_BOOK', 'invalid book id'); return true; }
        const proposalId = safeDecode(segments[3]);
        try {
            const found = await locateBook(bookId, { session: requestSession(req) });
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
        const bookId = safeDecode(segments[1]);
        if (!validBookId(bookId)) { fail(res, 400, 'BAD_BOOK', 'invalid book id'); return true; }
        const proposalId = safeDecode(segments[3]);
        try {
            const found = await locateBook(bookId, { session: requestSession(req) });
            if (!found) { fail(res, 404, 'NOT_FOUND', '书不存在'); return true; }
            const value = await proposals.discardProposal(found.fsio, bookId, proposalId, 'user');
            writeJson(res, 200, { ok: true, value });
        } catch (error) {
            fail(res, 400, 'PROPOSAL_REJECTED', String(error?.message ?? error));
        }
        return true;
    }

    // POST /projects/:id/proposals/:pid/merge — 用户在面板逐段选择后应用三路合并稿
    if (req.method === 'POST' && segments[0] === 'projects' && segments[2] === 'proposals' && segments[4] === 'merge' && segments.length === 5) {
        const bookId = safeDecode(segments[1]);
        if (!validBookId(bookId)) { fail(res, 400, 'BAD_BOOK', 'invalid book id'); return true; }
        let body;
        try { body = await readJsonBody(req); } catch (error) { failError(res, error); return true; }
        if (typeof body.content !== 'string' || body.content.trim() === ''
            || !Number.isInteger(body.currentVersion) || typeof body.currentHash !== 'string') {
            fail(res, 400, 'INVALID_FIELD', '合并需要非空 content、整数 currentVersion 与 currentHash'); return true;
        }
        const proposalId = safeDecode(segments[3]);
        try {
            const found = await locateBook(bookId, { session: requestSession(req, body) });
            if (!found) { fail(res, 404, 'NOT_FOUND', '书不存在'); return true; }
            const value = await proposals.applyProposal(found.fsio, bookId, proposalId, api.config, 'user', {
                mergedContent: body.content, expectedVersion: body.currentVersion, expectedHash: body.currentHash,
            });
            writeJson(res, 200, { ok: true, value });
        } catch (error) {
            if (error?.code === 'MERGE_CONFLICT') fail(res, 409, 'MERGE_CONFLICT', String(error?.message ?? error));
            else fail(res, 400, 'PROPOSAL_REJECTED', String(error?.message ?? error));
        }
        return true;
    }

    // GET /projects/:id/extraction-proposals — 人物/设定候选（模型不可经此应用）。
    if (req.method === 'GET' && segments[0] === 'projects' && segments[2] === 'extraction-proposals' && segments.length === 3) {
        const bookId = safeDecode(segments[1]);
        if (!validBookId(bookId)) { fail(res, 400, 'BAD_BOOK', 'invalid book id'); return true; }
        try {
            const found = await locateBook(bookId, { session: requestSession(req) });
            if (!found) { fail(res, 404, 'NOT_FOUND', '书不存在'); return true; }
            const value = await listExtractionProposals(found.fsio, store.pathsFor(bookId));
            writeJson(res, 200, { ok: true, value: { proposals: value } });
        } catch (error) { failError(res, error); }
        return true;
    }

    // POST /projects/:id/extraction-proposals/:pid/apply — 用户逐项编辑/选择后应用。
    if (req.method === 'POST' && segments[0] === 'projects' && segments[2] === 'extraction-proposals' && segments[4] === 'apply' && segments.length === 5) {
        const bookId = safeDecode(segments[1]);
        const proposalId = safeDecode(segments[3]);
        if (!validBookId(bookId) || !/^[A-Za-z0-9_-]{1,64}$/.test(proposalId)) { fail(res, 400, 'BAD_PROPOSAL', '书或提案 id 不合式'); return true; }
        let body;
        try { body = await readJsonBody(req); } catch (error) { failError(res, error); return true; }
        if (!Array.isArray(body.items) || body.items.length === 0 || body.items.length > 20
            || body.items.some((item) => item === null || typeof item !== 'object' || Array.isArray(item) || typeof item.id !== 'string')) {
            fail(res, 400, 'INVALID_FIELD', 'items 必须是 1–20 个带 id 的候选对象'); return true;
        }
        try {
            const found = await locateBook(bookId, { session: requestSession(req, body) });
            if (!found) { fail(res, 404, 'NOT_FOUND', '书不存在'); return true; }
            const value = await applyExtractionProposal(found.fsio, bookId, proposalId, body.items);
            writeJson(res, 200, { ok: true, value });
        } catch (error) {
            if (/已变化|已处理|已出现/.test(String(error?.message ?? error))) fail(res, 409, 'EXTRACTION_CONFLICT', String(error.message));
            else fail(res, 400, 'EXTRACTION_REJECTED', String(error?.message ?? error));
        }
        return true;
    }

    return false;
}
