// lib/server-routes/session.js — 会话域路由：疲劳会话的一键轮换（开新 + 归档旧）。
//
// 能力探测走「属性直读」而不是 inject：cordis inject 一个不存在/不实例化的服务名会让
// 插件 fiber 永远挂起等载（整站插件失效），而属性直读 `ctx[name]` 不等待——服务在就有、
// 不在就 undefined。宿主两个控制器（session.create / workspace.archiveSession）的真实
// 服务名无法从打包产物静态实证，所以候选名运行时探测 + 逐请求重读（服务晚加载也能被拾到）。
// 探测不到 → 结构化 501，面板退回「复制交接摘要」——绝不静默失败。

/** 会话控制器的候选服务名（含已 inject 的 'sessions'）。 */
// 顺序关键：'sessions' 是浏览器面（有 create 但建内存假体），真控制器必须先探——
// 命中即 break，假体在前会永久遮蔽真名（真机实证 2026-10-08）。
const SESSION_SERVICE_NAMES = ['sessionController', 'sessionApi', 'sessions'];
/** 工作区控制器的候选服务名（archiveSession / unarchiveSession 的宿主）。 */
const WORKSPACE_SERVICE_NAMES = ['workspaceController', 'workspace', 'workspaces', 'workspaceApi'];

/**
 * 非阻塞能力探测（纯属性直读，零等待）。
 * @param {object} ctx 插件 cordis 上下文
 * @returns {{ sessions: object|null, workspace: object|null, full: boolean }}
 *   sessions = 带 .create 的服务对象；workspace = 带 .archiveSession 的服务对象。
 */
export function probeSessionCapabilities(ctx) {
    // cordis 的 ctx 是代理：访问未 inject 的服务名不是 undefined 而是【throw】
    //（"cannot get property X without inject"——真机实证 2026-10-07，这个 throw 曾把
    // 疲劳横幅整块吞掉）。逐名 try/catch：throw = 本插件看不见该服务 = null。
    const peek = (name) => {
        try {
            const v = ctx?.[name];
            return (v && typeof v === 'object') ? v : null;
        } catch { return null; }
    };
    let sessions = null;
    for (const name of SESSION_SERVICE_NAMES) {
        const cand = peek(name);
        if (cand && typeof cand.create === 'function') { sessions = cand; break; }
    }
    let workspace = null;
    for (const name of WORKSPACE_SERVICE_NAMES) {
        const cand = peek(name);
        if (cand && typeof cand.archiveSession === 'function') { workspace = cand; break; }
    }
    // 探测明细（rotate 端点 501/500 消息里可见）：服务对象 surface 的方法名——
    // 既是排障抓手，也是「宿主哪天提供了 create/archive」的自动点亮依据。
    const surface = (o) => (o ? Object.keys(o).filter((k) => typeof o[k] === 'function').slice(0, 12).join(',') : '∅');
    const detail = `sessions候选={${sessions ? 'create✓' : peek('sessions') ? `无create[${surface(peek('sessions'))}]` : '不可见'}}, workspace候选={${workspace ? 'archive✓' : WORKSPACE_SERVICE_NAMES.some((n) => peek(n)) ? `无archive[${surface(WORKSPACE_SERVICE_NAMES.map(peek).find(Boolean))}]` : '不可见'}}`;
    return { sessions, workspace, full: sessions !== null && workspace !== null, canCreate: sessions !== null, detail };
}

/**
 * 轮换：开新会话 + 归档旧会话。两段各自尽力、独立报错——
 * 新会话建成功而归档失败时，面板照样能续写（书状态全在盘上），只是旧会话还在列表里。
 * create 的请求形状宿主未静态实证：按 docstring「identity/location/preset 皆可省」
 * 从最小形状开始逐个尝试，全部失败时收集错误原文（重启验证时据此校准）。
 */
async function rotateSessions(probe, currentSessionId) {
    const errors = [];
    let newSessionId = null;
    for (const attempt of [
        () => probe.sessions.create({}),
        () => probe.sessions.create(),
    ]) {
        try {
            const created = await attempt();
            newSessionId = created?.sessionId ?? created?.id ?? created?.session?.id ?? null;
            break;
        } catch (error) { errors.push(String(error?.message ?? error)); }
    }
    if (newSessionId === null) {
        return { rotated: false, errors };
    }
    let archived = false;
    let archiveError = null;
    try {
        await probe.workspace.archiveSession({ sessionId: currentSessionId });
        archived = true;
    } catch (error) { archiveError = String(error?.message ?? error); }
    return { rotated: true, newSessionId, archived, archiveError };
}

/**
 * 只建新会话（不归档——归档通道被宿主 cordis 门禁封死，见 probeSessionCapabilities）。
 * 工作区匹配：先 list 找当前会话行的 workspaceId（字段名宿主未实证，逐候选取），
 * 拿到就 create({ workspaceId })——新会话落同一工作区，工具直接可用；拿不到再裸 create。
 * create 请求形状同样未实证：按「带位置→空对象→无参」顺序逐个试，错误原文收集进消息。
 */
async function createNewSession(probe, currentSessionId, preferredCwd, preferredTitle) {
    const errors = [];
    let matchedCwd = null;
    let matchTrace = null;
    if (currentSessionId) {
        try {
            const listed = await probe.sessions.list({}, undefined);
            // 真机实证形状（typert + matchTrace 2026-10-08）：{ items: [{ sessionId, cwd, ... }] }
            const rows = listed?.items ?? listed?.sessions ?? (Array.isArray(listed) ? listed : []);
            const row = rows.find((r) => r?.sessionId === currentSessionId) ?? rows.find((r) => r?.id === currentSessionId);
            matchedCwd = row?.cwd ?? null;
            if (!matchedCwd) {
                // 匹配失败必须可见：把真实形状带回去，别让人对着 false 猜字段名
                matchTrace = JSON.stringify(listed)?.slice(0, 400) ?? '（list 返回非对象）';
            }
        } catch (error) {
            errors.push(`list: ${String(error?.message ?? error)}`);
            matchTrace = `list 抛错：${String(error?.message ?? error)}`;
        }
    }
    // 落点优先级（用户钦定 2026-10-08）：原会话的 cwd（新会话和旧会话同工作区，GUI
    // 同分组可见）> 书的工作区根 > 宿主默认。刚创建的会话可能还没进 list（持久化
    // 滞后），匹配不到时书根兜底。
    // SessionCreateRequest = { workspaceId?, cwd?, sessionId?, agentPreset? }（types.d.ts 实证）。
    const seen = new Set();
    const requests = [
        ...(matchedCwd ? [{ cwd: matchedCwd }] : []),
        ...(preferredCwd && preferredCwd !== matchedCwd ? [{ cwd: preferredCwd }] : []),
        {},
    ].filter((r) => { const k = JSON.stringify(r); if (seen.has(k)) return false; seen.add(k); return true; });
    for (const request of requests) {
        try {
            const created = await probe.sessions.create(request);
            const newSessionId = created?.sessionId ?? created?.id ?? created?.session?.id
                ?? created?.session?.sessionId ?? null;
            if (newSessionId) {
                // 命名（SessionRenameRequest={sessionId,title} 实证）：空白会话没有名字，
                // 在按工作区分组的列表里根本找不到——命名为《书名》续写就一眼可见。
                // best-effort：失败不回滚创建，renamed:false 如实上报。
                let renamed = false;
                if (preferredTitle) {
                    for (const req of [{ sessionId: newSessionId, title: preferredTitle }, { id: newSessionId, title: preferredTitle }]) {
                        try { await probe.sessions.rename(req); renamed = true; break; } catch { /* 下一形状 */ }
                    }
                }
                return { created: true, newSessionId, workspaceMatched: 'cwd' in request, matchTrace, renamed, usedCwd: ('cwd' in request ? request.cwd : null) ?? matchedCwd ?? preferredCwd ?? null };
            }
            errors.push(`create 返回无 id：${JSON.stringify(created)?.slice(0, 120) ?? '（非对象）'}`);
        } catch (error) { errors.push(String(error?.message ?? error)); }
    }
    return { created: false, errors, matchTrace };
}

/**
 * @param {object} req 请求
 * @param {object} res 响应
 * @param {string[]} segments 路径段
 * @param {object} api 共享依赖（含 sessionProbe 能力探测闭包）
 * @returns {Promise<boolean>} 是否已处理
 */
/** 破坏性会话端点（rotate/create）的简单节流（CodeBuddy 审计 2026-10-09，中危 M1）：
 *  归档是破坏性动作、create 每次附带 attach/rename 多次宿主调用；fence 是唯一防线，
 *  这里再加一层频率闸（全局滑动窗口，正常使用远够：人手点横幅一 分钟也就一两次）。 */
const RATE_LIMIT = { max: 6, windowMs: 60_000 };
const rateState = { hits: [] };
function rateLimited() {
    const now = Date.now();
    rateState.hits = rateState.hits.filter((t) => now - t < RATE_LIMIT.windowMs);
    if (rateState.hits.length >= RATE_LIMIT.max) return true;
    rateState.hits.push(now);
    return false;
}

/** 测试专用：清空节流窗口（全局状态不能在用例间累积）。 */
export function resetSessionRateLimit() {
    rateState.hits = [];
}

/** 会话 id 形状校验（真机形状 session-<uuid>）：rotate 的 session 直接进宿主
 *  archiveSession——不收口就是「归档任意字符串」原语。宽松白名单，只挡结构性怪值。 */
const validSessionId = (id) => typeof id === 'string' && id !== '' && id.length <= 128
    && /^[A-Za-z0-9:_-]+$/.test(id);

export async function handle(req, res, segments, api) {
    const { writeJson, readJsonBody, trusted, fail } = api;
    // POST /session/rotate — 疲劳横幅一键轮换：开新会话 + 归档旧会话
    // body: { session }（要归档的当前会话 id；新会话由宿主建，location 交给宿主默认）
    if (req.method === 'POST' && segments[0] === 'session' && segments[1] === 'rotate' && segments.length === 2) {
        if (!trusted(req)) { fail(res, 403, 'FORBIDDEN', 'missing fence header'); return true; }
        if (!api.sessionProbe) { fail(res, 501, 'SESSION_ROTATE_UNSUPPORTED', '服务端未接会话能力探测——请用「复制交接摘要」手动开新会话'); return true; }
        try {
            if (rateLimited()) { fail(res, 429, 'RATE_LIMITED', '会话轮换过于频繁，稍后再试'); return true; }
            const body = await readJsonBody(req);
            const session = String(body.session ?? '').trim();
            if (!session) { fail(res, 400, 'INVALID_FIELD', '缺少 session（要归档的是哪个会话）'); return true; }
            if (!validSessionId(session)) { fail(res, 400, 'INVALID_FIELD', 'session id 形状不合式'); return true; }
            const probe = api.sessionProbe();
            if (!probe.full) {
                fail(res, 501, 'SESSION_ROTATE_UNSUPPORTED',
                    `宿主未暴露会话 create/archive 能力（探测：${probe.detail}）——请用「复制交接摘要」手动开新会话`);
                return true;
            }
            const result = await rotateSessions(probe, session);
            if (!result.rotated) {
                fail(res, 500, 'SESSION_ROTATE_FAILED', `新会话创建失败：${result.errors.join('；')}`);
                return true;
            }
            writeJson(res, 200, {
                ok: true,
                value: {
                    rotated: true,
                    newSessionId: result.newSessionId,
                    archived: result.archived,
                    ...(result.archiveError ? { archiveError: result.archiveError } : {}),
                },
            });
        } catch (error) {
            fail(res, 500, 'IO_FAILURE', String(error));
        }
        return true;
    }
    // POST /session/create — 疲劳横幅「创建新会话并交接」：只建新（归档手动，宿主门禁）
    // body: { session? }（当前会话 id，用于工作区匹配；缺省由宿主默认位置建）
    if (req.method === 'POST' && segments[0] === 'session' && segments[1] === 'create' && segments.length === 2) {
        if (!trusted(req)) { fail(res, 403, 'FORBIDDEN', 'missing fence header'); return true; }
        try {
            if (rateLimited()) { fail(res, 429, 'RATE_LIMITED', '会话创建过于频繁，稍后再试'); return true; }
            const body = await readJsonBody(req);
            const reqSession = String(body.session ?? '').trim();
            if (reqSession !== '' && !validSessionId(reqSession)) { fail(res, 400, 'INVALID_FIELD', 'session id 形状不合式'); return true; }
            const probe = api.sessionProbe?.();
            if (!probe?.sessions) {
                fail(res, 501, 'SESSION_CREATE_UNSUPPORTED',
                    `宿主未暴露会话 create 能力（探测：${probe?.detail ?? '服务端未接探测'}）——请手动新建会话后粘贴交接摘要`);
                return true;
            }
            let preferredCwd = null;
            const bookId = String(body.book ?? '').trim();
            if (bookId) {
                try {
                    const found = await api.locateBook(bookId);
                    preferredCwd = found?.root ?? null;
                } catch { /* 书定位失败就退回会话 cwd/宿主默认，不阻断创建 */ }
            }
            const bookTitle = String(body.bookTitle ?? '').trim();
            const preferredTitle = bookTitle ? `《${bookTitle}》续写` : '';
            const result = await createNewSession(probe, String(body.session ?? '').trim(), preferredCwd, preferredTitle);
            if (!result.created) {
                fail(res, 500, 'SESSION_CREATE_FAILED', `新会话创建失败：${result.errors.join('；')}`);
                return true;
            }
            // 登记进工作区视图（GUI 侧栏按工作区分组——不登记就永远不显示）。
            // 形状实证 2026-10-08（宿主 dsh-workspace 打包产物）：
            //   控制器.get(workspaceId) → 每工作区实体；
            //   实体.attachSession(sessionId) —— 登记前置（新会话未登记直接 insert
            //       会抛 "the session is not accounted"）；
            //   实体.insertSessionBefore(sessionId, beforeSessionId) —— 【位置参数】，
            //       不是对象参数（旧实现传对象，真机上从未成功过——本次修复）。
            // 必须在归档之前——归档会摘掉原会话，锚点就没了。
            let attached = false;
            let attachError = null;
            let inserted = false;
            let insertError = null;
            const oldId = String(body.session ?? '').trim();
            if (probe.workspace) {
                const rows = api.readWorkspaceRegistry?.() ?? [];
                const row = rows.find((w) => oldId && w.sessionIds.includes(oldId))
                    ?? rows.find((w) => result.usedCwd && w.path === result.usedCwd);
                if (row?.workspaceId) {
                    // 实体解析：控制器形状（get→实体）优先；控制器直接带 attach/insert 面的形状兜底
                    const entities = [];
                    if (typeof probe.workspace.get === 'function') {
                        try {
                            const entity = probe.workspace.get(row.workspaceId);
                            if (entity && typeof entity.insertSessionBefore === 'function') entities.push(entity);
                        } catch { /* 形状不符，走兜底 */ }
                    }
                    if (entities.length === 0 && typeof probe.workspace.attachSession === 'function') entities.push(probe.workspace);
                    if (entities.length === 0) {
                        insertError = `工作区服务没有 get/attachSession 面（surface: ${Object.keys(probe.workspace).filter((k) => typeof probe.workspace[k] === 'function').slice(0, 10).join(',')}）`;
                    }
                    for (const entity of entities) {
                        if (typeof entity.attachSession === 'function') {
                            // 两种参数形状都试：实体 attachSession(sessionId)；控制器客户端 attachSession(workspaceId, sessionId)
                            for (const attach of [() => entity.attachSession(result.newSessionId), () => entity.attachSession(row.workspaceId, result.newSessionId)]) {
                                try { await attach(); attached = true; attachError = null; break; }
                                catch (error) { attachError = String(error?.message ?? error); }
                            }
                        }
                        const insertForms = [
                            ...(oldId ? [() => entity.insertSessionBefore(result.newSessionId, oldId)] : []),
                            ...(oldId ? [() => entity.insertSessionBefore(row.workspaceId, result.newSessionId, oldId)] : []),
                            () => entity.insertSessionBefore(result.newSessionId),
                        ];
                        for (const insert of insertForms) {
                            try { await insert(); inserted = true; insertError = null; break; }
                            catch (error) { insertError = String(error?.message ?? error); }
                        }
                        if (inserted) break;
                    }
                } else insertError = '工作区注册表里没找到原会话/落点所在工作区';
            }
            // 归档通道可用（真 workspaceController）就顺手归档旧会话——一个按钮完成轮换；
            // 失败不回滚创建（新会话已在），archiveError 如实上报。
            let archived = false;
            let archiveError = null;
            if (probe.full && body.session) {
                const target = String(body.session);
                // archiveSession 的请求形状未实证（真机裸 id 报 session 'undefined'）——
                // 按对象→裸值逐个试，错误原文收集，最后一试的错进 archiveError。
                const archiveAttempts = [() => probe.workspace.archiveSession({ sessionId: target }), () => probe.workspace.archiveSession({ id: target }), () => probe.workspace.archiveSession(target)];
                for (const attempt of archiveAttempts) {
                    try {
                        await attempt();
                        archived = true;
                        archiveError = null;
                        break;
                    } catch (error) { archiveError = String(error?.message ?? error); }
                }
            }
            writeJson(res, 200, {
                ok: true,
                value: {
                    created: true,
                    createdSessionId: result.newSessionId,
                    workspaceMatched: result.workspaceMatched,
                    archived,
                    renamed: result.renamed === true,
                    attached,
                    ...(attachError ? { attachError } : {}),
                    inserted,
                    ...(insertError ? { insertError } : {}),
                    ...(archiveError ? { archiveError } : {}),
                    ...(result.matchTrace ? { matchTrace: result.matchTrace } : {}),
                },
            });
        } catch (error) {
            fail(res, 500, 'IO_FAILURE', String(error));
        }
        return true;
    }
    return false;
}
