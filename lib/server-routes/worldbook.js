// lib/server-routes/worldbook.js — 世界书条目 CRUD。
//
// 从 server-api.js 按域拆出；每条路由的入口条件、fence 校验位置、响应体逐字保留。
// 条目 id 是字符串（工具默认 W1/W2…，自定义 id 任意）——严禁 Number 强转
// （'W1'→NaN 永不匹配，面板启用/停用按钮全坏；真机测试 2026-09-21 实锤）。

/**
 * @param {object} req 请求
 * @param {object} res 响应
 * @param {string[]} segments 路径段
 * @param {object} api 共享依赖（http 基元 + workspace 索引 + 库）
 * @returns {Promise<boolean>} 是否已处理
 */
export async function handle(req, res, segments, api) {
    const { writeJson, readJsonBody, trusted, fail, safeDecode, validBookId, locateBook, store, updateJson } = api;

    // GET /worldbook/:bookId — 世界书列表
    if (req.method === 'GET' && segments[0] === 'worldbook' && segments.length === 2) {
        if (!trusted(req)) { fail(res, 403, 'FORBIDDEN', 'missing fence header'); return true; }
        const bookId = safeDecode(segments[1]);
        if (!validBookId(bookId)) { fail(res, 400, 'BAD_BOOK', 'invalid book id'); return true; }
        try {
            const found = await locateBook(bookId);
            if (!found) { fail(res, 404, 'NOT_FOUND', '书不存在'); return true; }
            const fsio = found.fsio;
            const text = await fsio.readText(`${bookId}/设定/世界书.json`).catch(() => '[]');
            const entries = JSON.parse(text || '[]');
            writeJson(res, 200, { ok: true, value: entries });
        } catch (error) {
            fail(res, 500, 'IO_FAILURE', String(error));
        }
        return true;
    }

    // POST /worldbook/:bookId — 新建世界书条目
    if (req.method === 'POST' && segments[0] === 'worldbook' && segments.length === 2) {
        if (!trusted(req)) { fail(res, 403, 'FORBIDDEN', 'missing fence header'); return true; }
        const bookId = safeDecode(segments[1]);
        if (!validBookId(bookId)) { fail(res, 400, 'BAD_BOOK', 'invalid book id'); return true; }
        try {
            const body = await readJsonBody(req);
            const found = await locateBook(bookId);
            if (!found) { fail(res, 404, 'NOT_FOUND', '书不存在'); return true; }
            const fsio = found.fsio;
            // 读-改-写走守卫重放：id = max+1 必须从**重读后的最新列表**算。
            // 旧实现是「读全文 → push → 无条件覆盖写」，两个面板同时新增会撞
            // 同一个 id，后写者还会把先写者刚加的那条整份抹掉。
            const { result: entry } = await updateJson(fsio, `${bookId}/设定/世界书.json`, (current) => {
                const entries = Array.isArray(current) ? current : [];
                // id 生成走 store.js 的单一入口（nextWorldEntryId → 'W1'/W2…），与
                // 工具/导入同源。旧实现各自 Math.max 数字自增：已有字符串 id（'W1'）
                // 时求值得 NaN → 落盘 "id": null（真机可复现，面板「＋新建」即触发）。
                const id = store.nextWorldEntryId(entries);
                const created = {
                    id,
                    name: String(body.name ?? '').trim(),
                    content: String(body.content ?? ''),
                    keywords: typeof body.keywords === 'string'
                        ? body.keywords.split(',').map(s => s.trim()).filter(Boolean)
                        : Array.isArray(body.keywords) ? body.keywords : [],
                    always_active: body.always_active === true,
                    enabled: body.enabled !== false,
                    priority: typeof body.priority === 'number' ? body.priority : 50,
                    book_id: String(body.book_id ?? ''),
                };
                entries.push(created);
                return { value: entries, result: created };
            });
            writeJson(res, 200, { ok: true, value: entry });
        } catch (error) {
            fail(res, 500, 'IO_FAILURE', String(error));
        }
        return true;
    }

    // PUT /worldbook/:bookId/:entryId — 更新世界书条目
    if (req.method === 'PUT' && segments[0] === 'worldbook' && segments.length === 3) {
        if (!trusted(req)) { fail(res, 403, 'FORBIDDEN', 'missing fence header'); return true; }
        const bookId = safeDecode(segments[1]);
        if (!validBookId(bookId)) { fail(res, 400, 'BAD_BOOK', 'invalid book id'); return true; }
        // 条目 id 是字符串（工具默认 W1/W2…，自定义 id 任意）——严禁 Number 强转
        // （'W1'→NaN 永不匹配，面板启用/停用按钮全坏；真机测试 2026-09-21 实锤）
        const entryId = safeDecode(segments[2]);
        try {
            const body = await readJsonBody(req);
            const found = await locateBook(bookId);
            if (!found) { fail(res, 404, 'NOT_FOUND', '书不存在'); return true; }
            const fsio = found.fsio;
            // 守卫重放：合并必须基于**重读后的那一条**（窗口里别人可能刚改过它），
            // 条目已被删除时不覆盖写、直接 404
            const { written, result } = await updateJson(fsio, `${bookId}/设定/世界书.json`, (current) => {
                const entries = Array.isArray(current) ? current : [];
                const idx = entries.findIndex((e) => String(e.id) === String(entryId));
                if (idx === -1) return undefined;
                const prev = entries[idx];
                const keywords = typeof body.keywords === 'string'
                    ? body.keywords.split(',').map(s => s.trim()).filter(Boolean)
                    : Array.isArray(body.keywords) ? body.keywords : prev.keywords;
                entries[idx] = {
                    ...prev,
                    name: typeof body.name === 'string' ? body.name.trim() || prev.name : prev.name,
                    content: typeof body.content === 'string' ? body.content : prev.content,
                    keywords,
                    always_active: typeof body.always_active === 'boolean' ? body.always_active : prev.always_active,
                    enabled: typeof body.enabled === 'boolean' ? body.enabled : prev.enabled,
                    priority: typeof body.priority === 'number' ? body.priority : prev.priority,
                    id: prev.id,  // 存储 id 原样保留（URL 段是字符串，回写会把数字 id 腐蚀成 '1'）
                };
                return { value: entries, result: entries[idx] };
            });
            if (!written) { fail(res, 404, 'NOT_FOUND', '条目不存在'); return true; }
            writeJson(res, 200, { ok: true, value: result });
        } catch (error) {
            fail(res, 500, 'IO_FAILURE', String(error));
        }
        return true;
    }

    // DELETE /worldbook/:bookId/:entryId — 删除世界书条目
    if (req.method === 'DELETE' && segments[0] === 'worldbook' && segments.length === 3) {
        if (!trusted(req)) { fail(res, 403, 'FORBIDDEN', 'missing fence header'); return true; }
        const bookId = safeDecode(segments[1]);
        if (!validBookId(bookId)) { fail(res, 400, 'BAD_BOOK', 'invalid book id'); return true; }
        const entryId = safeDecode(segments[2]);
        try {
            const found = await locateBook(bookId);
            if (!found) { fail(res, 404, 'NOT_FOUND', '书不存在'); return true; }
            const fsio = found.fsio;
            // 守卫重放；没删到任何条目就**不写盘**（旧实现会把不存在条目的删除
            // 写成一次无条件覆盖，文件原本不存在时还会凭空建出一个 [] 世界书）
            const { written } = await updateJson(fsio, `${bookId}/设定/世界书.json`, (current) => {
                const entries = Array.isArray(current) ? current : [];
                const kept = entries.filter((e) => String(e.id) !== String(entryId));
                if (kept.length === entries.length) return undefined;
                return { value: kept };
            });
            if (!written) { fail(res, 404, 'NOT_FOUND', '条目不存在'); return true; }
            writeJson(res, 200, { ok: true, value: { deleted: entryId } });
        } catch (error) {
            fail(res, 500, 'IO_FAILURE', String(error));
        }
        return true;
    }

    return false;
}