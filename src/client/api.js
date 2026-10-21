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

// ── 会话归属：在唯一一个出口收口，不逐处补参数 ─────────────────────────────
// 「书跟会话走」要求每个按书定位的请求都带上会话 id（服务端 locateBook 靠它在多根
// 同名书里挑对用户看到的那份拷贝）。此前只有列表/详情带了，章节目录/阅读器/听书/
// 保存/提案/导出/删除全都按根排序定位——书卡显示 A 拷贝（105 章）、点进去读到的是
// B 拷贝（103 章），删除还会删错那本（2026-10-19 真机实锤）。
// 逐处补参数的做法已经被证明会漏：漏一处就是漏一路，新加端点还会再漏。
// 所以这里在 apiFetch 内部按**书作用域路径**统一附加——未来新增 /projects/… 端点
// 自动就在护栏内，不需要任何人记得补。
let sessionProvider = () => null;

/** 注入会话 id 来源（panel 装配时调用；不注入 = 一律不带，行为回旧版）。 */
export function setSessionProvider(fn) {
	sessionProvider = typeof fn === 'function' ? fn : (() => null);
}

/**
 * 是否属于「按某一本书定位」的路径。
 * 裸 `/projects`（列表）由调用方自己控范围（sessionScope 决定带不带 session），不在此列；
 * `LITERAL_ACTIONS` 是挂在 /projects 下的**动作段**而非书目名——服务端按字面量匹配它们，
 * 给它们附加 session 既没意义也会让 URL 断言变得含混。**新增这类字面量段时必须登记到这里。**
 */
const LITERAL_ACTIONS = ['/projects/claim'];

function isBookScopedPath(path) {
	if (LITERAL_ACTIONS.some((lit) => path === lit || path.startsWith(`${lit}/`))) return false;
	return path.startsWith('/projects/') || path.startsWith('/worldbook/');
}

function withSession(path) {
	if (!isBookScopedPath(path) || /[?&]session=/.test(path)) return path;
	const sid = sessionProvider();
	if (typeof sid !== 'string' || sid === '') return path;
	const sep = path.includes('?') ? '&' : '?';
	return `${path}${sep}session=${encodeURIComponent(sid)}`;
}

/**
 * 调一次 REST 端点，返回 `value`；失败抛 Error。
 * @param {string} path 相对 API_BASE 的路径，如 `/projects/书/export`
 * @param {object} [init] fetch 的第二参（method / body 等）；`timeoutMs` 可覆盖超时
 */
export async function apiFetch(path, init) {
	const finalPath = withSession(path);
	const timeoutMs = init?.timeoutMs ?? FETCH_TIMEOUT_MS;
	const ac = typeof AbortController === 'function' && timeoutMs > 0 ? new AbortController() : null;
	const timer = ac ? setTimeout(() => ac.abort(), timeoutMs) : null;
	let response;
	try {
		response = await fetch(`${API_BASE}${finalPath}`, {
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
	if (!payload.ok) {
		// code 必须挂在 Error 上一起抛：调用方要按错误族分流（409 GATE_REJECTED 是
		// 「内容没过门禁」，给二次确认；500 IO_FAILURE 是服务故障，只报错不给重试按钮）。
		// 只抛 message 的话，分流就得靠正则匹配中文文案——那正是会静默漂移的写法。
		const gateError = new Error(payload.error?.message ?? `HTTP ${response.status}`);
		gateError.code = payload.error?.code ?? '';
		gateError.status = response.status;
		throw gateError;
	}
	return payload.value;
}
