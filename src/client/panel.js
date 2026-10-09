// src/client/panel.js — 右侧栏「锻炉」面板：控制器装配（状态 + 共享 ctx + 子控制器接线）+ React 组件。
//
// 与 0.4.x 的差别：那时候是一个**自建 root 的全屏抽屉**（position:fixed + display 切换），
// 0.5.0 起交给**右侧栏 slot 框架**渲染 —— 我们只返回 element，不再自己 createRoot，
// 于是「点一次没反应 / 再点一次整屏空白」（createRoot 取错包）那类事故从根上消失。
//
// 分工：
//   views/*              纯渲染，只读 state
//   controllers/*        业务域（projects / chapters / proposals / lore / events），读写共享 ctx
//   panel.js             装配：建 state/ctx/守卫、接线子控制器、返回对外 API
//   forge-tab.js         把它挂进右侧栏（三步契约）
//
// 交互仍走 `data-action` + 容器级**原生** click 代理 —— 宿主环境里 React 合成事件
// 不可靠（这也是全篇不写 onClick 的原因）；面板容器是 slot 框架画的 DOM，
// 在上面 addEventListener 完全正常。
//
// 「项目跟会话走」：所有列表/创建/认领请求都带 sessionId（来自 slot inject 工厂）。
import { h, Component, useState, useRef, useEffect } from './react.js';
import { initialState } from './state.js';
import { apiFetch } from './api.js';
import { createTtsPlayer, resolveSynth } from './tts.js';
import {
	rootStyle, bodyStyle, headerStyle, brandMarkStyle, titleStyle, subtitleStyle,
	chip, space, color,
} from './styles.js';
import { ProjectListView } from './views/project-list.js';
import { ProjectDetailView } from './views/project-detail.js';
import { LorebookView } from './views/lorebook.js';
import { SettingsView } from './views/settings.js';
// 面板根属性 + 交互态样式表（:hover/:active 只能靠样式表，内联压不过它们）
import { PANEL_ATTR, ensureStyles } from './css.js';
// 业务域子控制器：各自只依赖共享 ctx（state/notify/seq/player + 晚绑定的跨域动作）
import { createChaptersController } from './controllers/chapters.js';
import { createLoreController } from './controllers/lore.js';
import { createProposalsController } from './controllers/proposals.js';
import { createProjectsController } from './controllers/projects.js';
import { createEventsController } from './controllers/events.js';

export { PANEL_ATTR };

/**
 * 渲染错误边界：某个视图抛错时只把这块换成报错文案，
 * 而不是让整棵 slot 树卸载（用户看到的是「面板空白」）。
 */
const ForgeBoundary = typeof Component === 'function'
	? class extends Component {
		constructor(props) { super(props); this.state = { error: null }; }
		static getDerivedStateFromError(error) { return { error }; }
		componentDidCatch(error) { console.error('[novel-forge] 面板渲染失败：', error); }
		render() {
			if (this.state.error) {
				return h('div', { style: { padding: '16px', color: color.danger, fontSize: '12.5px', lineHeight: 1.7, whiteSpace: 'pre-wrap' } },
					'面板渲染失败：' + String(this.state.error?.message ?? this.state.error));
			}
			return this.props.children;
		}
	}
	: null;

/**
 * 建一个面板控制器。
 *
 * 状态放闭包对象、改完手动 notify()（与 0.4.x 一致）：这样 headless 测试
 * 可以构造 controller 直接驱动断言，不必渲染 React。
 *
 * 域拆分见 controllers/*：本函数只负责建 state/守卫/播放器，把各域动作装进共享 ctx
 * 再接线。跨域调用（如 openProject→loadProposals）走 ctx 晚绑定，因此各域之间没有
 * 模块级循环 import。
 *
 * @param {object} [opts]
 * @param {string|null} [opts.sessionId] 当前会话（slot inject 工厂给的）
 * @param {Function} [opts.onChange] 需要重渲染时的回调
 */
export function createForgeController({ sessionId = null, resolveSessionId = null, onChange = () => {} } = {}) {
	const state = initialState();
	state.sessionId = sessionId ?? null;

	const notify = () => {
		try { onChange(); } catch (error) { console.error('[novel-forge] 面板重渲染失败：', error); }
	};

	/** 会话 id 校正：slot inject 的标识可能与真 agent 会话 id 不同源（0.13.2 真机实锤：
	 *  session-watch 用 sessions 服务的 id 能探到书，slot 的 id 过滤却是空、
	 *  服务端 agents.get(slot id) 也找不到父会话）。sessions 服务的「当前会话」
	 *  是已被证实能对上的来源 —— 发请求前对齐一次，过滤 / parent 锚定 / 认领 / 创建
	 *  就都落在真 id 上。 */
	const syncSession = () => {
		if (typeof resolveSessionId !== 'function') return;
		try {
			const id = resolveSessionId();
			if (typeof id === 'string' && id !== '' && id !== state.sessionId) state.sessionId = id;
		} catch { /* sessions 面不可得：留在 slot inject 的 id 上 */ }
	};

	/** 给请求带上会话 —— 「项目跟会话走」就靠这一处收口。 */
	const withSession = (path) => {
		syncSession();
		if (!state.sessionId) return path;
		const sep = path.includes('?') ? '&' : '?';
		return `${path}${sep}session=${encodeURIComponent(state.sessionId)}`;
	};

	// ── 陈旧响应守卫（请求序号）──
	// openProject / loadChapter 都是「await 完成后写 state」：快速连续切换时，
	// 慢响应后到会把新状态覆盖成旧内容（编辑器显示别章正文；此时点保存，
	// saveChapter 会把 A 章内容 POST 到现行 chapterNo —— 写错章）。每次发起
	// 切换自增序号，响应落地前比对，过期即弃。放共享对象里由各域共写共读。
	const seq = { open: 0, chapter: 0 };

	// ── 章节听书（0.6.0）──
	// 播放器先建好；onChange 把播放状态写进 state 再触发重渲染。
	// synth 可能为 null（无语音引擎的环境）：playFrom 会抛可读错误，面板转成提示。
	const player = createTtsPlayer({
		synth: resolveSynth(),
		loadChapter: (no) => apiFetch(`/projects/${encodeURIComponent(state.selected)}/chapters/${no}`),
		hasChapter: (no) => state.chapterList.some((c) => c.no === no),
		// 连播/空章跳过都要"下一个存在的章"，不是 currentNo+1 —— 章号有缺口不能早停
		//（chapterList 服务端已按 no 升序排）
		nextChapterAfter: (no) => {
			const n = state.chapterList.find((c) => c.no > no);
			return n ? n.no : null;
		},
		onChange: (playback) => { state.playback = playback; notify(); },
	});

	// 共享上下文：各子控制器往这里挂自己的动作；跨域调用（如 openProject 要拉提案）
	// 在装配完成后才发生，晚绑定天然解环。
	const ctx = { state, notify, syncSession, withSession, seq, player };
	Object.assign(ctx, createChaptersController(ctx));
	Object.assign(ctx, createLoreController(ctx));
	Object.assign(ctx, createProposalsController(ctx));
	Object.assign(ctx, createProjectsController(ctx));
	Object.assign(ctx, createEventsController(ctx));

	let started = false;
	/** 首次挂载后拉数据（幂等）。 */
	const start = () => {
		if (started) return;
		started = true;
		void ctx.refreshProjects();
	};

	/** 会话切换：换 id 并重新拉列表（面板是按会话的账本）。 */
	const setSession = (next) => {
		const id = next ?? null;
		if (state.sessionId === id) return;
		state.sessionId = id;
		// 序号作废（CodeBuddy 审计 2026-10-09 L2）：切换瞬间在途的 loadChapter/
		// openProject 响应若仍算「有效」，会把旧会话旧书的正文写进 draft/baseline。
		seq.open += 1; seq.chapter += 1;
		player.stop();
		state.selected = null; state.detail = null; state.view = 'projects'; state.chapterList = [];
		state.rename = null; state.listDeleteId = null; state.clone = null;
		state.sessionScope = 'session';
		state.loreDeleteId = null; state.filter = '';
		started = true;
		notify();
		void ctx.refreshProjects();
	};

	return {
		state, notify, attach: ctx.attach, detach: ctx.detach, start, setSession,
		refreshProjects: ctx.refreshProjects, handleAction: ctx.handleAction, syncSession,
		loadProposals: ctx.loadProposals, refreshProposalsIfIdle: ctx.refreshProposalsIfIdle,
		stopPlayback: () => player.stop(),
	};
}

/**
 * 头部副题：面板现在在哪一层、手上是什么。
 * 这行字是「我在哪」的唯一提示，别省。
 */
function panelSubtitle(s) {
	if (s.view === 'detail') {
		const title = s.detail?.title || s.selected || '这本书';
		const n = (s.chapterList ?? []).length;
		return n > 0 ? `${title} · 已写 ${n} 章` : title;
	}
	if (s.view === 'lorebook') return `${s.selected || '默认'} · 世界书`;
	if (s.view === 'settings') return '能力清单';
	const total = (s.projects ?? []).length;
	if (s.loading && total === 0) return '载入中…';
	const unclaimed = (s.unclaimed ?? []).length;
	return `${total} 本书` + (unclaimed > 0 ? ` · ${unclaimed} 本待认领` : '');
}

/**
 * 右侧栏面板组件（slot 框架渲染它）。
 * props.sessionId 由 forge-tab.js 的 inject 工厂注入；props.resolveSessionId 由
 * index.js 的包装闭包注入（读 sessions 服务的当前会话 —— 0.13.2 起 slot 标识
 * 与真 agent 会话 id 被证实可能不同源，发请求前以 resolver 对齐为准）。
 */
export function ForgePanel(props) {
	const sessionId = props?.sessionId ?? null;
	const resolveSessionId = props?.resolveSessionId ?? null;
	const [, forceTick] = useState(0);
	const controllerRef = useRef(null);
	const nodeRef = useRef(null);

	if (controllerRef.current === null) {
		controllerRef.current = createForgeController({
			sessionId,
			resolveSessionId,
			onChange: () => forceTick((n) => n + 1),
		});
	}
	const controller = controllerRef.current;

	// 会话切换（同一个面板实例被复用到别的会话）
	useEffect(() => { controller.setSession(sessionId); }, [sessionId]);

	// 挂载：注入交互态样式表 + 绑事件代理 + 首次拉数据；卸载：停播 + 解绑
	//（面板被宿主拆掉时朗读必须跟着停 —— 否则 tab 关了还在出声）
	useEffect(() => {
		// 只注入、不回收：样式表是**全局单例**（宿主会反复装配，必须查到就收养）。
		// 放在挂载里而不是 apply()：面板没渲染时不该往宿主页面塞样式。
		ensureStyles();
		const node = nodeRef.current;
		if (node) controller.attach(node);
		controller.start();
		// 页面重新可见/窗口聚焦 → 重拉提案队列（写作会话可能刚提交了新提案）
		const reloadIfIdle = () => controller.refreshProposalsIfIdle();
		document.addEventListener('visibilitychange', reloadIfIdle);
		window.addEventListener('focus', reloadIfIdle);
		return () => {
			controller.stopPlayback(); controller.detach();
			document.removeEventListener('visibilitychange', reloadIfIdle);
			window.removeEventListener('focus', reloadIfIdle);
		};
	}, []);

	const s = controller.state;
	const view = h('div', {
		[PANEL_ATTR]: '1',
		ref: nodeRef,
		style: rootStyle,
	},
		// 品牌条：图标块 + 标题（含版本）+ 副题 + 会话范围
		h('div', { style: headerStyle },
			h('div', { style: brandMarkStyle }, '🔨'),
			h('div', { style: { flex: '1 1 auto', minWidth: 0 } },
				h('div', { style: { display: 'flex', alignItems: 'center', gap: space.sm } },
					h('span', { style: titleStyle }, '锻炉'),
					h('span', { style: chip() }, 'v' + (window.__NOVEL_FORGE_VERSION__ || '?')),
				),
				h('div', { style: subtitleStyle }, panelSubtitle(s)),
			),
			s.sessionId
				? h('button', {
					'data-action': 'toggle-scope',
					title: '书单范围：本会话 ⇄ 全部项目（多会话各写各的书，只看本会话会漏掉别的会话建的书）',
					style: { ...chip({ tone: s.sessionScope === 'all' ? 'neutral' : 'accent' }), alignSelf: 'flex-start', cursor: 'pointer' },
				}, s.sessionScope === 'all' ? '全部项目' : '本会话')
				: h('span', {
					style: { ...chip({ tone: 'neutral' }), alignSelf: 'flex-start' },
				}, '全部项目'),
			// 设置入口常驻在头部：详情页/世界书页都够不到列表页那个按钮，
			// 用户想看一眼「面板到底能做什么」时不该先退回列表
			h('button', {
				'data-action': 'goto-settings',
				// 走按钮皮肤：底/描边/字色交给 css.js，这样它有悬停与按下反馈
				'data-nf-btn': '1', 'data-variant': 'secondary',
				title: '设置 · 能力清单',
				'aria-label': '设置 · 能力清单',
				style: {
					flex: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: '13px',
					lineHeight: 1, padding: '5px 7px', borderRadius: '8px',
				},
			}, '⚙'),
		),
		h('div', { style: bodyStyle },
			s.view === 'projects' ? h(ProjectListView, { state: s }) : null,
			s.view === 'detail' ? h(ProjectDetailView, { state: s }) : null,
			s.view === 'lorebook' ? h(LorebookView, { state: s }) : null,
			s.view === 'settings' ? h(SettingsView) : null,
		),
	);

	return ForgeBoundary ? h(ForgeBoundary, null, view) : view;
}