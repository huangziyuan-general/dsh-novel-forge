// src/client/index.js — 浏览器半（client bundle）入口。
//
// ⚠️ 本文件不直接发布：`npm run build` 会把它与全部依赖打包成
//   lib/client.js（经典脚本 + __ModuleLoader__ factory）
// dsh 只加载 package.json 的 exports["./client"]，也就是那个**构建产物**；
// 源码本身是 ESM，dsh 看不懂也不会去读。所以改完源码必须跑 build，再重启 dsh。
//
// 0.5.0 入口路线（仙尊 2026-09-13 定）：**右侧栏 tab**，不再往左侧栏注入 DOM。
//   · 没写过小说的会话不打扰 —— 本会话有项目时才把它放上屏幕（session-watch.js）；
//   · 项目跟会话走 —— 列表按会话过滤（sessionId 来自 slot inject 工厂）。
//
// 契约（被 test/client.test.mjs 与 dsh 双向依赖）：
//   exports.inject  cordis 服务注入声明
//   exports.apply   插件装配函数，dsh 在物化后调用一次
import { registerForgeTab, openForgeTab, tabDefinition, TAB_ID, TAB_KIND } from './forge-tab.js';
import { startForgeAutoOpen, currentSessionId } from './session-watch.js';
import { ForgePanel, createForgeController } from './panel.js';
import { chunkText, createTtsPlayer, resolveSynth } from './tts.js';
import { apiFetch, FETCH_TIMEOUT_MS } from './api.js';
import { buildCss, ensureStyles, PANEL_ATTR, STYLE_ID } from './css.js';
// 纯渲染原语：测试直测 role 契约（Feedback）与列表筛选（projectMatches / ProjectListView）
import { Feedback } from './ui.js';
import { ProjectListView, projectMatches } from './views/project-list.js';

// 版本号：必须与 package.json 的 version 一致。
// build-client.mjs 会把它与 package.json 对账，不一致直接构建失败（防发行漂移）。
const PLUGIN_VERSION = '0.13.2';

// 供视图头部徽标读取 —— 让视图层不必反向 import 入口（避免循环依赖）。
window.__NOVEL_FORGE_VERSION__ = PLUGIN_VERSION;

/**
 * cordis 服务注入（浏览器侧）：
 *   slots            内容 seat（右栏 pane.tab）
 *   sidebarRightTabs tab 类型注册表（三步契约的第一步）
 *   sidebarRight     导航面（三步契约的第三步 openTab）
 *   sessions         会话列表与当前选择（判断「这是哪个会话」）
 */
const inject = ['slots', 'sidebarRightTabs', 'sidebarRight', 'sessions'];

/**
 * 插件装配。
 * @param {object} ctx cordis 上下文
 */
function apply(ctx) {
	// 分诊日志：**没有这一行**就说明 apply 压根没被调用 ——
	// 问题在加载链路（没构建 / 没重启 dsh），而不在本文件。
	console.info('[novel-forge] client apply v' + PLUGIN_VERSION + ' — 注册右侧栏 tab');

	// ① 类型 + ② 内容 seat（forge-tab.js 的 registerForgeTab）
	// 包装一层：把 sessions 服务的「当前会话」读取器递给面板 —— slot inject 的
	// 会话标识与真 agent 会话 id 被证实可能不同源（0.13.2），面板发请求前以它对齐。
	try {
		registerForgeTab(ctx, (props) => ForgePanel({
			...props,
			resolveSessionId: () => currentSessionId(ctx),
		}));
	} catch (error) {
		console.error('[novel-forge] 右侧栏 tab 注册失败（可从右侧栏 guide 页手动进入）', error);
	}

	// ③ 打开：锻炉是右侧栏**常驻独立 tab** —— 会话里有没有项目都打开。
	//    之前 0.5.0 一度收进「本会话有项目才开」的门控，真机没项目（或 API 没命中）
	//    时右侧栏就没了那个独立「锻炉」，用户要的是"右侧栏 · 单独的"。
	//    面板内部仍按会话语义过滤项目列表，空会话给引导空态（见 project-list.js），
	//    所以无条件打开不会露丑。延迟重试由 openForgeTab 自己兜（seat 未挂载会抛）。
	try {
		openForgeTab(ctx);
	} catch (error) {
		console.warn('[novel-forge] 独立打开右侧栏 tab 失败，可从右侧栏 guide 页手动进入（"小说锻炉"）', error);
	}

	// 保底开关：自动打开失败时，控制台敲一行即可打开；
	// 也给冒烟测试一个不依赖 DOM/时序的入口。
	if (typeof window !== 'undefined') {
		window.__novelForge = {
			version: PLUGIN_VERSION,
			kind: TAB_KIND,
			open: () => openForgeTab(ctx, { maxTries: 1 }),
		};
	}
}

export { inject, apply, PLUGIN_VERSION };

/**
 * headless 门禁的抓手：把纯逻辑暴露给 test/client.test.mjs。
 *
 * 面板组件本身要 React 才渲染得出来（node 里没有），但**控制器是纯闭包**：
 * 会话过滤打什么请求、创建时带不带 session、认领发什么 body —— 这些都能直测。
 * 不给这个出口，测试就只能退回 `code.includes(...)` 那种幻觉绿。
 */
export const __internals = {
	TAB_ID, TAB_KIND, tabDefinition, openForgeTab,
	currentSessionId, startForgeAutoOpen, ForgePanel, createForgeController,
	chunkText, createTtsPlayer, resolveSynth,
	apiFetch, FETCH_TIMEOUT_MS,
	// 交互态样式表：测试要能验证「三态规则齐不齐」「注入是不是单例」
	buildCss, ensureStyles, PANEL_ATTR, STYLE_ID,
	// 视图原语：Feedback 的 role 契约、列表筛选的匹配与渲染
	projectMatches, ProjectListView, Feedback,
};
