// src/client/api.js — 与服务端半（lib/server-api.js）通话的唯一出口。
//
// 契约：所有响应都是 `{ ok: true, value } | { ok: false, error: { code, message } }`；
// `ok:false` 直接抛错，让调用方统一走 try/catch，不用每次判空。
// 每个请求都带 fence header —— 服务端拿它当跨站调用门禁（缺失即 403）。

/** REST 基础路径，与 lib/server-api.js 的挂载点必须一致。 */
export const API_BASE = '/api/novel-forge';

/** 服务端门禁头：值不重要，存在即可。 */
export const FENCE = 'x-dsh-novel-forge';

/** 单请求超时（毫秒）：卡死的请求 12 秒后必须变成可见错误，不许永远「加载中」。 */
export const FETCH_TIMEOUT_MS = 12_000;

/**
 * 调一次 REST 端点，返回 `value`；失败抛 Error。
 * @param {string} path 相对 API_BASE 的路径，如 `/projects/书/export`
 * @param {object} [init] fetch 的第二参（method / body 等）；`timeoutMs` 可覆盖超时
 */
export async function apiFetch(path, init) {
	const timeoutMs = init?.timeoutMs ?? FETCH_TIMEOUT_MS;
	const ac = typeof AbortController === 'function' && timeoutMs > 0 ? new AbortController() : null;
	const timer = ac ? setTimeout(() => ac.abort(), timeoutMs) : null;
	let response;
	try {
		response = await fetch(`${API_BASE}${path}`, {
			...init,
			signal: init?.signal ?? ac?.signal,
			headers: { ...(init?.headers ?? {}), [FENCE]: '1', 'content-type': 'application/json' },
		});
	} catch (error) {
		// 超时、断网、调用方自己中止在这里「长相一样」（都是 fetch reject），分开说人话：
		const aborted = error?.name === 'AbortError';
		if (aborted) {
			// 只有当我们**自己**那个超时 controller 触发时才叫「请求超时」；
			// 调用方自带 signal 中止的（不用超时），不该误报成超时。
			throw new Error(ac && !init?.signal
				? `请求超时：${path}（${Math.round(timeoutMs / 1000)} 秒无响应，服务可能没起或被浏览器扩展/代理拦截）`
				: `请求已中止：${path}（信号取消）`);
		}
		throw new Error(`网络错误：${String(error?.message ?? error)}`);
	} finally {
		if (timer) clearTimeout(timer);
	}
	let payload;
	try {
		payload = await response.json();
	} catch {
		// 典型场景：dsh 重启后旧页面的请求被 401 成 text/plain，或代理回了 HTML
		throw new Error(`响应不是 JSON（HTTP ${response.status}）—— 页面可能过期，硬刷新（Cmd+Shift+R）后再试`);
	}
	if (!payload.ok) throw new Error(payload.error?.message ?? `HTTP ${response.status}`);
	return payload.value;
}
