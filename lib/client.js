window.__ModuleLoader__.load({
	id: "dsh-novel-forge",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");

		/** 面板上显示的版本号；由 test/client.test.mjs 断言与 package.json 同步，禁止手改失联。 */
		const PLUGIN_VERSION = "0.3.7";

		// ── 面板样式（内联，避免对 dsh-client-ui-primitives 的 API 做猜测） ──
		const root = {
			boxSizing: "border-box",
			height: "100%",
			minHeight: 0,
			display: "flex",
			flexDirection: "column",
			gap: "8px",
			padding: "12px 12px 16px",
			overflow: "auto",
			color: "var(--dsw-alias-label-primary, #e6e6e6)",
			fontSize: "13px",
			lineHeight: 1.6,
		};
		const head = {
			display: "flex",
			alignItems: "baseline",
			gap: "8px",
			flex: "none",
		};
		const badge = {
			flex: "none",
			padding: "1px 8px",
			borderRadius: "999px",
			background: "var(--dsw-alias-accent-soft, rgba(80,120,255,.18))",
			color: "var(--dsw-alias-accent-strong, #8ab4ff)",
			fontSize: "11px",
		};
		const sub = {
			color: "var(--dsw-alias-label-secondary, #9aa0aa)",
			fontSize: "12px",
			margin: "0",
			flex: "none",
		};
		const card = {
			flex: "none",
			border: "1px solid var(--dsw-alias-border-l3, #333)",
			borderRadius: "10px",
			padding: "10px 12px",
			background: "var(--dsw-alias-bg-overlay, transparent)",
		};
		const row = { display: "flex", alignItems: "flex-start", gap: "8px", flex: "none" };
		const k = {
			flex: "none",
			minWidth: "56px",
			fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
			fontSize: "11px",
			color: "var(--dsw-alias-label-secondary, #9aa0aa)",
			paddingTop: "2px",
		};
		const v = { flex: "auto", minWidth: 0, wordBreak: "break-word" };
		const mono = {
			flex: "auto",
			minWidth: 0,
			fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
			fontSize: "11px",
			wordBreak: "break-all",
			lineHeight: 1.5,
			color: "var(--dsw-alias-label-secondary, #9aa0aa)",
		};
		const errStyle = {
			flex: "auto",
			minWidth: 0,
			color: "var(--dsw-alias-label-danger, #ff8a8a)",
			fontSize: "11.5px",
			wordBreak: "break-word",
		};
		const cardTitle = {
			fontSize: "11px",
			textTransform: "uppercase",
			letterSpacing: ".08em",
			color: "var(--dsw-alias-label-tertiary, #6b7280)",
			margin: "0 0 6px",
			flex: "none",
		};
		const footer = {
			margin: "0",
			color: "var(--dsw-alias-label-tertiary, #6b7280)",
			fontSize: "11px",
			flex: "none",
		};
		const btn = {
			flex: "none",
			background: "transparent",
			border: "1px solid var(--dsw-alias-border-l3, #333)",
			borderRadius: "6px",
			color: "var(--dsw-alias-label-secondary, #9aa0aa)",
			fontSize: "11px",
			padding: "2px 8px",
			cursor: "pointer",
			fontFamily: "inherit",
		};

		/** 右侧 tab 的 chip 标题。 */
		function ForgeTitle() {
			return react.createElement("span", { style: { whiteSpace: "nowrap" } },
				react.createElement("span", { style: { marginRight: "4px" } }, "🔨"),
				"锻炉");
		}

		/**
		 * 探测一次 Client Remote 的实际装配情况。
		 *
		 * 目的：右侧栏面板要显示书目/账本/基线，数据全在工作区文件里；这些文件只能经
		 * `remote.workspaceFiles` 读。而 Remote 域是「按 Client assembly 装配」的
		 * （`ClientRemote extends TypertRemoteNamespaceMap` —— 各包声明合并，没有静态全清单），
		 * 所以**必须先探运行时**再决定数据面怎么写，避免产出不可验证的死代码。
		 *
		 * 全程 try/catch：任何一步失败都作为诊断信息回传，绝不让面板崩掉。
		 *
		 * @param remote - `ctx.remote`（可能 undefined：inject 未生效时）。
		 * @param sessionId - 本 tab 所属会话 id（由 slot 的 inject 工厂注入）。
		 * @returns 探测结果（纯数据，便于断言）。
		 */
		async function probeRemote(remote, sessionId) {
			const out = {
				sessionId: sessionId || null,
				domains: [],
				host: null,
				rootEntries: null,
				rootError: null,
				fatal: null,
			};
			if (!remote) {
				out.fatal = "ctx.remote 不可用 —— inject 未声明 remote？";
				return out;
			}
			try {
				out.domains = Object.keys(remote).filter((n) => !n.startsWith("$"));
			} catch (e) {
				out.fatal = "读取 remote 域清单失败：" + (e && e.message);
				return out;
			}
			try {
				const h = remote.$host;
				if (h) out.host = { home: h.home || null, isLoopback: h.isLoopback };
			} catch (e) { /* $host 缺席不影响主流程 */ }

			const wf = remote.workspaceFiles;
			if (!wf) {
				out.rootError = "remote 未装配 workspaceFiles 域（域清单见下）";
				return out;
			}
			if (!sessionId) {
				out.rootError = "未拿到 sessionId，无法定位工作区";
				return out;
			}
			// list 的参数形态经实测确定：`list(sessionId, path, signal)`（2 个业务实参 + 可选 signal）；
			// 且 `path` 不能是空串（`path is required`）。根的取法：传入**工作区绝对根**。
			// `$host.home` 正是这个绝对根（连接侧 fixture 里 host.home == WORKSPACE_FILES_ROOT），
			// 服务端把它归一化成工作区相对根再查树。所以优先用 host.home 作为根路径，
			// 拿不到 home 时才退回空串（仅作诊断）。
			const home = (out.host && out.host.home) || "";
			const attempts = [];
			if (home) {
				attempts.push(["(sessionId, home)", () => wf.list(sessionId, home, undefined)]);
				attempts.push(["(sessionId, home)≤2", () => wf.list(sessionId, home)]);
				attempts.push(["(sessionId, {path:home})", () => wf.list(sessionId, { path: home })]);
			}
			attempts.push(["(sessionId, \"\")", () => wf.list(sessionId, "", undefined)]);
			const tried = [];
			for (const [label, call] of attempts) {
				try {
					const res = await call();
					if (res && res.ok) {
						out.rootEntries = {
							via: label,
							listing: res.value,
						};
						return out;
					}
					tried.push(label + " → " + describeFailure(res));
				} catch (e) {
					tried.push(label + " → 抛错 " + (e && e.message));
				}
			}
			out.rootError = "列目录四种形态均失败：" + tried.join("；");
			return out;
		}

		/** 把一次 Remote 失败压成一行可读文本。 */
		function describeFailure(res) {
			if (!res) return "无返回";
			if (res.ok === false && res.error) {
				return (res.error.code || "错误") + (res.error.message ? "：" + res.error.message : "");
			}
			return JSON.stringify(res).slice(0, 120);
		}

		/** 紧凑版书目摘要（client.js 内联，供无 import 的浏览器半使用）。
		 *  必须与 lib/book-console.js 的 summarizeBook 产出同口径（headless parity 断言锁定）。
		 *  只取面板要展示的少数几个量化字段，非法/缺失一律降级不抛。 */
		function summarizeBookClient({ name, novel = null, facts = null, foreshadows = null, style = null } = {}) {
			let bad = null;
			function parse(text) {
				if (text === null || text === undefined) return null;
				try { return JSON.parse(text); } catch (e) { return { __bad: e && e.message }; }
			}
			const nj = parse(novel);
			let title = name, stage = null, chapters = null, approved = null;
			if (nj && typeof nj === "object" && !nj.__bad) {
				title = nj.title || name;
				stage = nj.stage || null;
				if (nj.chapters && typeof nj.chapters === "object") chapters = Object.keys(nj.chapters).length;
				if (nj.approvals && nj.approvals.outline && typeof nj.approvals.outline === "object") approved = Object.keys(nj.approvals.outline).length;
			} else if (nj && nj.__bad) bad = "novel.json 非法 JSON";
			const fj = parse(facts);
			const factsCount = Array.isArray(fj) ? fj.length : 0;
			const vj = parse(foreshadows);
			let total = 0, open = 0;
			if (Array.isArray(vj)) {
				total = vj.length;
				open = vj.filter((f) => f && !Number.isInteger(f.payoffChapter)).length;
			}
			const sj = parse(style);
			const styleBuilt = !!(sj && typeof sj === "object" && !sj.__bad && sj.baseline && sj.baseline.dims);
			return { name, title, stage, chapters, approved, facts: factsCount, foreshadows: { total, open }, styleBuilt, error: bad };
		}

		/**
		 * 读盘探针：对一个书目目录读取 4 个机器文件（novel/facts/伏笔/style-baseline）。
		 * `list` 已收敛出书目录名后调用；`read` 的精确形态同样按多形态降级逐一尝试，
		 * 能读到文本就顺手 parse 成 control 摘要——把"读盘签名"和"数据渲染"一次收敛。
		 * 全程 try/catch，任何失败都原样带错，绝不伪造、绝不冒泡打断面板。
		 */
		async function probeReadBook(wf, sessionId, bookName) {
			const out = { book: bookName, files: {}, readForm: null, readError: null, summary: null };
			if (!wf || typeof wf.read !== "function") {
				out.readError = "workspaceFiles.read 不可用";
				return out;
			}
			const specs = [
				["novel", bookName + "/novel.json"],
				["facts", bookName + "/账本/facts.json"],
				["foreshadows", bookName + "/账本/伏笔.json"],
				["style", bookName + "/.novel/style-baseline.json"],
			];
			const forms = [
				(p) => wf.read(sessionId, p),            // (sessionId, path) 最小业务实参，最稳
				(p) => wf.read(sessionId, p, undefined), // 带 3 参（range/signal 补位）
				(p) => wf.read(sessionId, { path: p }),
				(p) => wf.read({ sessionId: sessionId, path: p }),
			];
			const failures = [];
			for (const [kind, rel] of specs) {
				let text = null, lastErr = null;
				for (let i = 0; i < forms.length; i++) {
					try {
						const res = await forms[i](rel);
						const val = (res && res.ok === false) ? null : (res && res.value !== undefined ? res.value : res);
						if (typeof val === "string") { text = val; if (out.readForm === null) out.readForm = kind + "@" + i; break; }
					} catch (e) { lastErr = (e && e.message) || "抛错"; }
				}
				if (text === null) failures.push(kind + ": " + lastErr);
				else out.files[kind] = text;
			}
			if (failures.length) out.readError = failures.join("；");
			// 一篇都没读到 → 不给面板造幽灵书目，只留 readError
			if (Object.keys(out.files).length) {
				out.summary = summarizeBookClient({
					name: bookName,
					novel: out.files.novel ?? null,
					facts: out.files.facts ?? null,
					foreshadows: out.files.foreshadows ?? null,
					style: out.files.style ?? null,
				});
			}
			return out;
		}

		/**
		 * 右侧 "锻炉" tab 的面板：静态识别面 + 运行时数据面探测。
		 *
		 * 数据面走「渐进增强」：静态部分先渲染，remote 探测结果异步补上；
		 * 探测失败只降级显示错误，不影响 tab 可用。
		 *
		 * @param props - slot 注入的 `{ sessionId, actions }`。
		 */
		function ForgePanel(props) {
			const sessionId = props && props.sessionId;
			const [probe, setProbe] = react.useState(null);
			const [books, setBooks] = react.useState(null);

			react.useEffect(() => {
				let alive = true;
				probeRemote(getRemote(), sessionId).then((result) => {
					if (!alive) return;
					console.info("[dsh-novel-forge] remote 探测完成", result);
					setProbe(result);
					// 探测出工作区后可读的书目录后，顺手读盘出每本书的控制台摘要
					return loadBookConsole(getRemote(), sessionId, result).then((bs) => {
						if (!alive) return;
						setBooks(bs);
					});
				}, (e) => {
					if (!alive) return;
					console.warn("[dsh-novel-forge] remote 探测异常", e);
					setProbe({ fatal: "探测抛错：" + (e && e.message), domains: [] });
				});
				return () => { alive = false; };
			}, [sessionId]);

			const children = [
				react.createElement("div", { key: "head", style: head },
					react.createElement("div", { style: Object.assign({ fontWeight: 600, flex: "none" }) }, "小说锻炉"),
					react.createElement("span", { style: badge }, "v" + PLUGIN_VERSION)),
				react.createElement("p", { key: "sub", style: sub },
					"dsh-novel-forge · 代码强制的长篇写作硬约束。"),
				react.createElement("div", { key: "static", style: card },
					react.createElement("div", { style: row },
						react.createElement("span", { style: k }, "tools"),
						react.createElement("span", { style: v }, "17 个 novel_* 工具已注册")),
					react.createElement("div", { style: row },
						react.createElement("span", { style: k }, "channels"),
						react.createElement("span", { style: v }, "宿主 + MCP 双通道")),
					react.createElement("div", { style: row },
						react.createElement("span", { style: k }, "guides"),
						react.createElement("span", { style: v }, "账本 / 门禁 / 机审 / 提案"))),
				renderBooks(books),
				react.createElement("div", { key: "probe", style: card },
					react.createElement("p", { style: cardTitle }, "数据面探测"),
					renderProbe(probe, sessionId)),
				react.createElement("p", { key: "foot", style: footer },
					"在会话中调用 novel_* 工具驱动；本卡显示 Client Remote 的运行时装配与书目数据面。"),
			];
			return react.createElement("div", { style: root }, children);
		}

		/** 枚举工作区里的书目录，逐个读盘出控制台摘要（read 签名已由 probeReadBook 多形态收敛）。 */
		async function loadBookConsole(remote, sessionId, probe) {
			const wf = remote && remote.workspaceFiles;
			const listing = probe && probe.rootEntries && probe.rootEntries.listing;
			const entries = (listing && listing.entries) || [];
			const dirs = entries.filter((x) => x && x.type === "directory" && x.name).map((x) => x.name);
			const out = [];
			for (const d of dirs.slice(0, 12)) out.push(await probeReadBook(wf, sessionId, d));
			return out;
		}

		/** 渲染书目控制台卡：每本一行的量化摘要；缺失/读盘失败降级不崩。 */
		function renderBooks(books) {
			if (books === null) return null;
			if (!books.length) {
				return react.createElement("div", { key: "books", style: card },
					react.createElement("p", { style: cardTitle }, "书目"),
					react.createElement("div", { style: row },
						react.createElement("span", { style: k }, "workspace"),
						react.createElement("span", { style: v }, "未发现书目目录")));
			}
			const rows = books.map((b) => {
				const s = b.summary;
				const line = s
					? react.createElement("span", { style: { flex: "auto", minWidth: 0, wordBreak: "break-word" } },
						(s.title || b.book) + (s.stage ? " · " + s.stage : "")
						+ (s.chapters ? " · " + s.chapters + " 章" : "")
						+ (s.approved ? " · ✓" + s.approved + " 细纲" : "")
						+ " · 账本 " + s.facts + " · 伏笔 " + s.foreshadows.open + "/" + s.foreshadows.total
						+ (s.styleBuilt ? " · 有基线" : ""))
					: react.createElement("span", { style: errStyle }, b.book + "（无摘要）");
				const err = b.readError
					? react.createElement("div", { style: row },
						react.createElement("span", { style: k }, "read"),
						react.createElement("span", { style: errStyle }, b.readError))
					: null;
				return react.createElement(react.Fragment, { key: b.book },
					react.createElement("div", { style: row }, line),
					err);
			});
			return react.createElement("div", { key: "books", style: card },
				react.createElement("p", { style: cardTitle }, "书目（" + books.length + "）"),
				rows);
		}

		/** 渲染探测结果；未完成时显示进行中。 */
		function renderProbe(probe, sessionId) {
			if (!probe) return react.createElement("div", { style: mono }, "探测中…");
			const lines = [];
			if (probe.fatal) {
				lines.push(react.createElement("div", { key: "f", style: row },
					react.createElement("span", { style: k }, "fatal"),
					react.createElement("span", { style: errStyle }, probe.fatal)));
			}
			lines.push(react.createElement("div", { key: "s", style: row },
				react.createElement("span", { style: k }, "session"),
				react.createElement("span", { style: mono }, sessionId || "（未注入）")));
			if (probe.host) {
				lines.push(react.createElement("div", { key: "h", style: row },
					react.createElement("span", { style: k }, "host"),
					react.createElement("span", { style: mono },
						(probe.host.isLoopback ? "loopback " : "remote ") + (probe.host.home || "?"))));
			}
			lines.push(react.createElement("div", { key: "d", style: row },
				react.createElement("span", { style: k }, "domains"),
				react.createElement("span", { style: mono },
					probe.domains.length
						? probe.domains.length + " 个：" + probe.domains.join(", ")
						: "（空）")));
			if (probe.rootEntries) {
				const listing = probe.rootEntries.listing || {};
				const entries = listing.entries || [];
				lines.push(react.createElement("div", { key: "r", style: row },
					react.createElement("span", { style: k }, "workspace"),
					react.createElement("span", { style: mono },
						"经 " + probe.rootEntries.via + " 列出 " + entries.length + " 项"
						+ (listing.truncated ? "（已截断）" : "")
						+ "：" + entries.map((x) => x.name + (x.type === "directory" ? "/" : "")).join("  "))));
			}
			if (probe.rootError) {
				lines.push(react.createElement("div", { key: "e", style: row },
					react.createElement("span", { style: k }, "根目录"),
					react.createElement("span", { style: errStyle }, probe.rootError)));
			}
			return lines;
		}

		/** 由 apply 注入的 ctx 引用（面板在 slot 内渲染，拿不到 ctx，用闭包桥接）。 */
		let liveCtx = null;
		function getRemote() {
			try { return liveCtx ? liveCtx.remote : null; } catch (e) { return null; }
		}

		/** 右侧 tab 的标识/类型：同时是内容 seat 的 key（sidebarRightTabs 按 id 派发）。 */
		const FORGE_TAB_ID = "novel-forge";
		/** 该 tab 类型所在 kind（唯一，不与他屏碰撞）。 */
		const FORGE_TAB_KIND = "novel-forge";

		/** 声明的 client 服务：槽注册表 + tab 类型注册表 + 导航面（自动打开用）+ 远程数据面。
		 *  注意 `"remote.workspaceFiles"` 子域必须单独声明，否则访问 `ctx.remote.workspaceFiles`
		 *  会被 remote Proxy 挡住（报 cannot get property … without inject）——工作区文件是
		 *  数据面的唯一读盘通道，缺它整块数据面都起不来。对齐 sidebar-files/documentpreview。 */
		const inject = ["slots", "sidebarRightTabs", "sidebarRight", "remote", "remote.workspaceFiles"];

		/**
		 * 第一阶段：tab 类型的静态定义（「是什么」）。
		 *
		 * 不声明 `patterns` ⇒ 这是一个**页面类型**（page type），由 kind 打开、
		 * 不认领任何地址；再补一个 `guide` 条目，右侧栏的 guide 页就会出现
		 * 「🔨 锻炉」入口（guide 是常驻 docked 页，用户任何 session 都能从这里点开）。
		 */
		function forgeDefinition() {
			return {
				id: FORGE_TAB_ID,
				kind: FORGE_TAB_KIND,
				title: () => "锻炉",
				guide: [{
					order: 100,
					title: () => "🔨 锻炉",
					description: () => "小说锻炉：账本 / 门禁 / 机审 / 提案"
				}]
			};
		}

		/**
		 * 客户端插件主体：三件事，缺一不可。
		 *
		 * ① 阶段一 `sidebarRightTabs.register` —— 声明「锻炉」这个 tab 类型
		 * （只声明类型不会产生 tab）；
		 * ② 阶段二 把 tab 面板与 chip 标题注册进对应 seat，key 用同一 tab id；
		 *    面板的 `inject: (sessionId, actions) => …` 是**拿到会话 id 的官方姿势**
		 *    （对齐 dsh-client-ui-sidebar-documentpreview），数据面靠它定位工作区；
		 * ③ `sidebarRight.openTab(kind)` —— 只有这样才会真正**打开**这个 tab。
		 * 右侧栏的每个入口都是 openResource/openTab 调用，没有第 ③ 步，
		 * 类型注册得再对右侧栏也不会多出一格。
		 *
		 * 第 ③ 步的时序：openTab 走的是「已挂载 seat 的绑定」，页面刚加载时 seat
		 * 还没挂上，此时调用会**直接抛错**（引擎设计如此：没有 session 可操作时
		 * 宁可报错也不静默写进没人画的 surface）。所以这里轮询重试，挂上即开、
		 * 开成即停，用户手动关掉后不再重开。
		 */
		function apply(ctx) {
			liveCtx = ctx;

			ctx.effect(() => ctx.sidebarRightTabs.register(forgeDefinition()),
				"dsh-novel-forge: forge tab type");
			ctx.effect(() => ctx.slots.inject("sidebar.right.pane.tab",
				() => ctx.slots.register({
					name: "sidebar.right.pane.tab",
					key: FORGE_TAB_ID,
					inject: (sessionId, actions) => ({ sessionId: sessionId, actions: actions })
				}, ForgePanel)),
				"dsh-novel-forge: forge pane");
			ctx.effect(() => ctx.slots.inject("sidebar.right.pane.tab.title",
				() => ctx.slots.register({ name: "sidebar.right.pane.tab.title", key: FORGE_TAB_ID }, ForgeTitle)),
				"dsh-novel-forge: forge tab title");

			// ③ 打开 tab：seat 未挂载时会抛，按 250ms 节拍重试（上限 ~30s），开成即停。
			//    窗口给宽是故意的：右侧栏若被折叠，seat 可能尚未挂载，用户展开前我们一直在等。
			let cancelled = false;
			let opened = false;
			let tries = 0;
			const MAX_TRIES = 120;
			function attemptOpen() {
				if (cancelled || opened) return;
				try {
					ctx.sidebarRight.openTab(FORGE_TAB_KIND);
					opened = true;
					console.info("[dsh-novel-forge] 已打开右侧栏「锻炉」tab");
				} catch (err) {
					tries += 1;
					if (tries === 1) {
						console.info("[dsh-novel-forge] 右侧栏 seat 尚未挂载，重试中…", err && err.message);
					}
					if (tries < MAX_TRIES) setTimeout(attemptOpen, 250);
					else console.warn("[dsh-novel-forge] 自动打开失败，可从右侧栏 guide 页点「🔨 锻炉」进入", err);
				}
			}
			const bootTimer = setTimeout(attemptOpen, 400);
			ctx.effect(() => () => { cancelled = true; clearTimeout(bootTimer); });
		}

		exports.inject = inject;
		exports.apply = apply;
		// 仅供 test/client.test.mjs 的 headless 门禁使用：数据面探测是纯逻辑（无 DOM、
		// 无 React），放进这里就能在无浏览器环境确定性测住"四种调用形态降级 + 错误聚合"。
		// 加前缀 __ 表示非插件对外契约，宿主不会读它。
		exports.__internals = {
			probeRemote: probeRemote,
			probeReadBook: probeReadBook,
			summarizeBookClient: summarizeBookClient,
			PLUGIN_VERSION: PLUGIN_VERSION
		};
		return module.exports;
	}
});
