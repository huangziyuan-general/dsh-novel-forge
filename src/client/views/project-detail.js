// src/client/views/project-detail.js — 项目详情：两个标签（基本信息 / 章节听书）。
//
// 「基本信息」＝ 原来的详情页（选章 / 编辑 / 保存 / 导出 / 诊断）；
// 「章节听书」＝ 目录 + 语音连播（views/chapters.js）。
// 「一键写章 / 润色 / 诊断」需要模型参与，面板只能给引导 —— 真正的动作
// 在会话里由 novel_* 工具完成。面板负责的是确定性部分：读章、改稿、存稿、导出、听书。
import { h } from '../react.js';
import { btnStyle, inputStyle, errStyle, okStyle, hintStyle, miniBtnStyle, dangerBtnStyle, primaryBtnStyle } from '../styles.js';
import { ChapterListView } from './chapters.js';
import { ProjectOverviewView } from './overview.js';

/** 标签按钮；激活态用主色描边。 */
const tabBtnStyle = (active) => ({
	...btnStyle,
	padding: '4px 12px',
	fontSize: '12px',
	...(active ? {
		borderColor: 'var(--dsw-alias-accent-strong, #8ab4ff)',
		color: 'var(--dsw-alias-accent-strong, #8ab4ff)',
		fontWeight: 700,
	} : {}),
});

export function ProjectDetailView({ state: s }) {
	const chapterCount = s.detail?.chapters ? Object.keys(s.detail.chapters).length : 0;

	// ── 标签条 ──
	const tabBar = h('div', { style: { display: 'flex', gap: '6px' } },
		h('button', { 'data-action': 'detail-tab', 'data-tab': 'info', style: tabBtnStyle(s.detailTab !== 'chapters') },
			'📋 基本信息'),
		h('button', { 'data-action': 'detail-tab', 'data-tab': 'chapters', style: tabBtnStyle(s.detailTab === 'chapters') },
			'🎧 章节听书'),
	);

	// ── 标签一：基本信息（要素总览 + 本章编辑） ──
	const infoView = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },

		// 小说基本要素：档案 / 大纲 / 角色卡 / 设定 / 时间线
		ProjectOverviewView({ state: s }),

		h('div', { style: { fontWeight: 600, fontSize: '13px', borderTop: '1px solid var(--dsw-alias-border-l3, #333)', paddingTop: '8px' } },
			'✍️ 本章编辑'),

		// 章节选择 + 需要模型的动作
		h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center' } },
			h('label', { style: { fontSize: '12px' } }, '章节'),
			h('select', {
				'data-field': 'chapterNo', value: String(s.chapterNo),
				style: { padding: '4px', borderRadius: '4px' },
			}, Array.from({ length: Math.max(1, chapterCount + 1) }, (_, i) => i + 1)
				.map((no) => h('option', { key: no, value: String(no) }, `第 ${no} 章`))),
			h('button', {
				'data-action': 'write', disabled: s.writing || s.polishing, style: btnStyle,
			}, s.writing ? '写作中…' : '一键写章'),
			h('button', {
				'data-action': 'polish', disabled: s.writing || s.polishing,
				style: { ...btnStyle, borderColor: '#a06', color: '#a06' },
			}, s.polishing ? '润色中…' : '一键润色'),
		),

		s.error ? h('div', { style: errStyle }, s.error) : null,
		s.notice ? h('div', { style: okStyle }, s.notice) : null,

		// 编辑区（key 带版本号，刷新章节时强制重建以吸收新的 defaultValue）
		h('textarea', {
			'data-field': 'draft', key: `draft-${s.draftVersion}`,
			defaultValue: s.draft, placeholder: '本章正文', rows: 8,
			style: { ...inputStyle, fontFamily: 'monospace', fontSize: '12px', minHeight: '120px' },
		}),

		h('div', { style: { display: 'flex', gap: '6px' } },
			h('button', { 'data-action': 'refresh', style: btnStyle }, '刷新'),
			h('button', { 'data-action': 'save', style: primaryBtnStyle }, '保存'),
			h('button', { 'data-action': 'export', disabled: s.exporting, style: btnStyle }, s.exporting ? '导出中…' : '导出'),
			h('button', { 'data-action': 'goto-lorebook', 'data-id': s.selected, style: btnStyle }, '世界书'),
			h('button', { 'data-action': 'delete', style: dangerBtnStyle },
				s.deleteState === 'confirm' ? '确认删除？' : '删除'),
		),

		// 结构诊断
		h('div', {
			style: {
				display: 'flex', alignItems: 'center', gap: '8px',
				borderTop: '1px solid var(--dsw-alias-border-l3, #333)', paddingTop: '8px',
			},
		},
			h('span', { style: { fontWeight: 600, fontSize: '13px' } }, '结构诊断'),
			h('button', { 'data-action': 'diagnose', disabled: s.diagnosing, style: btnStyle },
				s.diagnosing ? '诊断中…' : '诊断本章'),
			s.report ? h('span', {
				style: {
					fontSize: '13px', fontWeight: 700,
					color: s.report.score >= 70 ? '#2a7' : s.report.score >= 50 ? '#c90' : '#c33',
				},
			}, `得分 ${s.report.score}`) : null,
		),
		s.report && s.report.issues?.length > 0
			? h('div', { style: { fontSize: '12px', display: 'flex', flexDirection: 'column', gap: '4px' } },
				s.report.issues.slice(0, 5).map((issue, i) =>
					h('div', {
						key: i,
						style: {
							padding: '4px 6px',
							background: issue.severity === 'error' ? 'rgba(255,100,100,.1)' : 'rgba(255,200,0,.1)',
							borderRadius: '4px',
						},
					}, issue.advice)),
			)
			: s.report ? h('div', { style: { ...okStyle, fontSize: '12px' } }, '未发现问题') : null,

		h('div', { style: { display: 'flex', gap: '6px' } },
			h('button', { 'data-action': 'goto-lorebook', 'data-id': s.selected, style: miniBtnStyle }, '本书世界书'),
		),
	);

	return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
		h('button', { 'data-action': 'back', style: btnStyle }, '← 返回'),
		tabBar,
		s.detailTab === 'chapters'
			? h(ChapterListView, { state: s })
			: infoView,
	);
}
