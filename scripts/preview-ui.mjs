#!/usr/bin/env node
// scripts/preview-ui.mjs — 生成一个「看得见、点得动」的面板 UI 预览页。
//
// 为什么不是手搓一份 HTML mock：手搓的预览跟真实面板**必然漂移**（改完样式忘了改预览，
// 于是预览很好看、真机还是丑）。这里改成**真渲染**——
//   · 页面里跑的脚本就是构建产物 lib/client.js 本身（原样内联）；
//   · 颜色/字号全部来自宿主 dsh 的真实 `--dsw-alias-*` token，
//     浅色与深色两套都从 `dsh-client-ui-theme` 里**原样抽出来**（连静态色板一起），
//     于是「浅色主题下什么样」在这页上就是真的；
//   · 点按钮走的是面板真正的事件代理（`data-action` + 原生 click），不是假的。
// 唯一假的是数据：离线 mock（fetch 被替换），只为了把版面填满。
//
// 用法：node scripts/preview-ui.mjs  →  产出 preview/forge-ui.html（单文件，可直接双击打开）
// 依赖外网：React 18 UMD 从 unpkg 取（宿主那份 React 只存在于 web 运行时，磁盘上没有）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const outFile = path.join(root, 'preview', 'forge-ui.html');

// ── ① 从宿主主题包里抽真实 token（浅/深两套）──────────────────────────────
// 找不到就退化成「只有回退值」的预览，并明确告诉用户缺了什么——不静默假装成功。
const hostTheme = path.join(
	process.env.HOME ?? '',
	'.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js',
);

/**
 * 按「声明块」抽 CSS。两类块的判据不同：
 *   · 静态色板（--dsw-static-*）是**字面值**，块里不该出现 var()；
 *   · 语义层（--dsw-alias-bg-base: ...）本身就是一串 var() 引用，不能按那条排。
 * 两者都以「整块从某个声明开头」为特征，用它区分组件样式里零散的 var() 引用。
 */
function extractBlocks(css, prefix, { allowVar = false } = {}) {
	const out = [];
	for (const m of css.matchAll(/\{([^{}]*)\}/g)) {
		const body = m[1].trim();
		if (!body.startsWith(prefix)) continue;
		if (!allowVar && body.includes('var(')) continue;
		out.push(body);
	}
	return out;
}

let themeCss = '';
let themeNote = '';
if (fs.existsSync(hostTheme)) {
	const src = fs.readFileSync(hostTheme, 'utf8');
	const statics = extractBlocks(src, '--dsw-static-');
	const aliases = extractBlocks(src, '--dsw-alias-bg-base:', { allowVar: true });
	if (statics.length >= 2 && aliases.length >= 2) {
		// 文件里浅色在前、深色在后（body / body[data-ds-dark-theme]）
		themeCss = [
			`:root, body {\n${statics[0]}\n${aliases[0]}\n}`,
			`body[data-ds-dark-theme] {\n${statics[1]}\n${aliases[1]}\n}`,
		].join('\n\n');
		themeNote = `宿主 token 已抽入（静态 ${statics[0].split(';').length - 1} 项 + 语义 ${aliases[0].split(';').length - 1} 项 × 浅/深两套）`;
	} else {
		themeNote = '⚠️ 没能从宿主主题包解析出 token（结构变了），预览将只有插件的回退值';
	}
} else {
	themeNote = '⚠️ 未找到宿主主题包，预览将只有插件的回退值（颜色可能与真机不同）';
}

// ── ② 构建产物 ─────────────────────────────────────────────────────────────
const bundlePath = path.join(root, 'lib/client.js');
if (!fs.existsSync(bundlePath)) {
	console.error('✗ lib/client.js 不存在 —— 先跑 npm run build');
	process.exit(1);
}
const bundle = fs.readFileSync(bundlePath, 'utf8');

// ── ②b React 运行时：下到 preview/vendor 后**内联**，让预览页离线也能开 ──
// （宿主那份 React 只存在于 web 运行时，磁盘上没有，所以只能从 CDN 取一次；
//   取不到就退回 <script src> 形式，页面会提示需要联网。）
const vendorDir = path.join(root, 'preview', 'vendor');
const REACT = [
	{ file: 'react.production.min.js', url: 'https://unpkg.com/react@18.3.1/umd/react.production.min.js' },
	{ file: 'react-dom.production.min.js', url: 'https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js' },
];
let reactInline = '';
let reactTag = '';
let reactNote = '';
fs.mkdirSync(vendorDir, { recursive: true });
for (const r of REACT) {
	const dest = path.join(vendorDir, r.file);
	if (!fs.existsSync(dest)) {
		try {
			const res = await fetch(r.url);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			fs.writeFileSync(dest, await res.text());
			console.log(`  ↓ 取回 ${r.file}`);
		} catch (error) {
			console.warn(`  ⚠️ 取 ${r.file} 失败（${error.message}）—— 预览页将改为联网加载`);
		}
	}
	if (fs.existsSync(dest)) reactInline += `\n/* ${r.file} */\n${fs.readFileSync(dest, 'utf8')}\n`;
	else reactTag += `<script src="${r.url}" crossorigin></script>\n`;
}
reactNote = reactInline
	? 'React 已内联（离线可开）'
	: '⚠️ React 未内联，打开预览页需要联网';

// ── ③ mock 数据（只为了填满版面；结构与 lib/server-api.js 的返回一致）──────
const MOCK = {
	session: 'preview-session',
	projects: [
		{
			name: '星海拾骨', title: '星海拾骨', genre: '东方玄幻', stage: 'writing', stageLabel: '正文',
			chapters: 12, approved: 12, castCount: 4, facts: 34, maxChapter: 12,
			foreshadows: { total: 5, open: 2, overdue: 1 },
			style: { built: true, chapters: 12 },
		},
		{
			name: '黄子源', title: '黄子源', genre: '科幻仙侠', stage: 'revision', stageLabel: '修订',
			chapters: 26, approved: 24, castCount: 7, facts: 118, maxChapter: 26,
			foreshadows: { total: 11, open: 4, overdue: 0 },
			style: { built: true, chapters: 26 },
		},
		{
			name: '雪夜归人', title: '雪夜归人', genre: '古代权谋', stage: 'chapter', stageLabel: '细纲',
			chapters: 0, approved: 3, castCount: 2, facts: 0, maxChapter: null,
			foreshadows: { total: 0, open: 0, overdue: 0 },
			style: { built: false, chapters: null },
		},
	],
	unclaimed: [{ name: '旧实验稿', title: '旧实验稿（0.5.0 之前）' }],
	detail: {
		id: '星海拾骨', title: '星海拾骨', genre: '东方玄幻', stage: 'writing',
		chapters: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [String(i + 1), { title: `第 ${i + 1} 章`, version: 1 }])),
	},
	elements: {
		meta: {
			title: '星海拾骨', genre: '东方玄幻', stage: '正文',
			logline: '捡骨人逆改星图：一个替死人收拾身后事的姑娘，发现整座城的命数被改写。',
			createdAt: '2026-08-02T10:00:00.000Z', updatedAt: '2026-09-13T22:41:00.000Z',
			cast: ['林晚', '陈九', '沈砚', '老周'],
		},
		outline: {
			full: '第一部 · 拾骨\n第 1–12 章：林晚在城南义庄收殓一具无名单，牵出「空棺」旧案。\n\n第二部 · 逆星\n第 13–26 章：星图被改的真相浮出，林晚必须决定要不要把名字还回去。',
			chapterOutlines: ['第1章-雨夜来客.md', '第2章-空棺.md', '第3章-红泥.md', '第4章-问路.md', '第5章-旧契.md', '第6章-星图.md'],
		},
		characters: [
			{ name: '林晚', text: '外在：城南拾骨人，寡言，惯用短刃。\n隐性欲望：查清师父的死因。\n语言基因：短句、反问、从不先下结论。' },
			{ name: '陈九', text: '外在：更夫，瘸腿，爱喝酒。\n隐性欲望：替兄弟还债。\n语言基因：爱绕弯子，一紧张就报更点。' },
			{ name: '沈砚', text: '外在：县衙书吏，白面，手上有旧墨。\n隐性欲望：把案卷里的名字改回来。' },
		],
		worldbookCount: 4, glossaryCount: 1,
		facts: [
			{ entity: '林晚', key: '位置', value: '城南义庄', chapter: 1 },
			{ entity: '林晚', key: '持有', value: '红泥布鞋', chapter: 1 },
			{ entity: '布鞋', key: '来源', value: '门槛来客', chapter: 1 },
			{ entity: '空棺', key: '数量', value: '三口', chapter: 2 },
			{ entity: '林晚', key: '位置', value: '城西乱葬岗', chapter: 2 },
			{ entity: '陈九', key: '状态', value: '战死', chapter: 9 },
			{ entity: '陈九', key: '位置', value: '城北更楼', chapter: 14 },
			{ entity: '林晚', key: '境界', value: '引星境一层', chapter: 12 },
		],
		foreshadows: [
			{ id: 'F1', chapter: 1, plan: 8, payoffChapter: 10, setup: '来客留下沾红泥的布鞋 —— 鞋底红泥只产于城西乱葬岗。' },
			{ id: 'F2', chapter: 2, plan: 9, setup: '三口空棺，棺底刻着被划掉的铜钱记号。' },
			{ id: 'F3', chapter: 5, plan: 7, setup: '旧契上的日期比案发早三天。' },
		],
	},
	chapters: Array.from({ length: 12 }, (_, i) => ({
		no: i + 1,
		title: ['雨夜来客', '空棺', '红泥', '问路', '旧契', '星图', '更声', '借火', '断腿', '还名', '第一场雪', '引星'][i] ?? '',
		chars: [1820, 2140, 1980, 2310, 2050, 2440, 1890, 2200, 2370, 2610, 2080, 1930][i] ?? 2000,
		version: i === 8 ? 2 : 1,
	})),
	chapterText: [
		'林晚把最后一枚铜钱按进香炉，灰烬腾起来，呛得她直咳嗽。',
		'',
		'院门吱呀一声开了条缝。她没有回头，只是把刀往膝盖边挪了半寸。',
		'',
		'「进来吧，别站在风口上。」她说。',
		'',
		'来客没有进门。他在门槛外蹲下来，慢条斯理地重新系了一遍鞋带。',
		'',
		'「义庄的后墙，昨夜塌了个角。」他说，「棺材板翻出来三口，都是空的。」',
	].join('\n'),
	proposals: {
		proposals: [
			{ id: 'P9-mf3k21', chapter: 9, status: 'pending', createdAt: '2026-09-13T21:12:00.000Z',
				title: '夜探更楼', reason: '机审检出章末无钩子：末段落在静态收束上。重排结尾，把更楼的灯「自己亮了」压到末段收口，为第 11 章回收伏笔蓄力。正文其余未动。',
				preview: '把结尾改成悬念对白——更楼的灯自己亮了，陈九的手按上了刀柄……' },
			{ id: 'P11-mf8a04', chapter: 11, status: 'pending', createdAt: '2026-09-13T23:40:00.000Z',
				title: '灯下对峙', reason: '去AI味：删除三处总结式比喻，对话口语化，节奏拉紧。',
				preview: '「你说这灯是谁点的？」陈九没回头。身后的人笑了……' },
			{ id: 'P7-mf1c99', chapter: 7, status: 'applied', createdAt: '2026-09-10T09:02:00.000Z' },
		],
	},
	continuity: {
		ok: false,
		stats: { chapters: 12, facts: 34, foreshadows: 5, deaths: 1, errors: 2, warnings: 3 },
		issues: [
			{ severity: 'error', code: 'posthumous-change', where: '第9章·陈九', message: '陈九在第 9 章已记为战死，第 14 章却又出现状态变更（位置 → 城北更楼）——死后仍在活动。' },
			{ severity: 'error', code: 'ledger-same-chapter-conflict', where: '林晚·位置', message: '同一章（第 2 章）里林晚的位置先后写成「城南义庄」与「城西乱葬岗」，账本自相矛盾。' },
			{ severity: 'warning', code: 'foreshadow-overdue', where: '伏笔 F3', message: '伏笔 F3 计划第 7 章回收，全书已写到第 12 章仍未回收。' },
			{ severity: 'warning', code: 'chapter-gap', where: '第6→7章', message: '章号不连续：第 6 章之后直接是第 7 章之外的空档（请确认是不是漏写）。' },
			{ severity: 'warning', code: 'chapter-version-mismatch', where: '第9章', message: 'novel.json 记的版本号与实际正文文件名不一致（v2 vs v1）。' },
		],
	},
	diagnosis: {
		overall: '可——钩子够但冲突/灌输需回调',
		sampled: 3,
		perChapter: [
			{ chapter: 1, title: '雨夜来客', hook: 78, opening: 90, conflict: 52, infodump: 44 },
			{ chapter: 2, title: '灯下对峙', hook: 66, opening: 74, conflict: 48, infodump: 63 },
			{ chapter: 3, title: '更楼的灯', hook: 82, opening: 68, conflict: 71, infodump: 31 },
		],
		issues: [
			'第2章章末钩子偏弱（66）——结尾补一问句式悬念/意外转折',
			'第2章信息灌输偏高（63）——把设定拆成行为/事件，别成段说明',
		],
	},
	worldbook: [
		{ id: 1, name: '城西乱葬岗', content: '红泥遇水不散，是识尸标记。乱葬岗的土色偏赭，混着石灰，雨后三日仍湿。', keywords: ['乱葬岗', '红泥'], always_active: false, enabled: true, priority: 60 },
		{ id: 2, name: '引星境', content: '九境第三重，能借星位短暂改换自身命数，代价是折寿。', keywords: ['引星', '境界'], always_active: false, enabled: true, priority: 50 },
		{ id: 3, name: '更鼓规矩', content: '城北更楼一夜五更，报更点即报方位；陈九紧张时会无意识报更。', keywords: [], always_active: true, enabled: true, priority: 80 },
		{ id: 4, name: '拾骨人忌讳', content: '收殓时不可呼名，呼名则亡者随行。', keywords: ['收殓', '拾骨'], always_active: false, enabled: false, priority: 40 },
	],
	batchResult: {
		concurrency: 2,
		stats: { total: 3, committed: 2, failed: 1 },
		warnings: ['第 14 章无细纲，已跳过（可用「强制」跳过细纲门禁）'],
		results: [
			{ chapter: 13, ok: true, committed: true, title: '改星', chars: 2180, version: 1, noai: { level: '良好' } },
			{ chapter: 14, ok: true, committed: true, title: '问名', chars: 2020, version: 1, noai: { level: '良好' } },
			{ chapter: 15, ok: false, committed: false, reason: '内容门禁：第 3 段仍含占位符 TODO' },
		],
	},
	revision: {
		ok: { mode: 'polish', chapter: 9, proposalId: 'P9-mf9zz1', chars: 2410, deltaChars: 62, attempts: 1, route: { provider: 'default', model: 'inherit', source: 'session' }, warnings: [] },
		blocked: { code: 'GUARD_BLOCKED', message: '守卫拦下：改写后篇幅 1.74 倍于原文（上限 1.30），已丢弃', advice: '把「重写」拆成两次「局部润色」，或缩小病灶范围' },
	},
};

// ── ④ 生成页面 ─────────────────────────────────────────────────────────────
const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>锻炉 · UI 预览 v${pkg.version}</title>
<style>
/* ═══ 1. 宿主 dsh 的真实主题 token（浅/深两套，原样抽出，未改一个值）═══ */
${themeCss || '/* （未取到宿主 token，本页将只用插件回退值） */'}

/* ═══ 2. 预览页自己的版面 ═══ */
* { box-sizing: border-box; }
html, body { margin: 0; }
body {
  background: var(--dsw-alias-bg-base, #fff);
  color: var(--dsw-alias-label-primary, #111);
  font: 13px/1.6 system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
  -webkit-font-smoothing: antialiased;
}
.wrap { max-width: 1120px; margin: 0 auto; padding: 26px 20px 64px; }
h1 { font-size: 17px; font-weight: 700; margin: 0 0 6px; display: flex; align-items: center; gap: 8px; }
h1 .ver { font-size: 11px; font-weight: 500; padding: 1px 7px; border-radius: 999px;
  background: var(--dsw-alias-bg-layer-3, #eee); color: var(--dsw-alias-label-secondary, #666);
  font-family: ui-monospace, Menlo, monospace; }
.note { color: var(--dsw-alias-label-tertiary, #888); font-size: 12px; line-height: 1.75;
  margin: 0 0 4px; max-width: 860px; }
.note code { font-family: ui-monospace, Menlo, monospace; background: var(--dsw-alias-bg-layer-3, #eee);
  padding: 0 4px; border-radius: 4px; }
.bar { display: flex; flex-wrap: wrap; gap: 6px; margin: 16px 0 4px; align-items: center; }
.bar .lab { font-size: 11px; color: var(--dsw-alias-label-tertiary, #888); margin-right: 2px; }
.bar button {
  font: inherit; font-size: 12px; padding: 4px 10px; border-radius: 8px; cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l3, #ddd);
  background: var(--dsw-alias-bg-layer-1, #fff);
  color: var(--dsw-alias-label-secondary, #555);
}
.bar button:hover { background: var(--dsw-alias-interactive-bg-hover, #f2f2f2); }
.bar button.on { background: var(--dsw-alias-button-primary-fill, #111);
  color: var(--dsw-alias-label-primary-foreground, #fff); border-color: transparent; }
.bar .sep { width: 1px; height: 18px; background: var(--dsw-alias-border-l2, #ddd); margin: 0 4px; }
.stage { display: flex; gap: 20px; align-items: stretch; margin-top: 14px; }
.chatmock {
  flex: 1 1 auto; min-width: 240px; border-radius: 12px; padding: 16px;
  border: 1px dashed var(--dsw-alias-border-l2, #ddd);
  color: var(--dsw-alias-label-tertiary, #999); font-size: 12px;
  display: flex; flex-direction: column; gap: 10px;
}
.chatmock .bubble { max-width: 78%; padding: 8px 12px; border-radius: 10px;
  background: var(--dsw-alias-bg-layer-2, #f5f5f5); }
.chatmock .bubble.me { align-self: flex-end; background: var(--dsw-alias-bg-layer-3, #eee); }
#frame {
  flex: none; width: 380px; height: 780px; border-radius: 12px; overflow: hidden;
  display: flex; flex-direction: column;
  border: 1px solid var(--dsw-alias-border-l2, #ddd);
  background: var(--dsw-alias-bg-layer-1, #fff);
  box-shadow: 0 14px 34px rgba(0,0,0,.14);
}
#frame.narrow { width: 320px; }
#frame.wide { width: 460px; }
.hint { margin-top: 10px; font-size: 11.5px; color: var(--dsw-alias-label-tertiary, #999); }
</style>
</head>
<body>
<div class="wrap">
  <h1>🔨 锻炉 · 面板 UI 预览 <span class="ver">v${pkg.version}</span></h1>
  <p class="note">
    这是<b>真渲染</b>：页面里跑的脚本就是构建产物 <code>lib/client.js</code> 本身，
    颜色与字号全部取自宿主 dsh 的真实 <code>--dsw-alias-*</code> token（浅色/深色两套都从
    <code>dsh-client-ui-theme</code> 原样抽出），点按钮走的是面板真正的事件代理。
    只有<b>数据是假的</b>（离线 mock，为了把版面填满）。<br>
    ${themeNote}
  </p>

  <div class="bar" id="tour">
    <span class="lab">走一遍：</span>
    <button data-do="list">📚 项目列表</button>
    <button data-do="open">🔎 打开《星海拾骨》</button>
    <button data-do="checkup">🩺 全书体检</button>
    <button data-do="info">📋 基本信息</button>
    <button data-do="chapters">🎧 章节听书</button>
    <button data-do="lore">📖 世界书</button>
    <button data-do="settings">⚙ 设置</button>
    <span class="sep"></span>
    <button data-do="polish-ok">✨ 润色（成功）</button>
    <button data-do="polish-blocked">🚫 润色（守卫拦下）</button>
    <button data-do="batch">⚡ 批量起草</button>
    <span class="sep"></span>
    <button data-do="theme">🌗 浅色 / 深色</button>
    <button data-do="w">↔ 320 / 460 宽</button>
    <span class="sep"></span>
    <button data-do="sweep">🔫 按钮扫射（找点了没反应的）</button>
  </div>
  <pre id="sweepout" style="display:none;margin-top:12px;padding:12px;border-radius:10px;
    background:var(--dsw-alias-bg-layer-2,#f5f5f5);color:var(--dsw-alias-label-secondary,#555);
    font-size:11.5px;line-height:1.65;white-space:pre-wrap;max-height:340px;overflow:auto"></pre>

  <div class="stage">
    <div class="chatmock">
      <div class="bubble">左侧是宿主真实的对话区。锻炉常驻右侧栏 —— 写作、门禁、审计在对话里由 AI 调工具驱动，面板负责确定性那部分。</div>
      <div class="bubble me">写第 13 章。</div>
      <div class="bubble">（这里是 mock，点上面的按钮看右侧面板。）</div>
    </div>
    <div id="frame"></div>
  </div>
  <div class="hint">预览页只在本地生成，不参与构建；改完 <code>src/client/</code> 记得重跑
    <code>npm run build &amp;&amp; node scripts/preview-ui.mjs</code>。</div>
</div>

<script>
// ① 宿主模块表替身（要在 bundle 之前就位：bundle 是经典脚本，加载即注册）
${reactInline}
window.__ModuleLoader__ = { load(reg) { window.__FORGE_REG__ = reg; } };
</script>
${reactTag}
<script>
// ② 构建产物（原样）
${bundle}
</script>
<script>
// ③ 预览驱动：mock fetch + mock cordis ctx + 真渲染
const MOCK = ${JSON.stringify(MOCK)};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// —— mock fetch：路由与 lib/server-api.js 对齐，返回 { ok, value } ——
let polishMode = 'ok';
const previewFetch = async (url, init) => {
  const u = new URL(url, location.href);
  const p = u.pathname.replace(/^\\/api\\/novel-forge/, '');
  const q = u.searchParams;
  const json = (payload, status = 200) => ({ status, json: async () => payload });

  if (init?.method === 'POST' && /\\/chapters\\/\\d+\\/(polish|proofread)$/.test(p)) {
    await sleep(500);
    if (polishMode === 'blocked') {
      return json({ ok: false, error: MOCK.revision.blocked, value: { attempts: 1, blocked: { kind: 'growth' }, warnings: [] } }, 422);
    }
    return json({ ok: true, value: MOCK.revision.ok });
  }
  if (init?.method === 'POST' && /\\/draft-batch$/.test(p)) { await sleep(900); return json({ ok: true, value: MOCK.batchResult }); }
  if (init?.method === 'POST' && /\\/proposals\\/.*\\/apply$/.test(p)) return json({ ok: true, value: { chapter: 9, version: 2 } });
  if (init?.method === 'POST' && /\\/proposals\\/.*\\/discard$/.test(p)) return json({ ok: true, value: {} });
  // 克隆为模板（面板只做校验反馈；mock 不持久化，刷新后列表原样）
  if (init?.method === 'POST' && /\\/projects\\/[^/]+\\/clone$/.test(p)) {
    await sleep(600);
    return json({ ok: true, value: { book: '万刃-模板', from_book: '万刃', action: 'clone', chapters: 30, missing: 0, new_stage: 'topic', next: '克隆完成：《万刃-模板》已就绪（阶段重置 topic，提案与熔断计数已清空）' } });
  }

  if (p === '/projects' && q.get('scope') === 'unclaimed') return json({ ok: true, value: MOCK.unclaimed });
  // 带 session 的过滤恒空 → 演示「回落显示全部」说明条（0.13.2 真机同款症状）
  if (p === '/projects' && q.get('session')) return json({ ok: true, value: [] });
  if (p === '/projects') return json({ ok: true, value: MOCK.projects });
  if (/^\\/projects\\/[^/]+\\/elements$/.test(p)) return json({ ok: true, value: MOCK.elements });
  if (/^\\/projects\\/[^/]+\\/continuity$/.test(p)) { await sleep(420); return json({ ok: true, value: MOCK.continuity }); }
  if (/^\\/projects\\/[^/]+\\/diagnose$/.test(p)) { await sleep(380); return json({ ok: true, value: MOCK.diagnosis }); }
  if (/^\\/projects\\/[^/]+\\/proposals$/.test(p)) return json({ ok: true, value: MOCK.proposals });
  if (/^\\/projects\\/[^/]+\\/proposals\\/[^/]+$/.test(p)) {
    const id = p.split('/').pop();
    const found = MOCK.proposals.proposals.find((x) => x.id === id);
    return json({ ok: true, value: { ...found, content: '修订稿全文（预览 mock）：\\n\\n青州的晨，是从一张烧饼开始的。城北布市的天还没全亮，卖菜的已经占了半条街……\\n\\n把结尾改成悬念对白——更楼的灯自己亮了，陈九的手按上了刀柄，「这灯，是谁点的？」' } });
  }
  if (/^\\/projects\\/[^/]+\\/chapters$/.test(p)) return json({ ok: true, value: MOCK.chapters });
  if (/^\\/projects\\/[^/]+\\/chapters\\/\\d+$/.test(p)) return json({ ok: true, value: MOCK.chapterText });
  if (/^\\/projects\\/[^/]+$/.test(p)) return json({ ok: true, value: MOCK.detail });
  if (/^\\/worldbook\\//.test(p)) return json({ ok: true, value: MOCK.worldbook });
  return json({ ok: true, value: [] });
};
window.fetch = previewFetch;

// —— 加载 bundle，取出 { apply } ——
const reg = window.__FORGE_REG__;
if (!reg) {
  document.getElementById('frame').innerHTML =
    '<div style="padding:20px;color:#e5484d;font-size:12px">bundle 没有调用 __ModuleLoader__.load</div>';
  throw new Error('no registration');
}
const moduleTable = {
  react: window.React,
  'react/jsx-runtime': { jsx: () => null, jsxs: () => null },
  'react-dom': window.ReactDOM,
  'react-dom/client': window.ReactDOM,
  cordis: {},
};
const exports = reg.factory((spec) => {
  if (!(spec in moduleTable)) throw new Error('宿主未播种模块 ' + spec);
  return moduleTable[spec];
});

// —— cordis ctx 替身：只为拿到面板组件（与 test/helpers/dom.mjs 同语义）——
let Panel = null;
const ctx = {
  effect: (fn) => { try { fn(); } catch (e) { console.warn(e); } return () => {}; },
  slots: {
    register: (spec, component) => { Panel = component; return () => {}; },
    inject: (_name, cb) => cb(),
  },
  sidebarRightTabs: { register: () => () => {} },
  sidebarRight: { openTab: () => {} },
  sessions: { list: { getSnapshot: () => ({ current: MOCK.session }), subscribe: () => () => {} } },
};

const frame = document.getElementById('frame');
if (!window.React || !window.ReactDOM) {
  frame.innerHTML = '<div style="padding:20px;color:#e5484d;font-size:12px;line-height:1.8">'
    + 'React 没加载出来（本页从 unpkg 取 React 18，需要联网）。<br>联网后刷新即可。</div>';
} else {
  exports.apply(ctx);
  window.ReactDOM.createRoot(frame).render(
    window.React.createElement(Panel, { sessionId: MOCK.session }),
  );
}

// —— 导览：computed click 走面板自己的事件代理 ——
const click = (sel) => { const el = document.querySelector(sel); if (el) { el.click(); return true; } return false; };
const tour = {
  // 回列表：设置页/世界书页/详情页的「返回」各有各的 action，逐个退到列表为止
  list: async () => {
    for (let i = 0; i < 4; i++) {
      if (click('[data-action="back-from-settings"]')) { await sleep(140); continue; }
      if (click('[data-action="back-from-lore"]')) { await sleep(140); continue; }
      if (click('[data-action="back"]')) { await sleep(140); continue; }
      break;
    }
  },
  open: async () => click('[data-action="open"][data-id="星海拾骨"]'),
  checkup: async () => click('[data-action="continuity"]'),
  diagnose: async () => click('[data-action="diagnose"]'),
  write: async () => click('[data-action="write"]'),
  info: async () => click('[data-action="detail-tab"][data-tab="info"]'),
  chapters: async () => click('[data-action="detail-tab"][data-tab="chapters"]'),
  // 世界书入口只在「基本信息」标签里 —— 先切回去再点，否则点空
  lore: async () => { click('[data-action="detail-tab"][data-tab="info"]'); await sleep(100); click('[data-action="goto-lorebook"]'); },
  settings: async () => click('[data-action="goto-settings"]'),
  'polish-ok': async () => { polishMode = 'ok'; click('[data-action="polish"]'); },
  'polish-blocked': async () => { polishMode = 'blocked'; click('[data-action="polish"]'); },
  batch: async () => {
    document.querySelectorAll('details').forEach((d) => { d.open = true; });
    await sleep(60);
    click('[data-action="draft-batch"]');
  },
  theme: async () => {
    const on = document.body.hasAttribute('data-ds-dark-theme');
    if (on) document.body.removeAttribute('data-ds-dark-theme');
    else document.body.setAttribute('data-ds-dark-theme', '');
  },
  w: async () => {
    frame.classList.toggle('narrow');
    if (frame.classList.contains('narrow')) frame.classList.remove('wide');
    else frame.classList.add('wide');
  },
};
// —— 🔫 按钮扫射：遍历每个视图，逐个点击所有 data-action，报告「点了界面没反应」的 ——
//
// 为什么要有它：事件代理的失效是**静默**的 —— action 名对不上、按钮被误标 disabled、
// 处理器前置条件不满足提前 return，全都表现为「点了没反应」，且构建/单测一律绿灯
// （单测覆盖控制器，覆盖不到「点击真的送达了吗」）。扫射用**真渲染 + 真事件代理**照出这些。
// ⚠️ 属性名必须与 panel.js 的 PANEL_ATTR 一致（data-dsh-novel-forge-panel）。
// 少了 dsh- 前缀会让这里恒返回 'NO-PANEL' —— 于是**每一次点击都被判成"无变化"**，
// 扫射满屏假阳性（0.13.0 写这个功能时当场踩了）。所以拿不到面板根**直接抛错**，
// 宁可炸掉也不要给一份看起来煞有介事的假报告。
const panelRoot = () => {
  const root = frame.querySelector('[data-dsh-novel-forge-panel]');
  if (!root) throw new Error('扫射拿不到面板根 [data-dsh-novel-forge-panel] —— 面板没渲染或属性名写错了');
  return root;
};
const panelSig = () => {
  const root = panelRoot();
  const t = root.textContent || '';
  let hash = 0;
  for (let i = 0; i < t.length; i++) hash = (Math.imul(hash, 31) + t.charCodeAt(i)) | 0;
  return t.length + '|' + hash + '|' + root.querySelectorAll('*').length;
};

// 捕获阶段记一笔：用来区分「事件代理根本没收到」和「收到了但处理器没干活」
const delivered = [];
frame.addEventListener('click', (e) => {
  const el = e.target && e.target.closest && e.target.closest('[data-action]');
  if (el) delivered.push(el.dataset.action);
}, true);

const pageErrors = [];
window.addEventListener('error', (e) => pageErrors.push(String(e.message || e.error)));
window.addEventListener('unhandledrejection', (e) => pageErrors.push('unhandled: ' + String((e.reason && e.reason.message) || e.reason)));

const SWEEP_VIEWS = [
  { name: '项目列表', go: async () => { await tour.list(); } },
  { name: '详情 · 基本信息', go: async () => { await tour.list(); click('[data-action="open"][data-id="星海拾骨"]'); await sleep(420); click('[data-action="detail-tab"][data-tab="info"]'); await sleep(180); } },
  { name: '详情 · 章节听书', go: async () => { await tour.list(); click('[data-action="open"][data-id="星海拾骨"]'); await sleep(420); click('[data-action="detail-tab"][data-tab="chapters"]'); await sleep(220); } },
  // 世界书要自己走完「回列表 → 开书 → 基本信息 → 进世界书」四步：
  // 直接调 tour.lore() 会在别的视图上点空（tour 的导航前摇只在它自己的处理器里）
  { name: '世界书', go: async () => { await tour.list(); click('[data-action="open"][data-id="星海拾骨"]'); await sleep(420); click('[data-action="detail-tab"][data-tab="info"]'); await sleep(180); click('[data-action="goto-lorebook"]'); await sleep(260); } },
  { name: '设置', go: async () => { await tour.settings(); } },
];

const sweep = async () => {
  const out = document.getElementById('sweepout');
  const lines = ['（扫射跑的是真产物 + 真事件代理；「界面无变化」是**候选**清单，需人工看是 mock 没铺数据还是真 bug。）'];
  let dead = 0, thrown = 0, missing = 0;
  // 先就地确认「能拿到面板」：拿不到就立刻报出来，不要生成一份满屏假阳性的报告
  try { panelRoot(); } catch (error) {
    out.textContent = '!! ' + (error && error.message || error);
    out.style.display = 'block';
    return out.textContent;
  }
  for (const v of SWEEP_VIEWS) {
    await v.go();
    await sleep(240);
    frame.querySelectorAll('details').forEach((d) => { d.open = true; });
    await sleep(140);

    const keys = [];
    for (const el of frame.querySelectorAll('[data-action]')) {
      const key = [el.dataset.action, el.dataset.id || '', el.dataset.tab || ''].join('|');
      if (keys.indexOf(key) < 0) keys.push(key);
    }
    lines.push('');
    lines.push('── ' + v.name + '：' + keys.length + ' 个不同动作');

    for (const key of keys) {
      const parts = key.split('|');
      const action = parts[0], id = parts[1], tab = parts[2];

      // 预览里"本来就测不出变化"的动作：mock 不持久化（改完立刻读回原样），
      // 或重拉的数据与当前一致。这些**不算按钮坏**，单列一栏说明，避免报告满屏狼来了。
      const unverifiable = {
        'refresh': '重拉同一章，内容不变 → 界面本就不会变',
        'refresh-projects': '重拉列表，mock 数据不变 → 界面本就不会变',
        'lore-toggle': '预览 mock 不持久化（PUT 后仍返回原列表）→ 只能验"点得通"，验不了结果',
        'lore-delete': '同上（DELETE 后仍返回原列表）',
      }[action];
      if (unverifiable) { lines.push('  \u25cb ' + key + ' —— 预览下无法判定：' + unverifiable); continue; }

      // 每次点击前回到该视图稳定态并**重新取元素**：
      // 面板重渲染后旧节点已脱离文档，拿着它点等于点空气（会假报「无反应」）
      await v.go();
      await sleep(210);
      frame.querySelectorAll('details').forEach((d) => { d.open = true; });
      await sleep(110);

      // 让点击"有意义"的前置：切标签/进设置这类，若已经停在目标态，点了当然没变化
      if (action === 'detail-tab') {
        const otherTab = tab === 'info' ? 'chapters' : 'info';
        const other = frame.querySelector('[data-action="detail-tab"][data-tab="' + otherTab + '"]');
        if (other) { other.click(); await sleep(300); }
      } else if (action === 'goto-settings') {
        await tour.list();
        await sleep(220);
      }

      let sel = '[data-action="' + CSS.escape(action) + '"]';
      if (id) sel += '[data-id="' + CSS.escape(id) + '"]';
      if (tab) sel += '[data-tab="' + CSS.escape(tab) + '"]';
      const el = frame.querySelector(sel);
      if (!el) { lines.push('  ? ' + key + ' —— 稳定态下找不到该元素（只在特定状态出现）'); missing++; continue; }
      if (el.disabled) { lines.push('  \u25cb ' + key + ' —— 处于 disabled（预期内：前置条件没满足，如"没在播放就不能停"）'); continue; }

      const before = panelSig();
      const errN = pageErrors.length;
      const hitN = delivered.length;
      try { el.click(); } catch (e) { pageErrors.push(action + ' → ' + e.message); }
      await sleep(340);
      const after = panelSig();
      const err = pageErrors.length > errN ? pageErrors[pageErrors.length - 1] : '';
      const hit = delivered.length > hitN;

      if (err) { lines.push('  ! ' + key + ' —— 抛错：' + err); thrown++; }
      else if (!hit) { lines.push('  ✗ ' + key + ' —— **点击没送达事件代理**（代理/层级问题）'); dead++; }
      else if (before === after) { lines.push('  ✗ ' + key + ' —— 已送达但界面无任何变化'); dead++; }
    }
  }
  lines.push('');
  lines.push('═══ 扫射结束：无反应 ' + dead + ' · 抛错 ' + thrown + ' · 未找到 ' + missing + ' ═══');
  out.textContent = lines.join('\\n');
  out.style.display = 'block';
  console.log('[sweep]', out.textContent);
  return out.textContent;
};

document.getElementById('tour').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-do]');
  if (!btn) return;
  const what = btn.dataset.do;
  const isView = what === 'theme' || what === 'w' || what === 'sweep';
  btn.classList.toggle('on', !isView);
  if (what === 'sweep') { await sweep(); return; }
  if (!isView) {
    // 每步都从「项目列表」重新出发 —— 否则在设置页点「润色」会点空，
    // 导览按钮就变成"有时灵有时不灵"（真机调试最烦这种）。
    await tour.list();
    await sleep(200);
    if (what !== 'list') { click('[data-action="open"][data-id="星海拾骨"]'); await sleep(500); }
  }
  const fn = tour[what];
  if (fn) { await fn(); await sleep(300); }
});
// 默认先打开第一本书，再顺手跑一次体检 —— 打开页面就能看到「有内容」的样子
setTimeout(() => { document.querySelector('[data-do="open"]').click(); }, 400);
setTimeout(() => { document.querySelector('[data-do="checkup"]').click(); }, 1500);
</script>
</body>
</html>
`;

// —— 自检：内联脚本必须能编译 ——
//
// 为什么必须查：这个页面是**模板字符串生成**的。页面里的 JS 若再嵌一层字符串，
// 很容易把 `\n` 写成单反斜杠 —— 展开后就是一个坏掉的字符串字面量，整段脚本解析失败、
// 页面**全白**，而生成命令照样打印「已生成」。0.13.0 加按钮扫射时就踩了这个，
// 浏览器里表现为「面板压根没渲染」，排查方向极易跑偏。宁可在这里当场失败。
const inlineScripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
for (const [i, m] of inlineScripts.entries()) {
	try {
		// 只编译不执行：语法错误会在这一步抛出
		new Function(m[1]); // eslint-disable-line no-new-func
	} catch (error) {
		console.error(`\u2717 预览页第 ${i + 1} 段内联脚本编译失败：${error.message}`);
		console.error('  （多半是模板字符串转义问题：页面 JS 里的 \\n 要写成 \\\\n）');
		process.exit(1);
	}
}

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, html);
const kb = (fs.statSync(outFile).size / 1024).toFixed(0);
console.log(`✓ ${path.relative(root, outFile)} 已生成 — ${kb} KB`);
console.log(`  ${themeNote}`);
console.log(`  ${reactNote}`);
console.log(`  内联脚本 ${inlineScripts.length} 段，编译检查通过`);
