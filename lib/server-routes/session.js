// lib/server-routes/session.js — 会话域路由：疲劳会话的一键轮换（开新 + 归档旧）。
//
// 能力来源是**宿主真名服务**，由 lib/index.js 用数组形式 `ctx.inject(names, cb)` 建的
// 独立 fiber 交付（headless profile 真机实证 2026-10-12：把真名写进主插件顶层 inject，
// 服务缺席时 cordis 会让**整个插件**挂起——20 个工具 + 面板全灭；数组回调只有那条
// fiber 永不触发，父插件照常 mount）。
// 本模块因此不再按候选名 `ctx[name]` 直读：peek 只看得到**已声明**的服务，而唯一还能
// peek 到的 'sessions' 是浏览器面假体——它有 create，但建的是内存 session-N（宿主面板
// 可见、磁盘无目录、工具拿不到工作区），拿它当能力会「成功」开出一个不可用的会话
// （真机踩实 2026-10-08）。fiber 没交付 = 没有能力 → 结构化 501，面板退回「复制交接摘要」，
// 绝不静默失败。

/** 宿主会话控制器真名（typert.host.js 元数据实证 2026-10-08）。 */
export const SESSION_CONTROLLER_NAME = 'sessionController';
/** 宿主工作区控制器真名（archiveSession 的宿主）。 */
export const WORKSPACE_CONTROLLER_NAME = 'workspaceController';

/**
 * 轮换能力 = 两条 fiber 实际交付了什么（纯读 holder，零等待、零 throw）。
 * @param services holder：{ [SESSION_CONTROLLER_NAME]?, [WORKSPACE_CONTROLLER_NAME]?, probeError? }
 * @returns {{ sessions: object|null, workspace: object|null, full: boolean, canCreate: boolean, detail: string }}
 *   sessions = 带 .create 的服务对象；workspace = 带 .archiveSession 的服务对象。
 */
export function probeSessionCapabilities(services) {
    // holder 一般是普通对象，但测试桩/上游可能给拒绝式代理——探测绝不允许 throw
    //（68cb694 曾借 cordis 代理的 throw 把整块疲劳横幅吞掉）。
    const grab = (name) => {
        try {
            const v = services?.[name];
            return (v && typeof v === 'object') ? v : null;
        } catch { return null; }
    };
    // 服务对象 surface 的方法名：既是排障抓手，也是「宿主哪天补上 create/archive」的点亮依据。
    const surface = (o) => (o ? Object.keys(o).filter((k) => typeof o[k] === 'function').slice(0, 12).join(',') : '∅');
    const sess = grab(SESSION_CONTROLLER_NAME);
    const work = grab(WORKSPACE_CONTROLLER_NAME);
    const sessions = sess && typeof sess.create === 'function' ? sess : null;
    const workspace = work && typeof work.archiveSession === 'function' ? work : null;
    const shape = (given, ok, method, label) => (ok
        ? `${label}=${method}✓`
        : given ? `${label}=无${method}[${surface(given)}]` : `${label}=fiber未交付`);
    // probeError 同样要防 throw：holder 可能是 cordis 式拒绝代理（这条 detail 曾在
    // 68cb694 的同类事故里把整块疲劳横幅吞掉——探测路径上一个字符都不许直读）。
    let declared = '';
    try { declared = services?.probeError ? `, 声明失败[${services.probeError}]` : ''; } catch { declared = ''; }
    const detail = `${shape(sess, sessions !== null, 'create', SESSION_CONTROLLER_NAME)}, `
        + `${shape(work, workspace !== null, 'archive', WORKSPACE_CONTROLLER_NAME)}${declared}`;
    return {
        sessions, workspace,
        full: sessions !== null && workspace !== null,
        canCreate: sessions !== null,
        detail,
    };
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
async function createNewSession(probe, currentSessionId, preferredCwd, preferredTitle, preferredWorkspaceId) {
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
    // SessionCreateRequest = { workspaceId?, cwd?, sessionId?, agentPreset? }（types.d.ts 实证
    // 2026-10-09）：带 workspaceId 创建 = 宿主在创建时就完成工作区登记——比事后
    // attachSession 可靠（绕开 cwd 校验与持久化滞后两个失败点），故置顶优先。
    const seen = new Set();
    const requests = [
        ...(preferredWorkspaceId && matchedCwd ? [{ workspaceId: preferredWorkspaceId, cwd: matchedCwd }] : []),
        ...(preferredWorkspaceId ? [{ workspaceId: preferredWorkspaceId }] : []),
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
                // 在按工作区分组的列表里根本找不到——书名+日期一眼可见且可排序。
                // best-effort：失败不回滚创建，renamed:false 如实上报。
                let renamed = false;
                if (preferredTitle) {
                    for (const req of [{ sessionId: newSessionId, title: preferredTitle }, { id: newSessionId, title: preferredTitle }]) {
                        try { await probe.sessions.rename(req); renamed = true; break; } catch { /* 下一形状 */ }
                    }
                }
                return { created: true, newSessionId, workspaceMatched: 'cwd' in request || 'workspaceId' in request, matchTrace, renamed, usedCwd: ('cwd' in request ? request.cwd : null) ?? matchedCwd ?? preferredCwd ?? null, usedWorkspaceId: 'workspaceId' in request ? request.workspaceId : null };
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

// 会话 id 形状校验收口在 server-http.js 的 validSessionId（api 里解构），
// session/rotate、archive、create 与 chapters/insights 端点共用同一份白名单。


export async function handle(req, res, segments, api) {
    const { writeJson, readJsonBody, fail, validSessionId, validBookId } = api;
    // POST /session/rotate — 疲劳横幅一键轮换：开新会话 + 归档旧会话
    // body: { session }（要归档的当前会话 id；新会话由宿主建，location 交给宿主默认）
    if (req.method === 'POST' && segments[0] === 'session' && segments[1] === 'rotate' && segments.length === 2) {
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
            // 目录名要拿去拼读写路径（下面 locateBook、以及认领时的 pathsFor(bookId).meta
            // 都是**写路径**）——全站其它端点都先过 validBookId，这里漏了就是纵深防御的
            // 一个洞：形状不合式直接 400，别等它进 locateBook 拼出一串越界路径。
            if (bookId !== '' && !validBookId(bookId)) { fail(res, 400, 'BAD_BOOK', 'invalid book id'); return true; }
            if (bookId) {
                try {
                    // 带旧会话归属判据：多根同名书时，新会话必须建在**旧会话名下那份拷贝**
                    // 所在的工作区，而不是根排序第一份（它可能是别的会话的另一条血脉）
                    const found = await api.locateBook(bookId, { session: api.requestSession(req, body) });
                    preferredCwd = found?.root ?? null;
                } catch { /* 书定位失败就退回会话 cwd/宿主默认，不阻断创建 */ }
            }
            const bookTitle = String(body.bookTitle ?? '').trim();
            // 交接摘要（用户钦定 2026-10-10）：创建后直接 prompt 进新会话——点按钮即开写，
            // 不要「复制摘要 → 手动粘贴」这一步。截断保护：超长摘要说明上游拼接失控。
            const handoff = String(body.handoff ?? '').slice(0, 8000);
            // 延迟归档（用户钦定 2026-10-10）：客户端会先 openSession 跳进新会话，再调
            // /session/archive 归档旧会话——归档当前会话会触发宿主 clearMain 踢回首页，
            // 与跳转竞态（真机实证：先归档 = 用户被踢到「选择工作区」页）。
            const deferArchive = body.deferArchive === true;
            // 命名（用户钦定 2026-10-09）：书名-YYMMDD（如 示例书-261009）——
            // 一眼可见归属，且按名称排序即按时间排序
            const now = new Date();
            const yymmdd = `${String(now.getFullYear()).slice(2)}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
            const preferredTitle = bookTitle ? `${bookTitle}-${yymmdd}` : '';
            // 创建前先查工作区行（types.d.ts 实证 SessionCreateRequest.workspaceId）：
            // 带 workspaceId 创建 = 宿主创建时自己登记，绕开事后 attach 的两个失败点
            //（新会话 header cwd 校验 / 持久化滞后）。
            const oldIdPre = String(body.session ?? '').trim();
            const wsRow = (api.readWorkspaceRegistry?.() ?? []).find((w) => oldIdPre && w.sessionIds.includes(oldIdPre))
                ?? (preferredCwd ? (api.readWorkspaceRegistry?.() ?? []).find((w) => w.path === preferredCwd) : null);
            const preferredWorkspaceId = wsRow?.workspaceId ?? null;
            const result = await createNewSession(probe, String(body.session ?? '').trim(), preferredCwd, preferredTitle, preferredWorkspaceId);
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
            // 创建时已带 workspaceId（宿主创建即登记）→ attach/insert 兜底链整个跳过：
            // 再跑一遍只会产生「登记失败」的噪声错误（真机 2026-10-09：workspaceId 路径
            // accounted=true，兜底链却报「没有 get/attachSession 面」），登记与否由
            // accounted 终验说话。
            if (probe.workspace && !result.usedWorkspaceId) {
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
            // deferArchive：客户端要先跳进新会话再归档（否则宿主 clearMain 把人踢回首页），
            // 归档挪到 /session/archive 由客户端跳转后补调。
            let archived = false;
            let archiveError = null;
            if (!deferArchive && probe.full && body.session) {
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
            // 最终对账（诊断抓手）：宿主持久化可能有毫秒级滞后，重读注册表确认新会话
            // 真的进了某个工作区分组——GUI 侧栏「看得见」的唯一判据就是它。
            let accounted = false;
            try {
                accounted = (api.readWorkspaceRegistry?.() ?? []).some((w) => w.sessionIds.includes(result.newSessionId));
            } catch { /* 读不到就算了，attached/inserted 已各自可见 */ }
            // 自动认领书：把新会话 id 加到 novel.json.sessions——面板按 bookInSession
            // 过滤项目列表，没认领就看不到书（真机 2026-10-09：按钮建会话成功但面板空白，
            // 用户得手动调 novel_briefing 才触发 rememberSession 才认领）。这里建完就认领，
            // 跳进新会话面板立刻显示书，用户能直接写下一章。best-effort：失败不阻断创建。
            let claimed = false;
            let claimError = null;
            if (bookId && result.newSessionId) {
                try {
                    // 认领必须落在**旧会话名下**的那份拷贝上（与详情/阅读同一归属判据）：
                    // 不带 session 会按根排序先到先得，多根同名书时新会话就被绑到
                    // 别的会话的血脉上——交接后写的是另一本书，用户无感知（2026-10-19）
                    const found = await api.locateBook(bookId, { session: api.requestSession(req, body) });
                    if (found?.fsio) {
                        // fsio 钉在**工作区根**（locateBook.makeFsio(root)），路径必须带书名前缀——
                        // 与工具层 requireBook 的 pathsFor(book).meta 同一落点
                        // 变量名用 upd 不用 res：外层 res 是 HTTP 响应对象，遮蔽它迟早炸出莫名错误
                        const upd = await api.updateJson(found.fsio, api.store.pathsFor(bookId).meta, (novel) => {
                            if (!novel || typeof novel !== 'object') return undefined;
                            if (!api.store.addBookSession(novel, result.newSessionId)) return undefined;
                            return { value: novel };
                        });
                        claimed = upd.written === true;
                    }
                } catch (error) { claimError = String(error?.message ?? error); }
            }
            // 交接摘要直发新会话（在归档之前——prompt 与归档无关，但直发越早新会话越早开写）。
            // prompt 形状实证（dsh-api-session-controller types.d.ts）：
            //   { requestId, sessionId, mode:'queue'|'steer', content:[{type:'text',text}] }
            // mode=queue：全新会话没有运行中的 agent，排队即启动。返回值兼容两种形状——
            // 宿主服务直返 SessionPromptValue({accepted:true})，远程客户端返 RemoteResult({ok,value})。
            // best-effort：失败不吞创建结果，promptError 如实上报，面板退回复制粘贴。
            let prompted = false;
            let promptError = null;
            if (handoff !== '' && result.newSessionId) {
                if (typeof probe.sessions.prompt === 'function') {
                    try {
                        const requestId = `nf-handoff-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
                        // 第二参 signal 必传（真机 2026-10-10：typert host 面 prompt(request, signal)
                        // 裸调 signal.throwIfAborted()，不传 = TypeError "reading 'throwIfAborted'"）。
                        // queue-and-forget 语义没有取消方，给常驻未 abort 的 signal。
                        const r = await probe.sessions.prompt({
                            requestId,
                            sessionId: result.newSessionId,
                            mode: 'queue',
                            content: [{ type: 'text', text: handoff }],
                        }, new AbortController().signal);
                        if (r && r.ok === false) throw new Error(String(r.error?.message ?? r.error ?? 'prompt 被拒'));
                        prompted = true;
                    } catch (error) { promptError = String(error?.message ?? error); }
                } else {
                    promptError = '会话服务没有 prompt 面——请手动粘贴交接摘要';
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
                    ...(preferredTitle ? { title: preferredTitle } : {}),
                    attached,
                    ...(attachError ? { attachError } : {}),
                    inserted,
                    ...(insertError ? { insertError } : {}),
                    accounted,
                    claimed,
                    ...(claimError ? { claimError } : {}),
                    prompted,
                    ...(promptError ? { promptError } : {}),
                    ...(archiveError ? { archiveError } : {}),
                    ...(result.matchTrace ? { matchTrace: result.matchTrace } : {}),
                },
            });
        } catch (error) {
            fail(res, 500, 'IO_FAILURE', String(error));
        }
        return true;
    }
    // POST /session/archive — 延迟归档（与 /session/create 的 deferArchive 配套）：
    // 客户端跳进新会话后再调这里归档旧会话，躲开「归档当前会话 → clearMain 踢回首页」的竞态。
    // body: { session }（要归档的会话 id）
    if (req.method === 'POST' && segments[0] === 'session' && segments[1] === 'archive' && segments.length === 2) {
        try {
            if (rateLimited()) { fail(res, 429, 'RATE_LIMITED', '会话归档过于频繁，稍后再试'); return true; }
            const body = await readJsonBody(req);
            const session = String(body.session ?? '').trim();
            if (!session) { fail(res, 400, 'INVALID_FIELD', '缺少 session（要归档的是哪个会话）'); return true; }
            if (!validSessionId(session)) { fail(res, 400, 'INVALID_FIELD', 'session id 形状不合式'); return true; }
            const probe = api.sessionProbe?.();
            if (!probe?.workspace) {
                fail(res, 501, 'SESSION_ARCHIVE_UNSUPPORTED',
                    `宿主未暴露工作区 archive 能力（探测：${probe?.detail ?? '服务端未接探测'}）——请在会话列表手动归档`);
                return true;
            }
            // 与 /session/create 内归档同款形状链：对象→裸值逐个试，错误原文收集
            const attempts = [() => probe.workspace.archiveSession({ sessionId: session }), () => probe.workspace.archiveSession({ id: session }), () => probe.workspace.archiveSession(session)];
            let archived = false;
            let archiveError = null;
            for (const attempt of attempts) {
                try { await attempt(); archived = true; archiveError = null; break; }
                catch (error) { archiveError = String(error?.message ?? error); }
            }
            writeJson(res, 200, { ok: true, value: { archived, ...(archiveError ? { archiveError } : {}) } });
        } catch (error) {
            fail(res, 500, 'IO_FAILURE', String(error));
        }
        return true;
    }
    return false;
}
