// src/client/ui.js — 面板的 UI 原语层（视图只跟它打交道，不直接拼 style 对象）。
//
// 为什么要有这一层：6 个视图如果各自 `h('div', { style: {...} })` 拼样式，
// 同一件事（一个统计胶囊、一个空态、一段九阶段轨道）就会被写出 6 个略微不同的版本，
// 改一次颜色要翻 6 个文件——0.12 之前的「哪里都不一样」就是这么来的。
//
// 约定：
//   · 这些都是**纯函数**，直接调用，不注册成 React 组件 ——
//     面板的视图本来就是「普通函数 + props 对象」这种直接调用风格（见 panel.js），
//     保持同一种调用形态，headless 预览也才不用真 React 就能序列化出 HTML。
//   · 交互一律靠 `data-action`（宿主里 React 合成事件不可靠），所以按钮只接受
//     `action`/`id`/`field`，不接 onClick。
import { h } from './react.js';
import {
	color, space, radius, font, weight, tint,
	card, btnLayout, chip, meterTrackStyle, meterFillStyle,
	emptyStateStyle, emptyIconStyle, emptyTitleStyle, hintStyle, stackStyle,
} from './styles.js';
import { PHASES, phaseIndex } from '../../lib/phases.js';

/**
 * 可点区域的标记。**它的交互态在 `css.js` 里**（`[data-nf-tap]:hover` / `:active`）——
 * 内联样式压不过 `:hover`，所以「有反馈」这件事只能靠标记 + 样式表。
 * 视图里写成 `...TAP`，别手打属性名（打错就是静默没反馈）。
 */
export const TAP = { 'data-nf-tap': '1' };

/** 卡片。`tone`: plain | inset | accent | warn | danger | ok。 */
export function Card({ tone = 'plain', pad } = {}, ...children) {
	return h('div', { style: pad === undefined ? card({ tone }) : card({ tone, pad }) }, ...children);
}

/** 区块标题行：图标 + 标题 +（可选）右侧内容。 */
export function Section({ icon = '', title, right = null } = {}, ...children) {
	return h('div', { style: stackStyle(space.sm) },
		h('div', { style: { display: 'flex', alignItems: 'center', gap: space.sm } },
			h('span', { style: { fontWeight: weight.semibold, fontSize: font.small, color: color.text2 } },
				icon ? `${icon} ${title}` : title),
			right ? h('span', { style: { marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: space.xs } }, right) : null,
		),
		...children,
	);
}

/**
 * 按钮。`action` 会写进 data-action（事件代理的落点）；
 * `id` 写进 data-id；`field` 用于表单类控件。
 *
 * ⚠️ 这里**只给几何**（`btnLayout`）：底色/描边/字色由 `css.js` 按 `data-variant` 给，
 * 因为内联样式优先级高于 `:hover` / `:active` —— 外观留在内联里按钮就永远没有按下反馈。
 */
export function Btn({ variant = 'secondary', size = 'md', action, id, disabled = false, title, block = false } = {}, ...label) {
	const style = { ...btnLayout({ size }) };
	if (block) style.width = '100%';
	return h('button', {
		'data-nf-btn': '1',
		'data-variant': variant,
		'data-size': size,
		...(action ? { 'data-action': action } : {}),
		...(id === undefined || id === null ? {} : { 'data-id': String(id) }),
		...(disabled ? { disabled: true } : {}),
		...(title ? { title } : {}),
		style,
	}, ...label);
}

/** 胶囊标签。`tone`: neutral | accent | ok | warn | danger | ink。 */
export function Chip({ tone = 'neutral' } = {}, ...children) {
	return h('span', { style: chip({ tone }) }, ...children);
}

/**
 * 统计块（项目卡的「12 章」「34 台账」这种）。
 * 数字加重、单位弱化，扫读时先看数。
 */
export function Stat({ icon = '', value, unit = '', tone = 'neutral' } = {}) {
	const toneColor = tone === 'warn' ? color.warn : tone === 'danger' ? color.danger
		: tone === 'ok' ? color.ok : tone === 'accent' ? color.accent : color.text2;
	return h('span', {
		style: {
			display: 'inline-flex', alignItems: 'baseline', gap: '2px',
			fontSize: font.caption, color: color.text3, whiteSpace: 'nowrap',
		},
	},
		icon ? h('span', { style: { fontSize: '10px' } }, icon) : null,
		h('span', { style: { fontWeight: weight.semibold, fontSize: font.small, color: toneColor } }, String(value)),
		unit ? h('span', null, unit) : null,
	);
}

/**
 * 九阶段轨道：9 段小条，已过阶段实心、当前阶段着色加粗、未来阶段只留描边。
 * 阶段链是单一定义（lib/phases.js），这里只负责画——不要在视图里另抄一份阶段名。
 * @param {object} p { stage }  novel.stage（九阶段 id 或旧五阶段别名）
 */
export function StageRail({ stage } = {}) {
	const idx = phaseIndex(stage);
	const current = idx >= 0 ? PHASES[idx] : null;
	return h('div', { style: stackStyle(space.xs) },
		h('div', {
			style: { display: 'flex', gap: '2px', alignItems: 'center' },
			title: current ? `当前阶段：${current.label}（${current.entry}）` : '阶段未标记',
		},
			PHASES.map((p, i) => h('span', {
				key: p.id,
				style: {
					flex: '1 1 0', height: '3px', borderRadius: radius.pill,
					background: i < idx ? color.accent
						: i === idx ? color.accent : color.border2,
					opacity: i > idx ? 1 : (i === idx ? 1 : 0.55),
					boxShadow: i === idx ? `0 0 0 1.5px ${tint(color.accent, 30)}` : 'none',
				},
			})),
		),
		h('div', { style: { display: 'flex', alignItems: 'center', gap: space.xs } },
			Chip({ tone: 'accent' }, current ? current.label : '未标阶段'),
			current ? h('span', { style: { ...hintStyle, fontSize: font.caption } },
				`${idx + 1}/${PHASES.length}`) : null,
		),
	);
}

/** 占比条。 */
export function Meter({ pct, tone = 'accent' } = {}) {
	return h('div', { style: meterTrackStyle }, h('div', { style: meterFillStyle(pct, tone) }));
}

/** 空态：图标 + 主文案 +（可选）次文案 +（可选）动作行。 */
export function Empty({ icon = '·', title, hint = null, action = null } = {}) {
	return h('div', { style: emptyStateStyle },
		h('span', { style: emptyIconStyle }, icon),
		h('div', { style: emptyTitleStyle }, title),
		hint ? h('div', { style: { ...hintStyle, fontSize: font.caption, lineHeight: 1.7 } }, hint) : null,
		action ? h('div', { style: { display: 'flex', gap: space.sm, marginTop: space.xs } }, ...action) : null,
	);
}

/** 键值行（档案/设置）。 */
export function KV({ k } = {}, ...children) {
	return h('div', { style: { display: 'flex', gap: space.md, alignItems: 'flex-start' } },
		h('span', {
			style: {
				flex: 'none', minWidth: '52px', fontFamily: color.mono,
				fontSize: font.caption, color: color.text3, paddingTop: '2px',
			},
		}, k),
		h('span', { style: { flex: '1 1 auto', minWidth: 0, fontSize: font.small, wordBreak: 'break-word' } }, ...children),
	);
}

/** 可折叠区块（原生 <details>，不吃 React 事件，不需要事件代理）。 */
export function Fold({ title, open = false, tone = 'plain' } = {}, ...children) {
	const c = card({ tone, pad: space.md });
	return h('details', { style: c, open },
		h('summary', {
			style: {
				cursor: 'pointer', fontSize: font.small, color: color.text2,
				fontWeight: weight.medium, listStylePosition: 'inside',
			},
		}, title),
		h('div', { style: { marginTop: space.sm } }, ...children),
	);
}

/** 等宽小段（文件名、id、路由这类）。 */
export function Mono(_props = {}, ...children) {
	return h('span', { style: { fontFamily: color.mono, fontSize: font.caption, color: color.text3 } }, ...children);
}
