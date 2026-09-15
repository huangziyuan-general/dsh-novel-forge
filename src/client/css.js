// src/client/css.js — 交互态样式表（面板里**唯一**能表达 :hover / :active 的地方）。
//
// 为什么必须有这个文件（0.13.1 的真故障）：
//   面板的样式基本都是 React 内联样式对象，而**内联样式的优先级高于任何选择器规则** ——
//   包括 `:hover` / `:active`。所以 0.13.0 之前所有按钮都没有悬停与按下反馈：
//   「↻ 刷新」「⇪ 导入本地」点下去毫无动静；配上当时偏灰的静态配色，
//   用户的第一反应就是「这些按钮是坏的」。
//
// 分工（别再揉在一起）：
//   · styles.js  → 颜色/尺度/几何（内联样式对象）
//   · css.js     → 交互态与"必须被选择器命中的外观"（一张注入的 <style>）
//   按钮的**静态外观**也放这里：底/描边/字色若留在内联里，`:hover` 永远压不过它。
//
// 约定：
//   · 颜色一律从 `styles.js` 的表里取（btnSkin / color），**不在这里另抄一份色值**。
//   · 选择器一律以面板根起头，绝不外溢到宿主的其它界面。
//   · DOM 单例：宿主会反复装配插件，查到已有 <style> 就收养，不重复插。
//   · 深色专属微调用 `:where(body[data-ds-dark-theme])` 降权重（见文件末尾说明）。

import { color, space, radius, font, tint, btnSkin, BTN_VARIANTS } from './styles.js';

/**
 * 面板根属性。**唯一定义处**（面板组件与样式表都以它为准）。
 * 改这个名字等于换掉整套样式的生效范围，两处会同时跟上。
 */
export const PANEL_ATTR = 'data-dsh-novel-forge-panel';

/** 注入的 <style> 元素 id（单例键）。 */
export const STYLE_ID = 'dsh-novel-forge-css';

const ROOT = `[${PANEL_ATTR}]`;

/** 宿主深色主题的开关：主题包就是这么切的（`body[data-ds-dark-theme]`）。 */
const DARK = ':where(body[data-ds-dark-theme])';

/** React style 对象 → CSS 声明串（camelCase → kebab-case）。 */
function decl(style) {
	return Object.entries(style)
		.filter(([, v]) => v !== undefined && v !== null && v !== '')
		.map(([k, v]) => `${k.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())}:${v}`)
		.join(';');
}

/** 拼一条规则（选择器列表 + 声明串）。 */
const rule = (sel, style) => `${sel}{${decl(style)}}`;

/** 按钮三态：每个变体一条 rest + :hover + :active。 */
function buttonRules() {
	const out = [];
	for (const variant of BTN_VARIANTS) {
		const skin = btnSkin[variant];
		if (!skin) continue;
		const sel = `${ROOT} [data-nf-btn][data-variant="${variant}"]`;
		out.push(rule(sel, skin.rest));
		out.push(rule(`${sel}:hover:not(:disabled)`, skin.hover));
		out.push(rule(`${sel}:active:not(:disabled)`, {
			...skin.active,
			// "按下"的物理感：下沉 1px + 内阴影。**不改几何尺寸**，所以按钮不会跳。
			transform: 'translateY(1px)',
			boxShadow: 'inset 0 1px 3px rgba(0,0,0,.16)',
		}));
	}
	return out;
}

/** 组装整张样式表。纯函数，便于单测与预览复用。 */
export function buildCss() {
	return [
		`/* dsh-novel-forge 面板交互态（由 src/client/css.js 生成，勿手改）*/`,

		// ── 按钮基座：三态的前提是"外观由 CSS 说了算" ──
		rule(`${ROOT} [data-nf-btn]`, {
			borderWidth: '1px', borderStyle: 'solid', borderColor: 'transparent',
			background: 'transparent', color: color.text,
			transition: 'background-color .13s ease, border-color .13s ease, color .13s ease, box-shadow .13s ease, transform .06s ease',
			WebkitTapHighlightColor: 'transparent',
			touchAction: 'manipulation', // 消除移动端双击缩放延迟
		}),
		// 焦点环给**所有**可点元素，不只 [data-nf-btn]：分段控件（详情页 tab）、
		// 书卡标题按钮（TAP）、头部 ⚙ 都是裸 <button>——没有这条，键盘用户
		// 在面板最高频的入口上是「聚焦了但看不见」。
		rule(`${ROOT} button:focus-visible, ${ROOT} summary:focus-visible`, {
			outline: `2px solid ${color.accent}`, outlineOffset: '1px',
		}),
		rule(`${ROOT} [data-nf-btn]:disabled`, { opacity: '.45', cursor: 'default' }),
		...buttonRules(),

		// ── 可点区域（卡片 / 目录行 / 分段控件 / 标题块）──
		// 这些元素的**底色来自内联 card()**，内联优先级更高 → hover/active 必须 `!important`
		// 才压得过。只压这两个伪类，常态外观一概不动。
		rule(`${ROOT} [data-nf-tap]`, {
			transition: 'background-color .13s ease, border-color .13s ease, box-shadow .13s ease, transform .06s ease',
			touchAction: 'manipulation',
		}),
		rule(`${ROOT} [data-nf-tap]:hover`, {
			background: `${color.hover} !important`,
			borderColor: `${color.border3} !important`,
		}),
		rule(`${ROOT} [data-nf-tap]:active`, {
			background: `${color.pressed} !important`,
			transform: 'translateY(1px)',
		}),

		// ── 分段控件（📋 基本信息 / 🎧 章节听书）──
		// 「选中」是**状态**不是伪类，所以用 `data-active` 表达，让 CSS 一次管好
		// rest / hover / active / selected 四态。四态都写在样式表里才不会互相打架
		//（之前底色与字色内联，选中项一悬停就会丢掉"选中"的样子）。
		rule(`${ROOT} [data-nf-seg]`, {
			background: 'transparent', color: color.text3, boxShadow: 'none',
			touchAction: 'manipulation',
		}),
		rule(`${ROOT} [data-nf-seg]:hover:not([data-active="1"])`, { background: color.hover }),
		rule(`${ROOT} [data-nf-seg]:active:not([data-active="1"])`, {
			background: color.pressed, transform: 'translateY(1px)',
		}),
		rule(`${ROOT} [data-nf-seg][data-active="1"]`, {
			background: color.surface3, color: color.text,
			boxShadow: `inset 0 0 0 1px ${color.border2}`,
		}),

		// ── 输入：聚焦要看得见（宿主右侧栏里全是输入框，没焦点环很难用）──
		rule(`${ROOT} input:focus, ${ROOT} textarea:focus, ${ROOT} select:focus`, {
			borderColor: `${color.accent} !important`,
			boxShadow: `0 0 0 2px ${tint(color.accent, 22)} !important`,
			outline: 'none',
		}),
		rule(`${ROOT} input, ${ROOT} textarea, ${ROOT} select`, {
			transition: 'border-color .13s ease, box-shadow .13s ease',
		}),
		rule(`${ROOT} ::placeholder`, { color: color.textDim }),

		// ── 折叠标题（原生 <details>，不吃事件代理）──
		rule(`${ROOT} summary:hover`, { color: `${color.text} !important` }),
		rule(`${ROOT} summary:focus-visible`, {
			outline: `2px solid ${color.accent}`, outlineOffset: '2px', borderRadius: `${radius.sm}px`,
		}),

		// ── 标题字重与行距（右侧栏窄，标题太轻会糊）──
		// ⚠️ 裸 <button> 的 UA 默认灰底（ButtonFace）会透出来 —— 书卡标题按钮走 TAP
		// 不走 Btn，0.13.1 里书名底下那条"灰色横条"就是它（用户看作"与下方重叠"）。
		// 这里统一抹掉 UA 外观；真按钮（[data-nf-btn] / [data-nf-seg]）的规则
		// 权重更高，不受影响。
		rule(`${ROOT} button`, { font: 'inherit', background: 'transparent', border: 'none' }),

		// ── 深色专属微调 ──
		// 用 `:where()` 把选择器权重降到 0，**否则会压过上面的 `:active` 内阴影**
		// （`body[data-x] [y]` 比 `[y]:active` 权重更高）。这类"降权重"是深色补丁的通用手法。
		rule(`${DARK} ${ROOT} [data-nf-tap]`, {
			boxShadow: 'inset 0 1px 0 rgba(255,255,255,.04)',
		}),
		rule(`${DARK} ${ROOT} [data-nf-btn][data-variant="secondary"]`, {
			background: 'rgba(255,255,255,.05)',
			borderColor: 'rgba(255,255,255,.10)',
		}),
		rule(`${DARK} ${ROOT} [data-nf-btn][data-variant="secondary"]:hover:not(:disabled)`, {
			background: 'rgba(255,255,255,.10)',
			borderColor: 'rgba(255,255,255,.18)',
		}),

		`/* ── 尺度备查（改间距只动 styles.js，这里仅声明面板不引入外边距抖动）── */
${ROOT} *{box-sizing:border-box}
${ROOT} :where(h1,h2,h3,p){margin:0}
${ROOT} [data-nf-gap]{gap:${space.sm}px}
/* 窄栏里长单词/长路径不撑破布局 */
${ROOT} :where(span,div,p,code){overflow-wrap:anywhere}`,

		// ── 动效弱化（系统开了「减少动态效果」时）──
		// 位移与过渡都停：按下反馈只剩内阴影/底色，信息不丢、不晃。
		// 收成单行：静态自检要求每条含 `{` 的行都带面板根限定，@media 独占一行会破例。
		`@media (prefers-reduced-motion: reduce){${ROOT} [data-nf-btn],${ROOT} [data-nf-tap],${ROOT} [data-nf-seg],${ROOT} input,${ROOT} textarea,${ROOT} select{transition:none}${ROOT} [data-nf-btn]:active:not(:disabled),${ROOT} [data-nf-tap]:active,${ROOT} [data-nf-seg]:active:not([data-active="1"]){transform:none}}`,
	].join('\n');
}

/**
 * 注入样式表（**DOM 单例**）。
 *
 * 反复装配是宿主的常态（切会话/重挂载都会再走一次 apply），
 * 所以这里必须先查后插：查到就收养，绝不插第二份。
 * 拿不到 document / head 时返回 null（headless 测试与非浏览器环境），不抛错。
 *
 * @param {Document} [doc] 便于测试注入假 document
 * @returns {HTMLElement|null} 样式元素
 */
export function ensureStyles(doc = globalThis.document) {
	if (!doc) return null;
	let existing = null;
	try {
		existing = doc.getElementById ? doc.getElementById(STYLE_ID) : null;
		if (!existing && doc.querySelector) existing = doc.querySelector(`#${STYLE_ID}`);
	} catch { existing = null; }
	// 已存在但内容变了（热更新/版本升级）→ 就地更新，不新增节点
	if (existing) {
		const css = buildCss();
		if (existing.textContent !== css) existing.textContent = css;
		return existing;
	}
	let el = null;
	try { el = doc.createElement('style'); } catch { return null; }
	if (!el) return null;
	try {
		el.id = STYLE_ID;
		el.textContent = buildCss();
	} catch { /* 假 DOM 可能只读，忽略 */ }
	const host = doc.head ?? doc.body ?? null;
	if (!host || typeof host.appendChild !== 'function') return null;
	try { host.appendChild(el); } catch { return null; }
	return el;
}
