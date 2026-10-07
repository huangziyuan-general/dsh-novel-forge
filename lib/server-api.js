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
import { runRevisionTask, polishIssues } from './engine-tasks.js';
import { sectionOf, parseBanRules } from './gate-metrics.js';
import { runDraftBatch } from './batch-draft.js';
import { PREFIX, writeJson, readJsonBody, trusted, fail, parsePath, parseQuery, safeDecode, validBookId } from './server-http.js';
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
    /** 会话轮换能力探测（非阻塞属性直读，逐请求重读）。deps.sessionProbe 供测试桩注入；
     *  缺省探测真实 ctx——服务不在 → rotate 端点 501，面板退回复制交接。 */
    const sessionProbe = deps.sessionProbe ?? (() => probeSessionCapabilities(ctx));
    ctx.inject(['webServer'], (wctx) => {
        // 多工作区扫描（会话工作区根推导 + 锻炉书扫描 + 定位书）——实现见 server-workspace.js
        const workspace = createWorkspaceIndex({ ctx, config, deps });

        // 域处理器共享的依赖集合（http 基元 + 扫描索引 + 各库）。
        const api = {
            config, engine, sessionProbe,
            // http 基元与路径工具
            writeJson, readJsonBody, trusted, fail, parseQuery, safeDecode, validBookId,
            // 多工作区扫描
            ...workspace,
            // 数据/业务库
            store, versioning, proposals, continuity, exportLib, bookConsole,
            diagnoseIntro, loadContinuityInputs, healthIssues, readIndexedChapters,
            runRevisionTask, polishIssues, sectionOf, parseBanRules, runDraftBatch, cloneProject,
            updateJson, auditLine, assertBookName, isVersionConflict,
        };

        wctx.effect(() => wctx.webServer.register({
            kind: 'prefix',
            path: PREFIX,
            handler: async (req, res) => {
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