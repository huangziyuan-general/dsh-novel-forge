// src/client/react.js — 从宿主模块表取 React 的**唯一出口**。
//
// 为什么要有这个文件（两次真机事故的教训）：
//
// ① **`createRoot` 不在 `react` 里，在 `react-dom/client` 里。**
//    0.4.x 的全屏抽屉自己建 root，写成 `react.createRoot(node)` → 真机 TypeError，
//    表现是「第 1 次点击没反应（容器停在 display:none）、第 2 次点击整屏空白」，
//    极具迷惑性。0.5.0 起面板改由**右侧栏 slot 框架**渲染（我们只返回 element，
//    不自己 createRoot），这条坑随之消失；但历史写在这里，换回自建 root 时别重踩。
// ② 宿主播种的模块表（官方 CHUNK_EXTERNALS / PLATFORM_MODULES）只有：
//    react · react/jsx-runtime · react-dom · react-dom/client · cordis
//    · @deepseek-ai/dsh-client-ui-slots · @deepseek-ai/dsh-client-ui-primitives
//    —— 别 import 表外的东西，构建时会被打进包里、运行时拿不到真正的宿主实例。
//
// 所以：**凡是要 React 的东西，一律走本模块。**
import * as reactNamespace from 'react';

/** 从命名空间取函数：兼容 CJS 直出与 ESM 命名空间包装两种形态。 */
function pickFunction(namespace, name) {
	if (!namespace) return undefined;
	if (typeof namespace[name] === 'function') return namespace[name];
	const wrapped = namespace.default;
	if (wrapped && typeof wrapped[name] === 'function') return wrapped[name];
	return undefined;
}

/** 从命名空间取值（非函数）。 */
function pickValue(namespace, name) {
	if (!namespace) return undefined;
	if (namespace[name] !== undefined) return namespace[name];
	const wrapped = namespace.default;
	return wrapped ? wrapped[name] : undefined;
}

/** React.createElement —— 全插件统一的 h()。 */
export const createElement = pickFunction(reactNamespace, 'createElement');
/** 同 h（别名，读起来顺一点）。 */
export const h = createElement;
export const Fragment = pickValue(reactNamespace, 'Fragment');
export const Component = pickValue(reactNamespace, 'Component');

// hooks：面板是 slot 组件，靠这几个驱动重渲染。
export const useState = pickFunction(reactNamespace, 'useState');
export const useRef = pickFunction(reactNamespace, 'useRef');
export const useEffect = pickFunction(reactNamespace, 'useEffect');
export const useCallback = pickFunction(reactNamespace, 'useCallback');
export const useMemo = pickFunction(reactNamespace, 'useMemo');

/**
 * 诊断「宿主到底给了什么」——出问题时把这份快照贴出来，省掉两轮猜。
 * @returns {{ok:boolean, missing:string[], hasReactNs:boolean, reactKeys:string[]}}
 */
export function diagnoseRenderer() {
	const missing = [];
	if (typeof createElement !== 'function') missing.push('react.createElement');
	for (const [name, fn] of [['useState', useState], ['useRef', useRef], ['useEffect', useEffect]]) {
		if (typeof fn !== 'function') missing.push('react.' + name);
	}
	let reactKeys = [];
	try { reactKeys = Object.keys(reactNamespace ?? {}).slice(0, 16); } catch { reactKeys = []; }
	return {
		ok: missing.length === 0,
		missing,
		hasReactNs: reactNamespace !== undefined && reactNamespace !== null,
		reactKeys,
	};
}
