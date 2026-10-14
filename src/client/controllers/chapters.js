// src/client/controllers/chapters.js — 章正文域：读章 / 存章 / 导出 txt。
// 从 panel.js 的 createForgeController 按域拆出，只依赖共享 ctx（state/notify/seq），
// 不反向依赖其它域。陈旧响应守卫用 ctx.seq.chapter（章级请求序号）。
import { apiFetch } from '../api.js';

export function createChaptersController(ctx) {
	const { state, notify, seq } = ctx;

	const loadChapter = async (no) => {
		if (!state.selected) return;
		const mine = ++seq.chapter;
		state.chapterNo = no; state.discardPending = null; state.saveBlocked = ''; notify();
		try {
			const text = await apiFetch(`/projects/${encodeURIComponent(state.selected)}/chapters/${no}`);
			if (mine !== seq.chapter) return; // 期间已切章/切书：丢弃陈旧正文
			state.baseline = text ?? ''; state.draft = text ?? ''; state.draftVersion++;
			state.draftModified = false; state.undoStack = [];
		} catch {
			if (mine !== seq.chapter) return; // 陈旧失败的报错也不许覆盖新章
			// 读不到正文不能静默——给一句人话，别让用户以为这一章是空的
			state.baseline = ''; state.draft = ''; state.draftVersion++;
			state.error = `读取第 ${no} 章失败（刷新或检查服务）`;
			console.warn('[novel-forge] 读取章节失败', state.error);
		}
		notify();
	};

	const saveChapter = async ({ force = false } = {}) => {
		if (!state.selected) return;
		// M13 修复：await 期间用户可能已切书/切章/继续打字——保存完成后先核对
		// 「还是这本书的这一章、编辑器正文也还是存出去的那份」，再标记干净
		const bookId = state.selected;
		const no = state.chapterNo;
		const snapshot = state.draft;
		try {
			await apiFetch(`/projects/${encodeURIComponent(bookId)}/chapters/${no}`, {
				// title 不再送占位值：服务端缺省时沿用索引里的原标题（旧实现每次 POST
				// 都写「第 N 章」，存一次就把真标题抹掉一次）。
				method: 'POST', body: JSON.stringify({ text: snapshot, ...(force ? { force: true } : {}) }),
			});
			if (state.selected === bookId && state.chapterNo === no && state.draft === snapshot) {
				state.saveBlocked = '';
				state.notice = `已保存：第 ${no} 章`;
				state.baseline = snapshot; state.draftModified = false; state.undoStack = [];
			} else {
				state.notice = `已保存：第 ${no} 章——但编辑器已切走或继续改动，当前改动仍未保存`;
			}
		} catch (error) {
			if (state.selected !== bookId || state.chapterNo !== no) return;   // 陈旧失败的报错也不许覆盖新章
			if (error?.code === 'GATE_REJECTED') {
				// 门禁拦下 ≠ 服务故障：原文摆出来（判定逐条可执行），再给「仍要保存」
				// 二次确认。字数线这类硬判定 force 也顶不开——服务端会再回 409，
				// 文案自会说明还差多少，不靠这里猜。
				state.saveBlocked = String(error?.message ?? error);
				state.error = '';
			} else { state.error = String(error?.message ?? error); }
		}
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

	return { loadChapter, saveChapter, exportProject };
}