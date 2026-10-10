// src/client/controllers/projects.js — 项目域：列表/详情加载、创建认领改名克隆删除、
// 旁路引擎（润色/校对）、全书体检、黄金三章诊断、批量起草。
// 从 panel.js 的 createForgeController 按域拆出。跨域动作（章正文、提案、目录）经 ctx
// 晚绑定调用，避免模块间循环 import。
import { apiFetch } from '../api.js';

export function createProjectsController(ctx) {
	const { state, notify, syncSession, withSession, seq, player } = ctx;

	/** 拉小说基本要素（基本信息标签的展示数据）；缺失要素是常态，失败置空即可。 */
	const loadElements = async (id) => {
		const bookId = id || state.selected;
		if (!bookId) return;
		const mine = seq.open;
		state.elementsLoading = true; notify();
		try {
			const elements = await apiFetch(`/projects/${encodeURIComponent(bookId)}/elements`);
			if (mine !== seq.open) return; // 期间已切书：丢弃陈旧要素
			state.elements = elements;
		} catch { if (mine === seq.open) state.elements = null; }
		finally { if (mine === seq.open) { state.elementsLoading = false; notify(); } }
	};

	/** 拉章节目录（听书列表 + 连播边界）。 */
	const loadChapterList = async (id) => {
		const bookId = id || state.selected;
		if (!bookId) return;
		const mine = seq.open;
		state.chapterListLoading = true; notify();
		try {
			const list = await apiFetch(`/projects/${encodeURIComponent(bookId)}/chapters`);
			if (mine !== seq.open) return; // 期间已切书：丢弃陈旧目录
			state.chapterList = list;
		} catch { if (mine === seq.open) state.chapterList = []; }
		finally { if (mine === seq.open) { state.chapterListLoading = false; notify(); } }
	};

	const refreshProjects = async () => {
		syncSession();
		state.loading = true; state.error = ''; notify();
		// 探针日志：用户卡「加载中」时，console 里有没有这行 + 后面有没有收尾，直接分诊
		console.info('[novel-forge] GET /projects' + (state.sessionId ? `?session=${state.sessionId}` : '（无会话）'));
		try {
			// scope='all' 时不带 session 参数——多会话工作流里别的会话建的书也要能看（头部 chip 可切换）
			const scopedUrl = state.sessionId && state.sessionScope !== 'all' ? withSession('/projects') : '/projects';
			state.projects = await apiFetch(scopedUrl);
			// 回落：会话过滤为空但全量有书 → 显示全部。宿主 slot inject 给的会话
			// 标识与工具写入 novel.json 的 session id 可能不同源（0.13.2 真机实锤：
			// session-watch 用 sessions 服务的 id 能探到书、slot 的 id 过滤却是空），
			// 与其让用户对着「还没有项目」发呆，不如摊开全部书让他点开。
			if (state.projects.length === 0 && state.sessionId) {
				state.projects = await apiFetch('/projects');
				state.sessionFallback = state.projects.length > 0;
			} else {
				state.sessionFallback = false;
			}
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
			if (state.selected === r.id) await ctx.openProject(r.id); // 详情页正开着这本书，回头刷标题
		} catch (error) { state.error = String(error?.message ?? error); }
		finally { state.renaming = false; notify(); }
	};

	/** 克隆为模板：老书连章节带资产复制成新书（REST 走 lib/clone.js 共享核心）。
	 *  新书目录名必填（是稳定身份，同书名规则）；成功后刷新列表，新书带会话戳直接出现。 */
	const cloneProject = async () => {
		const c = state.clone;
		if (!c || !c.id) return;
		const newBook = String(c.value ?? '').trim();
		if (!newBook) { state.error = '新书目名不能为空'; notify(); return; }
		state.cloning = true; state.error = ''; notify();
		try {
			const v = await apiFetch(`/projects/${encodeURIComponent(c.id)}/clone`, {
				method: 'POST', body: JSON.stringify({ newBook, title: newBook, session: state.sessionId ?? undefined }),
			});
			state.notice = v?.next ?? `已克隆：${c.id} → ${newBook}`;
			state.clone = null;
			await refreshProjects();
		} catch (error) { state.error = String(error?.message ?? error); }
		finally { state.cloning = false; notify(); }
	};

	/** 列表删除：软删（服务端清 novel.json 标记非书）。 */
	const deleteListProject = async (id) => {
		// 用独立的 listDeleting，而不是往 listDeleteId 里塞 'busy'：
		// 确认行按 `listDeleteId === p.name` 渲染，哨兵会让整行在请求期间消失（闪烁），
		// 并把视图里「删除中…」的禁用分支变成死代码。
		if (state.listDeleting) return;
		state.listDeleting = true; notify();
		try {
			await apiFetch(`/projects/${encodeURIComponent(id)}`, { method: 'DELETE' });
			state.notice = `已删除：${id}`;
			if (state.selected === id) { state.selected = null; state.detail = null; state.chapterList = []; }
			state.listDeleteId = null;
			await refreshProjects();
		} catch (error) { state.error = String(error?.message ?? error); }
		finally { state.listDeleting = false; notify(); }
	};

	const openProject = async (id) => {
		const myOpen = ++seq.open;
		// 换书必然换章内容：使所有在途 loadChapter 的响应作废（它们的 seq 已过期）
		const myChapter = ++seq.chapter;
		state.selected = id; state.view = 'detail'; state.detail = null; state.chapterNo = 1;
		state.draft = ''; state.error = ''; state.detailTab = 'info';
		state.elements = null; state.discardPending = null; state.rename = null; state.listDeleteId = null; state.clone = null;
		// deleteState 属于「上一本书的删除确认」：漏清会让 B 书的「删除」单击直接生效
		//（两步确认跨书泄漏）。gateNotice/listDeleting 同理，都是上一本书的残留。
		state.deleteState = null; state.gateNotice = null; state.listDeleting = false;
		state.proposals = []; state.proposalsError = null; state.proposalBusy = null; state.proposalDetail = null; // 展开的全文也属于上一本书
		state.copiedHandoff = false; // 交接摘要的「已复制」反馈同样属于上一本书
		state.rotatePending = false; // 轮换的两段确认同样属于上一本书
		// 换书：体检结果与批量结果都属于「上一本书」，必须清掉（否则会把 A 书的红字
		// 挂在 B 书头上——这类串台比不显示更糟）
		state.continuity = null; state.continuityError = ''; state.batchResult = null; state.revising = null;
		state.diagnosis = null; state.diagnosisError = '';
		state.reader = null; // 阅读器也属于「上一本书」
		player.stop();
		notify();
		// detail 与 第 1 章正文并行拉；elements/chapters 由以下并行加载
		try {
			const [detail, text] = await Promise.all([
				apiFetch(withSession(`/projects/${encodeURIComponent(id)}`)),
				apiFetch(`/projects/${encodeURIComponent(id)}/chapters/1`).catch(() => ''),
			]);
			if (myOpen !== seq.open) return; // 期间已打开别的书：整体作废
			state.detail = detail;
			// 章正文只在「期间没有更晚的 loadChapter 抢先」时才写——否则会把第 1 章
			// 内容盖到用户刚点的章上（章号与正文错位）
			if (myChapter === seq.chapter) {
				state.baseline = text ?? ''; state.draft = text ?? '';
				state.draftVersion++; state.draftModified = false; state.undoStack = [];
			}
		} catch (error) { if (myOpen === seq.open) state.error = String(error?.message ?? error); }
		if (myOpen !== seq.open) return; // 失败路径同样不再追拉旧书的目录/要素/提案
		notify();
		await Promise.all([loadChapterList(id), loadElements(id), ctx.loadProposals(id)]);
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
				body: JSON.stringify({ title: state.title.trim(), genre: state.genre.trim() || undefined, session: state.sessionId ?? undefined }),
			});
			state.title = ''; state.titleReset = (state.titleReset ?? 0) + 1; await refreshProjects();
		} catch (error) { state.error = String(error?.message ?? error); }
		finally { state.creating = false; notify(); }
	};

	const deleteProject = async () => {
		if (!state.selected) return;
		state.deleteState = 'busy'; notify();
		try {
			await apiFetch(`/projects/${encodeURIComponent(state.selected)}`, { method: 'DELETE' });
			player.stop();
			state.selected = null; state.view = 'projects'; state.detail = null; state.chapterList = [];
			await refreshProjects();
		} catch (error) {
			state.error = String(error?.message ?? error);
			state.deleteState = 'confirm'; // L17：失败退回确认态，不在按钮上闪一下又消失
		}
		notify();
	};

	/** 真正返回项目列表。 */
	const goBack = async () => {
		player.stop(); state.view = 'projects'; state.selected = null; state.detail = null;
		state.discardPending = null; state.draftModified = false; state.rename = null; state.listDeleteId = null; state.clone = null;
		state.deleteState = null; state.gateNotice = null;
		await refreshProjects();
	};

	/** 全书体检：死人复活 / 账本矛盾 / 伏笔超期 / 章号断档 / 人物卡缺失。零 token。 */
	const loadContinuity = async () => {
		if (!state.selected) return;
		const mine = seq.open;
		state.continuityLoading = true; state.continuityError = ''; notify();
		try {
			const result = await apiFetch(`/projects/${encodeURIComponent(state.selected)}/continuity`);
			if (mine !== seq.open) return; // 期间已切书：丢弃陈旧体检（M12）
			state.continuity = result;
		} catch (error) {
			if (mine !== seq.open) return;
			state.continuity = null;
			state.continuityError = String(error?.message ?? error);
		} finally { if (mine === seq.open) { state.continuityLoading = false; notify(); } }
	};

	/** 黄金三章诊断：钩子/开场/冲突/灌输四维数字。与 novel_diagnose 同一纯函数，零 token。 */
	const loadDiagnosis = async () => {
		if (!state.selected || state.diagnosisLoading) return;
		const mine = seq.open;
		state.diagnosisLoading = true; state.diagnosisError = ''; notify();
		try {
			const result = await apiFetch(`/projects/${encodeURIComponent(state.selected)}/diagnose`);
			if (mine !== seq.open) return; // 期间已切书：丢弃陈旧诊断（M12）
			state.diagnosis = result;
		} catch (error) {
			if (mine !== seq.open) return;
			state.diagnosis = null;
			state.diagnosisError = String(error?.message ?? error);
		} finally { if (mine === seq.open) { state.diagnosisLoading = false; notify(); } }
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
		// 跨书竞态守卫（CodeBuddy 审计 2026-10-09）：润色/校对请求最长可等数分钟，
		// 期间切书后迟到的写回会把 A 书的 notice / 提案队列挂到 B 书头上。
		const bookId = state.selected;
		const chapterNo = state.chapterNo;
		state.revising = mode; state.error = ''; state.notice = ''; notify();
		try {
			const value = await apiFetch(
				`/projects/${encodeURIComponent(bookId)}/chapters/${chapterNo}/${mode}`,
				{
					method: 'POST', timeoutMs: REVISION_TIMEOUT_MS,
					// session = 面板锚定的会话 id：服务端拿它找活的父 agent 起子代理
					// （SubagentStartRequest.parent 必填，缺了宿主直接炸进程——0.13.2 事故）。
					body: JSON.stringify({ session: state.sessionId ?? undefined }),
				},
			);
			if (state.selected !== bookId) return; // 已切书：结果作废
			const what = mode === 'proofread' ? '校对' : '润色';
			const delta = Number(value?.deltaChars ?? 0);
			state.notice = `${what}完成：提案 ${value.proposalId}（${value.chars} 字，改动 ${delta >= 0 ? '+' : ''}${delta}）—— 到「待批准提案」里点应用才生效`;
			await ctx.loadProposals(bookId);
		} catch (error) { if (state.selected === bookId) state.error = revisionErrorText(error, mode); }
		finally { state.revising = null; notify(); }
	};

	// ── 批量起草（D2）──
	//
	// 服务端是**并发生成 + 串行提交**：每章照样过机审/内容门禁/账本/契约指标，
	// 单章被拦不影响其余章。所以失败不是异常，是结果的一部分——摊给用户看，不吞。
	/** 单章写章（0.13.2）：复用批量起草端点——from=当前编辑章、count=1。
	 *  与会话里 novel_write_chapter 同一条 commitChapter 门禁链，直接落盘（版本化，旧稿保留）。
	 *  被拦（细纲缺失/机审不过/熔断）不算异常——结果摊在批量结果区看。 */
	const writeSingleChapter = async () => {
		if (!state.selected || state.batchBusy) return;
		const no = state.chapterNo || 1;
		// 借用批量表单的值通道（表单会同步显示为单章，所见即所跑）
		state.batchFrom = String(no);
		state.batchCount = '1';
		state.batchConcurrency = '1';
		await runBatch();
	};

	const runBatch = async (opts = {}) => {
		if (!state.selected || state.batchBusy) return;
		// 跨书竞态守卫（CodeBuddy 审计 2026-10-09）：批量最长 15 分钟，期间切书后
		// 迟到的写回会把 A 书的结果/notice 挂到 B 书详情页。表单值也在发起时快照——
		// await 之后重读会拿到用户此刻改的值（M15 重载判断就错位了）。
		const bookId = state.selected;
		const batchFrom = Number(state.batchFrom) || 1;
		const batchCount = Number(state.batchCount) || 1;
		state.batchBusy = true; state.error = ''; state.notice = ''; state.batchResult = null; notify();
		try {
			state.batchResult = await apiFetch(`/projects/${encodeURIComponent(bookId)}/draft-batch`, {
				method: 'POST',
				timeoutMs: 900_000,
				body: JSON.stringify({
					from: batchFrom,
					count: batchCount,
					concurrency: Number(state.batchConcurrency) || 1,
					force: state.batchForce === true,
					session: state.sessionId ?? undefined,
					// 断点续跑：参数由服务端从 .novel/batch-checkpoint.json 恢复
					...(opts.resume === true ? { resume: true } : {}),
				}),
			});
			if (state.selected !== bookId) return; // 已切书：结果作废，不污染新书状态
			const st = state.batchResult?.stats ?? {};
			state.notice = `${state.batchResult?.resumed === true ? '断点续跑：' : ''}批量起草完成：落盘 ${st.committed ?? 0} 章，被拦 ${st.failed ?? 0} 章`;
			// 检查点状态同步：全落盘 → done（「继续上次批量」按钮退场），有被拦 → partial
			if (state.detail?.batchCheckpoint) {
				state.detail = { ...state.detail, batchCheckpoint: { ...state.detail.batchCheckpoint, status: (st.failed ?? 0) === 0 ? 'done' : 'partial' } };
			}
			// 新章会改变账本与提案队列；同时体检结果作废（它按章算的）
			await Promise.all([loadChapterList(bookId), ctx.loadProposals(bookId)]);
			if (state.selected !== bookId) return;
			state.continuity = null;
			state.diagnosis = null; // 批量可能覆盖前三章（force 时），诊断同样作废
			// M15 修复：正被编辑的章若在本次批量范围内（且真的落了盘），重拉正文——
			// 否则编辑器里还是旧稿，用户一点「保存」就把旧内容盖回成新版本
			if ((st.committed ?? 0) > 0
				&& state.chapterNo >= batchFrom && state.chapterNo < batchFrom + batchCount) {
				await ctx.loadChapter(state.chapterNo);
				state.notice += `；第 ${state.chapterNo} 章已在编辑器里重载为最新版本`;
			}
		} catch (error) {
			if (state.selected === bookId) {
				const raw = String(error?.message ?? error);
				state.error = /ENGINE_UNAVAILABLE|引擎未就绪/.test(raw)
					? '批量起草需要模型服务：本进程还没有可用的模型路由。'
					: raw;
			}
		} finally { state.batchBusy = false; notify(); }
	};

	// 会话疲劳「创建新会话并交接」（全自动版，用户钦定 2026-10-10）：
	// 交接摘要由服务端直接 prompt 进新会话（点开即写，不手动粘贴）；
	// 归档走 deferArchive——先跳进新会话再补归档，躲开「归档当前会话 → 宿主 clearMain
	// 把人踢回『选择工作区』首页」的竞态（真机实证 2026-10-10）。
	const createSession = async () => {
		if (!state.sessionId) { state.error = '缺会话 id（面板未挂在会话上）——无法创建新会话'; notify(); return; }
		const oldSessionId = state.sessionId;
		const handoff = state.detail?.session?.handoff ?? '';
		const canJump = typeof ctx.openSession === 'function';
		state.busy = true; notify();
		try {
			const value = await apiFetch('/session/create', {
				method: 'POST',
				// book：服务端据此把新会话 cwd 落到书的工作区根 + 顺手认领（面板跳进即见书）；
				// handoff：服务端 prompt 进新会话（能跳才直发——不能跳时用户还得靠剪贴板，
				// 但直发不冲突：queue 模式下消息就在新会话里等着，粘贴只是多一条）；
				// deferArchive：能跳就延迟归档（先跳后归档，躲开 clearMain 竞态）。
				body: JSON.stringify({
					session: oldSessionId,
					book: state.detail?.id ?? '',
					bookTitle: state.detail?.title ?? '',
					...(handoff ? { handoff } : {}),
					...(canJump ? { deferArchive: true } : {}),
				}),
			});
			// 剪贴板兜底保留：prompt 直发失败时（promptError）用户仍能手动粘贴
			if (handoff && !value.prompted && typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
				navigator.clipboard.writeText(handoff).then(() => { state.copiedHandoff = true; notify(); }).catch(() => { /* 剪贴板不可用时交接摘要仍在横幅可手复制 */ });
			}
			const archive = canJump
				? '' // 跳转后补归档，结果到那时才知道
				: (value.archived
					? '旧会话已归档'
					: (value.archiveError ? `旧会话归档失败：${value.archiveError}` : '旧会话可在会话列表手动归档'));
			const registered = value.accounted === true || value.inserted;
			const place = registered
				? (value.inserted ? '已插到原会话旁边' : '已登记进工作区列表')
				: (value.insertError || value.attachError
					? `，但登记到工作区列表失败：${value.insertError ?? value.attachError}`
					: '，且未登记进工作区列表（宿主未暴露工作区面）——到会话列表按名字找');
			const named = value.title ?? (value.renamed ? '（已创建，名未取得）' : '（未命名）');
			const claim = value.claimed ? '，已认领这本书' : (value.claimError ? `，认领失败：${value.claimError}` : '');
			const delivery = value.prompted
				? '交接摘要已自动发进新会话——它正在开写'
				: (value.promptError ? `摘要直发失败（${value.promptError}），已复制到剪贴板——打开新会话粘贴即续写` : '打开它粘贴交接摘要即续写');
			state.notice = value.createdSessionId
				? `新会话「${named}」已创建${value.workspaceMatched ? '，落在原会话的工作区' : ''}${claim}${place}${value.accounted === false ? '；侧栏暂未登记（可刷新页面或到全部会话找）' : ''}——${delivery}${archive ? `；${archive}` : ''}`
				: '新会话已创建但未取得 id——请到会话列表查看';
			// 先 notify 渲染反馈再延迟跳转：openSession 一调用面板就卸载了，
			// 同步赋 notice 来不及渲染——用户看到「没反应」（真机 2026-10-09）。
			if (value.createdSessionId && canJump) {
				notify();
				const newId = value.createdSessionId;
				const archiveOld = () => apiFetch('/session/archive', { method: 'POST', body: JSON.stringify({ session: oldSessionId }) })
					.catch((error) => console.warn('[novel-forge] 旧会话延迟归档失败（可在会话列表手动归档）：', error?.message ?? error));
				// 归档时机不猜时间猜状态（CodeBuddy 审查 2026-10-10）：openSession 同步返回、
				// 异步完成导航——固定 60ms 在慢渲染下会「归档先到、main 还是旧会话」，
				// clearMain 照样踢人。轮询 syncSession（读宿主 sessions.list 的 current）
				// 等 main 真的切到新会话再归档，上限 ~4s；openSession 抛错则立即归档
				//（退化为旧行为：被踢到首页也能从列表进新会话）。面板卸载不影响归档
				// fetch（模块级请求）；超时也归档——旧会话总要收掉，用户在首页找得到新会话。
				let tries = 0;
				const waitMainThenArchive = () => {
					try { ctx.syncSession(); } catch { /* 会话面缺失：按超时路径走 */ }
					if (state.sessionId === newId || tries >= 40) { archiveOld(); return; }
					tries += 1;
					setTimeout(waitMainThenArchive, 100);
				};
				setTimeout(() => {
					try {
						ctx.openSession(newId);
						waitMainThenArchive();
					} catch { archiveOld(); }
				}, 60);
			}
		} catch (error) { state.error = String(error?.message ?? error); }
		finally { state.busy = false; notify(); }
	};
	// 会话疲劳一键轮换（真发请求在第二击，armed 判定在 events 控制器）：
	// POST /session/rotate 由服务端探测宿主能力——探测不到返回 501，错误原文直接给面板。
	const rotateSession = async () => {
		if (!state.sessionId) { state.error = '缺会话 id（面板未挂在会话上）——无法轮换'; notify(); return; }
		state.busy = true; notify();
		try {
			const value = await apiFetch('/session/rotate', {
				method: 'POST', body: JSON.stringify({ session: state.sessionId }),
			});
			state.rotatePending = false;
			state.notice = value.archived
				? '已开新会话并归档旧会话——到会话列表打开新会话，点「复制交接摘要」粘一句即可续写'
				: `新会话已创建，但旧会话归档失败${value.archiveError ? `：${value.archiveError}` : ''}——可在会话列表手动归档`;
		} catch (error) { state.error = String(error?.message ?? error); }
		finally { state.busy = false; notify(); }
	};
	return {
		loadElements, loadChapterList, refreshProjects, claimProject, renameProject, cloneProject,
		deleteListProject, openProject, createProject, deleteProject, goBack, rotateSession, createSession,
		loadContinuity, loadDiagnosis, runRevision, writeSingleChapter, runBatch,
	};
}