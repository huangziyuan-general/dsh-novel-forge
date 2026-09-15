// src/client/forge-tab.js — 右侧栏 tab 的「三步契约」（0.5.0 起入口回到右侧栏）。
//
// 官方契约（见 @deepseek-ai/dsh-client-ui-sidebar-right 的 lib/types/client/）：
//   ① `ctx.sidebarRightTabs.register(definition)` —— **声明**有这么一种 tab；
//   ② `ctx.slots.register({ name: 'sidebar.right.pane.tab', key: <definition.id> }, Panel)`
//      —— 给这种 tab 提供内容（key 用 definition 的 `id`，不是 `kind`）；
//   ③ `ctx.sidebarRight.openTab(<definition.kind>)` —— **真正把它放上屏幕**。
//
// 最坑的一点：只做①②、没人调③时，**一格都不会多，也不报任何错**。
// register 的语义是「声明」，不是「放上去」——这正是「右侧栏 tab 死活不出现」
// 的第一大误判来源（会被误认成 bundle 没加载 / 缓存问题）。
//
// 为什么第③步要「延迟 + 重试」：`openTab` 在 seat **挂载前**调用会直接抛错
// （引擎有意设计：没有 session 可操作时宁可报错，也不静默写进没人画的面）。
// 而右侧栏若处于折叠态，seat 可能迟迟不挂载 —— 所以窗口给到 30 秒。
/** 本实现在 tab 系统里的身份：`definition.id`，也是内容 seat 的 key。 */
export const TAB_ID = 'dsh-novel-forge';

/** tab 类型判别符：`openTab` 用它点名（语义与 id 不同，别混）。 */
export const TAB_KIND = 'novel-forge';

/**
 * ① 类型定义（纯静态：认领什么地址、叫什么、guide 里给不给入口胶囊）。
 * 不给 `patterns` ⇒ **page type**：由 kind 打开，不认领地址。
 */
export function tabDefinition() {
	return {
		id: TAB_ID,
		kind: TAB_KIND,
		priority: 'extension',
		title: () => '🔨 锻炉',
		// guide 是「右侧栏常驻页」里的入口胶囊 —— 跨会话都在，
		// 自动打开失败 / 被用户关掉时，这是手动通道（保底入口）。
		guide: [{
			order: 90,
			title: () => '小说锻炉',
			description: () => '本会话的小说项目：章节 / 账本 / 世界书',
		}],
	};
}

/**
 * 注册①②步。返回 disposer（交给 ctx.effect 的返回值语义）。
 * @param {object} ctx cordis 客户端上下文
 * @param {Function} Panel tab 内容组件
 */
export function registerForgeTab(ctx, Panel) {
	ctx.effect(() => ctx.sidebarRightTabs.register(tabDefinition()),
		'dsh-novel-forge: 右侧栏 tab 类型');
	// `slots.inject(name, cb)`：等这个 seat 可用再注册（官方 documentpreview 同款写法）
	ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
		name: 'sidebar.right.pane.tab',
		key: TAB_ID,
		// inject 工厂是面板 props 的唯一来源：**sessionId 只有这里能拿到**，
		// 面板靠它把项目列表按会话过滤（「项目跟会话走」）。
		inject: (sessionId) => ({ sessionId }),
	}, Panel)), 'dsh-novel-forge: 右侧栏 tab 内容');
}

/**
 * ③ 打开 tab —— 必须延迟 + 重试，见文件头。
 * @param {object} ctx
 * @param {object} [opts]
 * @param {Function} [opts.timer] 注入的 setTimeout（测试用）
 * @param {number} [opts.maxTries] 重试上限（250ms × 120 ≈ 30s）
 * @param {Function} [opts.log]
 * @returns {Function} 立刻尝试一次并链式重试；返回 true 表示这次开成了
 */
export function openForgeTab(ctx, opts = {}) {
	const timer = opts.timer ?? setTimeout;
	const log = opts.log ?? console;
	const maxTries = opts.maxTries ?? 120;
	let tries = 0;
	let opened = false;
	let disposed = false;

	const attempt = () => {
		if (disposed || opened) return true;
		try {
			ctx.sidebarRight.openTab(TAB_KIND);
			opened = true;
			log.info('[novel-forge] 已打开右侧栏 tab（锻炉）');
			return true;
		} catch (error) {
			tries += 1;
			if (tries < maxTries) {
				timer(attempt, 250);
			} else {
				log.warn('[novel-forge] 自动打开右侧栏 tab 失败，可从右侧栏 guide 页手动进入', error);
			}
			return false;
		}
	};

	timer(attempt, 400);          // 首次延迟：给 seat 挂载留时间
	return () => { disposed = true; };
}
