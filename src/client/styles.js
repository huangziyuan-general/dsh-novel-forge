// src/client/styles.js — 面板的设计系统（唯一颜色/尺度来源）。
//
// 分三层，视图层只用第 ③ 层：
//   ① color  语义色（全部是**宿主真实存在**的 --dsw-alias-* 变量）
//   ② space / radius / font / weight / shadow  尺度
//   ③ card / btn / chip / field / meter / …  组件样式（函数式，按变体取）
//
// ⚠️ token 名不能凭感觉写（0.13.0 修正的一处真 bug）：
//   旧版用了 `--dsw-alias-accent-strong` / `accent-soft` / `label-danger` / `bg-primary`
//   四个名字 —— **宿主 token 表里根本没有它们**（只有 accent/danger 出现在
//   `interactive-bg-hover-accent` 这类交互态里）。于是每个 `var(...)` 都落到回退值上，
//   面板**永远按深色背景渲染**：在浅色主题里是一块深色糊字，这就是「太难看」的根因之一。
//   真实名字以 `dsh-client-ui-theme` 的导出为准（bg-layer-1/2/3、bg-overlay、
//   border-l1..l4、label-primary/secondary/tertiary/dimmed、link、state-*-primary、
//   button-primary-fill、label-primary-foreground、interactive-bg-hover）。
//   改这里的任何变量名之前，先去那个包里 grep 一遍。
//
// ⚠️⚠️ **名字存在 ≠ 用法正确**（0.13.1 修正的第二类事故，比上面更隐蔽）：
//   光核名字够不着下面这两种错——它们不报错、不错位，只是**难看**：
//     · `bg-overlay` 是**遮罩(scrim)色**（深色 #61666b 的中亮灰），
//       拿去当"输入框/胶囊底" → 深色主题里搜索框和所有胶囊糊成亮块；
//     · `label-dimmed` 是**表面**色（浅 #e1e5ee / 深 #43454a），
//       拿去当"最弱文字" → 两个主题里都等于看不见。
//   核名前先问一句：**这个 token 在宿主里是给什么用的？**
//   拿不准就用 `mix()` 按前景色自己染（见下），它是主题无关的。
//
// ⚠️ 回退值必须**双主题可用**（宿主没定义变量时也不能瞎）：
//   文字用 `inherit` / 半透明灰，边框与底色用 `rgba(128,128,128,α)`（浅底深底都看得见），
//   语义色用中调（#4d6bfe / #e08c00 / #e5484d / #2f9e44）。**不要写死 #1a1a1a 这类深色**。
//
// 另：不引入 CSS 文件、不引入新包。**几何**用内联样式对象；**外观与交互态**（hover /
// active / focus）由 `src/client/css.js` 生成一张样式表注入 —— 内联样式的优先级高于任何
// `:hover` 规则，外观留在内联里就永远做不出按下反馈。

/** 取宿主 token，带双主题可用的回退值。 */
const V = (name, fallback) => `var(--dsw-alias-${name}, ${fallback})`;

/**
 * 按宿主前景色染一层底：`color-mix(in srgb, var(--label-primary) N%, transparent)`。
 *
 * 为什么需要它（0.13.1 修的第二类 token 事故）：宿主的调色板是**平的**——
 * 浅色主题下 `bg-layer-1/2/3` 全是 `#fff`，想要「卡片里再嵌一层」的层次，
 * 光靠 layer token 取不出来。而 `label-primary` 在两套主题里正好是**反色**
 * （浅色 ≈ 近黑 `#0f1115`，深色 ≈ 近白 `#f9fafb`），
 * 于是「混 N% 前景色」在浅色下越混越灰、深色下越混越亮——**一套写法两个主题都成立**。
 */
const mix = (name, pct) => `color-mix(in srgb, ${V(name, 'currentColor')} ${pct}%, transparent)`;

// ── ① 语义色 ────────────────────────────────────────────────────────────────

export const color = {
	// 文字：四级（主/次/弱/更弱）；回退用 inherit（跟着宿主主题走）
	text: V('label-primary', 'inherit'),
	text2: V('label-secondary', 'rgba(128,128,128,.95)'),
	text3: V('label-tertiary', 'rgba(128,128,128,.82)'),
	// ⚠️ 这里曾写 `label-dimmed` —— 名字存在，但**它是"表面"色不是文字色**：
	//    浅色下 #e1e5ee、深色下 #43454a，两个主题里当文字都等于看不见。
	//    真正的"最弱文字"是 `label-caption`。
	textDim: V('label-caption', 'rgba(128,128,128,.7)'),
	/** 落在填充块上的文字（主按钮、阶段当前段）。 */
	onFill: V('label-primary-foreground', '#fff'),

	// 表面：卡片/面板沿用宿主 layer 层（与 dsh 其它界面一致）；
	// 「卡片里再嵌一层」（输入框、胶囊、进度槽、版本徽标）走 mix() 染色。
	// ⚠️ 这里曾用 `bg-overlay` 当内嵌底 —— 名字存在，但它是**遮罩(scrim)色**，
	//    深色下是 #61666b 的中亮灰：搜索框与所有胶囊在深色主题里糊成一片亮块，
	//    这正是「选了黑色主题配色不好看」的主因之一。
	base: V('bg-base', 'rgba(128,128,128,.02)'),
	surface1: V('bg-layer-1', 'rgba(128,128,128,.04)'),
	surface2: V('bg-layer-2', 'rgba(128,128,128,.07)'),
	surface3: V('bg-layer-3', 'rgba(128,128,128,.10)'),
	inset: mix('label-primary', 6),
	insetStrong: mix('label-primary', 10),
	hover: V('interactive-bg-hover', 'rgba(128,128,128,.12)'),
	/** 按下态（给 `:active` 用）。宿主有专门 token，比"hover 再深一档"更准。 */
	pressed: V('interactive-bg-active', 'rgba(128,128,128,.18)'),

	// 描边：四级。宿主值是半透明黑/白（#0000001f / #ffffff29），天然双主题
	border1: V('border-l1', 'rgba(128,128,128,.12)'),
	border2: V('border-l2', 'rgba(128,128,128,.18)'),
	border3: V('border-l3', 'rgba(128,128,128,.26)'),
	border4: V('border-l4', 'rgba(128,128,128,.34)'),

	// 语义：强调 / 成功 / 警告 / 危险
	accent: V('link', '#4d6bfe'),
	accentHover: V('interactive-bg-hover-accent', 'rgba(77,107,254,.12)'),
	ok: V('state-success-primary', '#2f9e44'),
	warn: V('state-warn-primary', '#e08c00'),
	danger: V('state-error-primary', '#e5484d'),
	/** 宿主主按钮填充（深色主题下是近白、浅色主题下是近黑——跟宿主按钮一致）。 */
	primaryFill: V('button-primary-fill', '#4d6bfe'),
	primaryHover: V('button-primary-hover', 'rgba(77,107,254,.86)'),

	// 字体族（宿主变量 + 本地回退）
	mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
};

/**
 * 半透明染色（软底 / 软描边）。用 color-mix 从语义色派生，**自动跟随主题**，
 * 不必为浅色深色各写一套 rgba。宿主 token 缺失时 color-mix 里的回退值仍生效。
 */
export const tint = (c, pct) => `color-mix(in srgb, ${c} ${pct}%, transparent)`;

// ── ② 尺度 ──────────────────────────────────────────────────────────────────

/** 间距刻度：只用这几个数，不要在视图里随手写 5px / 7px / 9px。 */
export const space = { xs: 4, sm: 6, md: 8, lg: 12, xl: 16, xxl: 20 };
/** 圆角刻度。 */
export const radius = { sm: 6, md: 8, lg: 12, pill: 999 };
/** 字号刻度。 */
export const font = { caption: 11, small: 12, body: 13, lead: 14, title: 15, hero: 18 };
export const weight = { normal: 400, medium: 500, semibold: 600, bold: 700 };

/** 面板根容器（宿主右侧栏的滚动区）。 */
export const rootStyle = {
	boxSizing: 'border-box', height: '100%', minHeight: 0,
	display: 'flex', flexDirection: 'column',
	color: color.text, fontSize: font.body, lineHeight: 1.6,
	background: 'transparent',
};

/** 内容滚动区（头部固定、内容滚动）。 */
export const bodyStyle = {
	flex: '1 1 auto', minHeight: 0, overflowY: 'auto',
	display: 'flex', flexDirection: 'column', gap: space.lg,
	padding: `${space.lg}px ${space.lg}px ${space.xxl}px`,
};

// ── ③ 组件样式 ──────────────────────────────────────────────────────────────

/** 面板头部：品牌块 + 标题/副题 + 右侧 chip 组。 */
export const headerStyle = {
	display: 'flex', alignItems: 'center', gap: space.md,
	padding: `${space.lg}px ${space.lg}px`,
	flex: '0 0 auto',
	borderBottom: `1px solid ${color.border2}`,
};

/** 头部品牌图标块（28×28 圆角方块，染色底）。 */
export const brandMarkStyle = {
	flex: 'none', width: '28px', height: '28px', borderRadius: radius.md,
	display: 'flex', alignItems: 'center', justifyContent: 'center',
	fontSize: '15px', background: tint(color.accent, 14),
};

/** 头部标题（一行：标题 + 版本 chip）。 */
export const titleStyle = { fontWeight: weight.bold, fontSize: font.title, letterSpacing: '.2px' };
/** 头部副题（当前书名 / 会话范围）。 */
export const subtitleStyle = { color: color.text3, fontSize: font.caption, marginTop: '1px' };

/** 版本 chip。 */
export const badgeStyle = {
	flex: 'none', padding: '1px 7px', borderRadius: radius.pill,
	background: color.inset, color: color.text2,
	fontSize: font.caption, fontFamily: color.mono, lineHeight: '16px',
};

/** 区块标题（比正文重一档 + 上间距，不用再加一行灰字注释）。 */
export const sectionTitleStyle = {
	display: 'flex', alignItems: 'center', gap: space.sm,
	fontWeight: weight.semibold, fontSize: font.small, color: color.text2,
	marginTop: space.xs,
};

/**
 * 卡片。`tone` 决定描边与底色，`pad` 覆盖内边距。
 * 不用阴影（宿主右侧栏本来就是浅浮层，阴影在浅色主题下会脏）。
 */
export const card = ({ tone = 'plain', pad = space.lg } = {}) => {
	const tones = {
		plain: { border: color.border2, background: color.surface1 },
		inset: { border: color.border2, background: color.inset },
		accent: { border: tint(color.accent, 30), background: tint(color.accent, 8) },
		warn: { border: tint(color.warn, 34), background: tint(color.warn, 10) },
		danger: { border: tint(color.danger, 30), background: tint(color.danger, 8) },
		ok: { border: tint(color.ok, 30), background: tint(color.ok, 8) },
	};
	const t = tones[tone] ?? tones.plain;
	return {
		flex: 'none', boxSizing: 'border-box',
		border: `1px solid ${t.border}`, background: t.background,
		borderRadius: radius.lg, padding: `${pad}px`,
	};
};

/**
 * 按钮**几何**（尺寸/内边距/字体/圆角）。
 *
 * ⚠️ 外观（底色/描边/字色）**故意不在这里**，一律由 `src/client/css.js` 的外观表驱动：
 * 内联样式的优先级**高于任何 `:hover` / `:active` 选择器规则** —— 外观一旦写死在内联里，
 * 按钮就永远不会有悬停与按下反馈。0.13.1 修的正是这个（刷新 / 导入本地书点了没反应）。
 */
export const btnLayout = ({ size = 'md' } = {}) => ({
	flex: 'none', display: 'inline-flex', alignItems: 'center', gap: '4px',
	justifyContent: 'center', fontFamily: 'inherit', fontWeight: weight.medium,
	cursor: 'pointer', borderRadius: radius.md, boxSizing: 'border-box',
	fontSize: size === 'sm' ? font.caption : font.small,
	padding: size === 'sm' ? '2px 7px' : '4px 10px',
	lineHeight: size === 'sm' ? '16px' : '18px',
	whiteSpace: 'nowrap',
	// 底/描边/字色**故意留空**：由 css.js 按 data-variant 给（含 hover/active）。
	// 这里若写死，内联优先级会压掉所有交互态。
});

/** 尺寸快照（供预览/直用；键与 `data-size` 同值）。 */
export const btnSizes = { sm: btnLayout({ size: 'sm' }), md: btnLayout({ size: 'md' }) };

/**
 * 按钮**外观**表：每个变体给 rest / hover / active 三态。
 * `css.js` 把它编译成 `[data-nf-btn][data-variant="…"]:hover{…}` 这类规则。
 * primary 的三态直接用宿主成套 token（fill / hover / dimmed），不自创。
 */
export const btnSkin = {
	primary: {
		rest: { background: color.primaryFill, color: color.onFill, borderColor: 'transparent' },
		hover: { background: V('button-primary-hover', 'rgba(77,107,254,.86)'), color: color.onFill },
		active: { background: V('button-primary-dimmed', color.primaryFill), color: color.onFill },
	},
	secondary: {
		rest: { background: color.inset, color: color.text, borderColor: color.border2 },
		hover: { background: color.hover, borderColor: color.border3 },
		active: { background: color.pressed, borderColor: color.border4 },
	},
	ghost: {
		rest: { background: 'transparent', color: color.text2, borderColor: 'transparent' },
		hover: { background: color.hover, color: color.text },
		active: { background: color.pressed, color: color.text },
	},
	accent: {
		rest: { background: tint(color.accent, 10), color: color.accent, borderColor: tint(color.accent, 40) },
		hover: { background: tint(color.accent, 18), borderColor: tint(color.accent, 60) },
		active: { background: tint(color.accent, 26), borderColor: tint(color.accent, 70) },
	},
	danger: {
		rest: { background: tint(color.danger, 10), color: color.danger, borderColor: tint(color.danger, 40) },
		hover: { background: tint(color.danger, 18), borderColor: tint(color.danger, 60) },
		active: { background: tint(color.danger, 26), borderColor: tint(color.danger, 70) },
	},
};

export const BTN_VARIANTS = ['primary', 'secondary', 'ghost', 'accent', 'danger'];

/**
 * 兼容旧调用：几何 + rest 外观的**静态快照**（没有交互态）。
 * 只在「不是按钮」或非浏览器上下文里用；界面上一律走 `ui.js` 的 `Btn`。
 */
export const btn = ({ variant = 'secondary', size = 'md' } = {}) => ({
	...btnLayout({ size }),
	...(btnSkin[variant] ?? btnSkin.secondary).rest,
});

/** 小胶囊标签。tone: neutral | accent | ok | warn | danger | ink。 */
export const chip = ({ tone = 'neutral' } = {}) => {
	const tones = {
		neutral: { background: color.inset, color: color.text3 },
		accent: { background: tint(color.accent, 14), color: color.accent },
		ok: { background: tint(color.ok, 14), color: color.ok },
		warn: { background: tint(color.warn, 16), color: color.warn },
		danger: { background: tint(color.danger, 14), color: color.danger },
		ink: { background: color.text, color: color.base },
	};
	const t = tones[tone] ?? tones.neutral;
	return {
		flex: 'none', display: 'inline-flex', alignItems: 'center', gap: '3px',
		padding: '0 6px', borderRadius: radius.pill, fontSize: font.caption,
		lineHeight: '16px', whiteSpace: 'nowrap', ...t,
	};
};

/** 输入框 / 文本域 / 下拉（同一套外框）。 */
export const field = ({ mono = false } = {}) => ({
	boxSizing: 'border-box', width: '100%',
	padding: '5px 8px', borderRadius: radius.md,
	border: `1px solid ${color.border3}`, background: color.inset,
	color: color.text, fontFamily: mono ? color.mono : 'inherit',
	fontSize: font.small, lineHeight: 1.6, outline: 'none',
});

export const inputStyle = field();

/** 稿纸区（本章正文编辑）：字号与行高按读稿调，不是按聊天框调。 */
export const manuscriptStyle = {
	...field({ mono: false }),
	minHeight: '180px', resize: 'vertical',
	fontSize: font.small, lineHeight: 1.85, letterSpacing: '.2px',
};

/** 进度/占比条（体检通过率、字数等）。 */
export const meterTrackStyle = {
	flex: '1 1 auto', height: '4px', borderRadius: radius.pill,
	background: color.inset, overflow: 'hidden', minWidth: '40px',
};
export const meterFillStyle = (pct, tone = 'accent') => ({
	height: '100%', borderRadius: radius.pill,
	width: `${Math.max(0, Math.min(100, pct))}%`,
	background: tone === 'ok' ? color.ok : tone === 'warn' ? color.warn : tone === 'danger' ? color.danger : color.accent,
});

/** 键值行（设置/档案用）。 */
export const rowStyle = { display: 'flex', alignItems: 'flex-start', gap: space.md, flex: 'none' };
export const kStyle = {
	flex: 'none', minWidth: '58px', fontFamily: color.mono, fontSize: font.caption,
	color: color.text3, paddingTop: '2px',
};
export const vStyle = { flex: 'auto', minWidth: 0, wordBreak: 'break-word', fontSize: font.small };

/** 提示与状态文案。 */
export const hintStyle = { color: color.text3, fontSize: font.small };
export const errStyle = {
	flex: 'auto', minWidth: 0, color: color.danger, fontSize: font.small,
	wordBreak: 'break-word', lineHeight: 1.6,
};
export const okStyle = { color: color.ok, fontSize: font.small };
/** 警告类状态文案（门禁提示等）：比红字轻、比绿字认真。 */
export const warnStyle = {
	flex: 'auto', minWidth: 0, color: color.warn, fontSize: font.small,
	wordBreak: 'break-word', lineHeight: 1.6,
};

/**
 * 空态：图标 + 一句主文案 + 可选的次文案/动作。
 * 视图里直接 `emptyState({ icon, title, hint, action })`，别再现写灰字。
 */
export const emptyStateStyle = {
	display: 'flex', flexDirection: 'column', alignItems: 'center', gap: space.sm,
	padding: `${space.xl}px ${space.lg}px`, textAlign: 'center',
	border: `1px dashed ${color.border2}`, borderRadius: radius.lg,
	background: color.surface1,
};
export const emptyIconStyle = { fontSize: '20px', lineHeight: 1, opacity: .85 };
export const emptyTitleStyle = { fontSize: font.small, color: color.text2 };

/** 底部说明。 */
export const footerStyle = {
	margin: 0, color: color.textDim, fontSize: font.caption,
	flex: 'none', lineHeight: 1.7,
};

/** 元素列表容器（统一竖向节奏）。 */
export const stackStyle = (gap = space.sm) => ({ display: 'flex', flexDirection: 'column', gap: `${gap}px` });
/** 横向按钮/胶囊行。 */
export const rowWrapStyle = (gap = space.sm) => ({
	display: 'flex', alignItems: 'center', gap: `${gap}px`, flexWrap: 'wrap',
});
/** 撑开剩余空间（把后面的东西推到右边）。 */
export const spacerStyle = { flex: '1 1 auto', minWidth: 0 };

// ── 兼容别名（0.12 之前的导出名，视图正在逐个迁移；新代码别再用）────────────
export const itemCardStyle = card();
export const miniBtnStyle = btn({ size: 'sm' });
export const dangerBtnStyle = btn({ variant: 'danger' });
export const primaryBtnStyle = btn({ variant: 'primary' });
export const accentBtnStyle = btn({ variant: 'accent' });
export const emptyStyle = { color: color.text3 };
