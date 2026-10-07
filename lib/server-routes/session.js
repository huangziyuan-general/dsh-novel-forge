// lib/server-routes/session.js — 会话域路由：疲劳会话的一键轮换（开新 + 归档旧）。
//
// 能力探测走「属性直读」而不是 inject：cordis inject 一个不存在/不实例化的服务名会让
// 插件 fiber 永远挂起等载（整站插件失效），而属性直读 `ctx[name]` 不等待——服务在就有、
// 不在就 undefined。宿主两个控制器（session.create / workspace.archiveSession）的真实
// 服务名无法从打包产物静态实证，所以候选名运行时探测 + 逐请求重读（服务晚加载也能被拾到）。
// 探测不到 → 结构化 501，面板退回「复制交接摘要」——绝不静默失败。

/** 会话控制器的候选服务名（含已 inject 的 'sessions'）。 */
const SESSION_SERVICE_NAMES = ['sessions', 'sessionApi', 'sessionController'];
/** 工作区控制器的候选服务名（archiveSession / unarchiveSession 的宿主）。 */
const WORKSPACE_SERVICE_NAMES = ['workspace', 'workspaces', 'workspaceApi', 'workspaceController'];

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
    return { sessions, workspace, full: sessions !== null && workspace !== null, detail };
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
 * @param {object} req 请求
 * @param {object} res 响应
 * @param {string[]} segments 路径段
 * @param {object} api 共享依赖（含 sessionProbe 能力探测闭包）
 * @returns {Promise<boolean>} 是否已处理
 */
export async function handle(req, res, segments, api) {
    const { writeJson, readJsonBody, trusted, fail } = api;
    // POST /session/rotate — 疲劳横幅一键轮换：开新会话 + 归档旧会话
    // body: { session }（要归档的当前会话 id；新会话由宿主建，location 交给宿主默认）
    if (req.method === 'POST' && segments[0] === 'session' && segments[1] === 'rotate' && segments.length === 2) {
        if (!trusted(req)) { fail(res, 403, 'FORBIDDEN', 'missing fence header'); return true; }
        if (!api.sessionProbe) { fail(res, 501, 'SESSION_ROTATE_UNSUPPORTED', '服务端未接会话能力探测——请用「复制交接摘要」手动开新会话'); return true; }
        try {
            const body = await readJsonBody(req);
            const session = String(body.session ?? '').trim();
            if (!session) { fail(res, 400, 'INVALID_FIELD', '缺少 session（要归档的是哪个会话）'); return true; }
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
    return false;
}
