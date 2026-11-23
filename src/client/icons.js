// src/client/icons.js — 面板统一图标系统（单色线性 SVG，替代装饰性 emoji）。
//
// 为什么要有这一层（1.10.0 视觉升级）：
//   旧界面用彩色 emoji 当功能图标（📋✍️🩺⚡🎧📄🧾🪡👥…）， emoji 的字形、配色、
//   基线在每个系统里都不一样，一屏十几个五颜六色的方块 = 消费级 App 观感，
//   和专业工具（Linear / Notion / VS Code）的克制单色图标语言背道而驰。
//   这里提供一套 15px、currentColor、1.7 描边的线性图标：字形统一、随文字色走、
//   深浅主题自动适配，也不需要任何外部图标库或网络请求。
//
// 契约（别改）：
//   · 全部走 h() = React.createElement —— 宿主只播种 react，不能 require 表外模块；
//   · 尺寸/颜色由 props.style 覆盖，默认 15px / currentColor / 垂直居中；
//   · `aria-hidden`：这些是**装饰性**图标，信息由旁边的文字承担（读屏不该念出来）；
//   · 纯函数，直接调用（与 ui.js 的组件风格一致），headless 测试只看 data-action。
//
// ⚠️ 功能按钮上**有测试锁定**的图标（章节的 📖 / ▶ / ✕）不要动，见 chapters.js。
import { h } from './react.js';

const NS_ATTRS = {
	viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
	strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round',
	'aria-hidden': 'true', focusable: 'false',
};

/**
 * 生成一枚 SVG 图标。
 * @param {string} name 图标名（见下方 PATHS 的键；未知名回落到 dot，绝不抛错）
 * @param {object} [opts] { size, style, strokeWidth }
 */
export function Ico(name, { size = 15, style, strokeWidth } = {}) {
	const paths = PATHS[name] ?? PATHS.dot;
	return h('svg', {
		...NS_ATTRS,
		...(strokeWidth === undefined ? {} : { strokeWidth }),
		width: size, height: size,
		style: { flex: 'none', display: 'inline-block', verticalAlign: '-0.15em', ...style },
		// path 的 key 必须带字符串前缀：面板里章节行用数字 key（c.no=1/2/3），
		// 测试与 React 都会按 key 收集元素；若这里是纯数字 0/1/2 会被误当成章节行。
	}, ...paths.map((d, i) => h('path', { key: `svg-path-${i}`, d })));
}

/**
 * 路径表。全部为 24×24 视口的单笔/多笔线性路径，风格对齐：
 * 直线为主、端点圆角、不闭合填充。新增图标沿用同一套笔画语言。
 */
const PATHS = {
	// ── 标签 / 导航 ──
	book: ['M4 19.5A2.5 2.5 0 0 1 6.5 17H20', 'M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z'],
	pen: ['M12 20h9', 'M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z'],
	pulse: ['M22 12h-4l-3 9L9 3l-3 9H2'],
	checkCircle: ['M22 11.08V12a10 10 0 1 1-5.93-9.14', 'm9 11 3 3L22 4'],
	bolt: ['M13 2 3 14h9l-1 8 10-12h-9l1-8z'],
	headphones: ['M3 18v-6a9 9 0 0 1 18 0v6', 'M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z'],

	// ── 统计 / 资料 ──
	page: ['M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z', 'M14 2v6h6'],
	receipt: ['M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1Z', 'M8 7h8', 'M8 11h8', 'M8 15h5'],
	thread: ['M12 2v4', 'M12 18v4', 'M5 8l3.5 2', 'M15.5 14 19 16', 'M19 8l-3.5 2', 'M8.5 14 5 16', 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z'],
	users: ['M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2', 'circle@9,7,4', 'M22 21v-2a4 4 0 0 0-3-3.87', 'M16 3.13a4 4 0 0 1 0 7.75'],
	layers: ['m12 2 9 5-9 5-9-5 9-5z', 'm3 12 9 5 9-5', 'm3 17 9 5 9-5'],
	map: ['m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3V6z', 'M9 3v15', 'M15 6v15'],
	clock: ['circle@12,12,9', 'M12 7v5l3 2'],
	globe: ['circle@12,12,9', 'M3 12h18', 'M12 3a15 15 0 0 1 0 18', 'M12 3a15 15 0 0 0 0 18'],

	// ── 动作 ──
	refresh: ['M21 2v6h-6', 'M3 12a9 9 0 0 1 15-6.7L21 8', 'M3 22v-6h6', 'M21 12a9 9 0 0 1-15 6.7L3 16'],
	upload: ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'm17 8-5-5-5 5', 'M12 3v12'],
	download: ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'm7 10 5 5 5-5', 'M12 15V3'],
	settings: ['circle@12,12,3', 'M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 0 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 0 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 0 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 0 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z'],
	trash: ['M3 6h18', 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6', 'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2'],
	copy: ['rect@9,9,13,13,2', 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1'],
	back: ['m12 19-7-7 7-7', 'M19 12H5'],
	arrowRight: ['M5 12h14', 'm12 5 7 7-7 7'],
	plus: ['M12 5v14', 'M5 12h14'],
	edit: ['M12 20h9', 'M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z'],
	sparkle: ['m12 3 1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6L12 3z', 'M19 16l.7 1.8L21.5 18l-1.8.7L19 20.5l-.7-1.8L16.5 18l1.8-.2L19 16z'],
	play: ['M7 4v16l13-8L7 4z'],
	pause: ['M8 5v14', 'M16 5v14'],
	stop: ['rect@6,6,12,12,1'],
	eye: ['M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z', 'circle@12,12,3'],
	close: ['M18 6 6 18', 'M6 6l12 12'],
	chevron: ['m6 9 6 6 6-6'],

	// ── 品牌 ──
	// 锻炉 logo：铁砧 + 上方一簇火苗。为 logo 专门画，笔画比功能图标略粗，
	// 缩到 18px 仍认得出「这是打铁的地方」。
	forge: ['M4 10h11l-1.5 3H14v3h-3v-3H8v3H5v-3h.5L4 10z', 'M6 7h7', 'M12.5 4.5c0 1.2-1 1.6-1 2.6 0 .6.4 1 .9 1.1-.2-1 .6-1.5.6-2.4 1 .9 1.3 1.9.9 2.9 1-.5 1.4-1.6 1.1-2.7-.4-1.5-1.9-2.2-2.5-1.5z'],

	// ── 状态 / 提示 ──
	warn: ['m10.3 3.9-8.1 14A2 2 0 0 0 3.9 21h16.2a2 2 0 0 0 1.7-3.1l-8.1-14a2 2 0 0 0-3.4 0z', 'M12 9v4', 'M12 17h.01'],
	shield: ['M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z'],
	target: ['circle@12,12,9', 'circle@12,12,5', 'circle@12,12,1'],
	warning: ['M10.3 3.9 2.2 17.9A2 2 0 0 0 3.9 21h16.2a2 2 0 0 0 1.7-3.1L13.7 3.9a2 2 0 0 0-3.4 0z', 'M12 9v5', 'M12 17h.01'],
	dot: ['circle@12,12,2'],
};

/**
 * 迷你语法：路径表里的 `circle@cx,cy,r` / `rect@x,y,w,h,r` 展开成真实 SVG 路径。
 * 让表保持可读，又不引入 <circle>/<rect> 节点（统一只发 <path>，SVG 渲染更快）。
 */
for (const [name, list] of Object.entries(PATHS)) {
	PATHS[name] = list.map((d) => {
		if (d.startsWith('circle@')) {
			const [cx, cy, r] = d.slice(7).split(',').map(Number);
			return `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${r * 2} 0a${r} ${r} 0 1 0 ${-r * 2} 0`;
		}
		if (d.startsWith('rect@')) {
			const [x, y, w, hh, rr = 2] = d.slice(5).split(',').map(Number);
			return `M${x + rr} ${y}h${w - 2 * rr}a${rr} ${rr} 0 0 1 ${rr} ${rr}v${hh - 2 * rr}a${rr} ${rr} 0 0 1 ${-rr} ${rr}h${-(w - 2 * rr)}a${rr} ${rr} 0 0 1 ${-rr} ${-rr}v${-(hh - 2 * rr)}a${rr} ${rr} 0 0 1 ${rr} ${-rr}z`;
		}
		return d;
	});
}

export const ICON_NAMES = Object.keys(PATHS);
