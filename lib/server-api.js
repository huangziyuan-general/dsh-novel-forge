// lib/server-api.js — 服务端 REST API（对齐大胖鱼的 /api/novel-writer 模式）。
//
// 浏览器通过 fetch() 调用这些端点，实现抽屉 UI 的写操作（写章/润色/世界书 CRUD）。
// 安全：fence header 校验（防止跨域调用）。
// 门禁：未启用时返回 503。

import { createServerFsio } from './fsio.js';
import * as store from './store.js';
import * as gate from './gate.js';
import * as ledger from './ledger.js';
import * as versioning from './versioning.js';
import * as contextpack from './contextpack.js';
import * as noai from './noai.js';
import * as auditLib from './audit.js';
import * as importLib from './import.js';
import * as exportLib from './export.js';
import * as glossaryLib from './glossary.js';
import * as worldbookIo from './worldbook-io.js';
import * as bookConsole from './book-console.js';

const PREFIX = '/api/novel-forge';
const FENCE_HEADER = 'x-dsh-novel-forge';

/**
 * 注册 REST API 路由。
 * @param {object} ctx - cordis 上下文（需注入 webServer + fs）
 * @param {object} config - 插件配置
 */
export function registerServerApi(ctx, config) {
    ctx.inject(['webServer'], (wctx) => {
        const writeJson = (res, status, value) => {
            res.writeHead(status, {
                'content-type': 'application/json; charset=utf-8',
                'cache-control': 'no-store',
            });
            res.end(JSON.stringify(value));
        };

        const readJsonBody = (req) => new Promise((resolve, reject) => {
            let data = '';
            req.on('data', (chunk) => { data += String(chunk); });
            req.on('end', () => {
                try { resolve(data ? JSON.parse(data) : {}); }
                catch { reject(new Error('invalid JSON body')); }
            });
            req.on('error', reject);
        });

        const trusted = (req) => req.headers[FENCE_HEADER] === '1';

        const fail = (res, status, code, message) => {
            writeJson(res, status, { ok: false, error: { code, message } });
        };

        /** 创建 fsio 适配器（绑定到会话工作区）。 */
        const makeFsio = (cwd) => createServerFsio(ctx, cwd);

        /** 从请求 URL 解析路径段。 */
        const parsePath = (url) => {
            const pathname = new URL(url ?? '/', 'http://localhost').pathname;
            const rest = pathname.slice(PREFIX.length);
            return rest.split('/').filter(Boolean);
        };

        /** 从请求 URL 解析查询参数。 */
        const parseQuery = (url) => new URL(url ?? '/', 'http://localhost').searchParams;

        /**
         * 扫描工作区一级目录，挑出「是锻炉书」的目录并解析其 novel.json。
         *
         * 一次扫描喂三个用途：全量列表、按会话过滤、未归属列表 ——
         * 避免每个用途各自再读一遍盘。
         * @returns {Promise<Array<{name:string, text:string, novel:object}>>}
         */
        const scanBooks = async (fsio) => {
            const names = await fsio.listNames('.');
            const books = [];
            for (const name of names) {
                try {
                    const text = await fsio.readText(`${name}/novel.json`);
                    if (!text) continue;                       // 不是锻炉书，跳过
                    const novel = JSON.parse(text);
                    books.push({ name, text, novel });
                } catch { /* 非法 JSON 或读不到：当作非书 */ }
            }
            return books;
        };

        /**
         * 把扫描结果渲染成面板要的摘要（会话过滤在调用方做）。
         * @param {Array} scanned scanBooks 的产物
         */
        const summarize = async (fsio, scanned) => {
            const out = [];
            for (const { name, text } of scanned) {
                const factsText = await fsio.readText(`${name}/账本/facts.json`).catch(() => null);
                const foreshadowsText = await fsio.readText(`${name}/账本/伏笔.json`).catch(() => null);
                out.push(bookConsole.summarizeBook({ name, novel: text, facts: factsText, foreshadows: foreshadowsText }));
            }
            return out;
        };

        wctx.effect(() => wctx.webServer.register({
            kind: 'prefix',
            path: PREFIX,
            handler: async (req, res) => {
                const segments = parsePath(req.url);

                // GET /projects[?session=<id>][&scope=unclaimed|all] — 列出书
                //
                // 「项目跟会话走」：给了 session 就只返回该会话的书（sessions 归属集），
                // scope=unclaimed 返回未归属的旧书（供面板认领）。两个都没给 = 全量，
                // 方便 curl 直接调试。
                if (req.method === 'GET' && segments[0] === 'projects' && segments.length === 1) {
                    if (!trusted(req)) return fail(res, 403, 'FORBIDDEN', 'missing fence header');
                    try {
                        const query = parseQuery(req.url);
                        const session = query.get('session');
                        const scope = query.get('scope');
                        const root = config.workspaceRoot || process.cwd();
                        const fsio = makeFsio(root);
                        const scanned = await scanBooks(fsio);
                        const picked = scope === 'unclaimed'
                            ? scanned.filter((b) => store.isUnclaimed(b.novel))
                            : scope === 'all' || !session
                                ? scanned
                                : scanned.filter((b) => store.bookInSession(b.novel, session));
                        writeJson(res, 200, { ok: true, value: await summarize(fsio, picked) });
                    } catch (error) {
                        fail(res, 500, 'IO_FAILURE', String(error));
                    }
                    return;
                }

                // POST /projects/claim — 把未归属的旧书认领到本会话
                // body: { session, ids?: string[] }（ids 省略 = 认领全部未归属）
                if (req.method === 'POST' && segments[0] === 'projects' && segments[1] === 'claim' && segments.length === 2) {
                    if (!trusted(req)) return fail(res, 403, 'FORBIDDEN', 'missing fence header');
                    try {
                        const body = await readJsonBody(req);
                        const session = String(body.session ?? '').trim();
                        if (!session) return fail(res, 400, 'INVALID_FIELD', '缺少 session（认领需要知道归给哪个会话）');
                        const only = Array.isArray(body.ids) ? new Set(body.ids.map(String)) : null;
                        const root = config.workspaceRoot || process.cwd();
                        const fsio = makeFsio(root);
                        const scanned = await scanBooks(fsio);
                        const claimed = [];
                        for (const { name, novel } of scanned) {
                            if (only && !only.has(name)) continue;
                            if (!store.isUnclaimed(novel)) continue;    // 已有归属的不动（别抢别人的书）
                            store.addBookSession(novel, session);
                            await fsio.writeText(`${name}/novel.json`, `${JSON.stringify(novel, null, 2)}\n`);
                            claimed.push(name);
                        }
                        writeJson(res, 200, { ok: true, value: { claimed } });
                    } catch (error) {
                        fail(res, 500, 'IO_FAILURE', String(error));
                    }
                    return;
                }

                // POST /projects — 创建新书
                if (req.method === 'POST' && segments[0] === 'projects' && segments.length === 1) {
                    if (!trusted(req)) return fail(res, 403, 'FORBIDDEN', 'missing fence header');
                    try {
                        const body = await readJsonBody(req);
                        const title = String(body.title ?? '').trim();
                        if (!title) return fail(res, 400, 'INVALID_FIELD', '书名不能为空');
                        const root = config.workspaceRoot || process.cwd();
                        const fsio = makeFsio(root);
                        const genre = String(body.genre ?? 'fantasy');
                        const slug = title.replace(/[\/\\:*?"<>|]/g, '_');
                        // 归属落盘：面板只列本会话创建的书，所以创建时就打上会话戳
                        const session = String(body.session ?? '').trim();
                        const novel = store.defaultNovel({ title, genre, session: session || null });
                        await fsio.writeText(`${slug}/novel.json`, `${JSON.stringify(novel, null, 2)}\n`);
                        writeJson(res, 200, { ok: true, value: { id: slug, title, genre } });
                    } catch (error) {
                        fail(res, 500, 'IO_FAILURE', String(error));
                    }
                    return;
                }

                // GET /projects/:id — 书详情
                if (req.method === 'GET' && segments[0] === 'projects' && segments.length === 2) {
                    if (!trusted(req)) return fail(res, 403, 'FORBIDDEN', 'missing fence header');
                    const bookId = segments[1];
                    try {
                        const root = config.workspaceRoot || process.cwd();
                        const fsio = makeFsio(root);
                        const text = await fsio.readText(`${bookId}/novel.json`);
                        if (!text) return fail(res, 404, 'NOT_FOUND', '书不存在');
                        const novel = JSON.parse(text);
                        writeJson(res, 200, { ok: true, value: { id: bookId, ...novel } });
                    } catch (error) {
                        fail(res, 500, 'IO_FAILURE', String(error));
                    }
                    return;
                }

                // GET /projects/:id/chapters/:no — 读章节正文
                if (req.method === 'GET' && segments[0] === 'projects' && segments[2] === 'chapters' && segments.length === 4) {
                    if (!trusted(req)) return fail(res, 403, 'FORBIDDEN', 'missing fence header');
                    const bookId = segments[1];
                    const chapterNo = Number(segments[3]);
                    try {
                        const root = config.workspaceRoot || process.cwd();
                        const fsio = makeFsio(root);
                        const text = await fsio.readText(`${bookId}/novel.json`);
                        if (!text) return fail(res, 404, 'NOT_FOUND', '书不存在');
                        const novel = JSON.parse(text);
                        const rec = novel.chapters?.[String(chapterNo)];
                        if (!rec?.file) return writeJson(res, 200, { ok: true, value: '' });
                        const content = await fsio.readText(`${bookId}/正文/${rec.file}`).catch(() => '');
                        writeJson(res, 200, { ok: true, value: content ?? '' });
                    } catch (error) {
                        fail(res, 500, 'IO_FAILURE', String(error));
                    }
                    return;
                }

                // POST /projects/:id/chapters/:no — 保存章节
                if (req.method === 'POST' && segments[0] === 'projects' && segments[2] === 'chapters' && segments.length === 4) {
                    if (!trusted(req)) return fail(res, 403, 'FORBIDDEN', 'missing fence header');
                    const bookId = segments[1];
                    const chapterNo = Number(segments[3]);
                    try {
                        const body = await readJsonBody(req);
                        const title = String(body.title ?? `第 ${chapterNo} 章`);
                        const content = String(body.text ?? '');
                        const root = config.workspaceRoot || process.cwd();
                        const fsio = makeFsio(root);
                        const text = await fsio.readText(`${bookId}/novel.json`);
                        if (!text) return fail(res, 404, 'NOT_FOUND', '书不存在');
                        const novel = JSON.parse(text);
                        const prev = novel.chapters?.[String(chapterNo)];
                        const version = (prev?.version ?? 0) + 1;
                        const fileName = versioning.chapterFileName(chapterNo, title, version);
                        await fsio.writeText(`${bookId}/正文/${fileName}`, content);
                        const rec = store.chapterRecord(prev, { title, version, file: fileName, chars: content.length });
                        if (!novel.chapters) novel.chapters = {};
                        novel.chapters[String(chapterNo)] = rec;
                        await fsio.writeText(`${bookId}/novel.json`, JSON.stringify(novel, null, 2));
                        writeJson(res, 200, { ok: true, value: { chapter: rec, text: content } });
                    } catch (error) {
                        fail(res, 500, 'IO_FAILURE', String(error));
                    }
                    return;
                }

                // POST /projects/:id/chapters/:no/write — 一键写章（调用 briefing + write_chapter 工具逻辑）
                if (req.method === 'POST' && segments[0] === 'projects' && segments[2] === 'chapters' && segments[4] === 'write' && segments.length === 5) {
                    if (!trusted(req)) return fail(res, 403, 'FORBIDDEN', 'missing fence header');
                    // 写章需要模型参与，从 HTTP 端无法直接调用
                    // 返回 501 提示用户通过聊天调用 novel_write_chapter
                    return fail(res, 501, 'NOT_IMPLEMENTED', '一键写章需要模型参与，请在聊天中调用 novel_write_chapter');
                }

                // POST /projects/:id/chapters/:no/polish — 一键润色（调用 novel_polish 工具逻辑）
                if (req.method === 'POST' && segments[0] === 'projects' && segments[2] === 'chapters' && segments[4] === 'polish' && segments.length === 5) {
                    if (!trusted(req)) return fail(res, 403, 'FORBIDDEN', 'missing fence header');
                    // 润色需要模型参与，从 HTTP 端无法直接调用
                    return fail(res, 501, 'NOT_IMPLEMENTED', '一键润色需要模型参与，请在聊天中调用 novel_polish');
                }

                // POST /projects/:id/export — 导出
                if (req.method === 'POST' && segments[0] === 'projects' && segments[2] === 'export' && segments.length === 3) {
                    if (!trusted(req)) return fail(res, 403, 'FORBIDDEN', 'missing fence header');
                    const bookId = segments[1];
                    try {
                        const root = config.workspaceRoot || process.cwd();
                        const fsio = makeFsio(root);
                        const text = await fsio.readText(`${bookId}/novel.json`);
                        if (!text) return fail(res, 404, 'NOT_FOUND', '书不存在');
                        const novel = JSON.parse(text);
                        const body = await readJsonBody(req);
                        const format = body.format === 'markdown' ? 'md' : 'txt';
                        const result = exportLib.assembleBook(fsio, novel, { format });
                        writeJson(res, 200, { ok: true, value: result });
                    } catch (error) {
                        fail(res, 500, 'IO_FAILURE', String(error));
                    }
                    return;
                }

                // DELETE /projects/:id — 删除书
                if (req.method === 'DELETE' && segments[0] === 'projects' && segments.length === 2) {
                    if (!trusted(req)) return fail(res, 403, 'FORBIDDEN', 'missing fence header');
                    const bookId = segments[1];
                    try {
                        const root = config.workspaceRoot || process.cwd();
                        const fsio = makeFsio(root);
                        // 删除 novel.json（标记为非书）
                        await fsio.writeText(`${bookId}/novel.json`, '');
                        writeJson(res, 200, { ok: true, value: { deleted: bookId } });
                    } catch (error) {
                        fail(res, 500, 'IO_FAILURE', String(error));
                    }
                    return;
                }

                // ── 世界书 ──

                // GET /worldbook/:bookId — 世界书列表
                if (req.method === 'GET' && segments[0] === 'worldbook' && segments.length === 2) {
                    if (!trusted(req)) return fail(res, 403, 'FORBIDDEN', 'missing fence header');
                    const bookId = segments[1];
                    try {
                        const root = config.workspaceRoot || process.cwd();
                        const fsio = makeFsio(root);
                        const text = await fsio.readText(`${bookId}/设定/世界书.json`).catch(() => '[]');
                        const entries = JSON.parse(text || '[]');
                        writeJson(res, 200, { ok: true, value: entries });
                    } catch (error) {
                        fail(res, 500, 'IO_FAILURE', String(error));
                    }
                    return;
                }

                // POST /worldbook/:bookId — 新建世界书条目
                if (req.method === 'POST' && segments[0] === 'worldbook' && segments.length === 2) {
                    if (!trusted(req)) return fail(res, 403, 'FORBIDDEN', 'missing fence header');
                    const bookId = segments[1];
                    try {
                        const body = await readJsonBody(req);
                        const root = config.workspaceRoot || process.cwd();
                        const fsio = makeFsio(root);
                        const text = await fsio.readText(`${bookId}/设定/世界书.json`).catch(() => '[]');
                        const entries = JSON.parse(text || '[]');
                        const id = entries.length > 0 ? Math.max(...entries.map(e => e.id ?? 0)) + 1 : 1;
                        const entry = {
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
                        entries.push(entry);
                        await fsio.writeText(`${bookId}/设定/世界书.json`, JSON.stringify(entries, null, 2));
                        writeJson(res, 200, { ok: true, value: entry });
                    } catch (error) {
                        fail(res, 500, 'IO_FAILURE', String(error));
                    }
                    return;
                }

                // PUT /worldbook/:bookId/:entryId — 更新世界书条目
                if (req.method === 'PUT' && segments[0] === 'worldbook' && segments.length === 3) {
                    if (!trusted(req)) return fail(res, 403, 'FORBIDDEN', 'missing fence header');
                    const bookId = segments[1];
                    const entryId = Number(segments[2]);
                    try {
                        const body = await readJsonBody(req);
                        const root = config.workspaceRoot || process.cwd();
                        const fsio = makeFsio(root);
                        const text = await fsio.readText(`${bookId}/设定/世界书.json`).catch(() => '[]');
                        const entries = JSON.parse(text || '[]');
                        const idx = entries.findIndex(e => e.id === entryId);
                        if (idx === -1) return fail(res, 404, 'NOT_FOUND', '条目不存在');
                        entries[idx] = { ...entries[idx], ...body, id: entryId };
                        if (typeof body.keywords === 'string') {
                            entries[idx].keywords = body.keywords.split(',').map(s => s.trim()).filter(Boolean);
                        }
                        await fsio.writeText(`${bookId}/设定/世界书.json`, JSON.stringify(entries, null, 2));
                        writeJson(res, 200, { ok: true, value: entries[idx] });
                    } catch (error) {
                        fail(res, 500, 'IO_FAILURE', String(error));
                    }
                    return;
                }

                // DELETE /worldbook/:bookId/:entryId — 删除世界书条目
                if (req.method === 'DELETE' && segments[0] === 'worldbook' && segments.length === 3) {
                    if (!trusted(req)) return fail(res, 403, 'FORBIDDEN', 'missing fence header');
                    const bookId = segments[1];
                    const entryId = Number(segments[2]);
                    try {
                        const root = config.workspaceRoot || process.cwd();
                        const fsio = makeFsio(root);
                        const text = await fsio.readText(`${bookId}/设定/世界书.json`).catch(() => '[]');
                        const entries = JSON.parse(text || '[]');
                        const filtered = entries.filter(e => e.id !== entryId);
                        await fsio.writeText(`${bookId}/设定/世界书.json`, JSON.stringify(filtered, null, 2));
                        writeJson(res, 200, { ok: true, value: { deleted: entryId } });
                    } catch (error) {
                        fail(res, 500, 'IO_FAILURE', String(error));
                    }
                    return;
                }

                // 404
                fail(res, 404, 'NOT_FOUND', 'unknown resource');
            },
        }), 'dsh-novel-forge: server-api');
    });
}
