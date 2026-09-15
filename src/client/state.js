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
		// 列表内联改名 / 删除：rename = {id, value} | null；listDeleteId = 待确认删除的书 id | null
		rename: null, renaming: false, listDeleteId: null,
		// 项目详情
		detail: null, chapterNo: 1, writing: false,
		draft: '', draftVersion: 0,
		// 旁路引擎动作（0.13.0）：'polish' | 'proofread' | null。
		// 两者都是**长任务**（服务端可能重试到几分钟），所以单独一个忙标记，
		// 而不是复用 writing —— 否则「写章中」和「润色中」会互相把按钮按死。
		revising: null,
		// 全书体检（GET /continuity，纯函数零 token）：null = 没查过
		continuity: null, continuityLoading: false, continuityError: '',
		// 批量起草（D2）：表单值 + 忙标记 + 结果
		batchFrom: 1, batchCount: 3, batchConcurrency: 1, batchForce: false,
		batchBusy: false, batchResult: null,
		// 小说基本要素（基本信息标签：档案/大纲/角色卡/设定/账本时间线）
		elements: null, elementsLoading: false,
		// 详情页两个标签：'info'（基本信息）| 'chapters'（章节听书）
		detailTab: 'info',
		chapterList: [], chapterListLoading: false,
		playback: { status: 'idle', currentNo: null },
		// 提案队列（0.7.0）：模型提的修订稿，pending 时等用户点「应用」才生成新版本。
		// 工具面没有 apply（见 lib/proposals.js）——「批准钥匙」在面板这一侧。
		proposals: [], proposalsLoading: false,
		// 正在处理的提案 id（应用/丢弃中，按钮禁用以防重复点）；null = 空闲
		proposalBusy: null,
		// 世界书
		loreEntries: [], loreForm: emptyLoreForm(), loreBusy: false,
		// 导出 / 删除
		exporting: false, deleteState: null,
		// 撤销栈与基线（保存判定依据）
		undoStack: [], baseline: '', draftModified: false,
		// 未保存离开确认：null | {kind:'back'} | {kind:'chapter', no:number}
		discardPending: null,
	};
}
