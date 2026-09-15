// src/client/views/project-detail.js — 项目详情：两个标签（基本信息 / 章节听书）。
//
// 这个页面承担三件事，顺序就是版面顺序：
//   ① **看**：要素总览（档案/大纲/角色卡/设定/时间线）——书攒了什么（views/overview.js）
//   ② **查**：全书体检（GET /continuity，纯函数零 token）——哪儿对不上
//   ③ **改**：提案队列 + 本章编辑 + 润色/校对 + 批量起草
//
// 能力边界（0.13.0 起如实呈现，别再写「需要模型参与」糊过去）：
//   · 润色 / 校对 → 服务端有真端点（D1 旁路引擎），产物是**提案**，点应用才生效
//   · 批量起草 → 服务端有真端点（D2），并发生成、串行提交，每章仍过同一套门禁
//   · 一键写章 —— 仍是 501（写章要走 briefing + 门禁，只能在会话里由工具做），
//     面板给一条**可复制的调用提示**，而不是一个点了没反应的按钮
import { h } from '../react.js';
import {
	color, space, font, weight, hintStyle, errStyle, okStyle,
	inputStyle, manuscriptStyle, stackStyle, tint, rowWrapStyle,
} from '../styles.js';
import { Card, Btn, Chip, Stat, Fold, Mono } from '../ui.js';
import { phaseLabel } from '../../../lib/phases.js';
import { ChapterListView } from './chapters.js';
import { ProjectOverviewView } from './overview.js';

/** 分段控件（替代并排两个描边按钮：当前项一眼看得出）。 */
function Segmented({ tab }) {
	const item = (value, label) => {
		const active = tab === value;
		return h('button', {
			'data-action': 'detail-tab', 'data-tab': value,
			// 四态（常态 / 悬停 / 按下 / 选中）全部由 css.js 的 [data-nf-seg] 规则管：
			// 「选中」是状态不是伪类，用 data-active 表达，CSS 才能一次排好优先级
			//（底色若内联，选中项一悬停就会丢掉"选中"的样子）。
			'data-nf-seg': '1', 'data-active': active ? '1' : '0',
			style: {
				flex: '1 1 0', padding: `${space.xs + 1}px ${space.md}px`,
				border: 'none', borderRadius: '7px', cursor: 'pointer',
				fontFamily: 'inherit', fontSize: font.small,
				fontWeight: active ? weight.semibold : weight.normal,
			},
		}, label);
	};
	return h('div', {
		style: {
			display: 'flex', gap: '2px', padding: '2px',
			borderRadius: '9px', background: color.inset,
		},
	}, item('info', '📋 基本信息'), item('chapters', '🎧 章节听书'));
}

/** 体检结果里的一条问题。 */
function issueRow(issue, i, total) {
	const isErr = issue.severity === 'error';
	return h('div', {
		key: i,
		style: {
			display: 'flex', gap: space.sm, alignItems: 'flex-start',
			paddingTop: space.sm,
			marginTop: i === 0 ? 0 : space.sm,
			borderTop: i === 0 ? 'none' : `1px solid ${color.border1}`,
		},
	},
		h('span', { style: { flex: 'none', fontSize: font.small, color: isErr ? color.danger : color.warn } },
			isErr ? '✗' : '⚠'),
		h('div', { style: { flex: '1 1 auto', minWidth: 0 } },
			h('div', { style: { fontSize: font.small, lineHeight: 1.65 } }, issue.message ?? ''),
			h('div', { style: { marginTop: '2px', display: 'flex', gap: space.sm, flexWrap: 'wrap' } },
				Chip({ tone: isErr ? 'danger' : 'warn' }, issue.where ?? ''),
				Mono({}, issue.code ?? ''),
				total > 12 && i === 11 ? Chip({}, `…另有 ${total - 12} 条`) : null,			),
		),
	);
}

/** 批量起草的每条结果。 */
function batchRow(r, i) {
	const ok = r.ok === true;
	return h('div', {
		key: i,
		style: { display: 'flex', alignItems: 'flex-start', gap: space.sm, fontSize: font.small, padding: '2px 0' },
	},
		h('span', { style: { flex: 'none', color: ok ? color.ok : color.danger } }, ok ? '✓' : '✗'),
		h('span', { style: { flex: 'none', color: color.text3, minWidth: '52px' } }, `第 ${r.chapter} 章`),
		h('span', { style: { flex: '1 1 auto', minWidth: 0, wordBreak: 'break-word', color: ok ? color.text2 : color.danger } },
			ok
				? `${r.title ?? ''} ${r.chars ? `${r.chars} 字` : ''} v${r.version ?? 1}${r.noai?.level ? ` · 去AI味 ${r.noai.level}` : ''}`
				: (r.reason ?? r.contentGate?.reason ?? '未通过门禁')),
	);
}

export function ProjectDetailView({ state: s }) {
	const chapters = s.chapterList ?? [];
	const maxWritten = chapters.reduce((m, c) => Math.max(m, c.no ?? 0), 0);
	const nextNo = maxWritten + 1;
	const pendingProposals = (s.proposals || []).filter((p) => p.status === 'pending');
	const revising = s.revising ?? null;

	// ── 面包屑 ──
	const crumb = h('div', { style: { display: 'flex', alignItems: 'center', gap: space.sm, minWidth: 0 } },
		Btn({ variant: 'ghost', size: 'sm', action: 'back' }, '← 返回'),
		h('span', {
			style: {
				fontWeight: weight.semibold, fontSize: font.lead, minWidth: 0,
				overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
			},
		}, s.detail?.title || s.selected || ''),
		s.detail?.stage ? Chip({ tone: 'accent' }, phaseLabel(s.detail.stage)) : null,
	);

	// ── 全书体检（GET /continuity · 服务端纯函数，零 token）──
	const cont = s.continuity;
	const continuityBlock = Card({ tone: cont && cont.ok === false ? 'danger' : 'plain' },
		h('div', { style: { display: 'flex', alignItems: 'center', gap: space.sm } },
			h('span', { style: { fontWeight: weight.semibold, fontSize: font.small } }, '🩺 全书体检'),
			cont
				? Chip({ tone: cont.ok ? 'ok' : 'danger' },
					cont.ok ? '未发现硬伤' : `${cont.stats?.errors ?? 0} 处硬伤`)
				: null,
			h('span', { style: { flex: '1 1 auto' } }),
			Btn({
				size: 'sm', variant: cont ? 'ghost' : 'secondary', action: 'continuity',
				disabled: s.continuityLoading,
			}, s.continuityLoading ? '体检中…' : cont ? '↻ 重跑' : '开始体检'),
		),

		s.continuityLoading
			? h('div', { style: { ...hintStyle, marginTop: space.sm } }, '正在核对账本、伏笔、时间线与文件……')
			: !cont
				? h('div', { style: { ...hintStyle, fontSize: font.caption, marginTop: space.sm, lineHeight: 1.7 } },
					'查的是「死人复活 / 账本前后矛盾 / 伏笔超期未收 / 章号断档 / 人物卡缺失」这类机器判得出来的硬伤 —— 全部是纯本地计算，不花 token。')
				: h('div', { style: { marginTop: space.md } },
					h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: `${space.xs}px ${space.lg}px`, marginBottom: cont.issues?.length ? space.sm : 0 } },
						Stat({ icon: '📄', value: cont.stats?.chapters ?? 0, unit: '章' }),
						Stat({ icon: '🧾', value: cont.stats?.facts ?? 0, unit: '台账' }),
						Stat({ icon: '🪡', value: cont.stats?.foreshadows ?? 0, unit: '伏笔' }),
						Stat({ icon: '⚰️', value: cont.stats?.deaths ?? 0, unit: '死亡实体' }),
						Stat({
							icon: '⚠️', value: cont.stats?.errors ?? 0, unit: '硬伤',
							tone: (cont.stats?.errors ?? 0) > 0 ? 'danger' : 'ok',
						}),
						Stat({
							icon: '·', value: cont.stats?.warnings ?? 0, unit: '警告',
							tone: (cont.stats?.warnings ?? 0) > 0 ? 'warn' : 'neutral',
						}),
					),
					cont.issues?.length > 0
						? h('div', null, ...cont.issues.slice(0, 12).map((it, i) => issueRow(it, i, cont.issues.length)))
						: h('div', { style: { ...okStyle, fontSize: font.small } },
							'账本、伏笔、时间线、文件都对得上。'),
				),

		s.continuityError
			? h('div', { style: { ...errStyle, marginTop: space.sm } }, s.continuityError)
			: null,
	);

	// ── 提案队列（用户主权动作：工具面刻意没有 apply）──
	const proposalsBlock = Card({ tone: pendingProposals.length > 0 ? 'warn' : 'plain' },
		h('div', { style: { display: 'flex', alignItems: 'center', gap: space.sm } },
			h('span', { style: { fontWeight: weight.semibold, fontSize: font.small } }, '📝 待批准提案'),
			pendingProposals.length > 0 ? Chip({ tone: 'warn' }, String(pendingProposals.length)) : null,
			h('span', { style: { flex: '1 1 auto' } }),
			s.proposalBusy ? h('span', { style: { ...hintStyle, fontSize: font.caption } }, '处理中…') : null,
		),
		s.proposalsLoading
			? h('div', { style: { ...hintStyle, fontSize: font.caption, marginTop: space.sm } }, '加载中…')
			: pendingProposals.length === 0
				? h('div', { style: { ...hintStyle, fontSize: font.caption, marginTop: space.sm, lineHeight: 1.7 } },
					'没有待批的修订。模型改稿（含面板上的润色/校对）都先落到这里，由你点「应用」才生成新版本。')
				: h('div', { style: stackStyle(space.xs) },
					...pendingProposals.map((p) => {
						const busy = s.proposalBusy === p.id;
						return h('div', {
							key: p.id,
							style: {
								display: 'flex', alignItems: 'center', gap: space.sm,
								padding: `${space.sm}px ${space.md}px`,
								borderRadius: '8px', background: color.surface2,
							},
						},
							h('span', { style: { flex: '1 1 auto', minWidth: 0, fontSize: font.small } },
								`第 ${p.chapter} 章`,
								h('span', { style: { ...hintStyle, fontSize: font.caption, marginLeft: space.sm } }, p.id)),
							Btn({ size: 'sm', variant: 'primary', action: 'proposal-apply', id: p.id, disabled: busy },
								busy ? '…' : '应用'),
							Btn({ size: 'sm', variant: 'danger', action: 'proposal-discard', id: p.id, disabled: busy }, '丢弃'),
						);
					}),
				),
	);

	// ── 本章编辑 ──
	const chapterOptions = Array.from({ length: Math.max(1, (s.detail?.chapters ? Object.keys(s.detail.chapters).length : 0) + 1) }, (_, i) => i + 1);
	const editBlock = Card({ tone: 'plain' },
		h('div', { style: { display: 'flex', alignItems: 'center', gap: space.sm, flexWrap: 'wrap' } },
			h('span', { style: { fontWeight: weight.semibold, fontSize: font.small } }, '✍️ 本章编辑'),
			h('span', { style: { flex: '1 1 auto' } }),
			h('select', {
				'data-field': 'chapterNo', value: String(s.chapterNo),
				style: { ...inputStyle, width: 'auto', padding: '3px 6px' },
			}, chapterOptions.map((no) => h('option', { key: no, value: String(no) }, `第 ${no} 章`))),
		),

		// 需要模型的三个动作：润色/校对走真端点，写章给可复制提示
		h('div', { style: { ...rowWrapStyle(space.xs), marginTop: space.sm } },
			Btn({
				size: 'sm', variant: 'accent', action: 'polish',
				disabled: revising !== null || s.chapterNo > maxWritten,
			}, revising === 'polish' ? '润色中…' : '✨ 润色'),
			Btn({
				size: 'sm', variant: 'secondary', action: 'proofread',
				disabled: revising !== null || s.chapterNo > maxWritten,
			}, revising === 'proofread' ? '校对中…' : '🔍 校对'),
			Btn({
				size: 'sm', variant: 'ghost', action: 'write',
				disabled: s.writing,
			}, s.writing ? '写作中…' : '🪶 写章'),
			h('span', { style: { ...hintStyle, fontSize: font.caption } },
				s.chapterNo > maxWritten ? '这一章还没落盘 —— 先写章' : '润色/校对的产物是提案'),
		),

		s.error ? h('div', { style: { ...errStyle, marginTop: space.sm } }, s.error) : null,
		s.notice ? h('div', { style: { ...okStyle, marginTop: space.sm } }, s.notice) : null,

		// 未保存离开确认：返回 / 换章前有改动时，先问一句
		s.discardPending
			? h('div', {
				style: {
					display: 'flex', alignItems: 'center', gap: space.sm,
					marginTop: space.md, padding: `${space.sm}px ${space.md}px`,
					borderRadius: '8px', background: tint(color.warn, 12),
					border: `1px solid ${tint(color.warn, 30)}`,
				},
			},
				h('span', { style: { flex: '1 1 auto', fontSize: font.small, color: color.warn } }, '本章有未保存的改动'),
				Btn({ size: 'sm', variant: 'danger', action: 'discard-confirm' }, '丢弃改动'),
				Btn({ size: 'sm', action: 'discard-cancel' }, '取消'),
			)
			: null,

		// 稿纸区（key 带版本号，刷新章节时强制重建以吸收新的 defaultValue）
		h('textarea', {
			'data-field': 'draft', key: `draft-${s.draftVersion}`,
			defaultValue: s.draft, placeholder: '本章正文…', rows: 9,
			style: { ...manuscriptStyle, marginTop: space.md, display: 'block' },
		}),

		h('div', { style: { display: 'flex', alignItems: 'center', gap: space.xs, marginTop: space.sm, flexWrap: 'wrap' } },
			Btn({ size: 'sm', variant: 'primary', action: 'save' }, '💾 保存'),
			Btn({ size: 'sm', variant: 'ghost', action: 'refresh' }, '↻ 刷新'),
			Btn({ size: 'sm', variant: 'ghost', action: 'export', disabled: s.exporting },
				s.exporting ? '导出中…' : '⇩ 导出'),
			Btn({ size: 'sm', variant: 'ghost', action: 'goto-lorebook', id: s.selected }, '📖 世界书'),
			h('span', { style: { flex: '1 1 auto' } }),
			s.deleteState === 'confirm'
				? Btn({ size: 'sm', action: 'delete-cancel' }, '取消删除')
				: null,
			Btn({ size: 'sm', variant: 'danger', action: 'delete' },
				s.deleteState === 'confirm' ? '确认删除这本书？' : '删除'),
		),

		// 诊断/去AI味这类「要靠模型判」的，如实说清在哪做
		h('div', { style: { ...hintStyle, fontSize: font.caption, marginTop: space.md, lineHeight: 1.7 } },
			'结构诊断、去AI味评级、写章本身需要模型参与且在会话里落审计 —— 在会话里调 ',
			h('code', {
				style: {
					fontFamily: color.mono,
					background: color.surface2, borderRadius: '4px', padding: '0 4px',
				},
			}, `novel_write_chapter / novel_audit`),
			'，或点写章按钮看调用提示。'),
		Btn({ size: 'sm', variant: 'ghost', action: 'diagnose' }, '结构诊断（在会话里做）'),
	);

	// ── 批量起草（D2：并发生成、串行提交，每章仍过同一套门禁）──
	const batch = s.batchResult;
	const batchBlock = Fold({
		title: `⚡ 批量起草（从第 ${s.batchFrom ?? nextNo} 章起 ${s.batchCount ?? 3} 章）`,
	},
		h('div', { style: { ...hintStyle, fontSize: font.caption, lineHeight: 1.7, marginBottom: space.md } },
			'并发生成、串行提交：每一章照样过机审、内容门禁、账本、契约指标，',
			'单章被拦下不影响其它章。没有细纲或细纲未批准的章会直接被挡（可勾选强制）。'),
		h('div', { style: { display: 'flex', alignItems: 'center', gap: space.sm, flexWrap: 'wrap' } },
			h('span', { style: { fontSize: font.small, color: color.text3 } }, '起始章'),
			h('input', {
				'data-field': 'batch-from', type: 'number', min: 1,
				value: String(s.batchFrom ?? nextNo),
				style: { ...inputStyle, width: '64px' },
			}),
			h('span', { style: { fontSize: font.small, color: color.text3 } }, '数量'),
			h('input', {
				'data-field': 'batch-count', type: 'number', min: 1, max: 20,
				value: String(s.batchCount ?? 3),
				style: { ...inputStyle, width: '64px' },
			}),
			h('span', { style: { fontSize: font.small, color: color.text3 } }, '并发'),
			h('select', {
				'data-field': 'batch-concurrency', value: String(s.batchConcurrency ?? 1),
				style: { ...inputStyle, width: 'auto', padding: '3px 6px' },
			}, [1, 2, 3, 4].map((n) => h('option', { key: n, value: String(n) }, String(n)))),
		),
		h('label', { style: { display: 'flex', alignItems: 'center', gap: space.xs, fontSize: font.caption, color: color.text3, marginTop: space.sm } },
			h('input', {
				'data-field': 'batch-force', type: 'checkbox',
				defaultChecked: s.batchForce === true,
			}),
			'强制：跳过「细纲未批准 / 熔断计数」两道（内容门禁不跳）'),
		h('div', { style: { marginTop: space.md } },
			Btn({ variant: 'primary', action: 'draft-batch', disabled: s.batchBusy },
				s.batchBusy ? '起草中…（可能几分钟）' : '开始批量起草'),
		),

		batch
			? h('div', { style: { marginTop: space.lg } },
				h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: `${space.xs}px ${space.lg}px`, marginBottom: space.sm } },
					Stat({ icon: '✓', value: batch.stats?.committed ?? 0, unit: '落盘', tone: 'ok' }),
					Stat({
						icon: '✗', value: batch.stats?.failed ?? 0, unit: '被拦',
						tone: (batch.stats?.failed ?? 0) > 0 ? 'danger' : 'neutral',
					}),
					Stat({ icon: '⚙', value: batch.concurrency ?? 1, unit: '并发' }),
				),
				...(batch.warnings ?? []).map((w, i) => h('div', { key: i, style: { ...hintStyle, fontSize: font.caption } }, `· ${w}`)),
				h('div', { style: { marginTop: space.sm } }, ...(batch.results ?? []).map(batchRow)),
			)
			: null,
	);

	// ── 标签一：基本信息 ──
	// 注意别在这里套 Section 标题：卡片自己已经带标题了，套一层会得到
	// 「✍️ 本章 / ✍️ 本章编辑」这种双标题。
	const infoView = h('div', { style: stackStyle(space.lg) },
		ProjectOverviewView({ state: s }),
		continuityBlock,
		proposalsBlock,
		editBlock,
		batchBlock,
	);

	return h('div', { style: stackStyle(space.lg) },
		crumb,
		Segmented({ tab: s.detailTab }),
		s.detailTab === 'chapters' ? ChapterListView({ state: s }) : infoView,
	);
}
