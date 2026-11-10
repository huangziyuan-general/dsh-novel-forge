// src/client/views/proposal-merge.js — 原稿 / 提案 / 当前稿逐段选择与预览。
import { h } from '../react.js';
import { color, font, hintStyle, space, stackStyle, tint, warnStyle } from '../styles.js';
import { Btn, Fold } from '../ui.js';
import { mergedText } from '../../../lib/paragraph-merge.js';

const textStyle = {
	whiteSpace: 'pre-wrap', maxHeight: '160px', overflowY: 'auto', lineHeight: 1.7,
	fontSize: font.caption, color: color.text2, padding: space.sm,
	borderRadius: '6px', background: color.surface1,
};

export function ProposalMergeView({ state: s, proposal }) {
	const detail = s.proposalDetail;
	if (!detail?.data || detail.id !== proposal.id) return null;
	const merge = s.proposalMerge?.id === proposal.id ? s.proposalMerge : null;
	if (!merge) {
		return h('div', { style: { marginTop: space.xs } },
			Btn({ size: 'sm', variant: 'secondary', action: 'proposal-merge-open', id: proposal.id }, '⇄ 逐段三路合并'),
			typeof detail.data.baseContent !== 'string'
				? h('span', { style: { ...hintStyle, marginLeft: space.sm } }, '旧提案缺基线时不能安全合并，可丢弃后重提。')
				: null,
		);
	}
	const changed = merge.rows.filter((row) => row.status !== 'unchanged');
	return h('div', { style: { ...stackStyle(space.sm), marginTop: space.sm } },
		h('div', { style: { fontSize: font.small, fontWeight: 600 } },
			`逐段合并 · ${changed.length} 个差异块 · ${merge.conflicts} 个冲突`),
		h('div', { style: hintStyle },
			'共有完整段落作为锚点；冲突默认保留当前稿。每次选择都可改，点击应用前请检查预览。'),
		...changed.map((row) => {
			const selected = merge.selections[row.id] ?? row.defaultChoice;
			return h('div', {
				key: row.id,
				style: {
					padding: space.sm, borderRadius: '8px', background: color.surface2,
					border: row.conflict ? `1px solid ${tint(color.warn, 35)}` : undefined,
				},
			},
				h('div', { style: { ...row.conflict ? warnStyle : hintStyle, marginBottom: space.xs } },
					`${row.id}${row.conflict ? ' · 双方改法不同，请人工选择' : ''}`),
				h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: space.xs } },
					...[['base', '原稿'], ['proposal', '提案'], ['current', '当前稿']].map(([key, label]) => h('div', { key },
						h('div', { style: { ...hintStyle, marginBottom: '2px' } }, label),
						h('div', { style: textStyle }, row[key].join('\n\n') || '（删除）'))),
				),
				h('div', { style: { display: 'flex', gap: space.xs, flexWrap: 'wrap', marginTop: space.xs } },
					...[['base', '用原稿'], ['proposal', '用提案'], ['current', '用当前稿']].map(([choice, label]) => Btn({
						key: choice, size: 'sm', variant: selected === choice ? 'primary' : 'secondary',
						action: 'proposal-merge-choice', id: proposal.id, row: row.id, choice,
					}, selected === choice ? `✓ ${label}` : label)),
				),
			);
		}),
		Fold({ title: '预览最终合并稿' },
			h('div', { style: { ...textStyle, maxHeight: '320px' } }, mergedText(merge.rows, merge.selections))),
		h('div', { style: { display: 'flex', gap: space.xs, flexWrap: 'wrap' } },
			Btn({ size: 'sm', variant: 'primary', action: 'proposal-merge-apply', id: proposal.id, disabled: s.proposalBusy === proposal.id },
				s.proposalBusy === proposal.id ? '应用中…' : '应用合并稿（生成新版本）'),
			Btn({ size: 'sm', action: 'proposal-merge-cancel', disabled: s.proposalBusy === proposal.id }, '取消合并'),
		),
	);
}
