// src/client/controllers/events.js — 动作分发（handleAction）+ 原生事件代理。
// 从 panel.js 的 createForgeController 拆出：视图发 `data-action`，这里统一路由到各域动作。
// 跨域动作经 ctx 晚绑定调用（装配完成后回填），因此拆分不引入模块循环 import。
import { apiFetch } from '../api.js';
import { sameEntryId } from '../../../lib/store.js';
import { emptyLoreForm } from '../state.js';

export function createEventsController(ctx) {
	const { state, notify, syncSession, player } = ctx;

	/** 需要模型参与的动作：面板只给引导，真动作在会话里。 */
	const needsModel = (msg) => { state.error = msg; notify(); };

	/** 有未保存改动时，把「离开意图」挂起，由视图里的 丢弃改动/取消 二选一。 */
	const intentLeave = (pending) => {
		if (state.draftModified) { state.discardPending = pending; notify(); return false; }
		return true;
	};

	const handleAction = async (action, target) => {
		syncSession();   // 所有带会话戳的动作（润色/校对/写章/认领/创建）先对齐真会话 id
		state.error = ''; state.notice = '';
		switch (action) {
			case 'reload-proposals': state.proposalsError = null; await ctx.loadProposals(state.selected); break;
			case 'refresh-projects': await ctx.refreshProjects(); break;
			case 'toggle-scope':
				if (!state.sessionId) break; // 无会话标识时本来就是全量，无可切换
				state.sessionScope = state.sessionScope === 'all' ? 'session' : 'all';
				await ctx.refreshProjects();
				break;
			case 'create': await ctx.createProject(); break;
			case 'open': await ctx.openProject(target.dataset.id); break;
			case 'rename-open': {
				const id = target.dataset.id;
				const p = state.projects.find((x) => x.name === id) || state.unclaimed.find((x) => x.name === id);
				state.rename = { id, value: p?.title || p?.name || '' };
				state.listDeleteId = null; notify(); break;
			}
			case 'rename-confirm': await ctx.renameProject(); break;
			case 'rename-cancel': state.rename = null; notify(); break;
			// 克隆为模板：与改名同款内联表单（clone = {id, value}）。互斥——开一个关另一个
			case 'clone-open': {
				const id = target.dataset.id;
				if (!id) { state.error = '拿不到要克隆的书（按钮上应有 data-id）'; notify(); break; }
				state.clone = { id, value: '' };
				state.rename = null; state.listDeleteId = null; notify(); break;
			}
			case 'clone-confirm': await ctx.cloneProject(); break;
			case 'clone-cancel': state.clone = null; notify(); break;
			case 'list-delete':
				if (state.listDeleteId === target.dataset.id) await ctx.deleteListProject(target.dataset.id);
				else { state.listDeleteId = target.dataset.id; state.rename = null; notify(); }
				break;
			case 'list-delete-cancel': state.listDeleteId = null; notify(); break;
			case 'back':
				if (!intentLeave({ kind: 'back' })) break;
				await ctx.goBack(); break;
			case 'claim': await ctx.claimProject(target.dataset.id || null); break;
			// 详情页两个标签：基本信息 / 章节听书
			case 'detail-tab': {
				const tab = target.dataset.tab === 'chapters' ? 'chapters' : 'info';
				if (state.detailTab !== tab) state.detailTab = tab;
				if (tab === 'chapters') await ctx.loadChapterList();
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
				await ctx.loadLoreEntries(state.selected || 'default'); break;
			case 'back-from-lore':
			case 'back-from-settings': state.view = state.selected ? 'detail' : 'projects'; notify(); break;
			case 'goto-settings': state.view = 'settings'; notify(); break;
			case 'write': await ctx.writeSingleChapter(); break;
			case 'polish': await ctx.runRevision('polish'); break;
			case 'proofread': await ctx.runRevision('proofread'); break;
			case 'continuity': await ctx.loadContinuity(); break;
			case 'draft-batch': await ctx.runBatch(); break;
			case 'diagnose': await ctx.loadDiagnosis(); break;
			case 'import-demo': case 'import-file': needsModel('请在会话中调用 novel_import 导入'); break;
			case 'save': await ctx.saveChapter(); break;
			// M14 修复：刷新会重拉当前章、覆盖编辑器——有未保存改动时走同一套
			// 「确认丢弃」流程（与切章一致），不再静默把草稿冲掉
			case 'refresh':
				if (state.selected && state.chapterNo) {
					if (state.draftModified) { state.discardPending = { kind: 'chapter', no: state.chapterNo }; notify(); }
					else await ctx.loadChapter(state.chapterNo);
				}
				break;
			// 提案：应用 / 丢弃都是**用户主权动作**（工具面刻意不提供，见 lib/proposals.js）
			case 'proposal-view': await ctx.toggleProposalDetail(target.dataset.id); break;
			case 'proposal-apply': await ctx.applyProposalAction(target.dataset.id); break;
			case 'proposal-discard': await ctx.discardProposalAction(target.dataset.id); break;
			case 'export': await ctx.exportProject(); break;
			case 'delete':
				if (state.deleteState === 'busy') break; // L17：删除进行中，重复点无效
				if (state.deleteState === 'confirm') await ctx.deleteProject();
				else { state.deleteState = 'confirm'; notify(); }
				break;
			case 'delete-cancel': state.deleteState = null; notify(); break;
			// 未保存改动：确认丢弃后才真正离开 / 换章；取消则留在原地
			case 'discard-confirm': {
				const pending = state.discardPending;
				state.discardPending = null; state.draftModified = false;
				if (pending?.kind === 'back') await ctx.goBack();
				else if (pending?.kind === 'chapter') await ctx.loadChapter(pending.no);
				else notify();
				break;
			}
			case 'discard-cancel': state.discardPending = null; notify(); break;
		case 'copy-handoff': {
			// 会话疲劳横幅的交接摘要：复制到剪贴板，用户去 shell 新建会话粘贴即可续写。
			// 剪贴板要安全上下文（localhost 满足）；不可用时给可行动提示，不静默。
			// ⚠ navigator 必须先过 typeof：headless（vm 测试环境）里它是未声明标识符，
			// 可选链只防 null/undefined，不防未声明——直接 navigator?.clipboard 会 ReferenceError。
			const handoff = state.detail?.session?.handoff;
			if (!handoff) break;
			const clipboard = typeof navigator !== 'undefined' ? navigator?.clipboard : undefined;
			if (typeof clipboard?.writeText !== 'function') {
				state.error = '剪贴板不可用（非安全上下文）——请在详情里手动选中交接摘要复制';
				notify();
				break;
			}
			clipboard.writeText(handoff)
				.then(() => { state.copiedHandoff = true; notify(); })
				.catch((error) => { state.error = `复制失败：${error?.message ?? error}`; notify(); });
			break;
		}
			case 'session-create':
				// 创建新会话并交接（服务端 sessions.create；非破坏性，单击即发）
				await ctx.createSession();
				break;
			case 'session-rotate': {
				// 两段确认：归档的是「正在看面板的这个会话」，第一击 arm 防手滑，第二击才发。
				if (!state.rotatePending) { state.rotatePending = true; notify(); break; }
				state.rotatePending = false;
				await ctx.rotateSession();
				break;
			}
			case 'lore-new': state.loreForm = { ...emptyLoreForm(), mode: 'new' }; state.loreDeleteId = null; notify(); break;
			case 'lore-edit': {
				// id 字符串比较（理由同 toggleLoreEntry）：Number('W1')=NaN 会让「编辑」
				// 对工具生成的条目静默失效（点了没反应）。
				const entry = state.loreEntries.find((x) => sameEntryId(x.id, target.dataset.id));
				if (entry) {
					state.loreForm = {
						mode: 'edit', id: String(entry.id), name: entry.name, content: entry.content,
						keywords: (entry.keywords || []).join(','), alwaysActive: entry.always_active,
						enabled: entry.enabled, priority: String(entry.priority), bookId: entry.book_id || '',
					};
					state.loreDeleteId = null;
					notify();
				} else if (target.dataset.id !== undefined) {
					// 拿不到条目不许静默：报出来，别让「点了没反应」再发生
					state.error = `找不到要编辑的世界书条目（id "${target.dataset.id}"）`;
					notify();
				}
				break;
			}
			case 'lore-save': await ctx.saveLoreEntry(); break;
			case 'lore-cancel': state.loreForm = emptyLoreForm(); notify(); break;
			case 'lore-toggle': await ctx.toggleLoreEntry(target.dataset.id); break;
			// 删除两步确认（与列表页删书同款）：第一次点只点亮确认行，再点才真删——
			// 世界书条目删了就没了（关键词、优先级、内容全在一条里），误触不可逆。
			case 'lore-delete':
				if (sameEntryId(state.loreDeleteId, target.dataset.id)) {
					state.loreDeleteId = null;
					await ctx.deleteLoreEntry(target.dataset.id);
				} else { state.loreDeleteId = target.dataset.id; notify(); }
				break;
			case 'lore-delete-cancel': state.loreDeleteId = null; notify(); break;
			default:
				// 视图发了控制器不认的动作名 = 「按钮点了没反应」的静默病根（AGENTS.md 第三次学费）。
				// 本项目不许可静默失败：报错可见 + 控制台留痕，client.test.mjs 的「动作契约对账」
				// 用例据此把「视图发出但控制器没有对应 case」判成红灯。
				state.error = `未处理的动作：${action}（界面按钮与控制器动作名不符，请报告）`;
				console.warn('[novel-forge] unknown action:', action);
				notify();
				break;
		}
	};

	// ── 原生事件代理（React 合成事件在宿主环境失效，故走容器级监听） ──
	const onClick = (e) => {
		const actionEl = e.target?.closest?.('[data-action]');
		if (actionEl) { e.preventDefault(); e.stopPropagation(); void handleAction(actionEl.dataset.action, actionEl); }
	};
	const onInput = (e) => {
		const field = e.target?.dataset?.field;
		// 书名输入是非受控的（defaultValue）：每键只记值不重渲染——
		// 「创建中…」那一下的 notify 由 create 自己负责（每键全列表重渲染白烧）。
		if (field === 'title') { state.title = e.target.value; }
		else if (field === 'project-filter') { state.filter = e.target.value; notify(); }
		else if (field === 'draft') { state.draft = e.target.value; state.draftModified = e.target.value !== state.baseline; }
		else if (field === 'rename-value') { if (state.rename) state.rename.value = e.target.value; }
		else if (field === 'clone-value') { if (state.clone) state.clone.value = e.target.value; }
		else if (field === 'chapterNo') {
			const no = Number(e.target.value);
			if (no > 0) {
				// 有未保存草稿时换章会丢内容——先确认再切
				if (state.draftModified) { state.discardPending = { kind: 'chapter', no }; notify(); }
				else void ctx.loadChapter(no);
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

	return { handleAction, attach, detach };
}