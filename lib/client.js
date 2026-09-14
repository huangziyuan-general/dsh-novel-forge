// ⚠️ 自动生成，请勿直接编辑 —— 改 src/client/ 后跑 npm run build。
// 源码：src/client/index.js（+ forge-tab.js / session-watch.js / panel.js / views/*）
// 本产物是经典脚本：dsh 的 client-modules 按 CJS factory 执行它。
window.__ModuleLoader__.load({
	id: "dsh-novel-forge",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client/index.js
var index_exports = {};
__export(index_exports, {
  PLUGIN_VERSION: () => PLUGIN_VERSION,
  __internals: () => __internals,
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(index_exports);

// src/client/forge-tab.js
var TAB_ID = "dsh-novel-forge";
var TAB_KIND = "novel-forge";
function tabDefinition() {
  return {
    id: TAB_ID,
    kind: TAB_KIND,
    priority: "extension",
    title: () => "🔨 锻炉",
    // guide 是「右侧栏常驻页」里的入口胶囊 —— 跨会话都在，
    // 自动打开失败 / 被用户关掉时，这是手动通道（保底入口）。
    guide: [{
      order: 90,
      title: () => "小说锻炉",
      description: () => "本会话的小说项目：章节 / 账本 / 世界书"
    }]
  };
}
function registerForgeTab(ctx, Panel) {
  ctx.effect(
    () => ctx.sidebarRightTabs.register(tabDefinition()),
    "dsh-novel-forge: 右侧栏 tab 类型"
  );
  ctx.effect(() => ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({
    name: "sidebar.right.pane.tab",
    key: TAB_ID,
    // inject 工厂是面板 props 的唯一来源：**sessionId 只有这里能拿到**，
    // 面板靠它把项目列表按会话过滤（「项目跟会话走」）。
    inject: (sessionId) => ({ sessionId })
  }, Panel)), "dsh-novel-forge: 右侧栏 tab 内容");
}
function openForgeTab(ctx, opts = {}) {
  const timer = opts.timer ?? setTimeout;
  const log = opts.log ?? console;
  const maxTries = opts.maxTries ?? 120;
  let tries = 0;
  let opened = false;
  const attempt = () => {
    if (opened) return true;
    try {
      ctx.sidebarRight.openTab(TAB_KIND);
      opened = true;
      log.info("[novel-forge] 已打开右侧栏 tab（锻炉）");
      return true;
    } catch (error) {
      tries += 1;
      if (tries < maxTries) {
        timer(attempt, 250);
      } else {
        log.warn("[novel-forge] 自动打开右侧栏 tab 失败，可从右侧栏 guide 页手动进入", error);
      }
      return false;
    }
  };
  timer(attempt, 400);
  return attempt;
}

// src/client/api.js
var API_BASE = "/api/novel-forge";
var FENCE = "x-dsh-novel-forge";
var FETCH_TIMEOUT_MS = 12e3;
async function apiFetch(path, init) {
  const timeoutMs = init?.timeoutMs ?? FETCH_TIMEOUT_MS;
  const ac = typeof AbortController === "function" && timeoutMs > 0 ? new AbortController() : null;
  const timer = ac ? setTimeout(() => ac.abort(), timeoutMs) : null;
  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...init,
      signal: init?.signal ?? ac?.signal,
      headers: { ...init?.headers ?? {}, [FENCE]: "1", "content-type": "application/json" }
    });
  } catch (error) {
    const aborted = error?.name === "AbortError";
    if (aborted) {
      throw new Error(ac && !init?.signal ? `请求超时：${path}（${Math.round(timeoutMs / 1e3)} 秒无响应，服务可能没起或被浏览器扩展/代理拦截）` : `请求已中止：${path}（信号取消）`);
    }
    throw new Error(`网络错误：${String(error?.message ?? error)}`);
  } finally {
    if (timer) clearTimeout(timer);
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`响应不是 JSON（HTTP ${response.status}）—— 页面可能过期，硬刷新（Cmd+Shift+R）后再试`);
  }
  if (!payload.ok) throw new Error(payload.error?.message ?? `HTTP ${response.status}`);
  return payload.value;
}

// src/client/session-watch.js
var POLL_INTERVAL_MS = 8e3;
function currentSessionId(ctx) {
  const face = ctx?.sessions?.list;
  if (!face) return null;
  let snapshot = null;
  try {
    if (typeof face.getSnapshot === "function") snapshot = face.getSnapshot();
    else if (typeof face.snapshot === "function") snapshot = face.snapshot();
    else snapshot = face;
  } catch {
    return null;
  }
  const id = snapshot?.current;
  return typeof id === "string" && id !== "" ? id : null;
}
function onSessionChange(ctx, listener) {
  const face = ctx?.sessions?.list;
  if (!face || typeof face.subscribe !== "function") return () => {
  };
  try {
    const off = face.subscribe(() => listener(currentSessionId(ctx)));
    return typeof off === "function" ? off : () => {
    };
  } catch {
    return () => {
    };
  }
}
function startForgeAutoOpen(ctx, opts = {}) {
  const intervalMs = opts.intervalMs ?? POLL_INTERVAL_MS;
  const setTimer = opts.setTimer ?? setTimeout;
  const clearTimer = opts.clearTimer ?? clearTimeout;
  const log = opts.log ?? console;
  const fetchProjects = opts.fetchProjects ?? ((sessionId) => apiFetch(`/projects?session=${encodeURIComponent(sessionId)}`));
  const openTab = opts.openTab ?? ((c) => openForgeTab(c, { timer: setTimer, log }));
  const opened = /* @__PURE__ */ new Set();
  let stopped = false;
  let inflight = false;
  let timerId = null;
  const check = async () => {
    if (stopped || inflight) return;
    const sessionId = currentSessionId(ctx);
    if (sessionId === null || opened.has(sessionId)) return;
    inflight = true;
    try {
      const books = await fetchProjects(sessionId);
      if (!stopped && !opened.has(sessionId) && Array.isArray(books) && books.length > 0) {
        opened.add(sessionId);
        log.info(`[novel-forge] 本会话有 ${books.length} 个项目 → 打开右侧栏 tab`);
        openTab(ctx);
      }
    } catch {
    } finally {
      inflight = false;
    }
  };
  const schedule = () => {
    if (stopped) return;
    timerId = setTimer(() => {
      void check();
      schedule();
    }, intervalMs);
  };
  const off = onSessionChange(ctx, () => {
    void check();
  });
  void check();
  schedule();
  return () => {
    stopped = true;
    try {
      off();
    } catch {
    }
    if (timerId !== null) clearTimer(timerId);
  };
}

// src/client/react.js
var reactNamespace = __toESM(require("react"), 1);
function pickFunction(namespace, name) {
  if (!namespace) return void 0;
  if (typeof namespace[name] === "function") return namespace[name];
  const wrapped = namespace.default;
  if (wrapped && typeof wrapped[name] === "function") return wrapped[name];
  return void 0;
}
function pickValue(namespace, name) {
  if (!namespace) return void 0;
  if (namespace[name] !== void 0) return namespace[name];
  const wrapped = namespace.default;
  return wrapped ? wrapped[name] : void 0;
}
var createElement = pickFunction(reactNamespace, "createElement");
var h = createElement;
var Fragment = pickValue(reactNamespace, "Fragment");
var Component = pickValue(reactNamespace, "Component");
var useState = pickFunction(reactNamespace, "useState");
var useRef = pickFunction(reactNamespace, "useRef");
var useEffect = pickFunction(reactNamespace, "useEffect");
var useCallback = pickFunction(reactNamespace, "useCallback");
var useMemo = pickFunction(reactNamespace, "useMemo");

// src/client/state.js
function emptyLoreForm() {
  return {
    mode: "none",
    // 'none' | 'new' | 'edit'
    id: "",
    name: "",
    content: "",
    keywords: "",
    alwaysActive: false,
    enabled: true,
    priority: "50",
    bookId: ""
  };
}
function initialState() {
  return {
    // 会话身份（slot inject 工厂注入）—— 列表/创建/认领都按它过滤
    sessionId: null,
    // 视图路由
    view: "projects",
    // 'projects' | 'detail' | 'lorebook' | 'settings'
    selected: null,
    // 项目列表
    projects: [],
    unclaimed: [],
    loading: true,
    error: "",
    notice: "",
    creating: false,
    busy: false,
    title: "",
    genre: "fantasy",
    // 列表内联改名 / 删除：rename = {id, value} | null；listDeleteId = 待确认删除的书 id | null
    rename: null,
    renaming: false,
    listDeleteId: null,
    // 项目详情
    detail: null,
    chapterNo: 1,
    writing: false,
    draft: "",
    draftVersion: 0,
    polishing: false,
    polishPreview: null,
    diagnosing: false,
    report: null,
    // 小说基本要素（基本信息标签：档案/大纲/角色卡/设定/账本时间线）
    elements: null,
    elementsLoading: false,
    // 详情页两个标签：'info'（基本信息）| 'chapters'（章节听书）
    detailTab: "info",
    chapterList: [],
    chapterListLoading: false,
    playback: { status: "idle", currentNo: null },
    // 提案队列（0.7.0）：模型提的修订稿，pending 时等用户点「应用」才生成新版本。
    // 工具面没有 apply（见 lib/proposals.js）——「批准钥匙」在面板这一侧。
    proposals: [],
    proposalsLoading: false,
    // 正在处理的提案 id（应用/丢弃中，按钮禁用以防重复点）；null = 空闲
    proposalBusy: null,
    // 世界书
    loreEntries: [],
    loreForm: emptyLoreForm(),
    loreBusy: false,
    // 导出 / 删除
    exporting: false,
    deleteState: null,
    // 撤销栈与基线（保存判定依据）
    undoStack: [],
    baseline: "",
    draftModified: false,
    // 未保存离开确认：null | {kind:'back'} | {kind:'chapter', no:number}
    discardPending: null
  };
}

// src/client/tts.js
function chunkText(text, limit = 180) {
  const paragraphs = String(text ?? "").split(/\n+/).map((p) => p.trim()).filter(Boolean);
  const pieces = [];
  for (const p of paragraphs) {
    if (p.length <= limit) {
      pieces.push(p);
      continue;
    }
    for (const s of p.split(/(?<=[。！？；!?;.])\s*/)) {
      const t = s.trim();
      if (t) pieces.push(t);
    }
  }
  const chunks = [];
  let buf = "";
  for (const s of pieces) {
    if (buf && buf.length + s.length > limit) {
      chunks.push(buf);
      buf = s;
    } else buf = buf ? buf + s : s;
  }
  if (buf) chunks.push(buf);
  return chunks;
}
function resolveSynth() {
  if (typeof globalThis !== "undefined" && globalThis.speechSynthesis) return globalThis.speechSynthesis;
  if (typeof window !== "undefined" && window.speechSynthesis) return window.speechSynthesis;
  return null;
}
function defaultUtteranceFactory() {
  const Ctor = typeof globalThis !== "undefined" && globalThis.SpeechSynthesisUtterance || typeof window !== "undefined" && window.SpeechSynthesisUtterance || null;
  if (typeof Ctor === "function") {
    return (text) => {
      const u = new Ctor();
      u.text = String(text);
      u.lang = "zh-CN";
      u.rate = 1;
      return u;
    };
  }
  return (text) => ({ text: String(text), lang: "zh-CN", rate: 1 });
}
function createTtsPlayer({
  synth,
  loadChapter,
  hasChapter,
  nextChapterAfter,
  makeUtterance = defaultUtteranceFactory(),
  onChange = () => {
  },
  chunkLimit = 180
}) {
  let status = "idle";
  let currentNo = null;
  let generation = 0;
  let queue = [];
  let idx = 0;
  const getNext = nextChapterAfter ?? ((no) => hasChapter(no + 1) ? no + 1 : null);
  const emit = () => {
    try {
      onChange({ status, currentNo });
    } catch {
    }
  };
  const finish = (gen) => {
    if (gen !== generation) return;
    status = "idle";
    currentNo = null;
    queue = [];
    idx = 0;
    emit();
  };
  const speakNext = (gen) => {
    if (gen !== generation) return;
    if (idx >= queue.length) {
      const next = getNext(currentNo);
      if (next != null) {
        void startChapter(next, gen);
      } else finish(gen);
      return;
    }
    const text = queue[idx++];
    const u = makeUtterance(text);
    u.onend = () => speakNext(gen);
    u.onerror = () => speakNext(gen);
    try {
      synth.speak(u);
    } catch {
      speakNext(gen);
    }
  };
  const startChapter = async (no, gen) => {
    if (gen !== generation) return;
    currentNo = no;
    emit();
    let text = "";
    try {
      text = await loadChapter(no);
    } catch {
      text = "";
    }
    if (gen !== generation) return;
    if (!String(text ?? "").trim()) {
      const next = getNext(no);
      if (next != null) {
        await startChapter(next, gen);
      } else finish(gen);
      return;
    }
    queue = chunkText(text, chunkLimit);
    idx = 0;
    speakNext(gen);
  };
  const playFrom = (no) => {
    if (!synth) throw new Error("当前环境不支持语音朗读（缺少 speechSynthesis）");
    generation += 1;
    const gen = generation;
    try {
      synth.cancel();
    } catch {
    }
    status = "playing";
    emit();
    return startChapter(no, gen);
  };
  const pause = () => {
    if (status !== "playing") return;
    try {
      synth.pause();
    } catch {
    }
    status = "paused";
    emit();
  };
  const resume = () => {
    if (status !== "paused") return;
    try {
      synth.resume();
    } catch {
    }
    status = "playing";
    emit();
  };
  const stop = () => {
    generation += 1;
    try {
      synth?.cancel();
    } catch {
    }
    status = "idle";
    currentNo = null;
    queue = [];
    idx = 0;
    emit();
  };
  return {
    playFrom,
    pause,
    resume,
    stop,
    get status() {
      return status;
    },
    get currentNo() {
      return currentNo;
    }
  };
}

// src/client/styles.js
var headerStyle = {
  display: "flex",
  alignItems: "center",
  gap: "8px",
  padding: "10px 14px",
  borderBottom: "1px solid var(--dsw-alias-border-l3, #333)",
  flex: "0 0 auto",
  background: "var(--dsw-alias-bg-primary, #1a1a1a)"
};
var badgeStyle = {
  flex: "none",
  padding: "1px 8px",
  borderRadius: "999px",
  background: "var(--dsw-alias-accent-soft, rgba(80,120,255,.18))",
  color: "var(--dsw-alias-accent-strong, #8ab4ff)",
  fontSize: "11px"
};
var cardStyle = {
  flex: "none",
  border: "1px solid var(--dsw-alias-border-l3, #333)",
  borderRadius: "10px",
  padding: "10px 12px",
  background: "var(--dsw-alias-bg-overlay, transparent)"
};
var rowStyle = { display: "flex", alignItems: "flex-start", gap: "8px", flex: "none" };
var kStyle = {
  flex: "none",
  minWidth: "56px",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: "11px",
  color: "var(--dsw-alias-label-secondary, #9aa0aa)",
  paddingTop: "2px"
};
var vStyle = { flex: "auto", minWidth: 0, wordBreak: "break-word" };
var btnStyle = {
  flex: "none",
  background: "transparent",
  border: "1px solid var(--dsw-alias-border-l3, #333)",
  borderRadius: "6px",
  color: "var(--dsw-alias-label-secondary, #9aa0aa)",
  fontSize: "11px",
  padding: "2px 8px",
  cursor: "pointer",
  fontFamily: "inherit"
};
var inputStyle = {
  padding: "4px 6px",
  border: "1px solid var(--dsw-alias-border-l3, #333)",
  borderRadius: "4px",
  width: "100%",
  boxSizing: "border-box",
  background: "var(--dsw-alias-bg-primary, #1a1a1a)",
  color: "var(--dsw-alias-label-primary, #e6e6e6)"
};
var errStyle = {
  flex: "auto",
  minWidth: 0,
  color: "var(--dsw-alias-label-danger, #ff8a8a)",
  fontSize: "11.5px",
  wordBreak: "break-word"
};
var footerStyle = {
  margin: "0",
  color: "var(--dsw-alias-label-tertiary, #6b7280)",
  fontSize: "11px",
  flex: "none"
};
var okStyle = { color: "var(--dsw-alias-accent-strong, #4ade80)", fontSize: "12px" };
var hintStyle = { color: "#888" };
var itemCardStyle = {
  padding: "8px 10px",
  border: "1px solid var(--dsw-alias-border-l3, #333)",
  borderRadius: "6px",
  background: "var(--dsw-alias-bg-overlay, transparent)"
};
var miniBtnStyle = { ...btnStyle, fontSize: "11px", padding: "2px 6px" };
var dangerBtnStyle = { ...btnStyle, color: "var(--dsw-alias-label-danger, #ff8a8a)", borderColor: "var(--dsw-alias-label-danger, #ff8a8a)" };
var primaryBtnStyle = { ...btnStyle, color: "var(--dsw-alias-accent-strong, #4ade80)", borderColor: "var(--dsw-alias-accent-strong, #4ade80)" };
var accentBtnStyle = { ...btnStyle, color: "var(--dsw-alias-accent-strong, #60a5fa)", borderColor: "var(--dsw-alias-accent-strong, #60a5fa)" };

// src/client/views/project-list.js
function ProjectListView({ state: s }) {
  return h(
    "div",
    { style: { display: "flex", flexDirection: "column", gap: "10px" } },
    h("div", { style: { fontWeight: 700, fontSize: "14px" } }, "本项目会话的项目"),
    // 创建表单
    h(
      "div",
      { style: { display: "flex", gap: "6px" } },
      h("input", {
        "data-field": "title",
        value: s.title,
        placeholder: "书名",
        style: { ...inputStyle, flex: 1 }
      }),
      h("button", {
        "data-action": "create",
        disabled: s.creating,
        style: btnStyle
      }, s.creating ? "创建中…" : "创建")
    ),
    // 批量操作
    h(
      "div",
      { style: { display: "flex", gap: "6px", alignItems: "center" } },
      h("button", { "data-action": "refresh-projects", style: btnStyle }, "刷新"),
      h("button", { "data-action": "import-file", style: accentBtnStyle }, "导入本地"),
      h("button", { "data-action": "goto-settings", style: { ...btnStyle, marginLeft: "auto" } }, "⚙ 设置")
    ),
    s.error ? h("div", { style: errStyle }, s.error) : null,
    s.notice ? h("div", { style: okStyle }, s.notice) : null,
    s.loading ? h("div", { style: hintStyle }, "加载中…") : s.projects.length === 0 ? h("div", { style: hintStyle }, "本会话还没有项目。输入书名创建一个，或在会话里让 AI 调 novel_project init。") : h(
      "div",
      { style: { display: "flex", flexDirection: "column", gap: "6px" } },
      s.projects.map((p) => h(
        "div",
        { key: p.name, style: itemCardStyle },
        h(
          "button",
          {
            "data-action": "open",
            "data-id": p.name,
            // 打开整卡：button 才能进 Tab 序 / 被读屏读到 / 回车触发
            style: {
              display: "block",
              width: "100%",
              textAlign: "left",
              cursor: "pointer",
              background: "transparent",
              border: "none",
              padding: 0,
              font: "inherit",
              color: "inherit"
            }
          },
          h("div", { style: { fontWeight: 600 } }, p.title || p.name),
          h(
            "div",
            { style: { ...hintStyle, fontSize: "12px" } },
            `${p.stage ? p.stage + " · " : ""}${p.chapters ?? 0} 章 · 账本 ${p.facts ?? 0} · 伏笔 ${p.foreshadows?.open ?? 0}/${p.foreshadows?.total ?? 0}${p.styleBuilt ? " · 有基线" : ""}`
          )
        ),
        h(
          "div",
          { style: { display: "flex", gap: "6px", marginTop: "6px" } },
          h("button", {
            "data-action": "goto-lorebook",
            "data-id": p.name,
            style: miniBtnStyle
          }, "世界书"),
          h("button", { "data-action": "rename-open", "data-id": p.name, style: miniBtnStyle }, "改名"),
          h("button", {
            "data-action": "list-delete",
            "data-id": p.name,
            style: dangerBtnStyle
          }, "删除")
        ),
        // 列表内联改名表单（目录名=id 不动，只改标题）
        s.rename && s.rename.id === p.name ? h(
          "div",
          { style: { display: "flex", gap: "6px", marginTop: "6px" } },
          h("input", {
            "data-field": "rename-value",
            value: s.rename.value,
            placeholder: "新书名",
            style: { ...inputStyle, flex: 1, fontSize: "12px" }
          }),
          h(
            "button",
            { "data-action": "rename-confirm", disabled: s.renaming, style: primaryBtnStyle },
            s.renaming ? "保存中…" : "确定"
          ),
          h("button", { "data-action": "rename-cancel", style: btnStyle }, "取消")
        ) : null,
        // 删除二次确认（误触可取消）
        s.listDeleteId === p.name ? h(
          "div",
          { style: { display: "flex", gap: "6px", marginTop: "6px", alignItems: "center" } },
          h("span", { style: { fontSize: "12px" } }, "删除这本书？"),
          h("button", {
            "data-action": "list-delete",
            "data-id": p.name,
            disabled: s.listDeleteId === "busy",
            style: dangerBtnStyle
          }, s.listDeleteId === "busy" ? "删除中…" : "确认删除"),
          h("button", { "data-action": "list-delete-cancel", style: btnStyle }, "取消")
        ) : null
      ))
    ),
    // 未归属的旧书（0.5.0 之前的书没有会话戳）
    s.unclaimed && s.unclaimed.length > 0 ? h(
      "div",
      { style: { display: "flex", flexDirection: "column", gap: "6px", borderTop: "1px solid var(--dsw-alias-border-l3, #333)", paddingTop: "8px" } },
      h("div", { style: { fontWeight: 600, fontSize: "12.5px" } }, `未归属的书（${s.unclaimed.length}）`),
      h("div", { style: { ...hintStyle, fontSize: "11.5px" } }, "这些书建在会话归属功能之前，认领后会出现在本会话。"),
      ...s.unclaimed.map((p) => h(
        "div",
        { key: p.name, style: { display: "flex", gap: "6px", alignItems: "center" } },
        h("span", { style: { flex: 1, fontSize: "12px" } }, p.title || p.name),
        h("button", {
          "data-action": "claim",
          "data-id": p.name,
          disabled: s.busy,
          style: miniBtnStyle
        }, "认领")
      ))
    ) : null,
    h("p", { style: footerStyle }, "在会话中调用 novel_* 工具驱动；列表只显示本会话创建或参与过的项目。")
  );
}

// src/client/views/chapters.js
var playingRowStyle = {
  ...itemCardStyle,
  borderColor: "var(--dsw-alias-accent-strong, #8ab4ff)",
  background: "var(--dsw-alias-accent-soft, rgba(80,120,255,.12))"
};
function ChapterListView({ state: s }) {
  const pb = s.playback ?? { status: "idle", currentNo: null };
  if (s.chapterListLoading) {
    return h("div", { style: hintStyle }, "章节目录加载中…");
  }
  if (!s.chapterList.length) {
    return h(
      "div",
      { style: { display: "flex", flexDirection: "column", gap: "8px" } },
      h(
        "div",
        { style: hintStyle },
        "本书还没有章节。在会话里让 AI 调用 novel_write_chapter 开写，写完这里就会出现目录。"
      ),
      h("button", { "data-action": "back", style: btnStyle }, "← 返回基本信息")
    );
  }
  const firstNo = s.chapterList[0].no;
  const playing = pb.status === "playing";
  const paused = pb.status === "paused";
  const startNo = pb.currentNo ?? firstNo;
  const controls = h(
    "div",
    { style: { display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap" } },
    !playing && !paused ? h(
      "button",
      { "data-action": "play-from", "data-no": String(startNo), style: btnStyle },
      `▶ 从第 ${startNo} 章开始听`
    ) : playing ? h("button", { "data-action": "playback-pause", style: btnStyle }, "⏸ 暂停") : h("button", { "data-action": "playback-resume", style: btnStyle }, "▶ 继续"),
    h("button", {
      "data-action": "playback-stop",
      disabled: !playing && !paused,
      style: btnStyle
    }, "⏹ 停止"),
    playing || paused ? h(
      "span",
      { style: { ...hintStyle, fontSize: "11px" } },
      `正在读：第 ${pb.currentNo} 章${paused ? "（已暂停）" : ""}`
    ) : h("span", { style: { ...hintStyle, fontSize: "11px" } }, "读完一章自动接下一章")
  );
  const rows = s.chapterList.map((c) => {
    const isCurrent = pb.currentNo === c.no && (playing || paused);
    return h(
      "div",
      { key: c.no, style: isCurrent ? playingRowStyle : itemCardStyle },
      h(
        "div",
        { style: { display: "flex", alignItems: "center", gap: "8px" } },
        h(
          "span",
          { style: { fontWeight: isCurrent ? 700 : 500 } },
          `第 ${c.no} 章 ${c.title || ""}`
        ),
        h(
          "span",
          { style: { ...hintStyle, fontSize: "11px", marginLeft: "auto" } },
          `${c.chars ?? 0} 字`
        ),
        h("button", {
          "data-action": "play-from",
          "data-no": String(c.no),
          style: miniBtnStyle,
          title: `从第 ${c.no} 章开始听`
        }, isCurrent && playing ? "♪" : "▶")
      )
    );
  });
  return h(
    "div",
    { style: { display: "flex", flexDirection: "column", gap: "8px" } },
    controls,
    s.error ? h("div", { style: errStyle }, s.error) : null,
    h("div", { style: { display: "flex", flexDirection: "column", gap: "6px" } }, rows)
  );
}

// src/client/views/overview.js
var sectionTitleStyle = {
  fontWeight: 700,
  fontSize: "13px",
  marginTop: "2px"
};
var emptyHint = (text) => h("div", { style: { ...hintStyle, fontSize: "11.5px" } }, text);
var detailBoxStyle = { ...itemCardStyle, padding: "6px 10px" };
var preStyle = {
  margin: "6px 0 0",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  fontSize: "12px",
  lineHeight: 1.7,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace"
};
function fold(title, content, open = false) {
  return h(
    "details",
    { style: detailBoxStyle, open },
    h("summary", { style: { cursor: "pointer", fontSize: "12.5px" } }, title),
    content
  );
}
function ProjectOverviewView({ state: s }) {
  const el = s.elements;
  if (s.elementsLoading) return h("div", { style: hintStyle }, "要素加载中…");
  if (!el) return emptyHint("要素加载失败 —— 点上方「刷新」重试。");
  const meta = el.meta ?? {};
  const facts = Array.isArray(el.facts) ? el.facts : [];
  const foreshadows = Array.isArray(el.foreshadows) ? el.foreshadows : [];
  const fmtDate = (iso) => iso ? String(iso).slice(0, 10) : "—";
  const profile = h(
    "div",
    { style: itemCardStyle },
    h(
      "div",
      { style: { display: "flex", flexWrap: "wrap", gap: "4px 14px", fontSize: "12.5px" } },
      h("span", null, `类型：${meta.genre || "—"}`),
      h("span", null, `阶段：${meta.stage || "—"}`),
      h("span", null, `建：${fmtDate(meta.createdAt)}`),
      h("span", null, `更：${fmtDate(meta.updatedAt)}`)
    ),
    meta.logline ? h("div", { style: { ...hintStyle, fontSize: "12px", marginTop: "4px" } }, meta.logline) : null
  );
  const outlineParts = [
    el.outline?.full ? fold("📖 全书大纲", h("div", { style: preStyle }, el.outline.full)) : emptyHint("还没有全书大纲 —— 在会话里让 AI 调用 novel_outline 生成。"),
    (el.outline?.chapterOutlines?.length ?? 0) > 0 ? h(
      "div",
      { style: { ...hintStyle, fontSize: "11.5px" } },
      `细纲 ${el.outline.chapterOutlines.length} 份（${el.outline.chapterOutlines.slice(0, 5).join("、")}${el.outline.chapterOutlines.length > 5 ? " …" : ""}）`
    ) : null
  ];
  const chars = Array.isArray(el.characters) ? el.characters : [];
  const castNames = (meta.cast ?? []).map((c) => typeof c === "string" ? c : c?.name).filter(Boolean);
  const characterParts = chars.length > 0 ? chars.map((c) => fold(`👤 ${c.name}`, h("div", { style: preStyle }, c.text || "（空卡）"))) : [emptyHint("还没有角色卡 —— 在会话里让 AI 调用 novel_cast 生成；已登记角色：" + (castNames.length ? castNames.join("、") : "无"))];
  const settingParts = [
    h(
      "div",
      { style: { display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" } },
      h(
        "span",
        { style: { fontSize: "12.5px" } },
        `世界书 ${el.worldbookCount ?? 0} 条 · 术语表 ${el.glossaryCount ?? 0} 条`
      ),
      h("button", { "data-action": "goto-lorebook", "data-id": s.selected, style: btnStyle }, "管理世界书")
    ),
    (el.worldbookCount ?? 0) + (el.glossaryCount ?? 0) === 0 ? emptyHint("设定还是空的 —— 在会话里让 AI 调用 novel_world 沉淀世界观。") : null
  ];
  const byChapter = /* @__PURE__ */ new Map();
  for (const f of facts) {
    const no = f.chapter ?? 0;
    if (!byChapter.has(no)) byChapter.set(no, []);
    byChapter.get(no).push(f);
  }
  const timelineRows = [...byChapter.keys()].sort((a, b) => a - b).map((no) => h(
    "div",
    { key: no, style: { marginBottom: "6px" } },
    h(
      "div",
      { style: { fontSize: "11.5px", color: "var(--dsw-alias-accent-strong, #8ab4ff)" } },
      no > 0 ? `第 ${no} 章` : "未定章"
    ),
    ...(byChapter.get(no) ?? []).map((f, i) => h(
      "div",
      { key: i, style: { fontSize: "12px", paddingLeft: "10px" } },
      `${f.entity ?? "？"} · ${f.key ?? "？"} → ${f.value ?? "？"}`
    ))
  ));
  const foreshadowRows = foreshadows.map((f, i) => h(
    "div",
    { key: i, style: { fontSize: "12px", marginBottom: "4px" } },
    `〔${f.id ?? "？"}〕第 ${f.chapter ?? "？"} 章埋 → 预计第 ${f.plan ?? "？"} 章收` + (f.payoffChapter ? `（已回收于第 ${f.payoffChapter} 章）` : "（未回收）"),
    "\n",
    f.setup ?? ""
  ));
  const timelineParts = facts.length + foreshadows.length === 0 ? [emptyHint("账本还是空的 —— 开始写章后，novel_write_chapter 会自动把事实与伏笔记进时间线。")] : [
    facts.length > 0 ? fold(`🕰 事实时间线（${facts.length} 条）`, h("div", null, timelineRows), facts.length <= 20) : null,
    foreshadows.length > 0 ? fold(`🪡 伏笔（${foreshadows.length} 个）`, h("div", null, foreshadowRows)) : null
  ];
  const section = (title, children) => h(
    "div",
    { style: { display: "flex", flexDirection: "column", gap: "6px" } },
    h("div", { style: sectionTitleStyle }, title),
    ...children
  );
  return h(
    "div",
    { style: { display: "flex", flexDirection: "column", gap: "12px" } },
    section("📚 档案", [profile]),
    section("🗺 大纲", outlineParts),
    section("👥 角色卡", characterParts),
    section("🧭 设定", settingParts),
    section("⏳ 时间线 · 账本", timelineParts)
  );
}

// src/client/views/project-detail.js
var tabBtnStyle = (active) => ({
  ...btnStyle,
  padding: "4px 12px",
  fontSize: "12px",
  ...active ? {
    borderColor: "var(--dsw-alias-accent-strong, #8ab4ff)",
    color: "var(--dsw-alias-accent-strong, #8ab4ff)",
    fontWeight: 700
  } : {}
});
function ProjectDetailView({ state: s }) {
  const chapterCount = s.detail?.chapters ? Object.keys(s.detail.chapters).length : 0;
  const tabBar = h(
    "div",
    { style: { display: "flex", gap: "6px" } },
    h(
      "button",
      { "data-action": "detail-tab", "data-tab": "info", style: tabBtnStyle(s.detailTab !== "chapters") },
      "📋 基本信息"
    ),
    h(
      "button",
      { "data-action": "detail-tab", "data-tab": "chapters", style: tabBtnStyle(s.detailTab === "chapters") },
      "🎧 章节听书"
    )
  );
  const pendingProposals = (s.proposals || []).filter((p) => p.status === "pending");
  const proposalsBlock = h(
    "div",
    {
      style: {
        border: "1px solid var(--dsw-alias-border-l3, #333)",
        borderRadius: "6px",
        padding: "8px",
        display: "flex",
        flexDirection: "column",
        gap: "6px"
      }
    },
    h(
      "div",
      { style: { display: "flex", alignItems: "center", gap: "6px" } },
      h("span", { style: { fontWeight: 600, fontSize: "13px" } }, "📝 待批准提案"),
      pendingProposals.length > 0 ? h("span", {
        style: {
          fontSize: "11px",
          padding: "1px 6px",
          borderRadius: "8px",
          background: "rgba(255,170,0,.18)"
        }
      }, String(pendingProposals.length)) : null
    ),
    s.proposalsLoading ? h("div", { style: { ...hintStyle, fontSize: "12px" } }, "加载中…") : pendingProposals.length === 0 ? h(
      "div",
      { style: { ...hintStyle, fontSize: "12px" } },
      "暂无待批准的修订。模型改稿会先落到这里，由你点「应用」才会生效。"
    ) : h(
      "div",
      { style: { display: "flex", flexDirection: "column", gap: "6px" } },
      pendingProposals.map((p) => {
        const busy = s.proposalBusy === p.id;
        return h(
          "div",
          {
            key: p.id,
            style: {
              display: "flex",
              alignItems: "center",
              gap: "6px",
              border: "1px solid var(--dsw-alias-border-l3, #333)",
              borderRadius: "4px",
              padding: "4px 6px"
            }
          },
          h("span", { style: { flex: 1, fontSize: "12px" } }, `${p.id} · 第 ${p.chapter} 章`),
          h("button", {
            "data-action": "proposal-apply",
            "data-id": p.id,
            disabled: busy,
            style: miniBtnStyle
          }, busy ? "处理中…" : "应用"),
          h("button", {
            "data-action": "proposal-discard",
            "data-id": p.id,
            disabled: busy,
            style: dangerBtnStyle
          }, "丢弃")
        );
      })
    )
  );
  const infoView = h(
    "div",
    { style: { display: "flex", flexDirection: "column", gap: "10px" } },
    // 小说基本要素：档案 / 大纲 / 角色卡 / 设定 / 时间线
    ProjectOverviewView({ state: s }),
    proposalsBlock,
    h(
      "div",
      { style: { fontWeight: 600, fontSize: "13px", borderTop: "1px solid var(--dsw-alias-border-l3, #333)", paddingTop: "8px" } },
      "✍️ 本章编辑"
    ),
    // 章节选择 + 需要模型的动作
    h(
      "div",
      { style: { display: "flex", gap: "6px", alignItems: "center" } },
      h("label", { style: { fontSize: "12px" } }, "章节"),
      h("select", {
        "data-field": "chapterNo",
        value: String(s.chapterNo),
        style: { padding: "4px", borderRadius: "4px" }
      }, Array.from({ length: Math.max(1, chapterCount + 1) }, (_, i) => i + 1).map((no) => h("option", { key: no, value: String(no) }, `第 ${no} 章`))),
      h("button", {
        "data-action": "write",
        disabled: s.writing || s.polishing,
        style: btnStyle
      }, s.writing ? "写作中…" : "一键写章"),
      h("button", {
        "data-action": "polish",
        disabled: s.writing || s.polishing,
        style: { ...btnStyle, borderColor: "var(--dsw-alias-accent-strong, #c084fc)", color: "var(--dsw-alias-accent-strong, #c084fc)" }
      }, s.polishing ? "润色中…" : "一键润色")
    ),
    s.error ? h("div", { style: errStyle }, s.error) : null,
    s.notice ? h("div", { style: okStyle }, s.notice) : null,
    // 未保存离开确认：返回 / 换章前有改动时，先问一句
    s.discardPending ? h(
      "div",
      {
        style: {
          display: "flex",
          gap: "6px",
          alignItems: "center",
          border: "1px solid var(--dsw-alias-border-l3, #333)",
          background: "rgba(255,170,0,.08)",
          borderRadius: "6px",
          padding: "6px 8px"
        }
      },
      h("span", { style: { flex: 1, fontSize: "12px" } }, "本章有未保存的改动，确认丢弃吗？"),
      h("button", { "data-action": "discard-confirm", style: dangerBtnStyle }, "丢弃改动"),
      h("button", { "data-action": "discard-cancel", style: btnStyle }, "取消")
    ) : null,
    // 编辑区（key 带版本号，刷新章节时强制重建以吸收新的 defaultValue）
    h("textarea", {
      "data-field": "draft",
      key: `draft-${s.draftVersion}`,
      defaultValue: s.draft,
      placeholder: "本章正文",
      rows: 8,
      style: { ...inputStyle, fontFamily: "monospace", fontSize: "12px", minHeight: "120px" }
    }),
    h(
      "div",
      { style: { display: "flex", gap: "6px" } },
      h("button", { "data-action": "refresh", style: btnStyle }, "刷新"),
      h("button", { "data-action": "save", style: primaryBtnStyle }, "保存"),
      h("button", { "data-action": "export", disabled: s.exporting, style: btnStyle }, s.exporting ? "导出中…" : "导出"),
      h("button", { "data-action": "goto-lorebook", "data-id": s.selected, style: btnStyle }, "世界书"),
      h(
        "button",
        { "data-action": "delete", style: dangerBtnStyle },
        s.deleteState === "confirm" ? "确认删除？" : "删除"
      ),
      s.deleteState === "confirm" ? h("button", { "data-action": "delete-cancel", style: btnStyle }, "取消") : null
    ),
    // 结构诊断
    h(
      "div",
      {
        style: {
          display: "flex",
          alignItems: "center",
          gap: "8px",
          borderTop: "1px solid var(--dsw-alias-border-l3, #333)",
          paddingTop: "8px"
        }
      },
      h("span", { style: { fontWeight: 600, fontSize: "13px" } }, "结构诊断"),
      h(
        "button",
        { "data-action": "diagnose", disabled: s.diagnosing, style: btnStyle },
        s.diagnosing ? "诊断中…" : "诊断本章"
      ),
      s.report ? h("span", {
        style: {
          fontSize: "13px",
          fontWeight: 700,
          color: s.report.score >= 70 ? "var(--dsw-alias-accent-strong, #4ade80)" : s.report.score >= 50 ? "#fbbf24" : "var(--dsw-alias-label-danger, #ff8a8a)"
        }
      }, `得分 ${s.report.score}`) : null
    ),
    s.report && s.report.issues?.length > 0 ? h(
      "div",
      { style: { fontSize: "12px", display: "flex", flexDirection: "column", gap: "4px" } },
      s.report.issues.slice(0, 5).map((issue, i) => h("div", {
        key: i,
        style: {
          padding: "4px 6px",
          background: issue.severity === "error" ? "rgba(255,100,100,.1)" : "rgba(255,200,0,.1)",
          borderRadius: "4px"
        }
      }, issue.advice))
    ) : s.report ? h("div", { style: { ...okStyle, fontSize: "12px" } }, "未发现问题") : null,
    h(
      "div",
      { style: { display: "flex", gap: "6px" } },
      h("button", { "data-action": "goto-lorebook", "data-id": s.selected, style: miniBtnStyle }, "本书世界书")
    )
  );
  return h(
    "div",
    { style: { display: "flex", flexDirection: "column", gap: "10px" } },
    h("button", { "data-action": "back", style: btnStyle }, "← 返回"),
    tabBar,
    s.detailTab === "chapters" ? h(ChapterListView, { state: s }) : infoView
  );
}

// src/client/views/lorebook.js
function LorebookView({ state: s }) {
  return h(
    "div",
    { style: { display: "flex", flexDirection: "column", gap: "10px" } },
    h(
      "div",
      { style: { display: "flex", alignItems: "center", gap: "8px" } },
      h("button", { "data-action": "back-from-lore", style: btnStyle }, "← 返回"),
      h("span", { style: { fontWeight: 700, fontSize: "14px" } }, "世界书（设定注入）"),
      h("button", { "data-action": "lore-new", style: { ...btnStyle, marginLeft: "auto" } }, "+ 新建")
    ),
    s.error ? h("div", { style: errStyle }, s.error) : null,
    s.notice ? h("div", { style: okStyle }, s.notice) : null,
    // 新建 / 编辑表单
    s.loreForm.mode !== "none" ? h(
      "div",
      {
        style: {
          padding: "10px",
          border: "1px solid #29a",
          borderRadius: "6px",
          background: "rgba(0,100,255,.05)",
          display: "flex",
          flexDirection: "column",
          gap: "6px"
        }
      },
      h(
        "div",
        { style: { fontWeight: 600, fontSize: "13px" } },
        s.loreForm.mode === "new" ? "新建条目" : "编辑条目"
      ),
      h("input", { "data-field": "lore-name", defaultValue: s.loreForm.name, placeholder: "条目名称", style: inputStyle }),
      h("input", { "data-field": "lore-keywords", defaultValue: s.loreForm.keywords, placeholder: "触发关键词（逗号分隔）", style: inputStyle }),
      h("textarea", {
        "data-field": "lore-content",
        defaultValue: s.loreForm.content,
        placeholder: "注入内容",
        rows: 3,
        style: { ...inputStyle, fontFamily: "monospace", fontSize: "12px" }
      }),
      h(
        "div",
        { style: { display: "flex", gap: "12px", alignItems: "center" } },
        h(
          "label",
          { style: { fontSize: "12px", display: "flex", gap: "4px", alignItems: "center" } },
          h("input", { "data-field": "lore-always", type: "checkbox", defaultChecked: s.loreForm.alwaysActive }),
          "常驻注入"
        ),
        h(
          "label",
          { style: { fontSize: "12px", display: "flex", gap: "4px", alignItems: "center" } },
          "优先级",
          h("input", {
            "data-field": "lore-priority",
            type: "number",
            defaultValue: s.loreForm.priority,
            style: { width: "56px", padding: "2px 4px" }
          })
        )
      ),
      h(
        "div",
        { style: { display: "flex", gap: "6px" } },
        h(
          "button",
          { "data-action": "lore-save", disabled: s.loreBusy, style: primaryBtnStyle },
          s.loreBusy ? "保存中…" : "保存"
        ),
        h("button", { "data-action": "lore-cancel", style: btnStyle }, "取消")
      )
    ) : null,
    // 条目列表
    s.loreEntries.length === 0 ? h("div", { style: hintStyle }, "还没有世界书条目") : h(
      "div",
      { style: { display: "flex", flexDirection: "column", gap: "6px" } },
      s.loreEntries.map((entry) => h(
        "div",
        { key: entry.id, style: itemCardStyle },
        h(
          "div",
          { style: { display: "flex", alignItems: "center", gap: "6px" } },
          h("span", { style: { fontWeight: 600, color: entry.enabled ? void 0 : "#aaa" } }, entry.name),
          entry.always_active ? h("span", { style: { fontSize: "10px", color: "#a70", background: "rgba(255,200,0,.15)", padding: "1px 5px", borderRadius: "3px" } }, "常驻") : null,
          !entry.enabled ? h("span", { style: { fontSize: "10px", color: "#888" } }, "已停用") : null,
          h("span", { style: { fontSize: "10px", color: "#888", marginLeft: "auto" } }, `P${entry.priority}`)
        ),
        entry.keywords?.length > 0 ? h("div", { style: { fontSize: "11px", color: "#666", marginTop: "3px" } }, `关键词：${entry.keywords.join("、")}`) : null,
        h(
          "div",
          { style: { display: "flex", gap: "6px", marginTop: "6px" } },
          h("button", { "data-action": "lore-edit", "data-id": String(entry.id), style: btnStyle }, "编辑"),
          h(
            "button",
            { "data-action": "lore-toggle", "data-id": String(entry.id), style: btnStyle },
            entry.enabled ? "停用" : "启用"
          ),
          h("button", { "data-action": "lore-delete", "data-id": String(entry.id), style: dangerBtnStyle }, "删除")
        )
      ))
    )
  );
}

// src/client/views/settings.js
function SettingsView() {
  return h(
    "div",
    { style: { display: "flex", flexDirection: "column", gap: "10px" } },
    h(
      "div",
      { style: { display: "flex", alignItems: "center", gap: "8px" } },
      h("button", { "data-action": "back-from-settings", style: btnStyle }, "← 返回"),
      h("span", { style: { fontWeight: 700, fontSize: "14px" } }, "⚙ 设置")
    ),
    h(
      "div",
      { style: cardStyle },
      h(
        "div",
        { style: rowStyle },
        h("span", { style: kStyle }, "tools"),
        h("span", { style: vStyle }, "18 个 novel_* 工具已注册")
      ),
      h(
        "div",
        { style: rowStyle },
        h("span", { style: kStyle }, "channels"),
        h("span", { style: vStyle }, "宿主 + MCP 双通道")
      ),
      h(
        "div",
        { style: rowStyle },
        h("span", { style: kStyle }, "guides"),
        h("span", { style: vStyle }, "账本 / 门禁 / 机审 / 提案")
      )
    ),
    h("p", { style: footerStyle }, "在会话中调用 novel_* 工具驱动。")
  );
}

// src/client/panel.js
var PANEL_ATTR = "data-dsh-novel-forge-panel";
var ForgeBoundary = typeof Component === "function" ? class extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error) {
    console.error("[novel-forge] 面板渲染失败：", error);
  }
  render() {
    if (this.state.error) {
      return h(
        "div",
        { style: { padding: "16px", color: "#ff8a8a", fontSize: "12.5px", lineHeight: 1.7, whiteSpace: "pre-wrap" } },
        "面板渲染失败：" + String(this.state.error?.message ?? this.state.error)
      );
    }
    return this.props.children;
  }
} : null;
function createForgeController({ sessionId = null, onChange = () => {
} } = {}) {
  const state = initialState();
  state.sessionId = sessionId ?? null;
  const notify = () => {
    try {
      onChange();
    } catch (error) {
      console.error("[novel-forge] 面板重渲染失败：", error);
    }
  };
  const withSession = (path) => {
    if (!state.sessionId) return path;
    const sep = path.includes("?") ? "&" : "?";
    return `${path}${sep}session=${encodeURIComponent(state.sessionId)}`;
  };
  const player = createTtsPlayer({
    synth: resolveSynth(),
    loadChapter: (no) => apiFetch(`/projects/${encodeURIComponent(state.selected)}/chapters/${no}`),
    hasChapter: (no) => state.chapterList.some((c) => c.no === no),
    // 连播/空章跳过都要"下一个存在的章"，不是 currentNo+1 —— 章号有缺口不能早停
    //（chapterList 服务端已按 no 升序排）
    nextChapterAfter: (no) => {
      const n = state.chapterList.find((c) => c.no > no);
      return n ? n.no : null;
    },
    onChange: (playback) => {
      state.playback = playback;
      notify();
    }
  });
  const loadElements = async (id) => {
    const bookId = id || state.selected;
    if (!bookId) return;
    state.elementsLoading = true;
    notify();
    try {
      state.elements = await apiFetch(`/projects/${encodeURIComponent(bookId)}/elements`);
    } catch {
      state.elements = null;
    } finally {
      state.elementsLoading = false;
      notify();
    }
  };
  const loadChapterList = async (id) => {
    const bookId = id || state.selected;
    if (!bookId) return;
    state.chapterListLoading = true;
    notify();
    try {
      state.chapterList = await apiFetch(`/projects/${encodeURIComponent(bookId)}/chapters`);
    } catch {
      state.chapterList = [];
    } finally {
      state.chapterListLoading = false;
      notify();
    }
  };
  const refreshProjects = async () => {
    state.loading = true;
    state.error = "";
    notify();
    console.info("[novel-forge] GET /projects" + (state.sessionId ? `?session=${state.sessionId}` : "（无会话）"));
    try {
      state.projects = await apiFetch(withSession("/projects"));
    } catch (error) {
      state.error = String(error?.message ?? error);
      console.warn("[novel-forge] 项目列表加载失败：", state.error);
    } finally {
      state.loading = false;
      notify();
    }
    try {
      state.unclaimed = state.sessionId ? await apiFetch("/projects?scope=unclaimed") : [];
    } catch {
      state.unclaimed = [];
    }
    notify();
  };
  const claimProject = async (id) => {
    if (!state.sessionId) {
      state.error = "未能识别当前会话，无法认领";
      notify();
      return;
    }
    state.busy = true;
    notify();
    try {
      await apiFetch("/projects/claim", {
        method: "POST",
        body: JSON.stringify({ session: state.sessionId, ids: id ? [id] : void 0 })
      });
      state.notice = id ? `已认领：${id}` : "已把未归属的书认领到本会话";
      await refreshProjects();
    } catch (error) {
      state.error = String(error?.message ?? error);
    } finally {
      state.busy = false;
      notify();
    }
  };
  const renameProject = async () => {
    const r = state.rename;
    if (!r || !r.id) return;
    const title = String(r.value ?? "").trim();
    if (!title) {
      state.error = "书名不能为空";
      notify();
      return;
    }
    state.renaming = true;
    state.error = "";
    notify();
    try {
      await apiFetch(`/projects/${encodeURIComponent(r.id)}/rename`, {
        method: "POST",
        body: JSON.stringify({ title })
      });
      state.notice = `已改名：${title}`;
      state.rename = null;
      await refreshProjects();
      if (state.selected === r.id) await openProject(r.id);
    } catch (error) {
      state.error = String(error?.message ?? error);
    } finally {
      state.renaming = false;
      notify();
    }
  };
  const deleteListProject = async (id) => {
    state.listDeleteId = "busy";
    notify();
    try {
      await apiFetch(`/projects/${encodeURIComponent(id)}`, { method: "DELETE" });
      state.notice = `已删除：${id}`;
      if (state.selected === id) {
        state.selected = null;
        state.detail = null;
        state.chapterList = [];
      }
      state.listDeleteId = null;
      await refreshProjects();
    } catch (error) {
      state.error = String(error?.message ?? error);
    } finally {
      state.listDeleteId = null;
      notify();
    }
  };
  const openProject = async (id) => {
    state.selected = id;
    state.view = "detail";
    state.detail = null;
    state.chapterNo = 1;
    state.draft = "";
    state.report = null;
    state.error = "";
    state.detailTab = "info";
    state.elements = null;
    state.discardPending = null;
    state.rename = null;
    state.listDeleteId = null;
    state.proposals = [];
    state.proposalBusy = null;
    player.stop();
    notify();
    try {
      const [detail, text] = await Promise.all([
        apiFetch(`/projects/${encodeURIComponent(id)}`),
        apiFetch(`/projects/${encodeURIComponent(id)}/chapters/1`).catch(() => "")
      ]);
      state.detail = detail;
      state.baseline = text ?? "";
      state.draft = text ?? "";
      state.draftVersion++;
      state.draftModified = false;
      state.undoStack = [];
    } catch (error) {
      state.error = String(error?.message ?? error);
    }
    notify();
    await Promise.all([loadChapterList(id), loadElements(id), loadProposals(id)]);
  };
  const loadChapter = async (no) => {
    if (!state.selected) return;
    state.chapterNo = no;
    state.report = null;
    state.polishPreview = null;
    state.discardPending = null;
    notify();
    try {
      const text = await apiFetch(`/projects/${encodeURIComponent(state.selected)}/chapters/${no}`);
      state.baseline = text ?? "";
      state.draft = text ?? "";
      state.draftVersion++;
      state.draftModified = false;
      state.undoStack = [];
    } catch {
      state.baseline = "";
      state.draft = "";
      state.draftVersion++;
      state.error = `读取第 ${no} 章失败（刷新或检查服务）`;
      console.warn("[novel-forge] 读取章节失败", state.error);
    }
    notify();
  };
  const loadProposals = async (id) => {
    const bookId = id || state.selected;
    if (!bookId) return;
    state.proposalsLoading = true;
    notify();
    try {
      const value = await apiFetch(`/projects/${encodeURIComponent(bookId)}/proposals`);
      state.proposals = Array.isArray(value?.proposals) ? value.proposals : [];
    } catch {
      state.proposals = [];
    } finally {
      state.proposalsLoading = false;
      notify();
    }
  };
  const applyProposalAction = async (proposalId) => {
    if (!state.selected || !proposalId) return;
    state.proposalBusy = proposalId;
    state.error = "";
    notify();
    try {
      const value = await apiFetch(`/projects/${encodeURIComponent(state.selected)}/proposals/${encodeURIComponent(proposalId)}/apply`, { method: "POST" });
      state.notice = `已应用提案 ${proposalId}：第${value.chapter}章 v${value.version}（旧版保留）`;
      await Promise.all([loadProposals(state.selected), loadChapterList(state.selected)]);
      if (state.chapterNo === value.chapter) await loadChapter(value.chapter);
    } catch (error) {
      state.error = String(error?.message ?? error);
    } finally {
      state.proposalBusy = null;
      notify();
    }
  };
  const discardProposalAction = async (proposalId) => {
    if (!state.selected || !proposalId) return;
    state.proposalBusy = proposalId;
    state.error = "";
    notify();
    try {
      await apiFetch(`/projects/${encodeURIComponent(state.selected)}/proposals/${encodeURIComponent(proposalId)}/discard`, { method: "POST" });
      state.notice = `已丢弃提案 ${proposalId}`;
      await loadProposals(state.selected);
    } catch (error) {
      state.error = String(error?.message ?? error);
    } finally {
      state.proposalBusy = null;
      notify();
    }
  };
  const createProject = async () => {
    if (!state.title.trim()) {
      state.error = "请先输入书名";
      notify();
      return;
    }
    state.creating = true;
    state.error = "";
    notify();
    try {
      await apiFetch("/projects", {
        method: "POST",
        // 创建即打会话戳：面板按会话过滤时它才会出现在本会话里
        body: JSON.stringify({ title: state.title.trim(), genre: state.genre, session: state.sessionId ?? void 0 })
      });
      state.title = "";
      await refreshProjects();
    } catch (error) {
      state.error = String(error?.message ?? error);
    } finally {
      state.creating = false;
      notify();
    }
  };
  const saveChapter = async () => {
    if (!state.selected) return;
    try {
      await apiFetch(`/projects/${encodeURIComponent(state.selected)}/chapters/${state.chapterNo}`, {
        method: "POST",
        body: JSON.stringify({ title: `第 ${state.chapterNo} 章`, text: state.draft })
      });
      state.notice = `已保存：第 ${state.chapterNo} 章`;
      state.baseline = state.draft;
      state.draftModified = false;
      state.undoStack = [];
    } catch (error) {
      state.error = String(error?.message ?? error);
    }
    notify();
  };
  const exportProject = async () => {
    if (!state.selected) return;
    state.exporting = true;
    notify();
    try {
      const result = await apiFetch(`/projects/${encodeURIComponent(state.selected)}/export`, { method: "POST", body: JSON.stringify({ format: "txt" }) });
      const blob = new Blob(["\uFEFF" + result.content], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = result.fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      state.notice = `已导出：${result.fileName}`;
    } catch (error) {
      state.error = String(error?.message ?? error);
    } finally {
      state.exporting = false;
      notify();
    }
  };
  const deleteProject = async () => {
    if (!state.selected) return;
    state.deleteState = "busy";
    notify();
    try {
      await apiFetch(`/projects/${encodeURIComponent(state.selected)}`, { method: "DELETE" });
      player.stop();
      state.selected = null;
      state.view = "projects";
      state.detail = null;
      state.chapterList = [];
      await refreshProjects();
    } catch (error) {
      state.error = String(error?.message ?? error);
    } finally {
      state.deleteState = null;
      notify();
    }
  };
  const loadLoreEntries = async (bookId) => {
    try {
      state.loreEntries = await apiFetch(`/worldbook/${encodeURIComponent(bookId)}`);
    } catch {
      state.loreEntries = [];
    }
    notify();
  };
  const saveLoreEntry = async () => {
    const f = state.loreForm;
    if (!f.name.trim()) {
      state.error = "条目名称不能为空";
      notify();
      return;
    }
    state.loreBusy = true;
    notify();
    try {
      const bookId = state.selected || f.bookId || "default";
      const body = JSON.stringify({
        name: f.name,
        content: f.content,
        keywords: f.keywords,
        always_active: f.alwaysActive,
        enabled: f.enabled,
        priority: Number(f.priority)
      });
      if (f.mode === "new") await apiFetch(`/worldbook/${encodeURIComponent(bookId)}`, { method: "POST", body });
      else if (f.mode === "edit") await apiFetch(`/worldbook/${encodeURIComponent(bookId)}/${f.id}`, { method: "PUT", body });
      state.loreForm = emptyLoreForm();
      await loadLoreEntries(bookId);
    } catch (error) {
      state.error = String(error?.message ?? error);
    } finally {
      state.loreBusy = false;
      notify();
    }
  };
  const deleteLoreEntry = async (entryId) => {
    const bookId = state.selected || "default";
    try {
      await apiFetch(`/worldbook/${encodeURIComponent(bookId)}/${entryId}`, { method: "DELETE" });
      await loadLoreEntries(bookId);
    } catch (error) {
      state.error = String(error?.message ?? error);
      notify();
    }
  };
  const toggleLoreEntry = async (entryId) => {
    const bookId = state.selected || "default";
    const entry = state.loreEntries.find((e) => e.id === Number(entryId));
    if (!entry) return;
    try {
      await apiFetch(`/worldbook/${encodeURIComponent(bookId)}/${entryId}`, { method: "PUT", body: JSON.stringify({ enabled: !entry.enabled }) });
      await loadLoreEntries(bookId);
    } catch (error) {
      state.error = String(error?.message ?? error);
      notify();
    }
  };
  const needsModel = (msg) => {
    state.error = msg;
    notify();
  };
  const intentLeave = (pending) => {
    if (state.draftModified) {
      state.discardPending = pending;
      notify();
      return false;
    }
    return true;
  };
  const goBack = async () => {
    player.stop();
    state.view = "projects";
    state.selected = null;
    state.detail = null;
    state.discardPending = null;
    state.draftModified = false;
    state.rename = null;
    state.listDeleteId = null;
    await refreshProjects();
  };
  const handleAction = async (action, target) => {
    state.error = "";
    state.notice = "";
    switch (action) {
      case "refresh-projects":
        await refreshProjects();
        break;
      case "create":
        await createProject();
        break;
      case "open":
        await openProject(target.dataset.id);
        break;
      case "rename-open": {
        const id = target.dataset.id;
        const p = state.projects.find((x) => x.name === id) || state.unclaimed.find((x) => x.name === id);
        state.rename = { id, value: p?.title || p?.name || "" };
        state.listDeleteId = null;
        notify();
        break;
      }
      case "rename-confirm":
        await renameProject();
        break;
      case "rename-cancel":
        state.rename = null;
        notify();
        break;
      case "list-delete":
        if (state.listDeleteId === target.dataset.id) await deleteListProject(target.dataset.id);
        else {
          state.listDeleteId = target.dataset.id;
          state.rename = null;
          notify();
        }
        break;
      case "list-delete-cancel":
        state.listDeleteId = null;
        notify();
        break;
      case "back":
        if (!intentLeave({ kind: "back" })) break;
        await goBack();
        break;
      case "claim":
        await claimProject(target.dataset.id || null);
        break;
      // 详情页两个标签：基本信息 / 章节听书
      case "detail-tab": {
        const tab = target.dataset.tab === "chapters" ? "chapters" : "info";
        if (state.detailTab !== tab) state.detailTab = tab;
        if (tab === "chapters") await loadChapterList();
        notify();
        break;
      }
      case "play-from": {
        state.detailTab = "chapters";
        const no = Number(target.dataset.no);
        try {
          await player.playFrom(no);
        } catch (error) {
          state.error = String(error?.message ?? error);
          notify();
        }
        break;
      }
      case "playback-pause":
        player.pause();
        notify();
        break;
      case "playback-resume":
        player.resume();
        notify();
        break;
      case "playback-stop":
        player.stop();
        notify();
        break;
      case "goto-lorebook":
        state.view = "lorebook";
        state.selected = target.dataset.id || state.selected;
        await loadLoreEntries(state.selected || "default");
        break;
      case "back-from-lore":
      case "back-from-settings":
        state.view = state.selected ? "detail" : "projects";
        notify();
        break;
      case "goto-settings":
        state.view = "settings";
        notify();
        break;
      case "write":
        needsModel("一键写章需要模型参与，请在会话中调用 novel_write_chapter");
        break;
      case "polish":
        needsModel("一键润色需要模型参与，请在会话中调用 novel_polish");
        break;
      case "diagnose":
        needsModel("诊断需要模型参与，请在会话中调用 novel_diagnose");
        break;
      case "import-demo":
      case "import-file":
        needsModel("请在会话中调用 novel_import 导入");
        break;
      case "save":
        await saveChapter();
        break;
      case "refresh":
        if (state.selected && state.chapterNo) await loadChapter(state.chapterNo);
        break;
      // 提案：应用 / 丢弃都是**用户主权动作**（工具面刻意不提供，见 lib/proposals.js）
      case "proposal-apply":
        await applyProposalAction(target.dataset.id);
        break;
      case "proposal-discard":
        await discardProposalAction(target.dataset.id);
        break;
      case "export":
        await exportProject();
        break;
      case "delete":
        if (state.deleteState === "confirm") await deleteProject();
        else {
          state.deleteState = "confirm";
          notify();
        }
        break;
      case "delete-cancel":
        state.deleteState = null;
        notify();
        break;
      // 未保存改动：确认丢弃后才真正离开 / 换章；取消则留在原地
      case "discard-confirm": {
        const pending = state.discardPending;
        state.discardPending = null;
        state.draftModified = false;
        if (pending?.kind === "back") await goBack();
        else if (pending?.kind === "chapter") await loadChapter(pending.no);
        else notify();
        break;
      }
      case "discard-cancel":
        state.discardPending = null;
        notify();
        break;
      case "lore-new":
        state.loreForm = { ...emptyLoreForm(), mode: "new" };
        notify();
        break;
      case "lore-edit": {
        const entry = state.loreEntries.find((x) => x.id === Number(target.dataset.id));
        if (entry) {
          state.loreForm = {
            mode: "edit",
            id: String(entry.id),
            name: entry.name,
            content: entry.content,
            keywords: (entry.keywords || []).join(","),
            alwaysActive: entry.always_active,
            enabled: entry.enabled,
            priority: String(entry.priority),
            bookId: entry.book_id || ""
          };
          notify();
        }
        break;
      }
      case "lore-save":
        await saveLoreEntry();
        break;
      case "lore-cancel":
        state.loreForm = emptyLoreForm();
        notify();
        break;
      case "lore-toggle":
        await toggleLoreEntry(target.dataset.id);
        break;
      case "lore-delete":
        await deleteLoreEntry(target.dataset.id);
        break;
    }
  };
  const onClick = (e) => {
    const actionEl = e.target?.closest?.("[data-action]");
    if (actionEl) {
      e.preventDefault();
      e.stopPropagation();
      void handleAction(actionEl.dataset.action, actionEl);
    }
  };
  const onInput = (e) => {
    const field = e.target?.dataset?.field;
    if (field === "title") {
      state.title = e.target.value;
      notify();
    } else if (field === "draft") {
      state.draft = e.target.value;
      state.draftModified = e.target.value !== state.baseline;
    } else if (field === "rename-value") {
      if (state.rename) state.rename.value = e.target.value;
    } else if (field === "chapterNo") {
      const no = Number(e.target.value);
      if (no > 0) {
        if (state.draftModified) {
          state.discardPending = { kind: "chapter", no };
          notify();
        } else void loadChapter(no);
      }
    } else if (field === "lore-name") state.loreForm.name = e.target.value;
    else if (field === "lore-keywords") state.loreForm.keywords = e.target.value;
    else if (field === "lore-content") state.loreForm.content = e.target.value;
    else if (field === "lore-priority") state.loreForm.priority = e.target.value;
  };
  const onChangeEvent = (e) => {
    if (e.target?.dataset?.field === "lore-always") state.loreForm.alwaysActive = e.target.checked;
  };
  let bound = null;
  const attach = (node) => {
    if (!node || bound === node) return;
    detach();
    bound = node;
    node.addEventListener("click", onClick);
    node.addEventListener("input", onInput);
    node.addEventListener("change", onChangeEvent);
  };
  const detach = () => {
    if (!bound) return;
    try {
      bound.removeEventListener("click", onClick);
      bound.removeEventListener("input", onInput);
      bound.removeEventListener("change", onChangeEvent);
    } catch {
    }
    bound = null;
  };
  let started = false;
  const start = () => {
    if (started) return;
    started = true;
    void refreshProjects();
  };
  const setSession = (next) => {
    const id = next ?? null;
    if (state.sessionId === id) return;
    state.sessionId = id;
    player.stop();
    state.selected = null;
    state.detail = null;
    state.view = "projects";
    state.chapterList = [];
    state.rename = null;
    state.listDeleteId = null;
    started = true;
    notify();
    void refreshProjects();
  };
  return {
    state,
    notify,
    attach,
    detach,
    start,
    setSession,
    refreshProjects,
    handleAction,
    loadProposals,
    stopPlayback: () => player.stop()
  };
}
function ForgePanel(props) {
  const sessionId = props?.sessionId ?? null;
  const [, forceTick] = useState(0);
  const controllerRef = useRef(null);
  const nodeRef = useRef(null);
  if (controllerRef.current === null) {
    controllerRef.current = createForgeController({
      sessionId,
      onChange: () => forceTick((n) => n + 1)
    });
  }
  const controller = controllerRef.current;
  useEffect(() => {
    controller.setSession(sessionId);
  }, [sessionId]);
  useEffect(() => {
    const node = nodeRef.current;
    if (node) controller.attach(node);
    controller.start();
    return () => {
      controller.stopPlayback();
      controller.detach();
    };
  }, []);
  const s = controller.state;
  const view = h(
    "div",
    {
      [PANEL_ATTR]: "1",
      ref: nodeRef,
      style: { display: "flex", flexDirection: "column", height: "100%", minHeight: 0, boxSizing: "border-box" }
    },
    h(
      "div",
      { style: headerStyle },
      h("span", { style: { fontWeight: 700, fontSize: "14px" } }, "🔨 锻炉"),
      h("span", { style: badgeStyle }, "v" + (window.__NOVEL_FORGE_VERSION__ || "?")),
      h(
        "span",
        { style: { ...hintStyle, fontSize: "11px" } },
        s.sessionId ? "本会话项目" : "全部项目"
      )
    ),
    h(
      "div",
      { style: { flex: "1 1 auto", overflowY: "auto", padding: "12px 12px 16px", minHeight: 0 } },
      s.view === "projects" ? h(ProjectListView, { state: s }) : null,
      s.view === "detail" ? h(ProjectDetailView, { state: s }) : null,
      s.view === "lorebook" ? h(LorebookView, { state: s }) : null,
      s.view === "settings" ? h(SettingsView) : null
    )
  );
  return ForgeBoundary ? h(ForgeBoundary, null, view) : view;
}

// src/client/index.js
var PLUGIN_VERSION = "0.10.0";
window.__NOVEL_FORGE_VERSION__ = PLUGIN_VERSION;
var inject = ["slots", "sidebarRightTabs", "sidebarRight", "sessions"];
function apply(ctx) {
  console.info("[novel-forge] client apply v" + PLUGIN_VERSION + " — 注册右侧栏 tab");
  try {
    registerForgeTab(ctx, ForgePanel);
  } catch (error) {
    console.error("[novel-forge] 右侧栏 tab 注册失败（可从右侧栏 guide 页手动进入）", error);
  }
  try {
    openForgeTab(ctx);
  } catch (error) {
    console.warn('[novel-forge] 独立打开右侧栏 tab 失败，可从右侧栏 guide 页手动进入（"小说锻炉"）', error);
  }
  if (typeof window !== "undefined") {
    window.__novelForge = {
      version: PLUGIN_VERSION,
      kind: TAB_KIND,
      open: () => openForgeTab(ctx, { maxTries: 1 })
    };
  }
}
var __internals = {
  TAB_ID,
  TAB_KIND,
  tabDefinition,
  openForgeTab,
  currentSessionId,
  startForgeAutoOpen,
  ForgePanel,
  createForgeController,
  chunkText,
  createTtsPlayer,
  resolveSynth,
  apiFetch,
  FETCH_TIMEOUT_MS
};

		return module.exports;
	}
});

