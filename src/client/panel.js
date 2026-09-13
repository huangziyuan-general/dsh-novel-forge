// src/client/panel.js — 右侧栏「锻炉」面板：控制器（状态 + 业务动作）+ React 组件。
//
// 与 0.4.x 的差别：那时候是一个**自建 root 的全屏抽屉**（position:fixed + display 切换），
// 0.5.0 起交给**右侧栏 slot 框架**渲染 —— 我们只返回 element，不再自己 createRoot，
// 于是「点一次没反应 / 再点一次整屏空白」（createRoot 取错包）那类事故从根上消失。
//
// 分工：
//   views/*        纯渲染，只读 state
//   panel.js       状态流转、事件代理、REST 调用
//   forge-tab.js   把它挂进右侧栏（三步契约）
//
// 交互仍走 `data-action` + 容器级**原生** click 代理 —— 宿主环境里 React 合成事件
// 不可靠（这也是全篇不写 onClick 的原因）；面板容器是 slot 框架画的 DOM，
// 在上面 addEventListener 完全正常。
//
// 「项目跟会话走」：所有列表/创建/认领请求都带 sessionId（来自 slot inject 工厂）。
import { h, Component, useState, useRef, useEffect } from './react.js';
import { initialState, emptyLoreForm } from './state.js';
import { apiFetch } from './api.js';
import { headerStyle, badgeStyle, btnStyle, hintStyle } from './styles.js';
import { ProjectListView } from './views/project-list.js';
import { ProjectDetailView } from './views/project-detail.js';
import { LorebookView } from './views/lorebook.js';
import { SettingsView } from './views/settings.js';

/** 面板容器标记：事件代理的落点，也是测试/诊断的抓手。 */
export const PANEL_ATTR = 'data-dsh-novel-forge-panel';

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
				return h('div', { style: { padding: '16px', color: '#ff8a8a', fontSize: '12.5px', lineHeight: 1.7, whiteSpace: 'pre-wrap' } },
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
 * @param {object} [opts]
 * @param {string|null} [opts.sessionId] 当前会话（slot inject 工厂给的）
 * @param {Function} [opts.onChange] 需要重渲染时的回调
 */
export function createForgeController({ sessionId = null, onChange = () => {} } = {}) {
	const state = initialState();
	state.sessionId = sessionId ?? null;

	const notify = () => {
		try { onChange(); } catch (error) { console.error('[novel-forge] 面板重渲染失败：', error); }
	};

	/** 给请求带上会话 —— 「项目跟会话走」就靠这一处收口。 */
	const withSession = (path) => {
		if (!state.sessionId) return path;
		const sep = path.includes('?') ? '&' : '?';
		return `${path}${sep}session=${encodeURIComponent(state.sessionId)}`;
	};

	// ── 业务动作 ──
	const refreshProjects = async () => {
		state.loading = true; state.error = ''; notify();
		try {
			state.projects = await apiFetch(withSession('/projects'));
		} catch (error) {
			state.error = String(error?.message ?? error);
		} finally {
			state.loading = false; notify();
		}
		// 未归属的旧书（0.5.0 之前建的没有会话戳）：单独拿一份，给个认领入口
		try {
			state.unclaimed = state.sessionId ? await apiFetch('/projects?scope=unclaimed') : [];
		} catch { state.unclaimed = []; }
		notify();
	};

	const claimProject = async (id) => {
		if (!state.sessionId) { state.error = '未能识别当前会话，无法认领'; notify(); return; }
		state.busy = true; notify();
		try {
			await apiFetch('/projects/claim', {
				method: 'POST',
				body: JSON.stringify({ session: state.sessionId, ids: id ? [id] : undefined }),
			});
			state.notice = id ? `已认领：${id}` : '已把未归属的书认领到本会话';
			await refreshProjects();
		} catch (error) { state.error = String(error?.message ?? error); }
		finally { state.busy = false; notify(); }
	};

	const openProject = async (id) => {
		state.selected = id; state.view = 'detail'; state.detail = null; state.chapterNo = 1;
		state.draft = ''; state.report = null; state.error = ''; notify();
		try {
			state.detail = await apiFetch(`/projects/${encodeURIComponent(id)}`);
			const text = await apiFetch(`/projects/${encodeURIComponent(id)}/chapters/1`);
			state.baseline = text ?? ''; state.draft = text ?? ''; state.draftVersion++;
		} catch (error) { state.error = String(error?.message ?? error); }
		notify();
	};

	const loadChapter = async (no) => {
		if (!state.selected) return;
		state.chapterNo = no; state.report = null; state.polishPreview = null; notify();
		try {
			const text = await apiFetch(`/projects/${encodeURIComponent(state.selected)}/chapters/${no}`);
			state.baseline = text ?? ''; state.draft = text ?? ''; state.draftVersion++;
			state.draftModified = false; state.undoStack = [];
		} catch { state.baseline = ''; state.draft = ''; state.draftVersion++; }
		notify();
	};

	const createProject = async () => {
		if (!state.title.trim()) { state.error = '请先输入书名'; notify(); return; }
		state.creating = true; state.error = ''; notify();
		try {
			await apiFetch('/projects', {
				method: 'POST',
				// 创建即打会话戳：面板按会话过滤时它才会出现在本会话里
				body: JSON.stringify({ title: state.title.trim(), genre: state.genre, session: state.sessionId ?? undefined }),
			});
			state.title = ''; await refreshProjects();
		} catch (error) { state.error = String(error?.message ?? error); }
		finally { state.creating = false; notify(); }
	};

	const saveChapter = async () => {
		if (!state.selected) return;
		try {
			await apiFetch(`/projects/${encodeURIComponent(state.selected)}/chapters/${state.chapterNo}`, {
				method: 'POST', body: JSON.stringify({ title: `第 ${state.chapterNo} 章`, text: state.draft }),
			});
			state.notice = `已保存：第 ${state.chapterNo} 章`;
			state.baseline = state.draft; state.draftModified = false; state.undoStack = [];
		} catch (error) { state.error = String(error?.message ?? error); }
		notify();
	};

	const exportProject = async () => {
		if (!state.selected) return;
		state.exporting = true; notify();
		try {
			const result = await apiFetch(`/projects/${encodeURIComponent(state.selected)}/export`, { method: 'POST', body: JSON.stringify({ format: 'txt' }) });
			const blob = new Blob(['\uFEFF' + result.content], { type: 'text/plain;charset=utf-8' });
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url; a.download = result.fileName;
			document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
			state.notice = `已导出：${result.fileName}`;
		} catch (error) { state.error = String(error?.message ?? error); }
		finally { state.exporting = false; notify(); }
	};

	const deleteProject = async () => {
		if (!state.selected) return;
		state.deleteState = 'busy'; notify();
		try {
			await apiFetch(`/projects/${encodeURIComponent(state.selected)}`, { method: 'DELETE' });
			state.selected = null; state.view = 'projects'; state.detail = null;
			await refreshProjects();
		} catch (error) { state.error = String(error?.message ?? error); }
		finally { state.deleteState = null; notify(); }
	};

	const loadLoreEntries = async (bookId) => {
		try { state.loreEntries = await apiFetch(`/worldbook/${encodeURIComponent(bookId)}`); }
		catch { state.loreEntries = []; }
		notify();
	};

	const saveLoreEntry = async () => {
		const f = state.loreForm;
		if (!f.name.trim()) { state.error = '条目名称不能为空'; notify(); return; }
		state.loreBusy = true; notify();
		try {
			const bookId = state.selected || f.bookId || 'default';
			const body = JSON.stringify({
				name: f.name, content: f.content, keywords: f.keywords,
				always_active: f.alwaysActive, enabled: f.enabled, priority: Number(f.priority),
			});
			if (f.mode === 'new') await apiFetch(`/worldbook/${encodeURIComponent(bookId)}`, { method: 'POST', body });
			else if (f.mode === 'edit') await apiFetch(`/worldbook/${encodeURIComponent(bookId)}/${f.id}`, { method: 'PUT', body });
			state.loreForm = emptyLoreForm();
			await loadLoreEntries(bookId);
		} catch (error) { state.error = String(error?.message ?? error); }
		finally { state.loreBusy = false; notify(); }
	};

	const deleteLoreEntry = async (entryId) => {
		const bookId = state.selected || 'default';
		try { await apiFetch(`/worldbook/${encodeURIComponent(bookId)}/${entryId}`, { method: 'DELETE' }); await loadLoreEntries(bookId); }
		catch (error) { state.error = String(error?.message ?? error); notify(); }
	};

	const toggleLoreEntry = async (entryId) => {
		const bookId = state.selected || 'default';
		const entry = state.loreEntries.find((e) => e.id === Number(entryId));
		if (!entry) return;
		try {
			await apiFetch(`/worldbook/${encodeURIComponent(bookId)}/${entryId}`, { method: 'PUT', body: JSON.stringify({ enabled: !entry.enabled }) });
			await loadLoreEntries(bookId);
		} catch (error) { state.error = String(error?.message ?? error); notify(); }
	};

	/** 需要模型参与的动作：面板只给引导，真动作在会话里。 */
	const needsModel = (msg) => { state.error = msg; notify(); };

	const handleAction = async (action, target) => {
		state.error = ''; state.notice = '';
		switch (action) {
			case 'refresh-projects': await refreshProjects(); break;
			case 'create': await createProject(); break;
			case 'open': await openProject(target.dataset.id); break;
			case 'back': state.view = 'projects'; state.selected = null; state.detail = null; await refreshProjects(); break;
			case 'claim': await claimProject(target.dataset.id || null); break;
			case 'goto-lorebook':
				state.view = 'lorebook'; state.selected = target.dataset.id || state.selected;
				await loadLoreEntries(state.selected || 'default'); break;
			case 'back-from-lore':
			case 'back-from-settings': state.view = state.selected ? 'detail' : 'projects'; notify(); break;
			case 'goto-settings': state.view = 'settings'; notify(); break;
			case 'write': needsModel('一键写章需要模型参与，请在会话中调用 novel_write_chapter'); break;
			case 'polish': needsModel('一键润色需要模型参与，请在会话中调用 novel_polish'); break;
			case 'diagnose': needsModel('诊断需要模型参与，请在会话中调用 novel_diagnose'); break;
			case 'import-demo': case 'import-file': needsModel('请在会话中调用 novel_import 导入'); break;
			case 'save': await saveChapter(); break;
			case 'refresh': if (state.selected && state.chapterNo) await loadChapter(state.chapterNo); break;
			case 'export': await exportProject(); break;
			case 'delete':
				if (state.deleteState === 'confirm') await deleteProject();
				else { state.deleteState = 'confirm'; notify(); }
				break;
			case 'lore-new': state.loreForm = { ...emptyLoreForm(), mode: 'new' }; notify(); break;
			case 'lore-edit': {
				const entry = state.loreEntries.find((x) => x.id === Number(target.dataset.id));
				if (entry) {
					state.loreForm = {
						mode: 'edit', id: String(entry.id), name: entry.name, content: entry.content,
						keywords: (entry.keywords || []).join(','), alwaysActive: entry.always_active,
						enabled: entry.enabled, priority: String(entry.priority), bookId: entry.book_id || '',
					};
					notify();
				}
				break;
			}
			case 'lore-save': await saveLoreEntry(); break;
			case 'lore-cancel': state.loreForm = emptyLoreForm(); notify(); break;
			case 'lore-toggle': await toggleLoreEntry(target.dataset.id); break;
			case 'lore-delete': await deleteLoreEntry(target.dataset.id); break;
		}
	};

	// ── 原生事件代理（React 合成事件在宿主环境失效，故走容器级监听） ──
	const onClick = (e) => {
		const actionEl = e.target?.closest?.('[data-action]');
		if (actionEl) { e.preventDefault(); e.stopPropagation(); void handleAction(actionEl.dataset.action, actionEl); }
	};
	const onInput = (e) => {
		const field = e.target?.dataset?.field;
		if (field === 'title') state.title = e.target.value;
		else if (field === 'draft') { state.draft = e.target.value; state.draftModified = e.target.value !== state.baseline; }
		else if (field === 'chapterNo') { const no = Number(e.target.value); if (no > 0) void loadChapter(no); }
		else if (field === 'lore-name') state.loreForm.name = e.target.value;
		else if (field === 'lore-keywords') state.loreForm.keywords = e.target.value;
		else if (field === 'lore-content') state.loreForm.content = e.target.value;
		else if (field === 'lore-priority') state.loreForm.priority = e.target.value;
	};
	const onChangeEvent = (e) => {
		if (e.target?.dataset?.field === 'lore-always') state.loreForm.alwaysActive = e.target.checked;
	};

	let bound = null;
	const attach = (node) => {
		if (!node || bound === node) return;
		detach();
		bound = node;
		node.addEventListener('click', onClick);
		node.addEventListener('input', onInput);
		node.addEventListener('change', onChangeEvent);
	};
	const detach = () => {
		if (!bound) return;
		try {
			bound.removeEventListener('click', onClick);
			bound.removeEventListener('input', onInput);
			bound.removeEventListener('change', onChangeEvent);
		} catch { /* 节点已被框架拆掉 */ }
		bound = null;
	};

	let started = false;
	/** 首次挂载后拉数据（幂等）。 */
	const start = () => {
		if (started) return;
		started = true;
		void refreshProjects();
	};

	/** 会话切换：换 id 并重新拉列表（面板是按会话的账本）。 */
	const setSession = (next) => {
		const id = next ?? null;
		if (state.sessionId === id) return;
		state.sessionId = id;
		state.selected = null; state.detail = null; state.view = 'projects';
		started = true;
		notify();
		void refreshProjects();
	};

	return { state, notify, attach, detach, start, setSession, refreshProjects, handleAction };
}

/**
 * 右侧栏面板组件（slot 框架渲染它）。
 * props.sessionId 由 forge-tab.js 的 inject 工厂注入 —— 会话身份的唯一来源。
 */
export function ForgePanel(props) {
	const sessionId = props?.sessionId ?? null;
	const [, forceTick] = useState(0);
	const controllerRef = useRef(null);
	const nodeRef = useRef(null);

	if (controllerRef.current === null) {
		controllerRef.current = createForgeController({
			sessionId,
			onChange: () => forceTick((n) => n + 1),
		});
	}
	const controller = controllerRef.current;

	// 会话切换（同一个面板实例被复用到别的会话）
	useEffect(() => { controller.setSession(sessionId); }, [sessionId]);

	// 挂载：绑事件代理 + 首次拉数据；卸载：解绑
	useEffect(() => {
		const node = nodeRef.current;
		if (node) controller.attach(node);
		controller.start();
		return () => controller.detach();
	}, []);

	const s = controller.state;
	const view = h('div', {
		[PANEL_ATTR]: '1',
		ref: nodeRef,
		style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, boxSizing: 'border-box' },
	},
		h('div', { style: headerStyle },
			h('span', { style: { fontWeight: 700, fontSize: '14px' } }, '🔨 锻炉'),
			h('span', { style: badgeStyle }, 'v' + (window.__NOVEL_FORGE_VERSION__ || '?')),
			h('span', { style: { ...hintStyle, fontSize: '11px' } },
				s.sessionId ? '本会话项目' : '全部项目'),
			h('button', { 'data-action': 'refresh-projects', style: { ...btnStyle, marginLeft: 'auto' } }, '刷新'),
		),
		h('div', { style: { flex: '1 1 auto', overflowY: 'auto', padding: '12px 12px 16px', minHeight: 0 } },
			s.view === 'projects' ? h(ProjectListView, { state: s }) : null,
			s.view === 'detail' ? h(ProjectDetailView, { state: s }) : null,
			s.view === 'lorebook' ? h(LorebookView, { state: s }) : null,
			s.view === 'settings' ? h(SettingsView) : null,
		),
	);

	return ForgeBoundary ? h(ForgeBoundary, null, view) : view;
}
