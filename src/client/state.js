// src/client/state.js — 抽屉的全部可变状态。
//
// 为什么不用 React state：宿主环境下 React 合成事件不可靠，交互统一走
// `data-action` + 原生 click 代理；因此状态放在闭包对象里，改完手动 render()。
// 好处是 headless 测试可以构造 state 直接断言，不必驱动 React。

/** 一次性的世界书表单（避免同一坨字面量在 5 处重复）。 */
export function emptyLoreForm() {
	return {
		mode: 'none', // 'none' | 'new' | 'edit'
		id: '', name: '', content: '', keywords: '',
		alwaysActive: false, enabled: true, priority: '50', bookId: '',
	};
}

/** 抽屉初始状态。 */
export function initialState() {
	return {
		// 会话身份（slot inject 工厂注入）—— 列表/创建/认领都按它过滤
		sessionId: null,
		// 视图路由
		view: 'projects', // 'projects' | 'detail' | 'lorebook' | 'settings'
		selected: null,
		// 项目列表
		projects: [], unclaimed: [], loading: true, error: '', notice: '',
		creating: false, busy: false, title: '', genre: 'fantasy',
		// 项目详情
		detail: null, chapterNo: 1, writing: false,
		draft: '', draftVersion: 0,
		polishing: false, polishPreview: null,
		diagnosing: false, report: null,
		// 世界书
		loreEntries: [], loreForm: emptyLoreForm(), loreBusy: false,
		// 导出 / 删除
		exporting: false, deleteState: null,
		// 撤销栈与基线（保存判定依据）
		undoStack: [], baseline: '', draftModified: false,
	};
}
