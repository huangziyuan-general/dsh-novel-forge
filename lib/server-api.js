// lib/server-api.js — 服务端 REST API（对齐大胖鱼的 /api/novel-writer 模式）。
//
// 浏览器通过 fetch() 调用这些端点，实现抽屉 UI 的写操作（写章/润色/世界书 CRUD）。
// 安全：fence header 校验（防止跨域调用）。
// 门禁：未启用时返回 503。
//
// 结构（按域拆分后）：本文件是**薄派发层** —— 建共享依赖（http 基元 + 多工作区扫描 +
// 库），把请求按路径段顺序交给 lib/server-routes/* 的域处理器，谁先认领谁处理，全不认
// 则 404。四个纯函数（parseProjcacheRoots / parseProjcacheSessionFile / unescapeTildeHex /
// decodeSessionDirRoots）落在 lib/server-workspace.js，这里原样 re-export，导出面不变。

import { auditLine, assertBookName, updateJson, isVersionConflict } from './fsio.js';
import { cloneProject } from './clone.js';
import * as store from './store.js';
import * as versioning from './versioning.js';
import * as exportLib from './export.js';
import * as bookConsole from './book-console.js';
import * as proposals from './proposals.js';
import * as continuity from './continuity.js';
import { diagnoseIntro } from './diagnose.js';
import { loadContinuityInputs } from './continuity-io.js';
import { healthIssues } from './health.js';
import { readIndexedChapters } from './index-store.js';
import { buildDashboard } from './dashboard.js';
import { runRevisionTask, polishIssues } from './engine-tasks.js';
import { sectionOf, parseBanRules } from './gate-metrics.js';
import { runDraftBatch } from './batch-draft.js';
import { PREFIX, writeJson, readJsonBody, trusted, fail, parsePath, parseQuery, safeDecode, validBookId, validSessionId } from './server-http.js';
import { createWorkspaceIndex } from './server-workspace.js';
import { handle as handleProjects } from './server-routes/projects.js';
import { handle as handleChapters } from './server-routes/chapters.js';
import { handle as handleProposals } from './server-routes/proposals.js';
import { handle as handleWorldbook } from './server-routes/worldbook.js';
import { handle as handleInsights } from './server-routes/insights.js';
import { handle as handleSession, probeSessionCapabilities } from './server-routes/session.js';

// 纯函数落在 server-workspace.js；此处 re-export 保持 server-api.js 的对外导出面不变。
export { parseProjcacheRoots, parseProjcacheSessionFile, unescapeTildeHex, decodeSessionDirRoots } from './server-workspace.js';

/** 域处理器：按顺序认领请求（各域路径段互斥，顺序不影响行为）。 */
const ROUTE_HANDLERS = [handleProjects, handleChapters, handleProposals, handleWorldbook, handleInsights, handleSession];

/**
 * 注册 REST API 路由。
 * @param {object} ctx - cordis 上下文（需注入 webServer + fs）
 * @param {object} config - 插件配置
 */
export function registerServerApi(ctx, config, deps = {}) {
    /** D1 旁路引擎（由 lib/index.js 注入）。缺省为 null → 端点返回可读的不可用错误。 */
    const engine = deps.engine ?? null;
    /** 会话轮换能力探测：只认 lib/index.js 那两条 fiber 交付的 holder（逐请求重读，
     *  服务晚加载也拾得到）。deps.sessionProbe 供测试桩注入。
     *  holder 空 = 宿主没给控制器 → rotate 端点 501，面板退回「复制交接摘要」。 */
    const sessionProbe = deps.sessionProbe ?? (() => probeSessionCapabilities(deps.sessionServices));
    ctx.inject(['webServer'], (wctx) => {
        // 多工作区扫描（会话工作区根推导 + 锻炉书扫描 + 定位书）——实现见 server-workspace.js
        const workspace = createWorkspaceIndex({ ctx, config, deps });

        // 域处理器共享的依赖集合（http 基元 + 扫描索引 + 各库）。
        const api = {
            config, engine, sessionProbe,
            // http 基元与路径工具
            writeJson, readJsonBody, trusted, fail, parseQuery, safeDecode, validBookId, validSessionId,
            /**
             * 「这次请求替哪个会话做事」的唯一取法：POST body 的 session 优先，
             * 退回 URL 的 ?session=，都没有 = '' （按根排序回退，旧行为）。
             * 收口成一份是因为各域以前各读各的：GET 只读 query、POST 只读 body，
             * 面板漏带一处，那一域就悄悄落到**另一会话的同名拷贝**上（多根同名书真机实锤）。
             */
            requestSession: (req, body = undefined) => {
                const fromBody = typeof body?.session === 'string' ? body.session.trim() : '';
                if (fromBody !== '') return fromBody;
                try { return parseQuery(req?.url ?? '').get('session') ?? ''; } catch { return ''; }
            },
            // 多工作区扫描
            ...workspace,
            // 数据/业务库
            store, versioning, proposals, continuity, exportLib, bookConsole,
            diagnoseIntro, loadContinuityInputs, healthIssues, readIndexedChapters, buildDashboard,
            effectiveCharConfig: store.effectiveCharConfig, charConfigSourceLabel: store.charConfigSourceLabel,
            runRevisionTask, polishIssues, sectionOf, parseBanRules, runDraftBatch, cloneProject,
            updateJson, auditLine, assertBookName, isVersionConflict,
        };

        wctx.effect(() => wctx.webServer.register({
            kind: 'prefix',
            path: PREFIX,
            handler: async (req, res) => {
                // ① DNS rebinding 防线（CodeBuddy 审计 2026-10-09）：fence header 不是秘密
                //    （写死在面板 JS），只挡普通跨域；rebinding 下攻击页与 127.0.0.1「同源」，
                //    可自由带 fence。Host 由浏览器按真实目标填写、页面无法伪造，是最硬的一道。
                //    小写归一（Host 是 case-insensitive 头：浏览器恒小写，本地工具可能大写）。
                const hostname = String(req.headers.host ?? '').toLowerCase().replace(/:\d+$/, '');
                if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname)) {
                    fail(res, 403, 'FORBIDDEN_HOST', `只允许本机访问（Host「${hostname}」不在本机白名单）`);
                    return;
                }
                // Origin 存在时（跨域 fetch/POST 总是带）也必须本机；畸形 Origin 直接拒。
                const origin = req.headers.origin;
                if (origin !== undefined) {
                    try {
                        const oh = new URL(String(origin)).hostname;
                        if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(oh)) {
                            fail(res, 403, 'FORBIDDEN_ORIGIN', 'Origin 非本机，已拒绝');
                            return;
                        }
                    } catch {
                        fail(res, 403, 'FORBIDDEN_ORIGIN', 'Origin 畸形，已拒绝');
                        return;
                    }
                }
                // ② fence header 中央收口（2026-10-28）：此前 trusted(req) 在 6 个路由文件里
                //    手抄了 30+ 遍——新增端点漏写一行就是静默开放的写端点，且没有任何测试
                //    会拦（正是「靠自觉」的反面）。面板 apiFetch 对**所有方法**恒带此头
                //    （src/client/api.js:67），这里全方法统一拦截，路由内不再各自检查。
                if (!trusted(req)) {
                    fail(res, 403, 'FORBIDDEN', 'missing fence header');
                    return;
                }
                const segments = parsePath(req.url);
                for (const handle of ROUTE_HANDLERS) {
                    if (await handle(req, res, segments, api)) return;
                }
                // 404
                fail(res, 404, 'NOT_FOUND', 'unknown resource');
            },
        }), 'dsh-novel-forge: server-api');
    });
}
