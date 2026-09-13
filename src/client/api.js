// src/client/api.js — 与服务端半（lib/server-api.js）通话的唯一出口。
//
// 契约：所有响应都是 `{ ok: true, value } | { ok: false, error: { code, message } }`；
// `ok:false` 直接抛错，让调用方统一走 try/catch，不用每次判空。
// 每个请求都带 fence header —— 服务端拿它当跨站调用门禁（缺失即 403）。

/** REST 基础路径，与 lib/server-api.js 的挂载点必须一致。 */
export const API_BASE = '/api/novel-forge';

/** 服务端门禁头：值不重要，存在即可。 */
export const FENCE = 'x-dsh-novel-forge';

/**
 * 调一次 REST 端点，返回 `value`；失败抛 Error。
 * @param {string} path 相对 API_BASE 的路径，如 `/projects/书/export`
 * @param {object} [init] fetch 的第二参（method / body 等）
 */
export async function apiFetch(path, init) {
	const response = await fetch(`${API_BASE}${path}`, {
		...init,
		headers: { ...(init?.headers ?? {}), [FENCE]: '1', 'content-type': 'application/json' },
	});
	const payload = await response.json();
	if (!payload.ok) throw new Error(payload.error?.message ?? `HTTP ${response.status}`);
	return payload.value;
}
