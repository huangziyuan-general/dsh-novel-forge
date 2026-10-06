// src/client/controllers/lore.js — 世界书面板域：列 / 存 / 删 / 启用停用。
// 从 panel.js 的 createForgeController 按域拆出；只依赖共享 ctx（state/notify）。
import { apiFetch } from '../api.js';
import { sameEntryId } from '../../../lib/store.js';
import { emptyLoreForm } from '../state.js';

export function createLoreController(ctx) {
	const { state, notify } = ctx;

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
		// 条目 id 是字符串（工具默认 W1/W2）——严禁 Number 强转（'W1'→NaN 永不命中，
		// 「启用/停用」对工具生成的条目会静默失效：点了没反应）。一律按字符串比较。
		const entry = state.loreEntries.find((e) => sameEntryId(e.id, entryId));
		if (!entry) { state.error = `找不到要切换的世界书条目（id "${entryId ?? ''}"）`; notify(); return; }
		try {
			await apiFetch(`/worldbook/${encodeURIComponent(bookId)}/${entryId}`, { method: 'PUT', body: JSON.stringify({ enabled: !entry.enabled }) });
			await loadLoreEntries(bookId);
		} catch (error) { state.error = String(error?.message ?? error); notify(); }
	};

	return { loadLoreEntries, saveLoreEntry, deleteLoreEntry, toggleLoreEntry };
}