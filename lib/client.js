window.__ModuleLoader__.load({
	id: "dsh-novel-forge",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");

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
		const row = { display: "flex", alignItems: "center", gap: "8px", flex: "none" };
		const k = {
			flex: "none",
			fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
			fontSize: "11px",
			color: "var(--dsw-alias-label-secondary, #9aa0aa)",
		};
		const footer = {
			margin: "0",
			color: "var(--dsw-alias-label-tertiary, #6b7280)",
			fontSize: "11px",
			flex: "none",
		};

		/**
		 * 右侧 tab 的 chip 标题。
		 */
		function ForgeTitle() {
			return react.createElement("span", { style: { whiteSpace: "nowrap" } },
				react.createElement("span", { style: { marginRight: "4px" } }, "🔨"),
				"锻炉");
		}

		/**
		 * 右侧 "锻炉" tab 的面板本体（v1 静态识别面，证明 client 挂载）。
		 * 数据接入（书目/账本/基线…）在后续里程碑经由 remote 拉取服务器工具态。
		 */
		function ForgePanel() {
			return react.createElement("div", { style: root },
				react.createElement("div", { style: head },
					react.createElement("div", { style: Object.assign({ fontWeight: 600, flex: "none" }) }, "小说锻炉"),
					react.createElement("span", { style: badge }, "v0.3.0")),
				react.createElement("p", { style: sub }, "dsh-novel-forge · 代码强制的长篇写作硬约束。"),
				react.createElement("div", { style: card },
					react.createElement("div", { style: row },
						react.createElement("span", { style: k }, "tools"),
						react.createElement("span", { style: { flex: "auto" } }, "17 个 novel_* 工具已注册")),
					react.createElement("div", { style: row },
						react.createElement("span", { style: k }, "channels"),
						react.createElement("span", { style: { flex: "auto" } }, "宿主 + MCP 双通道")),
					react.createElement("div", { style: row },
						react.createElement("span", { style: k }, "guides"),
						react.createElement("span", { style: { flex: "auto" } }, "账本 / 门禁 / 机审 / 提案"))),
				react.createElement("p", { style: footer },
					"在会话中调用 novel_* 工具即可驱动。控制台数据面将在下一里程碑接入。"));
		}

		/** 声明的 client 服务：仅需 UI 槽注册表。 */
		const inject = ["slots"];

		/**
		 * 客户端插件主体：把两个槽位（tab 面板 + tab 标题）注册进右侧栏。
		 * 注册惯用法对齐 dsh-client-ui-sidebar-files（同一套 pane.tab 体系）。
		 */
		function apply(ctx) {
			ctx.effect(() => ctx.slots.inject("sidebar.right.pane.tab",
				() => ctx.slots.register({ name: "sidebar.right.pane.tab", key: "novel-forge" }, ForgePanel)),
				"dsh-novel-forge: forge pane");
			ctx.effect(() => ctx.slots.inject("sidebar.right.pane.tab.title",
				() => ctx.slots.register({ name: "sidebar.right.pane.tab.title", key: "novel-forge" }, ForgeTitle)),
				"dsh-novel-forge: forge tab title");
		}

		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	}
});