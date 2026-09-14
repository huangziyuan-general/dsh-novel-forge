// src/client/views/settings.js — 设置视图。
//
// 目前只做只读的「能力清单」：让用户在 UI 里确认插件确实注册了什么，
// 不必去翻会话。写操作（开关 / 数据目录）预留给后续的 /settings 端点。
import { h } from '../react.js';
import { btnStyle, cardStyle, rowStyle, kStyle, vStyle, footerStyle } from '../styles.js';

export function SettingsView() {
	return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
		h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
			h('button', { 'data-action': 'back-from-settings', style: btnStyle }, '← 返回'),
			h('span', { style: { fontWeight: 700, fontSize: '14px' } }, '⚙ 设置'),
		),
		h('div', { style: cardStyle },
			h('div', { style: rowStyle },
				h('span', { style: kStyle }, 'tools'),
				h('span', { style: vStyle }, '20 个 novel_* 工具已注册')),
			h('div', { style: rowStyle },
				h('span', { style: kStyle }, 'channels'),
				h('span', { style: vStyle }, '宿主 + MCP 双通道')),
			h('div', { style: rowStyle },
				h('span', { style: kStyle }, 'guides'),
				h('span', { style: vStyle }, '账本 / 门禁 / 机审 / 提案')),
		),
		h('p', { style: footerStyle }, '在会话中调用 novel_* 工具驱动。'),
	);
}
