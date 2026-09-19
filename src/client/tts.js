// src/client/tts.js — 章节听书（Web Speech API 封装）。
//
// 为什么自己排队，不一把梭丢给 speechSynthesis：
//   ① 一章正文动辄几千字，Chrome 对超长 utterance 有「读十几秒就停」的老毛病，
//      必须切成短块逐个 speak（读完一块 onend 接下一块）；
//   ② 连播（第 N 章读完自动读第 N+1 章）要跨异步请求 —— 取正文是 await，
//      等待期间用户可能点了停止，所以用「代际计数」作废一切迟到回调，
//      防「停了又活过来」。
//
// 全部依赖注入（synth / loadChapter / hasChapter）：headless 测试直接喂替身，
// 不碰真机 Web Speech。

/**
 * 把正文切成朗读块：先按段落，超长段再按句末标点断开，最后合并到 limit 内。
 * 块与块之间由 utterance.onend 衔接，浏览器自己换气，不用插入停顿。
 * @param {string} text 章节正文
 * @param {number} [limit] 单块字符上限（默认 180，太长触发 Chrome 的停止 bug）
 * @returns {string[]}
 */
export function chunkText(text, limit = 180) {
	const paragraphs = String(text ?? '')
		.split(/\n+/)
		.map((p) => p.trim())
		.filter(Boolean);
	const pieces = [];
	for (const p of paragraphs) {
		if (p.length <= limit) { pieces.push(p); continue; }
		// 句末标点后断开（中英文标点都照顾到）
		for (const s of p.split(/(?<=[。！？；!?;.])\s*/)) {
			const t = s.trim();
			if (!t) continue;
			// L16 修复：无句读的超长段按字数硬切——整段塞给 TTS 引擎会被拒或整块吞掉
			if (t.length <= limit) { pieces.push(t); continue; }
			for (let i = 0; i < t.length; i += limit) pieces.push(t.slice(i, i + limit));
		}
	}
	const chunks = [];
	let buf = '';
	for (const s of pieces) {
		if (buf && buf.length + s.length > limit) { chunks.push(buf); buf = s; }
		else buf = buf ? buf + s : s;
	}
	if (buf) chunks.push(buf);
	return chunks;
}

/** 取宿主的 speechSynthesis；没有就返回 null（面板给出可读提示，不炸）。 */
export function resolveSynth() {
	if (typeof globalThis !== 'undefined' && globalThis.speechSynthesis) return globalThis.speechSynthesis;
	if (typeof window !== 'undefined' && window.speechSynthesis) return window.speechSynthesis;
	return null;
}

/**
 * 朗读对象的默认工厂。
 *
 * ⚠️ 真机 Web Speech 的 `speechSynthesis.speak()` 只收 **`SpeechSynthesisUtterance` 实例**，
 * 传普通对象会直接 `TypeError`（The provided value is not of type 'SpeechSynthesisUtterance'）。
 * 所以有真实构造器时**必须用它 new**，而不是手搓 `{text,...}` 对象糊过去。
 * node/headless 没有该构造器，此时退回普通对象（仅供测试替身按自己的契约决定是否放行）。
 * @returns {(text: string) => any} 造朗读对象的函数
 */
export function defaultUtteranceFactory() {
	const Ctor =
		(typeof globalThis !== 'undefined' && globalThis.SpeechSynthesisUtterance) ||
		(typeof window !== 'undefined' && window.SpeechSynthesisUtterance) ||
		null;
	if (typeof Ctor === 'function') {
		return (text) => {
			const u = new Ctor();
			u.text = String(text); u.lang = 'zh-CN'; u.rate = 1;
			return u;
		};
	}
	// 无 SpeechSynthesisUtterance 的宿主（node/headless）：退回普通对象
	return (text) => ({ text: String(text), lang: 'zh-CN', rate: 1 });
}

/**
 * 建一个听书播放器。
 *
 * 状态机：idle → playing →（pause）→ paused →（resume）→ playing → … → idle。
 * `onChange({ status, currentNo })` 在每次状态变化时回调，驱动面板重渲染。
 *
 * @param {object} deps
 * @param {object|null} deps.synth SpeechSynthesis（或同形替身）：speak/cancel/pause/resume
 * @param {(no: number) => Promise<string>} deps.loadChapter 取某章正文（缺失/失败按空串处理）
 * @param {(no: number) => boolean} deps.hasChapter 目录里有没有这一章（连播的兜底边界，给了 nextChapterAfter 时不用）
 * @param {(no: number) => number|null} [deps.nextChapterAfter] 目录里第一个编号**大于** no 的章；没有返回 null。
 *   连播/空章跳过都按它找下一章 —— 否则章号有缺口（如只有 1、3）会在缺口处早停。
 * @param {(text: string) => any} [deps.makeUtterance] 造朗读对象的工厂，默认 defaultUtteranceFactory()
 *   （真机必须产 SpeechSynthesisUtterance 实例，见 factory 注释）
 * @param {({status: string, currentNo: number|null}) => void} [deps.onChange]
 * @param {number} [deps.chunkLimit] 朗读块字符上限
 */
export function createTtsPlayer({ synth, loadChapter, hasChapter, nextChapterAfter,
	makeUtterance = defaultUtteranceFactory(), onChange = () => {}, chunkLimit = 180 }) {
	let status = 'idle';        // 'idle' | 'playing' | 'paused'
	let currentNo = null;
	let generation = 0;         // stop() / 新一次 playFrom 各 +1；旧代际的 onend 一律作废
	let queue = [];
	let idx = 0;
	let speaking = false;       // 有没有一块utterance正挂在引擎上（L15：暂停时机补偿用）

	// 连播要找"目录里下一章"，而不是无脑 currentNo+1 —— 章号有缺口不能卡在缺口处。
	const getNext = nextChapterAfter ?? ((no) => (hasChapter(no + 1) ? no + 1 : null));

	const emit = () => {
		try { onChange({ status, currentNo }); } catch { /* 渲染层自己兜 */ }
	};

	const finish = (gen) => {
		if (gen !== generation) return;
		status = 'idle'; currentNo = null; queue = []; idx = 0;
		emit();
	};

	const speakNext = (gen) => {
		if (gen !== generation) return;
		// L15 修复：暂停态不开新块——「取文窗口期按下暂停」时正文随后回来，
		// 不该无视 paused 状态直接开腔（恢复播放由 resume() 统一踢一脚）
		if (status === 'paused') return;
		if (idx >= queue.length) {
			// 本章读完 → 连播下一章（按目录找第一个编号更大的章）；目录尽头自动收工
			const next = getNext(currentNo);
			if (next != null) { void startChapter(next, gen); }
			else finish(gen);
			return;
		}
		const text = queue[idx++];
		// 真机必须用 SpeechSynthesisUtterance 实例（见 defaultUtteranceFactory 注释）
		const u = makeUtterance(text);
		speaking = true;
		u.onend = () => { speaking = false; speakNext(gen); };
		u.onerror = () => { speaking = false; speakNext(gen); };
		// 引擎对某一块同步抛错不能把链卡死在 playing —— 跳过继续（异常引擎最终会收工）
		try { synth.speak(u); }
		catch { speaking = false; speakNext(gen); }
	};

	const startChapter = async (no, gen) => {
		if (gen !== generation) return;
		currentNo = no;
		emit();
		let text = '';
		try { text = await loadChapter(no); } catch { text = ''; }
		if (gen !== generation) return;             // 取文期间被 stop / 换播
		if (!String(text ?? '').trim()) {
			// 空章（没写或取不到）：跳到目录里下一章，别让连播卡死
			const next = getNext(no);
			if (next != null) { await startChapter(next, gen); }
			else finish(gen);
			return;
		}
		queue = chunkText(text, chunkLimit);
		idx = 0;
		speakNext(gen);
	};

	/** 从第 no 章开始播（会打断当前播放）。没有语音引擎时抛可读错误。 */
	const playFrom = (no) => {
		if (!synth) throw new Error('当前环境不支持语音朗读（缺少 speechSynthesis）');
		generation += 1;
		const gen = generation;
		try { synth.cancel(); } catch { /* 有的实现没实现 cancel */ }
		status = 'playing';
		emit();
		return startChapter(no, gen);
	};

	const pause = () => {
		if (status !== 'playing') return;
		try { synth.pause(); } catch { /* 同上 */ }
		status = 'paused';
		emit();
	};

	const resume = () => {
		if (status !== 'paused') return;
		try { synth.resume(); } catch { /* 同上 */ }
		status = 'playing';
		emit();
		// L15 修复：暂停落在「取文窗口」时引擎里根本没有块，synth.resume() 是空操作
		// ——恢复时若没有在播的块，由这里把队列踢起来，否则永远停在假暂停
		if (!speaking) speakNext(generation);
	};

	const stop = () => {
		generation += 1;
		try { synth?.cancel(); } catch { /* 同上 */ }
		status = 'idle'; currentNo = null; queue = []; idx = 0;
		emit();
	};

	return {
		playFrom, pause, resume, stop,
		get status() { return status; },
		get currentNo() { return currentNo; },
	};
}
