// src/client/views/project-list.js — 项目列表视图（首屏）。
//
// 纯渲染：只读 state，不改。所有交互靠 `data-action` / `data-field`，
// 由 panel.js 的原生事件代理统一接住（宿主里 React 合成事件不可靠）。
//
// 「项目跟会话走」：这里的列表已经是**本会话**的书（服务端按 session 过滤过）。
// 0.5.0 之前建的书没有会话戳，会落在 state.unclaimed 里 —— 底部给一条认领通道，
// 免得老书从此看不见。
import { h } from '../react.js';
import { btnStyle, inputStyle, errStyle, footerStyle, okStyle, hintStyle, itemCardStyle, miniBtnStyle, accentBtnStyle } from '../styles.js';

export function ProjectListView({ state: s }) {
	return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
		h('div', { style: { fontWeight: 700, fontSize: '14px' } }, '本项目会话的项目'),

		// 创建表单
		h('div', { style: { display: 'flex', gap: '6px' } },
			h('input', {
				'data-field': 'title', value: s.title, placeholder: '书名',
				style: { ...inputStyle, flex: 1 },
			}),
			h('button', {
				'data-action': 'create', disabled: s.creating, style: btnStyle,
			}, s.creating ? '创建中…' : '创建'),
		),

		// 批量操作
		h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center' } },
			h('button', { 'data-action': 'refresh-projects', style: btnStyle }, '刷新'),
			h('button', { 'data-action': 'import-file', style: accentBtnStyle }, '导入本地'),
			h('button', { 'data-action': 'goto-settings', style: { ...btnStyle, marginLeft: 'auto' } }, '⚙ 设置'),
		),

		s.error ? h('div', { style: errStyle }, s.error) : null,
		s.notice ? h('div', { style: okStyle }, s.notice) : null,

		s.loading
			? h('div', { style: hintStyle }, '加载中…')
			: s.projects.length === 0
				? h('div', { style: hintStyle }, '本会话还没有项目。输入书名创建一个，或在会话里让 AI 调 novel_project init。')
				: h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
					s.projects.map((p) => h('div', { key: p.name, style: itemCardStyle },
						h('button', {
							'data-action': 'open', 'data-id': p.name,
							// 打开整卡：button 才能进 Tab 序 / 被读屏读到 / 回车触发
							style: {
								display: 'block', width: '100%', textAlign: 'left', cursor: 'pointer',
								background: 'transparent', border: 'none', padding: 0,
								font: 'inherit', color: 'inherit',
							},
						},
							h('div', { style: { fontWeight: 600 } }, p.title || p.name),
							h('div', { style: { ...hintStyle, fontSize: '12px' } },
								`${p.stage ? p.stage + ' · ' : ''}${p.chapters ?? 0} 章 · 账本 ${p.facts ?? 0} · 伏笔 ${p.foreshadows?.open ?? 0}/${p.foreshadows?.total ?? 0}${p.styleBuilt ? ' · 有基线' : ''}`),
						),
						h('div', { style: { display: 'flex', gap: '6px', marginTop: '6px' } },
							h('button', {
								'data-action': 'goto-lorebook', 'data-id': p.name,
								style: miniBtnStyle,
							}, '世界书'),
						),
					)),
				),

		// 未归属的旧书（0.5.0 之前的书没有会话戳）
		s.unclaimed && s.unclaimed.length > 0
			? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px', borderTop: '1px solid var(--dsw-alias-border-l3, #333)', paddingTop: '8px' } },
				h('div', { style: { fontWeight: 600, fontSize: '12.5px' } }, `未归属的书（${s.unclaimed.length}）`),
				h('div', { style: { ...hintStyle, fontSize: '11.5px' } }, '这些书建在会话归属功能之前，认领后会出现在本会话。'),
				...s.unclaimed.map((p) => h('div', { key: p.name, style: { display: 'flex', gap: '6px', alignItems: 'center' } },
					h('span', { style: { flex: 1, fontSize: '12px' } }, p.title || p.name),
					h('button', {
						'data-action': 'claim', 'data-id': p.name, disabled: s.busy, style: miniBtnStyle,
					}, '认领'),
				)),
			)
			: null,

		h('p', { style: footerStyle }, '在会话中调用 novel_* 工具驱动；列表只显示本会话创建或参与过的项目。'),
	);
}
