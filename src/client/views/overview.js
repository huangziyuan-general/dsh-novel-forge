// src/client/views/overview.js — 「基本信息」标签：把一本书的全部沉淀摊开看。
//
// 档案 → 大纲 → 角色卡 → 设定 → 时间线（账本）→ 伏笔。
// 数据来自 GET /projects/:id/elements 一次聚合；要素缺失是常态（书是 AI 在会话里
// 一点点写出来的），每个区块给**空态引导**而不是报错——空态文案本身就是使用说明。
//
// 版面取舍：这些内容天然是「长列表 + 大段文本」，所以一律用原生 <details> 折叠
// （点开才占视线、不吃 React 事件、不需要事件代理）。时间线改成**左侧竖轴**：
// 账本的价值在「按章推进」，平铺成一串灰字就看不出这件事了。
import { h } from '../react.js';
import { color, space, font, weight, hintStyle, tint, stackStyle } from '../styles.js';
import { Card, Chip, Stat, Fold, Empty, Section, Mono, KV } from '../ui.js';
import { genreLabel } from '../genre.js';

const preStyle = {
	margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
	fontSize: font.small, lineHeight: 1.8,
};

/** 一条账本事实（竖轴右侧的一行）。 */
function factLine(f) {
	return h('div', {
		style: {
			display: 'flex', alignItems: 'baseline', gap: space.xs,
			fontSize: font.small, padding: '1px 0',
		},
	},
		h('span', { style: { color: color.text2, fontWeight: weight.medium } }, f.entity ?? '？'),
		h('span', { style: { color: color.textDim, fontSize: font.caption } }, f.key ?? '？'),
		h('span', { style: { color: color.textDim, fontSize: font.caption } }, '→'),
		h('span', { style: { flex: '1 1 auto', minWidth: 0, wordBreak: 'break-word' } }, f.value ?? '？'),
	);
}

export function ProjectOverviewView({ state: s }) {
	const el = s.elements;
	if (s.elementsLoading) return h('div', { style: hintStyle }, '要素加载中…');
	if (!el) {
		return Empty({
			icon: '📂',
			title: '要素没读出来',
			hint: '可能这本书刚建、还没有任何沉淀文件。点上方「刷新」重试一次。',
		});
	}

	const meta = el.meta ?? {};
	const facts = Array.isArray(el.facts) ? el.facts : [];
	const foreshadows = Array.isArray(el.foreshadows) ? el.foreshadows : [];
	const chars = Array.isArray(el.characters) ? el.characters : [];
	const castNames = (meta.cast ?? []).map((c) => (typeof c === 'string' ? c : c?.name)).filter(Boolean);
	const outlineCount = el.outline?.chapterOutlines?.length ?? 0;
	const writtenMax = (s.chapterList ?? []).reduce((m, c) => Math.max(m, c.no ?? 0), 0);

	// ── 档案 ──
	const fmtDate = (iso) => (iso ? String(iso).slice(0, 10) : '—');
	const profile = Card({ tone: 'plain' },
		h('div', { style: { display: 'flex', alignItems: 'center', gap: space.sm, flexWrap: 'wrap' } },
			h('span', { style: { fontWeight: weight.semibold, fontSize: font.lead } }, meta.title || s.selected),
			meta.genre ? Chip({ tone: 'neutral' }, genreLabel(meta.genre)) : null,
			meta.stage ? Chip({ tone: 'accent' }, String(meta.stage)) : null,
		),
		h('div', { style: { ...stackStyle(space.xs), marginTop: space.md } },
			KV({ k: '创建' }, fmtDate(meta.createdAt)),
			KV({ k: '更新' }, fmtDate(meta.updatedAt)),
			KV({ k: '角色' }, castNames.length ? castNames.join('、') : '—'),
		),
		meta.logline
			? h('div', {
				style: {
					marginTop: space.md, padding: `${space.sm}px ${space.md}px`,
					borderLeft: `2px solid ${tint(color.accent, 55)}`, borderRadius: '0 6px 6px 0',
					background: tint(color.accent, 6),
					fontSize: font.small, color: color.text2, lineHeight: 1.7,
				},
			}, meta.logline)
			: null,
	);

	// ── 沉淀统计：一眼看清「这本书攒了什么」──
	const tiles = Card({ tone: 'inset', pad: space.md },
		h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: `${space.sm}px ${space.xl}px` } },
			Stat({ icon: '🗺', value: el.outline?.full ? '有' : '无', unit: '大纲', tone: el.outline?.full ? 'ok' : 'warn' }),
			Stat({ icon: '📑', value: outlineCount, unit: '细纲' }),
			Stat({ icon: '👤', value: chars.length, unit: '角色卡' }),
			Stat({ icon: '📖', value: el.worldbookCount ?? 0, unit: '世界书' }),
			Stat({ icon: '🔤', value: el.glossaryCount ?? 0, unit: '术语' }),
			Stat({ icon: '🧾', value: facts.length, unit: '台账' }),
			Stat({ icon: '🪡', value: foreshadows.length, unit: '伏笔' }),
		),
	);

	// ── 大纲 ──
	const outlineBlock = el.outline?.full
		? Fold({ title: '📖 全书大纲', open: false },
			h('div', { style: preStyle }, el.outline.full))
		: Empty({ icon: '🗺', title: '还没有全书大纲', hint: '在会话里让 AI 调 novel_outline 生成，生成后这里会显示全文。' });

	// ── 角色卡 ──
	const castBlock = chars.length > 0
		? h('div', { style: stackStyle(space.xs) },
			...chars.map((c) => Fold({ title: `👤 ${c.name}` }, h('div', { style: preStyle }, c.text || '（空卡）'))))
		: Empty({
			icon: '👥', title: '还没有角色卡',
			hint: '在会话里让 AI 调 novel_cast 生成。'
				+ (castNames.length ? `已登记但无卡的角色：${castNames.join('、')}` : ''),
		});

	// ── 设定 ──
	const settingBlock = h('div', { style: stackStyle(space.sm) },
		h('div', { style: { display: 'flex', alignItems: 'center', gap: space.md, flexWrap: 'wrap' } },
			Stat({ icon: '📖', value: el.worldbookCount ?? 0, unit: '条世界书' }),
			Stat({ icon: '🔤', value: el.glossaryCount ?? 0, unit: '条术语' }),
		),
		(el.worldbookCount ?? 0) + (el.glossaryCount ?? 0) === 0
			? Empty({ icon: '🧭', title: '设定还是空的', hint: '在会话里让 AI 调 novel_world 沉淀世界观；也可以在「世界书」里手动加。' })
			: null,
	);

	// ── 时间线（账本事实按章分组，竖轴样式）──
	const byChapter = new Map();
	for (const f of facts) {
		const no = f.chapter ?? 0;
		if (!byChapter.has(no)) byChapter.set(no, []);
		byChapter.get(no).push(f);
	}
	const chaptersSorted = [...byChapter.keys()].sort((a, b) => a - b);
	const timelineBlock = chaptersSorted.length > 0
		? Fold({ title: `🕰 事实时间线（${facts.length} 条 / ${chaptersSorted.length} 章）`, open: facts.length <= 24 },
			h('div', { style: stackStyle(0) },
				...chaptersSorted.map((no, gi) => h('div', {
					key: no,
					style: { display: 'flex', gap: space.md, minWidth: 0 },
				},
					// 左：竖轴（圆点 + 连线；最后一节不画线）
					h('div', {
						style: {
							flex: 'none', width: '10px', display: 'flex', flexDirection: 'column',
							alignItems: 'center', paddingTop: '5px',
						},
					},
						h('span', {
							style: {
								width: '6px', height: '6px', borderRadius: '50%',
								background: no === 0 ? color.textDim : color.accent, flex: 'none',
							},
						}),
						gi < chaptersSorted.length - 1
							? h('span', { style: { flex: '1 1 auto', width: '1px', background: color.border2, minHeight: '8px' } })
							: null,
					),
					// 右：章标签 + 该章全部事实
					h('div', { style: { flex: '1 1 auto', minWidth: 0, paddingBottom: space.md } },
						h('div', { style: { fontSize: font.caption, color: color.text3, marginBottom: '2px' } },
							no > 0 ? `第 ${no} 章` : '未定章'),
						...(byChapter.get(no) ?? []).map((f, i) => h('div', { key: i }, factLine(f))),
					),
				)),
			))
		: Empty({
			icon: '⏳', title: '账本还是空的',
			hint: '开始写章后，novel_write_chapter 会自动把状态变化记进时间线（谁在哪章变成了什么）。',
		});

	// ── 伏笔 ──
	const foreshadowBlock = foreshadows.length > 0
		? Fold({ title: `🪡 伏笔（${foreshadows.length} 个）` },
			h('div', { style: stackStyle(space.sm) },
				...foreshadows.map((f, i) => {
					const paid = Number.isInteger(f.payoffChapter);
					const overdue = !paid && Number.isInteger(f.plan) && writtenMax > f.plan;
					return h('div', {
						key: i,
						style: {
							display: 'flex', flexDirection: 'column', gap: '2px',
							paddingBottom: space.sm,
							borderBottom: i < foreshadows.length - 1 ? `1px solid ${color.border1}` : 'none',
						},
					},
						h('div', { style: { display: 'flex', alignItems: 'center', gap: space.sm, flexWrap: 'wrap' } },
							Mono({}, f.id ?? '？'),
							Chip({ tone: paid ? 'ok' : overdue ? 'warn' : 'neutral' },
								paid ? `已回收·第 ${f.payoffChapter} 章`
									: overdue ? `超期·计划第 ${f.plan} 章` : `未回收·计划第 ${f.plan ?? '？'} 章`),
							h('span', { style: { ...hintStyle, fontSize: font.caption } }, `第 ${f.chapter ?? '？'} 章埋`),
						),
						f.setup ? h('div', { style: { ...preStyle, fontSize: font.caption, color: color.text2 } }, f.setup) : null,
					);
				}),
			))
		: null;

	return h('div', { style: stackStyle(space.xl) },
		Section({ icon: '📚', title: '档案' }, profile, tiles),
		Section({ icon: '🗺', title: '大纲' }, outlineBlock),
		Section({ icon: '👥', title: '角色卡' }, castBlock),
		Section({ icon: '🧭', title: '设定' }, settingBlock),
		Section({ icon: '⏳', title: '时间线 · 账本' }, timelineBlock),
		foreshadowBlock ? Section({ icon: '🪡', title: '伏笔' }, foreshadowBlock) : null,
	);
}
