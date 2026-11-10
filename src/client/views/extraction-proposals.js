import { h } from '../react.js';
import { color, space, font, weight, hintStyle, inputStyle } from '../styles.js';
import { Card, Btn, Chip } from '../ui.js';

function editOf(state, proposalId, item) {
	return state.extractionEdits?.[proposalId]?.[item.id] ?? {
		name: item.name, content: item.content, aliases: (item.aliases ?? []).join('、'),
		keywords: (item.keywords ?? []).join('、'), always: item.always === true, priority: item.priority ?? 50,
	};
}

export function ExtractionProposalView({ state: s }) {
	const proposals = (s.extractionProposals ?? []).filter((proposal) => (proposal.items ?? []).some((item) => item.status === 'pending'));
	if (proposals.length === 0) return null;
	return Card({ tone: 'plain' },
		h('div', { style: { display: 'flex', alignItems: 'center', gap: space.sm, marginBottom: space.sm } },
			h('span', { style: { fontWeight: weight.semibold, fontSize: font.small } }, '🧩 档案抽取提案'),
			h('span', { style: { ...hintStyle, fontSize: font.caption } }, '原文证据已核验；应用前可逐项编辑，未勾选项不会入库'),
		),
		...proposals.map((proposal) => h('div', { key: proposal.id, style: { marginBottom: space.md, padding: space.sm, borderRadius: '8px', background: color.surface2 } },
			h('div', { style: { display: 'flex', alignItems: 'center', gap: space.xs, flexWrap: 'wrap', marginBottom: space.sm } },
				Chip({ tone: 'accent' }, `${proposal.id} · 第 ${proposal.from}–${proposal.to} 章`),
				h('span', { style: { flex: 1 } }),
				Btn({ size: 'sm', variant: 'primary', action: 'extraction-apply', id: proposal.id, disabled: s.extractionBusy === proposal.id },
					s.extractionBusy === proposal.id ? '应用中…' : '应用所选项'),
			),
			...(proposal.items ?? []).filter((item) => item.status === 'pending').map((item) => {
				const edit = editOf(s, proposal.id, item);
				const common = { 'data-pid': proposal.id, 'data-id': item.id };
				return h('div', { key: item.id, style: { padding: `${space.sm}px 0`, borderTop: `1px solid ${color.border1}` } },
					h('label', { style: { display: 'flex', alignItems: 'center', gap: space.xs, fontSize: font.caption, color: color.text2 } },
						h('input', { ...common, 'data-field': 'extraction-selected', type: 'checkbox', checked: s.extractionSelected?.[`${proposal.id}:${item.id}`] === true }),
						`${item.id} · ${item.kind === 'character' ? '人物' : '世界书'} · 第 ${item.chapter} 章`,
					),
					h('div', { style: { ...hintStyle, fontSize: font.caption, margin: `${space.xs}px 0`, whiteSpace: 'pre-wrap' } }, `原文证据：${item.quote}`),
					h('input', { ...common, 'data-field': 'extraction-name', value: edit.name, 'aria-label': `${item.id} 名称`, style: { ...inputStyle, marginBottom: space.xs } }),
					h('textarea', { ...common, 'data-field': 'extraction-content', value: edit.content, rows: 3, 'aria-label': `${item.id} 档案内容`, style: { ...inputStyle, resize: 'vertical' } }),
					h('input', { ...common, 'data-field': 'extraction-aliases', value: edit.aliases, placeholder: '别名（可选）', 'aria-label': `${item.id} 别名`, style: { ...inputStyle, marginTop: space.xs } }),
					item.kind === 'worldbook' ? h('input', { ...common, 'data-field': 'extraction-keywords', value: edit.keywords, placeholder: '触发词', 'aria-label': `${item.id} 触发词`, style: { ...inputStyle, marginTop: space.xs } }) : null,
				);
			}),
		)),
	);
}
