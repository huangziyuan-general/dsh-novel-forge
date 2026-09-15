// lib/server-api.js — 服务端 REST API（对齐大胖鱼的 /api/novel-writer 模式）。
//
// 浏览器通过 fetch() 调用这些端点，实现抽屉 UI 的写操作（写章/润色/世界书 CRUD）。
// 安全：fence header 校验（防止跨域调用）。
// 门禁：未启用时返回 503。

import { createServerFsio } from './fsio.js';
import { cloneProject } from './clone.js';
import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
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
import * as proposals from './proposals.js';
import * as continuity from './continuity.js';
import { loadContinuityInputs } from './continuity-io.js';
import { runRevisionTask, polishIssues } from './engine-tasks.js';
import { sectionOf, parseBanRules } from './gate-metrics.js';
import { runDraftBatch } from './batch-draft.js';

const PREFIX = '/api/novel-forge';
const FENCE_HEADER = 'x-dsh-novel-forge';

/**
 * 注册 REST API 路由。
 * @param {object} ctx - cordis 上下文（需注入 webServer + fs）
 * @param {object} config - 插件配置
 */
export function registerServerApi(ctx, config, deps = {}) {
    /** D1 旁路引擎（由 lib/index.js 注入）。缺省为 null → 端点返回可读的不可用错误。 */
    const engine = deps.engine ?? null;
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

        /** 创建 fsio 适配器（绑定到指定根目录）。 */
        const makeFsio = (cwd) => createServerFsio(ctx, cwd);

        // ── 多工作区扫描（0.6.3）──
        //
        // 书由 AI 工具创建，落在「会话 workspace」（ctx.fs 以会话 cwd 为根）；
        // 而 REST 进程只有一个 cwd。dsh 可以有多个工作区（左侧栏 novel / other / ...），
        // 只扫进程 cwd 就会漏掉其它工作区里的书 —— 面板永远「本会话没有项目」。
        //
        // 解法：会话工作区列表能从 ~/.dsh/sessions/ 的目录名反推
        // （目录名 = `--` + 绝对路径把 / 换成 - + `--`，如 --Users-me-Documents-novel--）。
        // 反推结果用 statSync 验证：含 - 的真实目录名会解码错，验证失败就跳过（安全降级）。

        const SESSIONS_DIR = join(homedir(), '.dsh', 'sessions');

        /** 从 ~/.dsh/sessions 目录名解码全部会话工作区根（`--Users-me-Doc-novel--` → `/Users/me/Doc/novel`）。 */
        let _rootsCache = null;
        let _rootsTs = 0;
        const ROOTS_TTL_MS = 60_000;
        const decodeWorkspaceRoots = () => {
            const now = Date.now();
            if (_rootsCache !== null && now - _rootsTs < ROOTS_TTL_MS) return _rootsCache;
            try {
                _rootsCache = readdirSync(SESSIONS_DIR)
                    .filter((d) => d.startsWith('--') && d.endsWith('--') && d.length > 4)
                    .map((d) => `/${d.slice(2, -2).replace(/-/g, '/')}`)
                    .filter((p) => { try { return statSync(p).isDirectory(); } catch { return false; } });
            } catch { _rootsCache = []; }
            _rootsTs = now;
            return _rootsCache;
        };

        /** 全部扫描根：进程 cwd（或 config.workspaceRoot）优先，其余会话工作区跟上，去重。 */
        const collectRoots = () => [...new Set([config.workspaceRoot || process.cwd(), ...decodeWorkspaceRoots()])];

        /**
         * 扫描所有工作区根下的锻炉书。同名书以 cwd 根优先（roots[0]）。
         * @returns {Promise<Array<{name, text, novel, fsio}>>} fsio 供后续读写该书所在根
         */
        const scanAllBooks = async () => {
            const out = [];
            const seen = new Set();
            for (const root of collectRoots()) {
                const fsio = makeFsio(root);
                for (const b of await scanBooks(fsio)) {
                    if (seen.has(b.name)) continue;
                    seen.add(b.name);
                    out.push({ ...b, fsio });
                }
            }
            return out;
        };

        /** 在所有根里找一本书，返回其 fsio 与 novel.json 原文；找不到返回 null。 */
        const locateBook = async (bookId) => {
            for (const root of collectRoots()) {
                const fsio = makeFsio(root);
                const text = await fsio.readText(`${bookId}/novel.json`).catch(() => null);
                if (text) return { fsio, text };
            }
            return null;
        };

        /** 从请求 URL 解析路径段。 */
        const parsePath = (url) => {
            const pathname = new URL(url ?? '/', 'http://localhost').pathname;
            const rest = pathname.slice(PREFIX.length);
            return rest.split('/').filter(Boolean);
        };

        /** 书目录名校验：拒绝空、`.`、`..` 与带路径分隔符的段。
         *  bookId 来自 URL 路径段、之后会拼进文件路径（`${bookId}/novel.json`），
         *  虽然 ctx.fs.resolve 有工作区边界兜底，但仍是「未校验入路径」——防御性收口。 */
        const validBookId = (id) => typeof id === 'string' && id !== ''
            && id !== '.' && id !== '..' && !/[\\/]/.test(id);

        /** URL 路径段先回解成真名再拼路径（`new URL().pathname` 返回 percent-encoded）——
         *  不解码的话中文书名 `%E6%98%9F...` 会被当成真实目录名，读盘全部失败。 */
        const safeDecode = (s) => {
            try { return decodeURIComponent(String(s ?? '')); }
            catch { return ''; }
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
            const names = await fsio.listDirs('.');
            const books = [];
            for (const name of names) {
                try {
                    const text = await fsio.readText(`${name}/novel.json`);
                    if (!text) continue;                       // 不是锻炉书，跳过
                    const novel = JSON.parse(text);
                    books.push({ name, text, novel });
                } catch (e) { console.warn(`[novel-forge] scanBooks: 跳过 ${name}（${e?.message ?? '非法 JSON'}）`); }
            }
            return books;
        };

        /**
         * 发布前把模型拉进回路（D1 的 REST 面）。
         *
         * 两个端点共用一条实现：polish=按病灶清单整章改写，proofread=机械校对。
         * 三条纪律：
         *   ① 产物一律是**提案**（用户点「应用」才生成新版本）——旁路不能成为绕过提案制的后门；
         *   ② 引擎失败回**人话**（code + message + advice）+ 语义化状态码，不再裸 501；
         *   ③ actor 记 'user'——这是面板按钮触发的，不是模型自己发起的。
         */
        const runChapterRevision = async (req, res, bookId, chapterNo, mode) => {
            if (engine === null) {
                return fail(res, 503, 'ENGINE_UNAVAILABLE', '模型引擎未就绪：本进程没有可用的模型服务');
            }
            try {
                const found = await locateBook(bookId);
                if (!found) return fail(res, 404, 'NOT_FOUND', '书不存在');
                const { fsio } = found;
                const novel = JSON.parse(found.text);
                const rec = novel.chapters?.[String(chapterNo)];
                if (rec?.file === undefined) return fail(res, 400, 'NO_CHAPTER', `第${chapterNo}章尚未保存，无可修订内容`);
                const content = (await fsio.readText(`${bookId}/正文/${rec.file}`).catch(() => null)) ?? '';
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
                            out.push(bookConsole.summarizeBook({ name: b.name, novel: b.text, facts: factsText, foreshadows: foreshadowsText }));
                        }
                        writeJson(res, 200, { ok: true, value: out });
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
                        const scanned = await scanAllBooks();
                        const claimed = [];
                        for (const { name, novel, fsio } of scanned) {
                            if (only && !only.has(name)) continue;
                            if (!store.isUnclaimed(novel)) continue;    // 已有归属的不动（别抢别人的书）
                            store.addBookSession(novel, session);
                            await fsio.writeTextIfVersion(`${name}/novel.json`, `${JSON.stringify(novel, null, 2)}\n`);
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
                        // 与工具侧默认（project-tools 的 init）对齐用中文；'fantasy' 时代已经过去
                        const genre = String(body.genre ?? '').trim() || '未分类';
                        const slug = title.replace(/[\/\\:*?"<>|]/g, '_');
                        // 创建根：优先 body.workspace（面板知道当前会话的工作区），
                        // 缺省回进程 cwd —— 工具建书走的是会话 cwd，面板建书跟它对齐。
                        const ws = String(body.workspace ?? '').trim();
                        const root = ws && !ws.includes('..') ? ws : (config.workspaceRoot || process.cwd());
                        const fsio = makeFsio(root);
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
                    const bookId = safeDecode(segments[1]);
                    if (!validBookId(bookId)) return fail(res, 400, 'BAD_BOOK', 'invalid book id');
                    try {
                        const found = await locateBook(bookId);
                        if (!found) return fail(res, 404, 'NOT_FOUND', '书不存在');
                        const { fsio, text } = found;
                        const novel = JSON.parse(text);
                        writeJson(res, 200, { ok: true, value: { id: bookId, ...novel } });
                    } catch (error) {
                        fail(res, 500, 'IO_FAILURE', String(error));
                    }
                    return;
                }

                // GET /projects/:id/elements — 小说基本要素（基本信息标签：档案/大纲/角色卡/设定/账本时间线）
                if (req.method === 'GET' && segments[0] === 'projects' && segments[2] === 'elements' && segments.length === 3) {
                    if (!trusted(req)) return fail(res, 403, 'FORBIDDEN', 'missing fence header');
                    const bookId = safeDecode(segments[1]);
                    if (!validBookId(bookId)) return fail(res, 400, 'BAD_BOOK', 'invalid book id');
                    try {
                        const found = await locateBook(bookId);
                        if (!found) return fail(res, 404, 'NOT_FOUND', '书不存在');
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
                    return;
                }

                // GET /projects/:id/chapters — 章节目录（听书 / 列表用）
                if (req.method === 'GET' && segments[0] === 'projects' && segments[2] === 'chapters' && segments.length === 3) {
                    if (!trusted(req)) return fail(res, 403, 'FORBIDDEN', 'missing fence header');
                    const bookId = safeDecode(segments[1]);
                    if (!validBookId(bookId)) return fail(res, 400, 'BAD_BOOK', 'invalid book id');
                    try {
                        const found = await locateBook(bookId);
                        if (!found) return fail(res, 404, 'NOT_FOUND', '书不存在');
                        const { fsio, text } = found;
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
                    return;
                }

                // GET /projects/:id/chapters/:no — 读章节正文
                if (req.method === 'GET' && segments[0] === 'projects' && segments[2] === 'chapters' && segments.length === 4) {
                    if (!trusted(req)) return fail(res, 403, 'FORBIDDEN', 'missing fence header');
                    const bookId = safeDecode(segments[1]);
                    if (!validBookId(bookId)) return fail(res, 400, 'BAD_BOOK', 'invalid book id');
                    const chapterNo = Number(segments[3]);
                    try {
                        const found = await locateBook(bookId);
                        if (!found) return fail(res, 404, 'NOT_FOUND', '书不存在');
                        const { fsio, text } = found;
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

                // GET /projects/:id/continuity — 全书一致性校验（面板体检用；纯函数零 token）
                if (req.method === 'GET' && segments[0] === 'projects' && segments[2] === 'continuity' && segments.length === 3) {
                    const bookId = safeDecode(segments[1]);
                    if (!validBookId(bookId)) return fail(res, 400, 'BAD_BOOK', 'invalid book id');
                    try {
                        const found = await locateBook(bookId);
                        if (!found) return fail(res, 404, 'NOT_FOUND', '书不存在');
                        const { fsio, text } = found;
                        const novel = JSON.parse(text);
                        const inputs = await loadContinuityInputs(fsio, store.pathsFor(bookId), novel);
                        const result = continuity.validateContinuity(inputs);
                        writeJson(res, 200, { ok: true, value: { ok: result.ok, stats: result.stats, issues: result.issues } });
                    } catch (error) {
                        fail(res, 500, 'IO_FAILURE', String(error));
                    }
                    return;
                }

                // POST /projects/:id/chapters/:no — 保存章节
                if (req.method === 'POST' && segments[0] === 'projects' && segments[2] === 'chapters' && segments.length === 4) {
                    if (!trusted(req)) return fail(res, 403, 'FORBIDDEN', 'missing fence header');
                    const bookId = safeDecode(segments[1]);
                    if (!validBookId(bookId)) return fail(res, 400, 'BAD_BOOK', 'invalid book id');
                    const chapterNo = Number(segments[3]);
                    try {
                        const body = await readJsonBody(req);
                        const title = String(body.title ?? `第 ${chapterNo} 章`);
                        const content = String(body.text ?? '');
                        const found = await locateBook(bookId);
                        if (!found) return fail(res, 404, 'NOT_FOUND', '书不存在');
                        const { fsio, text } = found;
                        const novel = JSON.parse(text);
                        const prev = novel.chapters?.[String(chapterNo)];
                        const version = (prev?.version ?? 0) + 1;
                        const fileName = versioning.chapterFileName(chapterNo, title, version);
                        await fsio.writeText(`${bookId}/正文/${fileName}`, content);
                        const rec = store.chapterRecord(prev, { title, version, file: fileName, chars: content.length });
                        if (!novel.chapters) novel.chapters = {};
                        novel.chapters[String(chapterNo)] = rec;
                        await fsio.writeTextIfVersion(`${bookId}/novel.json`, JSON.stringify(novel, null, 2));
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

                // POST /projects/:id/chapters/:no/polish — 一键润色（D1 旁路引擎：出提案，不落正文）
                if (req.method === 'POST' && segments[0] === 'projects' && segments[2] === 'chapters' && segments[4] === 'polish' && segments.length === 5) {
                    if (!trusted(req)) return fail(res, 403, 'FORBIDDEN', 'missing fence header');
                    const bookId = safeDecode(segments[1]);
                    if (!validBookId(bookId)) return fail(res, 400, 'BAD_BOOK', 'invalid book id');
                    return runChapterRevision(req, res, bookId, Number(segments[3]), 'polish');
                }

                // POST /projects/:id/chapters/:no/proofread — 一键机械校对（D1 旁路引擎：守卫更严）
                if (req.method === 'POST' && segments[0] === 'projects' && segments[2] === 'chapters' && segments[4] === 'proofread' && segments.length === 5) {
                    if (!trusted(req)) return fail(res, 403, 'FORBIDDEN', 'missing fence header');
                    const bookId = safeDecode(segments[1]);
                    if (!validBookId(bookId)) return fail(res, 400, 'BAD_BOOK', 'invalid book id');
                    return runChapterRevision(req, res, bookId, Number(segments[3]), 'proofread');
                }

                // POST /projects/:id/draft-batch — 并发批量起草（D2）
                //
                // 并发生成 → **串行提交**（同一条 chapter-commit 硬约束链：机审/账本/
                // 内容门禁/契约指标一个都不少）。失败不整批回滚：1 章挂了其余照落盘。
                // 并发默认 1，上限 4，且只在有场景契约裁过上下文的书上放开。
                if (req.method === 'POST' && segments[0] === 'projects' && segments[2] === 'draft-batch' && segments.length === 3) {
                    if (!trusted(req)) return fail(res, 403, 'FORBIDDEN', 'missing fence header');
                    const bookId = safeDecode(segments[1]);
                    if (!validBookId(bookId)) return fail(res, 400, 'BAD_BOOK', 'invalid book id');
                    if (engine === null) return fail(res, 503, 'ENGINE_UNAVAILABLE', '模型引擎未就绪：本进程没有可用的模型服务');
                    try {
                        const found = await locateBook(bookId);
                        if (!found) return fail(res, 404, 'NOT_FOUND', '书不存在');
                        const novel = JSON.parse(found.text);
                        const body = await readJsonBody(req);
                        const from = Number(body.from ?? 1);
                        const count = Number(body.count ?? 1);
                        if (!Number.isInteger(from) || from < 1) return fail(res, 400, 'BAD_RANGE', 'from 必须是正整数');
                        if (!Number.isInteger(count) || count < 1 || count > 20) return fail(res, 400, 'BAD_RANGE', 'count 必须是 1–20');
                        const result = await runDraftBatch({
                            engine, config, io: found.fsio, p: store.pathsFor(bookId), book: bookId, novel,
                            from, count,
                            concurrency: Number(body.concurrency ?? 1),
                            force: body.force === true,
                        });
                        writeJson(res, 200, {
                            ok: true,
                            value: {
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
                    return;
                }

                // ── 提案端点（融合第一批 · A1）──────────────────────────────
                //
                // 提案的「应用 / 丢弃 / 清理」是**用户主权动作**，刻意不进工具面
                // （见 lib/tools/propose-tools.js 的 enum 只有 propose/list）。
                // 面板通过下面这几个端点操作，审计里 actor 一律记 'user' ——
                // 于是「谁批准的修订」在 audit.jsonl 里可查，模型无法自己批准自己。

                // GET /projects/:id/proposals — 列出提案
                if (req.method === 'GET' && segments[0] === 'projects' && segments[2] === 'proposals' && segments.length === 3) {
                    if (!trusted(req)) return fail(res, 403, 'FORBIDDEN', 'missing fence header');
                    const bookId = safeDecode(segments[1]);
                    if (!validBookId(bookId)) return fail(res, 400, 'BAD_BOOK', 'invalid book id');
                    try {
                        const found = await locateBook(bookId);
                        if (!found) return fail(res, 404, 'NOT_FOUND', '书不存在');
                        const value = await proposals.listProposals(found.fsio, bookId);
                        writeJson(res, 200, { ok: true, value });
                    } catch (error) {
                        fail(res, 500, 'IO_FAILURE', String(error));
                    }
                    return;
                }

                // POST /projects/:id/proposals/prune — 清理已终态提案索引
                if (req.method === 'POST' && segments[0] === 'projects' && segments[2] === 'proposals' && segments[3] === 'prune' && segments.length === 4) {
                    if (!trusted(req)) return fail(res, 403, 'FORBIDDEN', 'missing fence header');
                    const bookId = safeDecode(segments[1]);
                    if (!validBookId(bookId)) return fail(res, 400, 'BAD_BOOK', 'invalid book id');
                    try {
                        const found = await locateBook(bookId);
                        if (!found) return fail(res, 404, 'NOT_FOUND', '书不存在');
                        const value = await proposals.pruneProposals(found.fsio, bookId, 'user');
                        writeJson(res, 200, { ok: true, value });
                    } catch (error) {
                        fail(res, 400, 'PROPOSAL_REJECTED', String(error?.message ?? error));
                    }
                    return;
                }

                // POST /projects/:id/proposals/:pid/apply — 应用提案（生成新版本，旧版保留）
                if (req.method === 'POST' && segments[0] === 'projects' && segments[2] === 'proposals' && segments[4] === 'apply' && segments.length === 5) {
                    if (!trusted(req)) return fail(res, 403, 'FORBIDDEN', 'missing fence header');
                    const bookId = safeDecode(segments[1]);
                    if (!validBookId(bookId)) return fail(res, 400, 'BAD_BOOK', 'invalid book id');
                    const proposalId = safeDecode(segments[3]);
                    try {
                        const found = await locateBook(bookId);
                        if (!found) return fail(res, 404, 'NOT_FOUND', '书不存在');
                        const value = await proposals.applyProposal(found.fsio, bookId, proposalId, config, 'user');
                        writeJson(res, 200, { ok: true, value });
                    } catch (error) {
                        // 提案不存在 / 状态非 pending / 文件缺失 都是业务性拒绝，不是服务故障。
                        fail(res, 400, 'PROPOSAL_REJECTED', String(error?.message ?? error));
                    }
                    return;
                }

                // POST /projects/:id/proposals/:pid/discard — 丢弃提案（正文不动）
                if (req.method === 'POST' && segments[0] === 'projects' && segments[2] === 'proposals' && segments[4] === 'discard' && segments.length === 5) {
                    if (!trusted(req)) return fail(res, 403, 'FORBIDDEN', 'missing fence header');
                    const bookId = safeDecode(segments[1]);
                    if (!validBookId(bookId)) return fail(res, 400, 'BAD_BOOK', 'invalid book id');
                    const proposalId = safeDecode(segments[3]);
                    try {
                        const found = await locateBook(bookId);
                        if (!found) return fail(res, 404, 'NOT_FOUND', '书不存在');
                        const value = await proposals.discardProposal(found.fsio, bookId, proposalId, 'user');
                        writeJson(res, 200, { ok: true, value });
                    } catch (error) {
                        fail(res, 400, 'PROPOSAL_REJECTED', String(error?.message ?? error));
                    }
                    return;
                }

                // POST /projects/:id/export — 导出
                if (req.method === 'POST' && segments[0] === 'projects' && segments[2] === 'export' && segments.length === 3) {
                    if (!trusted(req)) return fail(res, 403, 'FORBIDDEN', 'missing fence header');
                    const bookId = safeDecode(segments[1]);
                    if (!validBookId(bookId)) return fail(res, 400, 'BAD_BOOK', 'invalid book id');
                    try {
                        const found = await locateBook(bookId);
                        if (!found) return fail(res, 404, 'NOT_FOUND', '书不存在');
                        const { fsio, text } = found;
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
                    const bookId = safeDecode(segments[1]);
                    if (!validBookId(bookId)) return fail(res, 400, 'BAD_BOOK', 'invalid book id');
                    try {
                        const found = await locateBook(bookId);
                        if (!found) return fail(res, 404, 'NOT_FOUND', '书不存在');
                        // 删除 novel.json（标记为非书）—— 必须写在书真正所在的工作区根
                        await found.fsio.writeText(`${bookId}/novel.json`, '');
                        writeJson(res, 200, { ok: true, value: { deleted: bookId } });
                    } catch (error) {
                        fail(res, 500, 'IO_FAILURE', String(error));
                    }
                    return;
                }

                // POST /projects/:id/rename — 改名
                // 目录名（bookId）是这本书的**稳定身份**（章节/世界书/账本路径都挂在它下面），
                // 改名只改 novel.json.title，不挪目录——与删除同样走「软操作」模型，零数据丢失风险。
                if (req.method === 'POST' && segments[0] === 'projects' && segments[2] === 'rename' && segments.length === 3) {
                    if (!trusted(req)) return fail(res, 403, 'FORBIDDEN', 'missing fence header');
                    const bookId = safeDecode(segments[1]);
                    if (!validBookId(bookId)) return fail(res, 400, 'BAD_BOOK', 'invalid book id');
                    try {
                        const body = await readJsonBody(req);
                        const title = String(body.title ?? '').trim();
                        if (!title) return fail(res, 400, 'INVALID_FIELD', '书名不能为空');
                        const found = await locateBook(bookId);
                        if (!found) return fail(res, 404, 'NOT_FOUND', '书不存在');
                        const { fsio, text } = found;
                        const novel = JSON.parse(text);
                        const prev = novel.title ?? bookId;
                        novel.title = title;
                        await fsio.writeText(`${bookId}/novel.json`, `${JSON.stringify(novel, null, 2)}\n`);
                        writeJson(res, 200, { ok: true, value: { id: bookId, prev, title } });
                    } catch (error) {
                        fail(res, 500, 'IO_FAILURE', String(error));
                    }
                    return;
                }

                // POST /projects/:id/clone — 克隆为模板
                // 复制规则全在 lib/clone.js（与 novel_clone_project 工具共用一份）。
                // 克隆进**源书所在根**（资产同根才完整）；归属打当前会话（body.session）。
                if (req.method === 'POST' && segments[0] === 'projects' && segments[2] === 'clone' && segments.length === 3) {
                    if (!trusted(req)) return fail(res, 403, 'FORBIDDEN', 'missing fence header');
                    const fromBook = safeDecode(segments[1]);
                    if (!validBookId(fromBook)) return fail(res, 400, 'BAD_BOOK', 'invalid book id');
                    try {
                        const body = await readJsonBody(req);
                        const newBook = String(body.newBook ?? '').trim();
                        if (!newBook) return fail(res, 400, 'INVALID_FIELD', '新书目名不能为空');
                        const found = await locateBook(fromBook);
                        if (!found) return fail(res, 404, 'NOT_FOUND', '书不存在');
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
                    return;
                }

                // ── 世界书 ──

                // GET /worldbook/:bookId — 世界书列表
                if (req.method === 'GET' && segments[0] === 'worldbook' && segments.length === 2) {
                    if (!trusted(req)) return fail(res, 403, 'FORBIDDEN', 'missing fence header');
                    const bookId = safeDecode(segments[1]);
                    if (!validBookId(bookId)) return fail(res, 400, 'BAD_BOOK', 'invalid book id');
                    try {
                        const found = await locateBook(bookId);
                        if (!found) return fail(res, 404, 'NOT_FOUND', '书不存在');
                        const fsio = found.fsio;
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
                    const bookId = safeDecode(segments[1]);
                    if (!validBookId(bookId)) return fail(res, 400, 'BAD_BOOK', 'invalid book id');
                    try {
                        const body = await readJsonBody(req);
                        const found = await locateBook(bookId);
                        if (!found) return fail(res, 404, 'NOT_FOUND', '书不存在');
                        const fsio = found.fsio;
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
                    const bookId = safeDecode(segments[1]);
                    if (!validBookId(bookId)) return fail(res, 400, 'BAD_BOOK', 'invalid book id');
                    const entryId = Number(segments[2]);
                    try {
                        const body = await readJsonBody(req);
                        const found = await locateBook(bookId);
                        if (!found) return fail(res, 404, 'NOT_FOUND', '书不存在');
                        const fsio = found.fsio;
                        const text = await fsio.readText(`${bookId}/设定/世界书.json`).catch(() => '[]');
                        const entries = JSON.parse(text || '[]');
                        const idx = entries.findIndex(e => e.id === entryId);
                        if (idx === -1) return fail(res, 404, 'NOT_FOUND', '条目不存在');
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
                            id: entryId,
                        };
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
                    const bookId = safeDecode(segments[1]);
                    if (!validBookId(bookId)) return fail(res, 400, 'BAD_BOOK', 'invalid book id');
                    const entryId = Number(segments[2]);
                    try {
                        const found = await locateBook(bookId);
                        if (!found) return fail(res, 404, 'NOT_FOUND', '书不存在');
                        const fsio = found.fsio;
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
