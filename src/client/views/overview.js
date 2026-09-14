// src/client/views/overview.js — 「基本信息」标签：小说基本要素总览。
//
// 档案 → 大纲 → 角色卡 → 设定 → 时间线（账本）。
// 数据来自 GET /projects/:id/elements 一次聚合；要素缺失是常态（书是 AI 在会话里
// 一点点写出来的），每个区块都给空态引导，不显示报错。
// 大纲全文 / 角色卡全文用原生 <details> 折叠 —— 不需要事件代理，点开才占视线。
import { h } from '../react.js';
import { btnStyle, hintStyle, itemCardStyle } from '../styles.js';

const sectionTitleStyle = {
	fontWeight: 700, fontSize: '13px',
	marginTop: '2px',
};
const emptyHint = (text) => h('div', { style: { ...hintStyle, fontSize: '11.5px' } }, text);
const detailBoxStyle = { ...itemCardStyle, padding: '6px 10px' };
const preStyle = {
	margin: '6px 0 0', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
	fontSize: '12px', lineHeight: 1.7,
	fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
};

/** 一个可折叠区块：<details><summary>标题</summary>内容</details>（原生，不吃 React 事件）。 */
function fold(title, content, open = false) {
	return h('details', { style: detailBoxStyle, open },
		h('summary', { style: { cursor: 'pointer', fontSize: '12.5px' } }, title),
		content);
}

export function ProjectOverviewView({ state: s }) {
	const el = s.elements;
	if (s.elementsLoading) return h('div', { style: hintStyle }, '要素加载中…');
	if (!el) return emptyHint('要素加载失败 —— 点上方「刷新」重试。');

	const meta = el.meta ?? {};
	const facts = Array.isArray(el.facts) ? el.facts : [];
	const foreshadows = Array.isArray(el.foreshadows) ? el.foreshadows : [];

	// ── 档案 ──
	const fmtDate = (iso) => (iso ? String(iso).slice(0, 10) : '—');
	const profile = h('div', { style: itemCardStyle },
		h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '4px 14px', fontSize: '12.5px' } },
			h('span', null, `类型：${meta.genre || '—'}`),
			h('span', null, `阶段：${meta.stage || '—'}`),
			h('span', null, `建：${fmtDate(meta.createdAt)}`),
			h('span', null, `更：${fmtDate(meta.updatedAt)}`),
		),
		meta.logline
			? h('div', { style: { ...hintStyle, fontSize: '12px', marginTop: '4px' } }, meta.logline)
			: null,
	);

	// ── 大纲 ──
	const outlineParts = [
		el.outline?.full
			? fold('📖 全书大纲', h('div', { style: preStyle }, el.outline.full))
			: emptyHint('还没有全书大纲 —— 在会话里让 AI 调用 novel_outline 生成。'),
		(el.outline?.chapterOutlines?.length ?? 0) > 0
			? h('div', { style: { ...hintStyle, fontSize: '11.5px' } },
				`细纲 ${el.outline.chapterOutlines.length} 份（${el.outline.chapterOutlines.slice(0, 5).join('、')}${el.outline.chapterOutlines.length > 5 ? ' …' : ''}）`)
			: null,
	];

	// ── 角色卡 ──
	const chars = Array.isArray(el.characters) ? el.characters : [];
	const castNames = (meta.cast ?? []).map((c) => (typeof c === 'string' ? c : c?.name)).filter(Boolean);
	const characterParts = chars.length > 0
		? chars.map((c) => fold(`👤 ${c.name}`, h('div', { style: preStyle }, c.text || '（空卡）')))
		: [emptyHint('还没有角色卡 —— 在会话里让 AI 调用 novel_cast 生成；已登记角色：'
			+ (castNames.length ? castNames.join('、') : '无'))];

	// ── 设定 ──
	const settingParts = [
		h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
			h('span', { style: { fontSize: '12.5px' } },
				`世界书 ${el.worldbookCount ?? 0} 条 · 术语表 ${el.glossaryCount ?? 0} 条`),
			h('button', { 'data-action': 'goto-lorebook', 'data-id': s.selected, style: btnStyle }, '管理世界书'),
		),
		(el.worldbookCount ?? 0) + (el.glossaryCount ?? 0) === 0
			? emptyHint('设定还是空的 —— 在会话里让 AI 调用 novel_world 沉淀世界观。')
			: null,
	];

	// ── 时间线（账本：事实按章分组 + 伏笔） ──
	const byChapter = new Map();
	for (const f of facts) {
		const no = f.chapter ?? 0;
		if (!byChapter.has(no)) byChapter.set(no, []);
		byChapter.get(no).push(f);
	}
	const timelineRows = [...byChapter.keys()].sort((a, b) => a - b)
		.map((no) => h('div', { key: no, style: { marginBottom: '6px' } },
			h('div', { style: { fontSize: '11.5px', color: 'var(--dsw-alias-accent-strong, #8ab4ff)' } },
				no > 0 ? `第 ${no} 章` : '未定章'),
			...(byChapter.get(no) ?? []).map((f, i) => h('div', { key: i, style: { fontSize: '12px', paddingLeft: '10px' } },
				`${f.entity ?? '？'} · ${f.key ?? '？'} → ${f.value ?? '？'}`)),
		));
	const foreshadowRows = foreshadows.map((f, i) => h('div', { key: i, style: { fontSize: '12px', marginBottom: '4px' } },
		`〔${f.id ?? '？'}〕第 ${f.chapter ?? '？'} 章埋 → 预计第 ${f.plan ?? '？'} 章收`
		+ (f.payoffChapter ? `（已回收于第 ${f.payoffChapter} 章）` : '（未回收）'),
		'\n', f.setup ?? ''));
	const timelineParts = facts.length + foreshadows.length === 0
		? [emptyHint('账本还是空的 —— 开始写章后，novel_write_chapter 会自动把事实与伏笔记进时间线。')]
		: [
			facts.length > 0 ? fold(`🕰 事实时间线（${facts.length} 条）`, h('div', null, timelineRows), facts.length <= 20) : null,
			foreshadows.length > 0 ? fold(`🪡 伏笔（${foreshadows.length} 个）`, h('div', null, foreshadowRows)) : null,
		];

	const section = (title, children) => h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
		h('div', { style: sectionTitleStyle }, title),
		...children);

	return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
		section('📚 档案', [profile]),
		section('🗺 大纲', outlineParts),
		section('👥 角色卡', characterParts),
		section('🧭 设定', settingParts),
		section('⏳ 时间线 · 账本', timelineParts),
	);
}
