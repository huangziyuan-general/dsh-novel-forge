// src/client/views/project-list.js — 项目列表（首屏）。
//
// 纯渲染：只读 state，不改。所有交互靠 `data-action` / `data-field`，
// 由 panel.js 的原生事件代理统一接住（宿主里 React 合成事件不可靠）。
//
// 「项目跟会话走」：这里的列表已经是**本会话**的书（服务端按 session 过滤过）。
// 0.5.0 之前建的书没有会话戳，会落在 state.unclaimed 里 —— 底部给一条认领通道，
// 免得老书从此看不见。
//
// 版面（自上而下）：创建 → 反馈 → 书卡列表 → 未归属 → 脚注。
// 一张书卡要在一屏内回答三件事：**这书到哪一步了**（九阶段轨道）、
// **攒了多少料**（章/账本/伏笔/角色）、**能对它做什么**（世界书/改名/删除）。
import { h } from '../react.js';
import { color, space, font, weight, hintStyle, footerStyle, inputStyle, stackStyle, card, tint } from '../styles.js';
import { Card, Btn, Chip, Stat, StageRail, Empty, Section, Feedback, TAP } from '../ui.js';
import { genreLabel } from '../genre.js';

/**
 * 列表筛选的匹配规则（导出以便直测）：书名 / 目录名 / 显示题材 的子串匹配。
 * 查询词也做一次同样的小写化，中英混着敲都能命中。
 */
export function projectMatches(p, query) {
	const q = String(query ?? '').trim().toLowerCase();
	if (!q) return true;
	return [p.title, p.name, p.genre ? genreLabel(p.genre) : '']
		.some((v) => String(v ?? '').toLowerCase().includes(q));
}

/** 列表项里的一颗统计。fields 缺失（老书/解析失败）就不显示，不显示 0 之外的空壳。 */
function statsOf(p) {
	const fh = p.foreshadows ?? {};
	const stats = [];
	if (p.chapters !== null && p.chapters !== undefined) stats.push(Stat({ icon: '📄', value: p.chapters, unit: '章' }));
	if (p.facts) stats.push(Stat({ icon: '🧾', value: p.facts, unit: '台账' }));
	if (fh.total) {
		// 未回收数量是**要动作**的信号：超期用警告色，普通未回收用中性色
		stats.push(Stat({
			icon: '🪡', value: `${fh.open}/${fh.total}`, unit: '伏笔',
			tone: fh.overdue > 0 ? 'warn' : 'neutral',
		}));
	}
	if (p.castCount) stats.push(Stat({ icon: '👥', value: p.castCount, unit: '角色' }));
	return stats;
}

export function ProjectListView({ state: s }) {
	const creating = s.creating;
	// 列表筛选：书少时是噪音，>8 本才亮出来（客户端子串匹配，无服务端参与）
	const filtering = s.projects.length > 8;
	const query = s.filter ?? '';
	const shown = filtering ? s.projects.filter((p) => projectMatches(p, query)) : s.projects;
	return h('div', { style: stackStyle(space.lg) },

		// ── 创建 ──
		Card({ tone: 'inset', pad: space.md },
			h('div', { style: { display: 'flex', gap: space.sm } },
				h('input', {
					// 非受控（defaultValue + key）：每键只进 state 不重渲染；
					// 创建成功后 panel bump titleReset，key 变化即清空输入框。
					key: `title-${s.titleReset ?? 0}`,
					'data-field': 'title', defaultValue: s.title, placeholder: '新书书名…',
					'aria-label': '新书书名',
					style: { ...inputStyle, flex: '1 1 auto' },
				}),
				Btn({ variant: 'primary', action: 'create', disabled: creating }, creating ? '创建中…' : '创建'),
			),
			h('div', { style: { display: 'flex', alignItems: 'center', gap: space.sm, marginTop: space.sm } },
				Btn({ variant: 'ghost', size: 'sm', action: 'refresh-projects' }, '↻ 刷新'),
				Btn({ variant: 'ghost', size: 'sm', action: 'import-file' }, '⇪ 导入本地'),
			),
		),

		s.error ? Feedback({ tone: 'err' }, s.error) : null,
		s.notice ? Feedback({ tone: 'ok' }, s.notice) : null,
		// 会话过滤空、回落显示全部时的说明（0.13.2：宿主 slot 会话标识与书写入的 id 不同源）
		s.sessionFallback === true
			? h('div', { style: { ...hintStyle, fontSize: font.caption, marginBottom: space.sm } },
				`本会话名下暂时没有匹配到书，先显示全部 ${s.projects.length} 本 —— 书都能正常打开；新建的书会归属到本会话。`)
			: null,

		// ── 列表 ──
		s.loading
			? h('div', { style: hintStyle }, '加载中…')
			: s.projects.length === 0
				? Empty({
					icon: '🔨',
					title: '本会话还没有项目',
					hint: '输入书名创建一个；或在会话里让 AI 调 novel_project init —— 书建好后会自动出现在这里。',
				})
				: h('div', { style: stackStyle(space.md) },
					filtering
						? h('div', { style: stackStyle(space.xs) },
							h('input', {
								'data-field': 'project-filter', value: s.filter ?? '',
								placeholder: '筛选：书名 / 题材…',
								'aria-label': '筛选书目',
								style: inputStyle,
							}),
							h('div', { style: { ...hintStyle, fontSize: font.caption } },
								`${shown.length}/${s.projects.length} 本`),
						)
						: null,
					shown.length === 0
						? Empty({ icon: '·', title: '没有匹配的书', hint: '换个关键词，或清空筛选框。' })
						: null,
					...shown.map((p) => h('div', {
						key: p.name,
						style: { ...card(), padding: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' },
					},
						h('div', { style: { display: 'flex', minWidth: 0 } },
							// 书脊：一条 3px 竖条，扫一眼就知道卡片边界在哪
							h('div', { style: { flex: 'none', width: '3px', background: color.accent, opacity: 0.75 } }),
							h('div', { style: { flex: '1 1 auto', minWidth: 0, padding: `${space.lg}px` } },
								// 标题行：整块可点（button 才能进 Tab 序 / 被读屏读到 / 回车触发）
								// `...TAP` 给它悬停/按下反馈 —— 交互态只能来自 css.js
								h('button', {
									...TAP,
									'data-action': 'open', 'data-id': p.name,
									style: {
										display: 'block', width: '100%', textAlign: 'left', cursor: 'pointer',
										// 热区只向上/左/右扩：底部若也负边距，会把下面的标签行
										// 拉上来贴住按钮的 hover 高亮背景（0.13.1 用户实测重叠）。
										padding: `${space.xs}px ${space.sm}px 0`, margin: `-${space.xs}px -${space.sm}px 0`,
										borderRadius: '8px',
										border: 'none', font: 'inherit', color: 'inherit',
									},
								},
									h('div', { style: { display: 'flex', alignItems: 'center', gap: space.sm } },
										h('span', {
											style: {
												fontWeight: weight.semibold, fontSize: font.lead,
												overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
											},
										}, p.title || p.name),
										p.style?.built ? Chip({ tone: 'ok' }, '有基线') : null,
									),
								),
								h('div', { style: { display: 'flex', gap: space.xs, marginTop: space.xs } },
									p.genre ? Chip({}, genreLabel(p.genre)) : null,
									p.maxChapter ? Chip({}, `写到第 ${p.maxChapter} 章`) : null,
								),

								h('div', { style: { marginTop: space.md } }, StageRail({ stage: p.stage })),

								statsOf(p).length > 0
									? h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: `${space.xs}px ${space.lg}px`, marginTop: space.md } }, ...statsOf(p))
									: null,

								h('div', { style: { display: 'flex', alignItems: 'center', gap: space.xs, marginTop: space.md } },
									Btn({ variant: 'ghost', size: 'sm', action: 'goto-lorebook', id: p.name }, '📖 世界书'),
									Btn({ variant: 'ghost', size: 'sm', action: 'rename-open', id: p.name }, '✎ 改名'),
									Btn({ variant: 'ghost', size: 'sm', action: 'clone-open', id: p.name }, '⧉ 克隆'),
									h('span', { style: { flex: '1 1 auto' } }),
									Btn({ variant: 'danger', size: 'sm', action: 'list-delete', id: p.name }, '删除'),
								),

								// 列表内联改名（目录名=id 不动，只改标题）
								s.rename && s.rename.id === p.name
									? h('div', { style: { display: 'flex', gap: space.sm, marginTop: space.sm } },
										h('input', {
											'data-field': 'rename-value', value: s.rename.value,
											placeholder: '新书名…', 'aria-label': '新书名',
											style: { ...inputStyle, flex: '1 1 auto' },
										}),
										Btn({ variant: 'primary', action: 'rename-confirm', disabled: s.renaming },
											s.renaming ? '保存中…' : '确定'),
										Btn({ action: 'rename-cancel' }, '取消'),
									)
									: null,

								// 克隆为模板（老书连章节带资产复制成新书；目录名是稳定身份，必填）
								s.clone && s.clone.id === p.name
									? h('div', { style: { display: 'flex', gap: space.sm, marginTop: space.sm } },
										h('input', {
											'data-field': 'clone-value', value: s.clone.value,
											placeholder: '新书目录名（如：万刃-模板）', 'aria-label': '新书目录名',
											style: { ...inputStyle, flex: '1 1 auto' },
										}),
										Btn({ variant: 'primary', action: 'clone-confirm', disabled: s.cloning },
											s.cloning ? '克隆中…' : '克隆'),
										Btn({ action: 'clone-cancel' }, '取消'),
									)
									: null,

								// 删除二次确认（误触可取消）
								s.listDeleteId === p.name
									? h('div', {
										style: {
											display: 'flex', alignItems: 'center', gap: space.sm,
											marginTop: space.sm, padding: `${space.sm}px ${space.md}px`,
											borderRadius: '8px', background: tint(color.danger, 10),
										},
									},
										h('span', { style: { fontSize: font.small, color: color.danger } }, '删除这本书？'),
										h('span', { style: { flex: '1 1 auto' } }),
										Btn({
											variant: 'danger', action: 'list-delete', id: p.name,
											disabled: s.listDeleteId === 'busy',
										}, s.listDeleteId === 'busy' ? '删除中…' : '确认删除'),
										Btn({ action: 'list-delete-cancel' }, '取消'),
									)
									: null,
							),
						),
					)),
				),

		// ── 未归属的旧书（0.5.0 之前的书没有会话戳）──
		s.unclaimed && s.unclaimed.length > 0
			? Card({ tone: 'inset', pad: space.md },
				Section({
					icon: '📦', title: `未归属的书（${s.unclaimed.length}）`,
					right: Btn({ size: 'sm', action: 'claim' }, '全部认领'),
				},
					h('div', { style: { ...hintStyle, fontSize: font.caption } },
						'这些书建在会话归属功能之前。认领后归本会话，之后才会出现在上面的列表里。'),
					h('div', { style: stackStyle(space.xs) },
						...s.unclaimed.map((p) => h('div', {
							key: p.name,
							style: { display: 'flex', alignItems: 'center', gap: space.sm },
						},
							h('span', {
								style: {
									flex: '1 1 auto', minWidth: 0, fontSize: font.small,
									overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
								},
							}, p.title || p.name),
							Btn({ variant: 'ghost', size: 'sm', action: 'claim', id: p.name, disabled: s.busy }, '认领'),
						)),
					),
				),
			)
			: null,

		h('p', { style: footerStyle },
			'列表只显示本会话创建或参与过的项目；写作、门禁、审计都在会话里由 novel_* 工具驱动。'),
	);
}
