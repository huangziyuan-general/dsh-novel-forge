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

	// ── 陈旧响应守卫（请求序号）──
	// openProject / loadChapter 都是「await 完成后写 state」：快速连续切换时，
	// 慢响应后到会把新状态覆盖成旧内容（编辑器显示别章正文；此时点保存，
	// saveChapter 会把 A 章内容 POST 到现行 chapterNo —— 写错章）。每次发起
	// 切换自增序号，响应落地前比对，过期即弃。
	let openSeq = 0;     // 项目级：openProject / 目录、要素、提案加载
	let chapterSeq = 0;  // 章级：章正文（baseline/draft）写入

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

	/** 拉小说基本要素（基本信息标签的展示数据）；缺失要素是常态，失败置空即可。 */
	const loadElements = async (id) => {
		const bookId = id || state.selected;
		if (!bookId) return;
		const seq = openSeq;
		state.elementsLoading = true; notify();
		try {
			const elements = await apiFetch(`/projects/${encodeURIComponent(bookId)}/elements`);
			if (seq !== openSeq) return; // 期间已切书：丢弃陈旧要素
			state.elements = elements;
		} catch { if (seq === openSeq) state.elements = null; }
		finally { if (seq === openSeq) { state.elementsLoading = false; notify(); } }
	};

	/** 拉章节目录（听书列表 + 连播边界）。 */
	const loadChapterList = async (id) => {
		const bookId = id || state.selected;
		if (!bookId) return;
		const seq = openSeq;
		state.chapterListLoading = true; notify();
		try {
			const list = await apiFetch(`/projects/${encodeURIComponent(bookId)}/chapters`);
			if (seq !== openSeq) return; // 期间已切书：丢弃陈旧目录
			state.chapterList = list;
		} catch { if (seq === openSeq) state.chapterList = []; }
		finally { if (seq === openSeq) { state.chapterListLoading = false; notify(); } }
	};

	// ── 业务动作 ──
	const refreshProjects = async () => {
		state.loading = true; state.error = ''; notify();
		// 探针日志：用户卡「加载中」时，console 里有没有这行 + 后面有没有收尾，直接分诊
		console.info('[novel-forge] GET /projects' + (state.sessionId ? `?session=${state.sessionId}` : '（无会话）'));
		try {
			state.projects = await apiFetch(withSession('/projects'));
		} catch (error) {
			state.error = String(error?.message ?? error);
			console.warn('[novel-forge] 项目列表加载失败：', state.error);
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

	/** 改名：只改 novel.json.title（目录名=id 是稳定身份，不挪），改完刷新列表并同步正在看的书。 */
	const renameProject = async () => {
		const r = state.rename;
		if (!r || !r.id) return;
		const title = String(r.value ?? '').trim();
		if (!title) { state.error = '书名不能为空'; notify(); return; }
		state.renaming = true; state.error = ''; notify();
		try {
			await apiFetch(`/projects/${encodeURIComponent(r.id)}/rename`, {
				method: 'POST', body: JSON.stringify({ title }),
			});
			state.notice = `已改名：${title}`;
			state.rename = null;
			await refreshProjects();
			if (state.selected === r.id) await openProject(r.id); // 详情页正开着这本书，回头刷标题
		} catch (error) { state.error = String(error?.message ?? error); }
		finally { state.renaming = false; notify(); }
	};

	/** 列表删除：软删（服务端清 novel.json 标记非书）。 */
	const deleteListProject = async (id) => {
		state.listDeleteId = 'busy'; notify();
		try {
			await apiFetch(`/projects/${encodeURIComponent(id)}`, { method: 'DELETE' });
			state.notice = `已删除：${id}`;
			if (state.selected === id) { state.selected = null; state.detail = null; state.chapterList = []; }
			state.listDeleteId = null;
			await refreshProjects();
		} catch (error) { state.error = String(error?.message ?? error); }
		finally { state.listDeleteId = null; notify(); }
	};

	const openProject = async (id) => {
		const seq = ++openSeq;
		// 换书必然换章内容：使所有在途 loadChapter 的响应作废（它们的 seq 已过期）
		const cseq = ++chapterSeq;
		state.selected = id; state.view = 'detail'; state.detail = null; state.chapterNo = 1;
		state.draft = ''; state.error = ''; state.detailTab = 'info';
		state.elements = null; state.discardPending = null; state.rename = null; state.listDeleteId = null;
		state.proposals = []; state.proposalBusy = null;
		// 换书：体检结果与批量结果都属于「上一本书」，必须清掉（否则会把 A 书的红字
		// 挂在 B 书头上——这类串台比不显示更糟）
		state.continuity = null; state.continuityError = ''; state.batchResult = null; state.revising = null;
		state.reader = null; // 阅读器也属于「上一本书」
		player.stop();
		notify();
		// detail 与 第 1 章正文并行拉；elements/chapters 由以下并行加载
		try {
			const [detail, text] = await Promise.all([
				apiFetch(`/projects/${encodeURIComponent(id)}`),
				apiFetch(`/projects/${encodeURIComponent(id)}/chapters/1`).catch(() => ''),
			]);
			if (seq !== openSeq) return; // 期间已打开别的书：整体作废
			state.detail = detail;
			// 章正文只在「期间没有更晚的 loadChapter 抢先」时才写——否则会把第 1 章
			// 内容盖到用户刚点的章上（章号与正文错位）
			if (cseq === chapterSeq) {
				state.baseline = text ?? ''; state.draft = text ?? '';
				state.draftVersion++; state.draftModified = false; state.undoStack = [];
			}
		} catch (error) { if (seq === openSeq) state.error = String(error?.message ?? error); }
		if (seq !== openSeq) return; // 失败路径同样不再追拉旧书的目录/要素/提案
		notify();
		await Promise.all([loadChapterList(id), loadElements(id), loadProposals(id)]);
	};

	const loadChapter = async (no) => {
		if (!state.selected) return;
		const seq = ++chapterSeq;
		state.chapterNo = no; state.discardPending = null; notify();
		try {
			const text = await apiFetch(`/projects/${encodeURIComponent(state.selected)}/chapters/${no}`);
			if (seq !== chapterSeq) return; // 期间已切章/切书：丢弃陈旧正文
			state.baseline = text ?? ''; state.draft = text ?? ''; state.draftVersion++;
			state.draftModified = false; state.undoStack = [];
		} catch {
			if (seq !== chapterSeq) return; // 陈旧失败的报错也不许覆盖新章
			// 读不到正文不能静默——给一句人话，别让用户以为这一章是空的
			state.baseline = ''; state.draft = ''; state.draftVersion++;
			state.error = `读取第 ${no} 章失败（刷新或检查服务）`;
			console.warn('[novel-forge] 读取章节失败', state.error);
		}
		notify();
	};

	// ── 提案队列（0.7.0 · 融合第一批 A1）──
	//
	// 模型只能 novel_propose（登记提案），**工具面没有 apply**（见 lib/proposals.js）。
	// 「应用」这个批准动作因此只能从这里发起 —— 批准钥匙在用户手里是工具层保证的。

	/** 拉提案队列（待批准的修订稿）。 */
	const loadProposals = async (id) => {
		const bookId = id || state.selected;
		if (!bookId) return;
		const seq = openSeq;
		state.proposalsLoading = true; notify();
		try {
			const value = await apiFetch(`/projects/${encodeURIComponent(bookId)}/proposals`);
			if (seq !== openSeq) return; // 期间已切书：丢弃陈旧提案队列
			state.proposals = Array.isArray(value?.proposals) ? value.proposals : [];
		} catch { if (seq === openSeq) state.proposals = []; }
		finally { if (seq === openSeq) { state.proposalsLoading = false; notify(); } }
	};

	/** 应用提案：生成新版本（旧版保留），审计 actor 记 'user'。 */
	const applyProposalAction = async (proposalId) => {
		if (!state.selected || !proposalId) return;
		state.proposalBusy = proposalId; state.error = ''; notify();
		try {
			const value = await apiFetch(`/projects/${encodeURIComponent(state.selected)}/proposals/${encodeURIComponent(proposalId)}/apply`, { method: 'POST' });
			state.notice = `已应用提案 ${proposalId}：第${value.chapter}章 v${value.version}（旧版保留）`;
			await Promise.all([loadProposals(state.selected), loadChapterList(state.selected)]);
			// 正开着被改的那一章就刷新正文，让用户立刻看到新版本
			if (state.chapterNo === value.chapter) await loadChapter(value.chapter);
		} catch (error) { state.error = String(error?.message ?? error); }
		finally { state.proposalBusy = null; notify(); }
	};

	/** 丢弃提案：正文不动，提案转 discarded（同样只从面板触发）。 */
	const discardProposalAction = async (proposalId) => {
		if (!state.selected || !proposalId) return;
		state.proposalBusy = proposalId; state.error = ''; notify();
		try {
			await apiFetch(`/projects/${encodeURIComponent(state.selected)}/proposals/${encodeURIComponent(proposalId)}/discard`, { method: 'POST' });
			state.notice = `已丢弃提案 ${proposalId}`;
			await loadProposals(state.selected);
		} catch (error) { state.error = String(error?.message ?? error); }
		finally { state.proposalBusy = null; notify(); }
	};

	// ── 旁路引擎动作（0.13.0 · 融合第五批 D1）────────────────────────────────
	//
	// 润色/校对走服务端的 /polish 与 /proofread：**引擎在服务端**（插件已拿到 ctx.llm），
	// 所以面板侧不需要任何 key。两条纪律：
	//   ① 产物是**提案** —— 面板只发起、只提示「去哪里批准」，绝不直接落正文；
	//   ② 超时要放宽：服务端通道超时 180s 且默认重试 2 次，用通用的 12s 会把
	//      正常的长任务一律误报成「请求超时」。
	const REVISION_TIMEOUT_MS = 600_000;

	/** 把服务端的语义化错误码翻成人话（503/409/422/499 各有各的处置办法）。 */
	const revisionErrorText = (error, mode) => {
		const raw = String(error?.message ?? error);
		const what = mode === 'proofread' ? '校对' : '润色';
		if (/ENGINE_UNAVAILABLE|引擎未就绪/.test(raw)) return `${what}需要模型服务：本进程还没有可用的模型路由，先在会话里正常对话一次再试。`;
		if (/NO_ROUTE/.test(raw)) return `${what}通道没有可用路由：检查插件配置里的 engine.channels.${mode}。`;
		if (/GUARD_BLOCKED|守卫/.test(raw)) return `${what}结果被守卫拦下（改动过大或与原文偏离太多），已丢弃——正文没动。`;
		if (/ABORTED/.test(raw)) return `${what}被中止。`;
		return raw;
	};

	const runRevision = async (mode) => {
		if (!state.selected || state.revising) return;
		state.revising = mode; state.error = ''; state.notice = ''; notify();
		try {
			const value = await apiFetch(
				`/projects/${encodeURIComponent(state.selected)}/chapters/${state.chapterNo}/${mode}`,
				{ method: 'POST', timeoutMs: REVISION_TIMEOUT_MS },
			);
			const what = mode === 'proofread' ? '校对' : '润色';
			const delta = Number(value?.deltaChars ?? 0);
			state.notice = `${what}完成：提案 ${value.proposalId}（${value.chars} 字，改动 ${delta >= 0 ? '+' : ''}${delta}）—— 到「待批准提案」里点应用才生效`;
			await loadProposals(state.selected);
		} catch (error) { state.error = revisionErrorText(error, mode); }
		finally { state.revising = null; notify(); }
	};

	/** 全书体检：死人复活 / 账本矛盾 / 伏笔超期 / 章号断档 / 人物卡缺失。零 token。 */
	const loadContinuity = async () => {
		if (!state.selected) return;
		state.continuityLoading = true; state.continuityError = ''; notify();
		try {
			state.continuity = await apiFetch(`/projects/${encodeURIComponent(state.selected)}/continuity`);
		} catch (error) {
			state.continuity = null;
			state.continuityError = String(error?.message ?? error);
		} finally { state.continuityLoading = false; notify(); }
	};

	// ── 批量起草（D2）──
	//
	// 服务端是**并发生成 + 串行提交**：每章照样过机审/内容门禁/账本/契约指标，
	// 单章被拦不影响其余章。所以失败不是异常，是结果的一部分——摊给用户看，不吞。
	const runBatch = async () => {
		if (!state.selected || state.batchBusy) return;
		state.batchBusy = true; state.error = ''; state.notice = ''; state.batchResult = null; notify();
		try {
			state.batchResult = await apiFetch(`/projects/${encodeURIComponent(state.selected)}/draft-batch`, {
				method: 'POST',
				timeoutMs: 900_000,
				body: JSON.stringify({
					from: Number(state.batchFrom) || 1,
					count: Number(state.batchCount) || 1,
					concurrency: Number(state.batchConcurrency) || 1,
					force: state.batchForce === true,
				}),
			});
			const st = state.batchResult?.stats ?? {};
			state.notice = `批量起草完成：落盘 ${st.committed ?? 0} 章，被拦 ${st.failed ?? 0} 章`;
			// 新章会改变账本与提案队列；同时体检结果作废（它按章算的）
			await Promise.all([loadChapterList(state.selected), loadProposals(state.selected)]);
			state.continuity = null;
		} catch (error) {
			const raw = String(error?.message ?? error);
			state.error = /ENGINE_UNAVAILABLE|引擎未就绪/.test(raw)
				? '批量起草需要模型服务：本进程还没有可用的模型路由。'
				: raw;
		} finally { state.batchBusy = false; notify(); }
	};

	const createProject = async () => {
		if (!state.title.trim()) { state.error = '请先输入书名'; notify(); return; }
		state.creating = true; state.error = ''; notify();
		try {
			await apiFetch('/projects', {
				method: 'POST',
				// 创建即打会话戳：面板按会话过滤时它才会出现在本会话里
				// 题材：面板没有题材输入框，留空就不传（服务端默认「未分类」），
				// 别再学早期把 'fantasy' 写死在默认值里（书卡上全是英文 chip 的来历）。
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
			player.stop();
			state.selected = null; state.view = 'projects'; state.detail = null; state.chapterList = [];
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

	/** 有未保存改动时，把「离开意图」挂起，由视图里的 丢弃改动/取消 二选一。 */
	const intentLeave = (pending) => {
		if (state.draftModified) { state.discardPending = pending; notify(); return false; }
		return true;
	};

	/** 真正返回项目列表。 */
	const goBack = async () => {
		player.stop(); state.view = 'projects'; state.selected = null; state.detail = null;
		state.discardPending = null; state.draftModified = false; state.rename = null; state.listDeleteId = null;
		await refreshProjects();
	};

	const handleAction = async (action, target) => {
		state.error = ''; state.notice = '';
		switch (action) {
			case 'refresh-projects': await refreshProjects(); break;
			case 'create': await createProject(); break;
			case 'open': await openProject(target.dataset.id); break;
			case 'rename-open': {
				const id = target.dataset.id;
				const p = state.projects.find((x) => x.name === id) || state.unclaimed.find((x) => x.name === id);
				state.rename = { id, value: p?.title || p?.name || '' };
				state.listDeleteId = null; notify(); break;
			}
			case 'rename-confirm': await renameProject(); break;
			case 'rename-cancel': state.rename = null; notify(); break;
			case 'list-delete':
				if (state.listDeleteId === target.dataset.id) await deleteListProject(target.dataset.id);
				else { state.listDeleteId = target.dataset.id; state.rename = null; notify(); }
				break;
			case 'list-delete-cancel': state.listDeleteId = null; notify(); break;
			case 'back':
				if (!intentLeave({ kind: 'back' })) break;
				await goBack(); break;
			case 'claim': await claimProject(target.dataset.id || null); break;
			// 详情页两个标签：基本信息 / 章节听书
			case 'detail-tab': {
				const tab = target.dataset.tab === 'chapters' ? 'chapters' : 'info';
				if (state.detailTab !== tab) state.detailTab = tab;
				if (tab === 'chapters') await loadChapterList();
				notify(); break;
			}
			case 'play-from': {
				state.detailTab = 'chapters';
				// 章号走 data-id（视图是 `Btn({ id: c.no })`，Btn 把 id 写成 data-id）。
				// ⚠️ 曾经这里读的是 `dataset.no` —— 而全项目**没有任何地方写过 data-no**，
				// 于是 Number(undefined) = NaN 一路传进播放器：synth.cancel → status=playing
				// → loadChapter(NaN) 取不到正文 → nextChapterAfter(NaN) 也找不到下一章 → finish 回 idle。
				// 前后两次 emit 把状态**还原成原样**，界面于是"点了毫无反应"——
				// 整列「▶」和顶部「从第 N 章开始听」全是死的（0.13.0 真实故障）。
				const no = Number(target.dataset.id);
				if (!Number.isFinite(no) || no <= 0) {
					state.error = `拿不到要播的章号（播放钮上应有 data-id，实际是 "${target.dataset.id ?? ''}"）`;
					notify();
					break;
				}
				try { await player.playFrom(no); }
				catch (error) { state.error = String(error?.message ?? error); notify(); }
				break;
			}
			case 'read-chapter': {
				// 阅读器：取单章正文展开在目录上方。与播放互相独立（可以边听边看）。
				// 章号同样只认 data-id —— 理由见 play-from 里的注释（字段名对不上＝点了没反应）。
				state.detailTab = 'chapters';
				const no = Number(target.dataset.id);
				if (!Number.isFinite(no) || no <= 0) {
					state.error = `拿不到要读的章号（阅读钮上应有 data-id，实际是 "${target.dataset.id ?? ''}"）`;
					notify();
					break;
				}
				const meta = state.chapterList.find((c) => c.no === no);
				state.reader = { no, title: meta?.title ?? `第 ${no} 章`, text: '', loading: true };
				notify();
				try {
					const text = await apiFetch(`/projects/${encodeURIComponent(state.selected)}/chapters/${no}`);
					// 请求期间用户可能已点了另一章的 📖 —— 只更新仍是同一章的 reader
					if (state.reader?.no === no) {
						state.reader = { no, title: meta?.title ?? `第 ${no} 章`, text: String(text ?? ''), loading: false };
					}
				} catch (error) {
					if (state.reader?.no === no) state.reader = null;
					state.error = `读不出第 ${no} 章正文：${String(error?.message ?? error)}`;
				}
				notify();
				break;
			}
			case 'close-reader': state.reader = null; notify(); break;
			case 'playback-pause': player.pause(); notify(); break;
			case 'playback-resume': player.resume(); notify(); break;
			case 'playback-stop': player.stop(); notify(); break;
			case 'goto-lorebook':
				state.view = 'lorebook'; state.selected = target.dataset.id || state.selected;
				await loadLoreEntries(state.selected || 'default'); break;
			case 'back-from-lore':
			case 'back-from-settings': state.view = state.selected ? 'detail' : 'projects'; notify(); break;
			case 'goto-settings': state.view = 'settings'; notify(); break;
			case 'write': needsModel('一键写章要拼上下文包并走落盘门禁，只能在会话里做 —— 让 AI 调 novel_write_chapter，或直接说「写第 N 章」。'); break;
			case 'polish': await runRevision('polish'); break;
			case 'proofread': await runRevision('proofread'); break;
			case 'continuity': await loadContinuity(); break;
			case 'draft-batch': await runBatch(); break;
			case 'diagnose': needsModel('结构诊断需要模型判断，请在会话里调 novel_diagnose 或 novel_audit（诊断结果会落到审计里）。'); break;
			case 'import-demo': case 'import-file': needsModel('请在会话中调用 novel_import 导入'); break;
			case 'save': await saveChapter(); break;
			case 'refresh': if (state.selected && state.chapterNo) await loadChapter(state.chapterNo); break;
			// 提案：应用 / 丢弃都是**用户主权动作**（工具面刻意不提供，见 lib/proposals.js）
			case 'proposal-apply': await applyProposalAction(target.dataset.id); break;
			case 'proposal-discard': await discardProposalAction(target.dataset.id); break;
			case 'export': await exportProject(); break;
			case 'delete':
				if (state.deleteState === 'confirm') await deleteProject();
				else { state.deleteState = 'confirm'; notify(); }
				break;
			case 'delete-cancel': state.deleteState = null; notify(); break;
			// 未保存改动：确认丢弃后才真正离开 / 换章；取消则留在原地
			case 'discard-confirm': {
				const pending = state.discardPending;
				state.discardPending = null; state.draftModified = false;
				if (pending?.kind === 'back') await goBack();
				else if (pending?.kind === 'chapter') await loadChapter(pending.no);
				else notify();
				break;
			}
			case 'discard-cancel': state.discardPending = null; notify(); break;
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
		if (field === 'title') { state.title = e.target.value; notify(); }
		else if (field === 'draft') { state.draft = e.target.value; state.draftModified = e.target.value !== state.baseline; }
		else if (field === 'rename-value') { if (state.rename) state.rename.value = e.target.value; }
		else if (field === 'chapterNo') {
			const no = Number(e.target.value);
			if (no > 0) {
				// 有未保存草稿时换章会丢内容——先确认再切
				if (state.draftModified) { state.discardPending = { kind: 'chapter', no }; notify(); }
				else void loadChapter(no);
			}
		}
		else if (field === 'lore-name') state.loreForm.name = e.target.value;
		else if (field === 'lore-keywords') state.loreForm.keywords = e.target.value;
		else if (field === 'lore-content') state.loreForm.content = e.target.value;
		else if (field === 'lore-priority') state.loreForm.priority = e.target.value;
		// 批量起草表单：留成受控值，但只在提交时才校验（边输边报错太吵）
		else if (field === 'batch-from') state.batchFrom = e.target.value;
		else if (field === 'batch-count') state.batchCount = e.target.value;
		else if (field === 'batch-concurrency') state.batchConcurrency = e.target.value;
		else if (field === 'batch-force') state.batchForce = e.target.checked === true;
	};
	const onChangeEvent = (e) => {
		const field = e.target?.dataset?.field;
		if (field === 'lore-always') state.loreForm.alwaysActive = e.target.checked;
		else if (field === 'batch-concurrency') state.batchConcurrency = e.target.value;
		else if (field === 'batch-force') state.batchForce = e.target.checked === true;
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
		player.stop();
		state.selected = null; state.detail = null; state.view = 'projects'; state.chapterList = [];
		state.rename = null; state.listDeleteId = null;
		started = true;
		notify();
		void refreshProjects();
	};

	return { state, notify, attach, detach, start, setSession, refreshProjects, handleAction, loadProposals,
		stopPlayback: () => player.stop() };
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

	// 挂载：注入交互态样式表 + 绑事件代理 + 首次拉数据；卸载：停播 + 解绑
	//（面板被宿主拆掉时朗读必须跟着停 —— 否则 tab 关了还在出声）
	useEffect(() => {
		// 只注入、不回收：样式表是**全局单例**（宿主会反复装配，必须查到就收养）。
		// 放在挂载里而不是 apply()：面板没渲染时不该往宿主页面塞样式。
		ensureStyles();
		const node = nodeRef.current;
		if (node) controller.attach(node);
		controller.start();
		return () => { controller.stopPlayback(); controller.detach(); };
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
			h('span', {
				style: { ...chip({ tone: s.sessionId ? 'accent' : 'neutral' }), alignSelf: 'flex-start' },
			}, s.sessionId ? '本会话' : '全部项目'),
			// 设置入口常驻在头部：详情页/世界书页都够不到列表页那个按钮，
			// 用户想看一眼「面板到底能做什么」时不该先退回列表
			h('button', {
				'data-action': 'goto-settings',
				// 走按钮皮肤：底/描边/字色交给 css.js，这样它有悬停与按下反馈
				'data-nf-btn': '1', 'data-variant': 'secondary',
				title: '设置 · 能力清单',
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
