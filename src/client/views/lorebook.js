// src/client/views/lorebook.js — 世界书（设定注入）管理视图。
//
// 条目字段与 node 半侧 lib/worldbook-io.js 对齐：
// always_active（常驻注入）/ priority（优先级）/ keywords（触发关键词）/ enabled（启用）。
import { h } from '../react.js';
import { btnStyle, inputStyle, errStyle, okStyle, hintStyle, itemCardStyle, dangerBtnStyle, primaryBtnStyle } from '../styles.js';

export function LorebookView({ state: s }) {
	return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
		h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
			h('button', { 'data-action': 'back-from-lore', style: btnStyle }, '← 返回'),
			h('span', { style: { fontWeight: 700, fontSize: '14px' } }, '世界书（设定注入）'),
			h('button', { 'data-action': 'lore-new', style: { ...btnStyle, marginLeft: 'auto' } }, '+ 新建'),
		),

		s.error ? h('div', { style: errStyle }, s.error) : null,
		s.notice ? h('div', { style: okStyle }, s.notice) : null,

		// 新建 / 编辑表单
		s.loreForm.mode !== 'none'
			? h('div', {
				style: {
					padding: '10px', border: '1px solid #29a', borderRadius: '6px',
					background: 'rgba(0,100,255,.05)',
					display: 'flex', flexDirection: 'column', gap: '6px',
				},
			},
				h('div', { style: { fontWeight: 600, fontSize: '13px' } },
					s.loreForm.mode === 'new' ? '新建条目' : '编辑条目'),
				h('input', { 'data-field': 'lore-name', defaultValue: s.loreForm.name, placeholder: '条目名称', style: inputStyle }),
				h('input', { 'data-field': 'lore-keywords', defaultValue: s.loreForm.keywords, placeholder: '触发关键词（逗号分隔）', style: inputStyle }),
				h('textarea', {
					'data-field': 'lore-content', defaultValue: s.loreForm.content,
					placeholder: '注入内容', rows: 3,
					style: { ...inputStyle, fontFamily: 'monospace', fontSize: '12px' },
				}),
				h('div', { style: { display: 'flex', gap: '12px', alignItems: 'center' } },
					h('label', { style: { fontSize: '12px', display: 'flex', gap: '4px', alignItems: 'center' } },
						h('input', { 'data-field': 'lore-always', type: 'checkbox', defaultChecked: s.loreForm.alwaysActive }),
						'常驻注入'),
					h('label', { style: { fontSize: '12px', display: 'flex', gap: '4px', alignItems: 'center' } },
						'优先级',
						h('input', {
							'data-field': 'lore-priority', type: 'number',
							defaultValue: s.loreForm.priority, style: { width: '56px', padding: '2px 4px' },
						})),
				),
				h('div', { style: { display: 'flex', gap: '6px' } },
					h('button', { 'data-action': 'lore-save', disabled: s.loreBusy, style: primaryBtnStyle },
						s.loreBusy ? '保存中…' : '保存'),
					h('button', { 'data-action': 'lore-cancel', style: btnStyle }, '取消'),
				),
			)
			: null,

		// 条目列表
		s.loreEntries.length === 0
			? h('div', { style: hintStyle }, '还没有世界书条目')
			: h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
				s.loreEntries.map((entry) => h('div', { key: entry.id, style: itemCardStyle },
					h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
						h('span', { style: { fontWeight: 600, color: entry.enabled ? undefined : '#aaa' } }, entry.name),
						entry.always_active
							? h('span', { style: { fontSize: '10px', color: '#a70', background: 'rgba(255,200,0,.15)', padding: '1px 5px', borderRadius: '3px' } }, '常驻')
							: null,
						!entry.enabled ? h('span', { style: { fontSize: '10px', color: '#888' } }, '已停用') : null,
						h('span', { style: { fontSize: '10px', color: '#888', marginLeft: 'auto' } }, `P${entry.priority}`),
					),
					entry.keywords?.length > 0
						? h('div', { style: { fontSize: '11px', color: '#666', marginTop: '3px' } }, `关键词：${entry.keywords.join('、')}`)
						: null,
					h('div', { style: { display: 'flex', gap: '6px', marginTop: '6px' } },
						h('button', { 'data-action': 'lore-edit', 'data-id': String(entry.id), style: btnStyle }, '编辑'),
						h('button', { 'data-action': 'lore-toggle', 'data-id': String(entry.id), style: btnStyle },
							entry.enabled ? '停用' : '启用'),
						h('button', { 'data-action': 'lore-delete', 'data-id': String(entry.id), style: dangerBtnStyle }, '删除'),
					),
				)),
			),
	);
}
