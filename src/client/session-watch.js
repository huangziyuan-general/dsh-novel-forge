// src/client/session-watch.js — 「用了工具的会话才显示 tab」的调度层。
//
// 产品语义（仙尊 2026-09-13 定）：
//   · 入口放**右侧栏**（不再是左侧栏 DOM 注入）；
//   · **只在会话里真的有了小说项目时才把它放上屏幕** —— 没写过小说的会话不打扰；
//   · 项目 = **本会话**的项目，会话里创建了几本就几本（按会话过滤，见 lib/store.js 的 sessions）。
//
// 怎么判断「本会话有项目」：服务端 REST `GET /projects?session=<id>` 只回本会话的书。
// 客户端拿当前会话 id 的唯一正道是 `ctx.sessions.list`（ObservableSnapshot<SessionListState>，
// 其中 `current: SessionId`）—— 这条比从 URL 或 DOM 里抠 id 稳得多。
//
// 为什么还要轮询：书是**会话里的 AI 调工具**创建的，客户端不会收到通知。
// 会话切换时查一次 + 未打开时每 8 秒轻量轮询一次，直到该会话的项目出现为止；
// 一旦为某个会话打开过就不再重复（关掉是用户的自由，不跟用户抢）。
import { apiFetch } from './api.js';
import { openForgeTab } from './forge-tab.js';

/** 轮询间隔：只查「本会话有没有项目」，请求极小。 */
export const POLL_INTERVAL_MS = 8000;

/**
 * 读当前会话 id。
 *
 * `ctx.sessions.list` 是 ObservableSnapshot，真机形态是 `getSnapshot()` + `subscribe()`；
 * 这里对三种可能形态都做兜底（getSnapshot / snapshot() / 裸对象），任一形态变了都不至于瞎。
 * @returns {string|null}
 */
export function currentSessionId(ctx) {
	const face = ctx?.sessions?.list;
	if (!face) return null;
	let snapshot = null;
	try {
		if (typeof face.getSnapshot === 'function') snapshot = face.getSnapshot();
		else if (typeof face.snapshot === 'function') snapshot = face.snapshot();
		else snapshot = face;
	} catch {
		return null;
	}
	const id = snapshot?.current;
	return typeof id === 'string' && id !== '' ? id : null;
}

/**
 * 订阅会话切换（拿不到订阅面时退化成空实现 —— 后面还有轮询兜底）。
 * @returns {Function} 取消订阅
 */
export function onSessionChange(ctx, listener) {
	const face = ctx?.sessions?.list;
	if (!face || typeof face.subscribe !== 'function') return () => {};
	try {
		const off = face.subscribe(() => listener(currentSessionId(ctx)));
		return typeof off === 'function' ? off : () => {};
	} catch {
		return () => {};
	}
}

/**
 * 启动「有项目才显示」调度。
 * @param {object} ctx cordis 客户端上下文
 * @param {object} [opts]
 * @param {Function} [opts.fetchProjects] 取本会话项目（默认 REST）
 * @param {number}   [opts.intervalMs]
 * @param {Function} [opts.setTimer]
 * @param {Function} [opts.clearTimer]
 * @param {Function} [opts.openTab] 打开 tab 的策略（默认延迟重试版）
 * @param {object}   [opts.log]
 * @returns {Function} stop
 */
export function startForgeAutoOpen(ctx, opts = {}) {
	const intervalMs = opts.intervalMs ?? POLL_INTERVAL_MS;
	const setTimer = opts.setTimer ?? setTimeout;
	const clearTimer = opts.clearTimer ?? clearTimeout;
	const log = opts.log ?? console;
	const fetchProjects = opts.fetchProjects
		?? ((sessionId) => apiFetch(`/projects?session=${encodeURIComponent(sessionId)}`));
	const openTab = opts.openTab ?? ((c) => openForgeTab(c, { timer: setTimer, log }));

	/** 已经自动打开过的会话 —— 不重复打扰（用户手动关掉后也不强行再开）。 */
	const opened = new Set();
	let stopped = false;
	let inflight = false;
	let timerId = null;

	const check = async () => {
		if (stopped || inflight) return;
		const sessionId = currentSessionId(ctx);
		if (sessionId === null || opened.has(sessionId)) return;
		inflight = true;
		try {
			const books = await fetchProjects(sessionId);
			if (!stopped && !opened.has(sessionId) && Array.isArray(books) && books.length > 0) {
				opened.add(sessionId);
				log.info(`[novel-forge] 本会话有 ${books.length} 个项目 → 打开右侧栏 tab`);
				openTab(ctx);
			}
		} catch {
			// 服务端还没起来 / 面板未挂载 / 会话刚切走：都不是错，下一轮再说
		} finally {
			inflight = false;
		}
	};

	const schedule = () => {
		if (stopped) return;
		timerId = setTimer(() => { void check(); schedule(); }, intervalMs);
	};

	const off = onSessionChange(ctx, () => { void check(); });
	void check();          // 冷启动先查一次
	schedule();

	return () => {
		stopped = true;
		try { off(); } catch { /* 订阅面已拆 */ }
		if (timerId !== null) clearTimer(timerId);
	};
}
