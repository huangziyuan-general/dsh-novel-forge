// src/client/views/lorebook.js — 世界书（设定注入）管理。
//
// 条目字段与 node 半侧 lib/worldbook-io.js 对齐：
// always_active（常驻注入）/ priority（优先级）/ keywords（触发关键词）/ enabled（启用）。
//
// 这一页的读者关心的是「**什么会被注入进上下文**」，所以每条都把它会在
// 正文里被什么词触发、优先级多高、当前开没开，明明白白摆在卡面上。
import { h } from '../react.js';
import { color, space, font, weight, hintStyle, errStyle, okStyle, inputStyle, stackStyle, card } from '../styles.js';
import { Card, Btn, Chip, Empty, Mono } from '../ui.js';

export function LorebookView({ state: s }) {
	const editing = s.loreForm.mode !== 'none';
	const on = s.loreEntries.filter((e) => e.enabled).length;

	return h('div', { style: stackStyle(space.lg) },

		h('div', { style: { display: 'flex', alignItems: 'center', gap: space.sm } },
			Btn({ variant: 'ghost', size: 'sm', action: 'back-from-lore' }, '← 返回'),
			h('span', { style: { fontWeight: weight.semibold, fontSize: font.lead } }, '世界书'),
			h('span', { style: { ...hintStyle, fontSize: font.caption } }, `${on}/${s.loreEntries.length} 条启用`),
			h('span', { style: { flex: '1 1 auto' } }),
			Btn({ size: 'sm', variant: 'primary', action: 'lore-new' }, '＋ 新建'),
		),

		s.error ? h('div', { style: errStyle }, s.error) : null,
		s.notice ? h('div', { style: okStyle }, s.notice) : null,

		// 新建 / 编辑表单
		editing
			? Card({ tone: 'accent', pad: space.md },
				h('div', { style: { fontWeight: weight.semibold, fontSize: font.small, marginBottom: space.sm } },
					s.loreForm.mode === 'new' ? '新建条目' : '编辑条目'),
				h('div', { style: stackStyle(space.sm) },
					h('input', { 'data-field': 'lore-name', defaultValue: s.loreForm.name, placeholder: '条目名称（如：城西乱葬岗）', style: inputStyle }),
					h('input', { 'data-field': 'lore-keywords', defaultValue: s.loreForm.keywords, placeholder: '触发关键词，逗号分隔（如：乱葬岗,红泥）', style: inputStyle }),
					h('textarea', {
						'data-field': 'lore-content', defaultValue: s.loreForm.content,
						placeholder: '注入内容：这段设定会原样进上下文，写清事实而不是氛围词。', rows: 4,
						style: { ...inputStyle, lineHeight: 1.8, resize: 'vertical' },
					}),
					h('div', { style: { display: 'flex', alignItems: 'center', gap: space.lg, flexWrap: 'wrap' } },
						h('label', { style: { display: 'flex', alignItems: 'center', gap: space.xs, fontSize: font.small, color: color.text2 } },
							h('input', { 'data-field': 'lore-always', type: 'checkbox', defaultChecked: s.loreForm.alwaysActive }),
							'常驻注入'),
						h('label', { style: { display: 'flex', alignItems: 'center', gap: space.xs, fontSize: font.small, color: color.text2 } },
							'优先级',
							h('input', {
								'data-field': 'lore-priority', type: 'number',
								defaultValue: s.loreForm.priority,
								style: { ...inputStyle, width: '64px' },
							})),
					),
					h('div', { style: { display: 'flex', gap: space.sm } },
						Btn({ variant: 'primary', action: 'lore-save', disabled: s.loreBusy }, s.loreBusy ? '保存中…' : '保存'),
						Btn({ action: 'lore-cancel' }, '取消'),
					),
				),
			)
			: null,

		// 条目列表
		s.loreEntries.length === 0
			? Empty({
				icon: '📖',
				title: '还没有世界书条目',
				hint: '世界书是「按关键词自动注入」的设定库：写到的词一出现，对应设定就会进上下文，不必每次重复交代。',
			})
			: h('div', { style: stackStyle(space.sm) },
				...s.loreEntries.map((entry) => h('div', {
					key: entry.id,
					style: { ...card({ pad: space.md }), opacity: entry.enabled ? 1 : 0.62 },
				},
					h('div', { style: { display: 'flex', alignItems: 'center', gap: space.sm, flexWrap: 'wrap' } },
						h('span', {
							style: {
								fontWeight: weight.semibold, fontSize: font.small,
								overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0,
							},
						}, entry.name),
						entry.always_active ? Chip({ tone: 'accent' }, '常驻') : null,
						!entry.enabled ? Chip({ tone: 'danger' }, '已停用') : null,
						h('span', { style: { flex: '1 1 auto' } }),
						Mono({}, `P${entry.priority}`),
					),
					entry.keywords?.length
						? h('div', { style: { display: 'flex', gap: space.xs, flexWrap: 'wrap', marginTop: space.sm } },
							...entry.keywords.map((k, i) => Chip({ key: i }, k)))
						: h('div', { style: { ...hintStyle, fontSize: font.caption, marginTop: space.xs } },
							entry.always_active ? '无关键词 —— 靠「常驻」注入' : '无关键词 —— 不会被触发，等于没注入'),
					entry.content
						? h('div', {
							style: {
								...hintStyle, fontSize: font.caption, marginTop: space.sm, lineHeight: 1.7,
								display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
							},
						}, entry.content)
						: null,
					h('div', { style: { display: 'flex', gap: space.xs, marginTop: space.sm } },
						Btn({ size: 'sm', variant: 'ghost', action: 'lore-edit', id: entry.id }, '编辑'),
						Btn({ size: 'sm', variant: 'ghost', action: 'lore-toggle', id: entry.id },
							entry.enabled ? '停用' : '启用'),
						h('span', { style: { flex: '1 1 auto' } }),
						Btn({ size: 'sm', variant: 'danger', action: 'lore-delete', id: entry.id }, '删除'),
					),
				)),
			),

		h('p', { style: { ...hintStyle, fontSize: font.caption, margin: 0, lineHeight: 1.7 } },
			'关键词命中的条目 + 常驻条目会一起进上下文；同一轮内容里优先级高的在前。'),
	);
}
