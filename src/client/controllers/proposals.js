// src/client/controllers/proposals.js — 提案队列域：拉取 / 应用 / 丢弃 / 展开全文。
// 从 panel.js 的 createForgeController 按域拆出；应用后要刷目录与正文，
// 因此经 ctx 晚绑定调用 ctx.loadChapterList / ctx.loadChapter（不直接 import，解环）。
import { apiFetch } from '../api.js';

export function createProposalsController(ctx) {
	const { state, notify, seq } = ctx;

	/** 拉提案队列（待批准的修订稿）。 */
	const loadProposals = async (id) => {
		const bookId = id || state.selected;
		if (!bookId) return;
		const mine = seq.open;
		state.proposalsLoading = true; state.proposalsError = null; notify();
		try {
			const value = await apiFetch(`/projects/${encodeURIComponent(bookId)}/proposals`);
			if (mine !== seq.open) return; // 期间已切书：丢弃陈旧提案队列
			state.proposals = Array.isArray(value?.proposals) ? value.proposals : [];
		} catch (error) {
			// 加载失败 ≠ 没有待批：必须留痕可辨（2026-09-23 真机教训——失败曾被静默
			// 渲染成「没有待批的修订」，用户盯着空列表误以为提案被吞了几天）
			if (mine === seq.open) { state.proposals = []; state.proposalsError = String(error?.message ?? error); }
		}
		finally { if (mine === seq.open) { state.proposalsLoading = false; notify(); } }
	};

	/** 应用提案：生成新版本（旧版保留），审计 actor 记 'user'。 */
	const applyProposalAction = async (proposalId) => {
		if (!state.selected || !proposalId) return;
		state.proposalBusy = proposalId; state.error = ''; notify();
		try {
			const value = await apiFetch(`/projects/${encodeURIComponent(state.selected)}/proposals/${encodeURIComponent(proposalId)}/apply`, { method: 'POST' });
			state.notice = `已应用提案 ${proposalId}：第${value.chapter}章 v${value.version}（旧版保留）`;
			// 服务端已把这版正文过了一遍内容门禁（lib/proposals.js）：应用是用户主权不拦，
			// 但「改出了死人复活/隐藏人物泄底」必须当场看见。gate 为 null = 门禁输入读不到，跳过。
			const gate = value.gate;
			state.gateNotice = gate && ((gate.blocking?.length ?? 0) > 0 || (gate.warnings?.length ?? 0) > 0)
				? { chapter: value.chapter, version: value.version, ...gate }
				: null;
			if (state.gateNotice) {
				const bits = [...(state.gateNotice.blocking ?? []), ...(state.gateNotice.warnings ?? [])];
				state.notice += ` ⚠ 门禁提示 ${bits.length} 条（详见下方）`;
			}
			await Promise.all([loadProposals(state.selected), ctx.loadChapterList(state.selected)]);
			// 正开着被改的那一章就刷新正文，让用户立刻看到新版本
			if (state.chapterNo === value.chapter) await ctx.loadChapter(value.chapter);
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
			if (state.proposalDetail?.id === proposalId) state.proposalDetail = null;
			await loadProposals(state.selected);
		} catch (error) { state.error = String(error?.message ?? error); }
		finally { state.proposalBusy = null; notify(); }
	};

	/** 展开/收起单条提案全文——应用前让人看清楚到底改了什么。
	 *  0.13.1 之前提案卡只有「第 N 章」三个字，看不出提案要干嘛（仙尊实测反馈）。 */
	const toggleProposalDetail = async (proposalId) => {
		if (!state.selected) return;
		if (!proposalId) {
			state.error = '拿不到提案号（查看钮上应有 data-id）';
			notify();
			return;
		}
		// 再点一次收起
		if (state.proposalDetail?.id === proposalId && !state.proposalDetail.loading) {
			state.proposalDetail = null; notify();
			return;
		}
		state.proposalDetail = { id: proposalId, loading: true, data: null, error: '' }; notify();
		try {
			const value = await apiFetch(`/projects/${encodeURIComponent(state.selected)}/proposals/${encodeURIComponent(proposalId)}`);
			if (state.proposalDetail?.id !== proposalId) return; // 期间已点别条/换书：丢弃陈旧响应
			state.proposalDetail = { id: proposalId, loading: false, data: value, error: '' };
		} catch (error) {
			if (state.proposalDetail?.id !== proposalId) return;
			state.proposalDetail = { id: proposalId, loading: false, data: null, error: String(error?.message ?? error) };
		} finally { notify(); }
	};

	/** 页面重新可见/聚焦时的提案重拉：写作会话随时可能提交新提案，而队列只在
	 *  开书/应用动作时加载——挂着面板的用户看到的永远是打开那一刻的快照
	 *  （真机 10-04 实锤：写作会话新建 P45/P48/P49，用户面板停在旧空态）。
	 *  只在详情态且无在途动作时执行；loadProposals 同步置 proposalsLoading，
	 *  visibilitychange+focus 连发也不会双拉。 */
	const refreshProposalsIfIdle = () => {
		if (state.view !== 'detail' || !state.selected) return;
		if (state.proposalsLoading || state.proposalBusy) return;
		loadProposals(state.selected);
	};

	return { loadProposals, applyProposalAction, discardProposalAction, toggleProposalDetail, refreshProposalsIfIdle };
}