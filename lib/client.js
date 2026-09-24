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
  let disposed = false;
  const attempt = () => {
    if (disposed || opened) return true;
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
  return () => {
    disposed = true;
  };
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
    // sessionFallback：会话过滤为空但全量有书 → 回落显示全部（宿主 slot 会话标识
    // 与工具写入的 session id 可能不同源，0.13.2 真机实锤）。null = 未触发过回落。
    projects: [],
    sessionFallback: null,
    unclaimed: [],
    loading: true,
    error: "",
    notice: "",
    creating: false,
    busy: false,
    title: "",
    genre: "",
    // titleReset：书名输入是非受控的（defaultValue + key），创建成功清空后 bump 重置
    titleReset: 0,
    // 列表筛选（>8 本才显示输入框）：按书名/目录名/题材做客户端子串匹配
    filter: "",
    // 列表内联改名 / 删除：rename = {id, value} | null；listDeleteId = 待确认删除的书 id | null
    // listDeleting：删除请求在途的**独立**标记。不能拿 listDeleteId 塞 'busy' 当哨兵——
    // 确认行的渲染条件是 `listDeleteId === p.name`，哨兵会让整行卸载（闪一下）且
    // 「删除中…」分支永远不可达。
    // clone = {id, value} | null：克隆为模板的输入行（value 是新书目录名）
    rename: null,
    renaming: false,
    listDeleteId: null,
    listDeleting: false,
    clone: null,
    cloning: false,
    // 项目详情
    detail: null,
    chapterNo: 1,
    writing: false,
    draft: "",
    draftVersion: 0,
    // 旁路引擎动作（0.13.0）：'polish' | 'proofread' | null。
    // 两者都是**长任务**（服务端可能重试到几分钟），所以单独一个忙标记，
    // 而不是复用 writing —— 否则「写章中」和「润色中」会互相把按钮按死。
    revising: null,
    // 全书体检（GET /continuity，纯函数零 token）：null = 没查过
    continuity: null,
    continuityLoading: false,
    continuityError: "",
    // 黄金三章诊断（GET /diagnose，同为纯函数零 token）：null = 没查过
    diagnosis: null,
    diagnosisLoading: false,
    diagnosisError: "",
    // 批量起草（D2）：表单值 + 忙标记 + 结果
    batchFrom: 1,
    batchCount: 3,
    batchConcurrency: 1,
    batchForce: false,
    batchBusy: false,
    batchResult: null,
    // 小说基本要素（基本信息标签：档案/大纲/角色卡/设定/账本时间线）
    elements: null,
    elementsLoading: false,
    // 详情页两个标签：'info'（基本信息）| 'chapters'（章节听书）
    detailTab: "info",
    chapterList: [],
    chapterListLoading: false,
    playback: { status: "idle", currentNo: null },
    // 阅读器（0.13.1）：点目录行的 📖 展开正文。{ no, title, text, loading } | null
    // 与播放互相独立——可以一边听一边看。
    reader: null,
    // 提案队列（0.7.0）：模型提的修订稿，pending 时等用户点「应用」才生成新版本。
    // 工具面没有 apply（见 lib/proposals.js）——「批准钥匙」在面板这一侧。
    proposals: [],
    proposalsLoading: false,
    proposalsError: null,
    // 提案队列加载失败——必须可见，不得伪装成「没有待批」（2026-09-23 真机教训）
    // 提案全文展开（👁 查看）：{ id, loading, data, error } | null
    proposalDetail: null,
    // 正在处理的提案 id（应用/丢弃中，按钮禁用以防重复点）；null = 空闲
    proposalBusy: null,
    // 应用提案时服务端跑出的内容门禁提示：{ok, blocking[], warnings[]} | null。
    // 应用是用户主权（不拦），但「这版改出了死人复活/隐藏人物泄底」必须当场看见，
    // 不能等下一次写章才在别的章节冒出来。
    gateNotice: null,
    // 世界书
    loreEntries: [],
    loreForm: emptyLoreForm(),
    loreBusy: false,
    // loreDeleteId：待确认删除的世界书条目 id（字符串，与 dataset.id 同形）| null
    loreDeleteId: null,
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
      if (!t) continue;
      if (t.length <= limit) {
        pieces.push(t);
        continue;
      }
      for (let i = 0; i < t.length; i += limit) pieces.push(t.slice(i, i + limit));
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
  let speaking = false;
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
    if (status === "paused") return;
    if (idx >= queue.length) {
      const next = getNext(currentNo);
      if (next != null) {
        void startChapter(next, gen);
      } else finish(gen);
      return;
    }
    const text = queue[idx++];
    const u = makeUtterance(text);
    speaking = true;
    u.onend = () => {
      speaking = false;
      speakNext(gen);
    };
    u.onerror = () => {
      speaking = false;
      speakNext(gen);
    };
    try {
      synth.speak(u);
    } catch {
      speaking = false;
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
    if (!speaking) speakNext(generation);
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
var V = (name, fallback) => `var(--dsw-alias-${name}, ${fallback})`;
var mix = (name, pct) => `color-mix(in srgb, ${V(name, "currentColor")} ${pct}%, transparent)`;
var color = {
  // 文字：四级（主/次/弱/更弱）；回退用 inherit（跟着宿主主题走）
  text: V("label-primary", "inherit"),
  text2: V("label-secondary", "rgba(128,128,128,.95)"),
  text3: V("label-tertiary", "rgba(128,128,128,.82)"),
  // ⚠️ 这里曾写 `label-dimmed` —— 名字存在，但**它是"表面"色不是文字色**：
  //    浅色下 #e1e5ee、深色下 #43454a，两个主题里当文字都等于看不见。
  //    真正的"最弱文字"是 `label-caption`。
  textDim: V("label-caption", "rgba(128,128,128,.7)"),
  /** 落在填充块上的文字（主按钮、阶段当前段）。 */
  onFill: V("label-primary-foreground", "#fff"),
  // 表面：卡片/面板沿用宿主 layer 层（与 dsh 其它界面一致）；
  // 「卡片里再嵌一层」（输入框、胶囊、进度槽、版本徽标）走 mix() 染色。
  // ⚠️ 这里曾用 `bg-overlay` 当内嵌底 —— 名字存在，但它是**遮罩(scrim)色**，
  //    深色下是 #61666b 的中亮灰：搜索框与所有胶囊在深色主题里糊成一片亮块，
  //    这正是「选了黑色主题配色不好看」的主因之一。
  base: V("bg-base", "rgba(128,128,128,.02)"),
  surface1: V("bg-layer-1", "rgba(128,128,128,.04)"),
  surface2: V("bg-layer-2", "rgba(128,128,128,.07)"),
  surface3: V("bg-layer-3", "rgba(128,128,128,.10)"),
  inset: mix("label-primary", 6),
  insetStrong: mix("label-primary", 10),
  hover: V("interactive-bg-hover", "rgba(128,128,128,.12)"),
  /** 按下态（给 `:active` 用）。宿主有专门 token，比"hover 再深一档"更准。 */
  pressed: V("interactive-bg-active", "rgba(128,128,128,.18)"),
  // 描边：四级。宿主值是半透明黑/白（#0000001f / #ffffff29），天然双主题
  border1: V("border-l1", "rgba(128,128,128,.12)"),
  border2: V("border-l2", "rgba(128,128,128,.18)"),
  border3: V("border-l3", "rgba(128,128,128,.26)"),
  border4: V("border-l4", "rgba(128,128,128,.34)"),
  // 语义：强调 / 成功 / 警告 / 危险
  accent: V("link", "#4d6bfe"),
  accentHover: V("interactive-bg-hover-accent", "rgba(77,107,254,.12)"),
  ok: V("state-success-primary", "#2f9e44"),
  warn: V("state-warn-primary", "#e08c00"),
  danger: V("state-error-primary", "#e5484d"),
  /** 宿主主按钮填充（深色主题下是近白、浅色主题下是近黑——跟宿主按钮一致）。 */
  primaryFill: V("button-primary-fill", "#4d6bfe"),
  primaryHover: V("button-primary-hover", "rgba(77,107,254,.86)"),
  // 字体族（宿主变量 + 本地回退）
  mono: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
};
var tint = (c, pct) => `color-mix(in srgb, ${c} ${pct}%, transparent)`;
var space = { xs: 4, sm: 6, md: 8, lg: 12, xl: 16, xxl: 20 };
var radius = { sm: 6, md: 8, lg: 12, pill: 999 };
var font = { caption: 11, small: 12, body: 13, lead: 14, title: 15, hero: 18 };
var weight = { normal: 400, medium: 500, semibold: 600, bold: 700 };
var rootStyle = {
  boxSizing: "border-box",
  height: "100%",
  minHeight: 0,
  display: "flex",
  flexDirection: "column",
  color: color.text,
  fontSize: font.body,
  lineHeight: 1.6,
  background: "transparent"
};
var bodyStyle = {
  flex: "1 1 auto",
  minHeight: 0,
  overflowY: "auto",
  display: "flex",
  flexDirection: "column",
  gap: space.lg,
  padding: `${space.lg}px ${space.lg}px ${space.xxl}px`
};
var headerStyle = {
  display: "flex",
  alignItems: "center",
  gap: space.md,
  padding: `${space.lg}px ${space.lg}px`,
  flex: "0 0 auto",
  borderBottom: `1px solid ${color.border2}`
};
var brandMarkStyle = {
  flex: "none",
  width: "28px",
  height: "28px",
  borderRadius: radius.md,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: "15px",
  background: tint(color.accent, 14)
};
var titleStyle = { fontWeight: weight.bold, fontSize: font.title, letterSpacing: ".2px" };
var subtitleStyle = { color: color.text3, fontSize: font.caption, marginTop: "1px" };
var badgeStyle = {
  flex: "none",
  padding: "1px 7px",
  borderRadius: radius.pill,
  background: color.inset,
  color: color.text2,
  fontSize: font.caption,
  fontFamily: color.mono,
  lineHeight: "16px"
};
var sectionTitleStyle = {
  display: "flex",
  alignItems: "center",
  gap: space.sm,
  fontWeight: weight.semibold,
  fontSize: font.small,
  color: color.text2,
  marginTop: space.xs
};
var card = ({ tone = "plain", pad = space.lg } = {}) => {
  const tones = {
    plain: { border: color.border2, background: color.surface1 },
    inset: { border: color.border2, background: color.inset },
    accent: { border: tint(color.accent, 30), background: tint(color.accent, 8) },
    warn: { border: tint(color.warn, 34), background: tint(color.warn, 10) },
    danger: { border: tint(color.danger, 30), background: tint(color.danger, 8) },
    ok: { border: tint(color.ok, 30), background: tint(color.ok, 8) }
  };
  const t = tones[tone] ?? tones.plain;
  return {
    flex: "none",
    boxSizing: "border-box",
    border: `1px solid ${t.border}`,
    background: t.background,
    borderRadius: radius.lg,
    padding: `${pad}px`
  };
};
var btnLayout = ({ size = "md" } = {}) => ({
  flex: "none",
  display: "inline-flex",
  alignItems: "center",
  gap: "4px",
  justifyContent: "center",
  fontFamily: "inherit",
  fontWeight: weight.medium,
  cursor: "pointer",
  borderRadius: radius.md,
  boxSizing: "border-box",
  fontSize: size === "sm" ? font.caption : font.small,
  padding: size === "sm" ? "2px 7px" : "4px 10px",
  lineHeight: size === "sm" ? "16px" : "18px",
  whiteSpace: "nowrap"
  // 底/描边/字色**故意留空**：由 css.js 按 data-variant 给（含 hover/active）。
  // 这里若写死，内联优先级会压掉所有交互态。
});
var btnSizes = { sm: btnLayout({ size: "sm" }), md: btnLayout({ size: "md" }) };
var btnSkin = {
  primary: {
    rest: { background: color.primaryFill, color: color.onFill, borderColor: "transparent" },
    hover: { background: V("button-primary-hover", "rgba(77,107,254,.86)"), color: color.onFill },
    active: { background: V("button-primary-dimmed", color.primaryFill), color: color.onFill }
  },
  secondary: {
    rest: { background: color.inset, color: color.text, borderColor: color.border2 },
    hover: { background: color.hover, borderColor: color.border3 },
    active: { background: color.pressed, borderColor: color.border4 }
  },
  ghost: {
    rest: { background: "transparent", color: color.text2, borderColor: "transparent" },
    hover: { background: color.hover, color: color.text },
    active: { background: color.pressed, color: color.text }
  },
  accent: {
    rest: { background: tint(color.accent, 10), color: color.accent, borderColor: tint(color.accent, 40) },
    hover: { background: tint(color.accent, 18), borderColor: tint(color.accent, 60) },
    active: { background: tint(color.accent, 26), borderColor: tint(color.accent, 70) }
  },
  danger: {
    rest: { background: tint(color.danger, 10), color: color.danger, borderColor: tint(color.danger, 40) },
    hover: { background: tint(color.danger, 18), borderColor: tint(color.danger, 60) },
    active: { background: tint(color.danger, 26), borderColor: tint(color.danger, 70) }
  }
};
var BTN_VARIANTS = ["primary", "secondary", "ghost", "accent", "danger"];
var btn = ({ variant = "secondary", size = "md" } = {}) => ({
  ...btnLayout({ size }),
  ...(btnSkin[variant] ?? btnSkin.secondary).rest
});
var chip = ({ tone = "neutral" } = {}) => {
  const tones = {
    neutral: { background: color.inset, color: color.text3 },
    accent: { background: tint(color.accent, 14), color: color.accent },
    ok: { background: tint(color.ok, 14), color: color.ok },
    warn: { background: tint(color.warn, 16), color: color.warn },
    danger: { background: tint(color.danger, 14), color: color.danger },
    ink: { background: color.text, color: color.base }
  };
  const t = tones[tone] ?? tones.neutral;
  return {
    flex: "none",
    display: "inline-flex",
    alignItems: "center",
    gap: "3px",
    padding: "0 6px",
    borderRadius: radius.pill,
    fontSize: font.caption,
    lineHeight: "16px",
    whiteSpace: "nowrap",
    ...t
  };
};
var field = ({ mono = false } = {}) => ({
  boxSizing: "border-box",
  width: "100%",
  padding: "5px 8px",
  borderRadius: radius.md,
  border: `1px solid ${color.border3}`,
  background: color.inset,
  color: color.text,
  fontFamily: mono ? color.mono : "inherit",
  fontSize: font.small,
  lineHeight: 1.6,
  outline: "none"
});
var inputStyle = field();
var manuscriptStyle = {
  ...field({ mono: false }),
  minHeight: "180px",
  resize: "vertical",
  fontSize: font.small,
  lineHeight: 1.85,
  letterSpacing: ".2px"
};
var meterTrackStyle = {
  flex: "1 1 auto",
  height: "4px",
  borderRadius: radius.pill,
  background: color.inset,
  overflow: "hidden",
  minWidth: "40px"
};
var rowStyle = { display: "flex", alignItems: "flex-start", gap: space.md, flex: "none" };
var kStyle = {
  flex: "none",
  minWidth: "58px",
  fontFamily: color.mono,
  fontSize: font.caption,
  color: color.text3,
  paddingTop: "2px"
};
var vStyle = { flex: "auto", minWidth: 0, wordBreak: "break-word", fontSize: font.small };
var hintStyle = { color: color.text3, fontSize: font.small };
var errStyle = {
  flex: "auto",
  minWidth: 0,
  color: color.danger,
  fontSize: font.small,
  wordBreak: "break-word",
  lineHeight: 1.6
};
var okStyle = { color: color.ok, fontSize: font.small };
var warnStyle = {
  flex: "auto",
  minWidth: 0,
  color: color.warn,
  fontSize: font.small,
  wordBreak: "break-word",
  lineHeight: 1.6
};
var emptyStateStyle = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: space.sm,
  padding: `${space.xl}px ${space.lg}px`,
  textAlign: "center",
  border: `1px dashed ${color.border2}`,
  borderRadius: radius.lg,
  background: color.surface1
};
var emptyIconStyle = { fontSize: "20px", lineHeight: 1, opacity: 0.85 };
var emptyTitleStyle = { fontSize: font.small, color: color.text2 };
var footerStyle = {
  margin: 0,
  color: color.textDim,
  fontSize: font.caption,
  flex: "none",
  lineHeight: 1.7
};
var stackStyle = (gap = space.sm) => ({ display: "flex", flexDirection: "column", gap: `${gap}px` });
var rowWrapStyle = (gap = space.sm) => ({
  display: "flex",
  alignItems: "center",
  gap: `${gap}px`,
  flexWrap: "wrap"
});
var itemCardStyle = card();
var miniBtnStyle = btn({ size: "sm" });
var dangerBtnStyle = btn({ variant: "danger" });
var primaryBtnStyle = btn({ variant: "primary" });
var accentBtnStyle = btn({ variant: "accent" });
var emptyStyle = { color: color.text3 };

// lib/phases.js
var PHASES = [
  { id: "topic", label: "立意", order: 0, entry: "一句话故事（logline）已定" },
  { id: "setting", label: "设定", order: 1, entry: "世界书有条目或已写故事承诺书" },
  { id: "character", label: "人物", order: 2, entry: "至少一张人物卡" },
  { id: "outline", label: "大纲", order: 3, entry: "全书大纲已保存" },
  { id: "volume", label: "分卷", order: 4, entry: "大纲含卷/幕/部结构" },
  { id: "chapter", label: "细纲", order: 5, entry: "至少一章细纲已批准" },
  { id: "writing", label: "正文", order: 6, entry: "至少一章正文已保存" },
  { id: "revision", label: "修订", order: 7, entry: "至少一章正文，且全书一致性无硬伤" },
  { id: "done", label: "完稿", order: 8, entry: "所有已批细纲都有正文" }
];
var PHASE_IDS = PHASES.map((p) => p.id);
var LEGACY_STAGE = {
  planning: "topic",
  outline: "outline",
  drafting: "writing",
  revising: "revision",
  done: "done"
};
var LEGACY_STAGE_LABEL = {
  planning: "规划",
  outline: "大纲",
  drafting: "正文",
  revising: "修订",
  done: "完结"
};
function canonicalPhase(stage) {
  if (typeof stage !== "string" || stage === "") return null;
  if (PHASE_IDS.includes(stage)) return stage;
  return LEGACY_STAGE[stage] ?? null;
}
function phaseIndex(stage) {
  const id = canonicalPhase(stage);
  return id === null ? -1 : PHASES.find((p) => p.id === id).order;
}
function phaseLabel(stage) {
  const id = canonicalPhase(stage);
  if (id !== null) return PHASES.find((p) => p.id === id).label;
  return LEGACY_STAGE_LABEL[stage] ?? stage ?? "—";
}

// src/client/ui.js
var TAP = { "data-nf-tap": "1" };
function Card({ tone = "plain", pad } = {}, ...children) {
  return h("div", { style: pad === void 0 ? card({ tone }) : card({ tone, pad }) }, ...children);
}
function Section({ icon = "", title, right = null } = {}, ...children) {
  return h(
    "div",
    { style: stackStyle(space.sm) },
    h(
      "div",
      { style: { display: "flex", alignItems: "center", gap: space.sm } },
      h(
        "span",
        { style: { fontWeight: weight.semibold, fontSize: font.small, color: color.text2 } },
        icon ? `${icon} ${title}` : title
      ),
      right ? h("span", { style: { marginLeft: "auto", display: "flex", alignItems: "center", gap: space.xs } }, right) : null
    ),
    ...children
  );
}
function Btn(props = {}, ...label) {
  const { variant = "secondary", size = "md", action, id, disabled = false, title, block = false } = props;
  const aria = props.ariaLabel ?? props["aria-label"];
  const style = { ...btnLayout({ size }) };
  if (block) style.width = "100%";
  return h("button", {
    "data-nf-btn": "1",
    "data-variant": variant,
    "data-size": size,
    ...action ? { "data-action": action } : {},
    ...id === void 0 || id === null ? {} : { "data-id": String(id) },
    ...disabled ? { disabled: true } : {},
    ...title ? { title } : {},
    // M17 修复：aria-label 此前被参数白名单丢掉——纯图标按钮（▶⏸⏹）对读屏器不可名
    ...aria ? { "aria-label": aria } : {},
    style
  }, ...label);
}
function Chip({ tone = "neutral" } = {}, ...children) {
  return h("span", { style: chip({ tone }) }, ...children);
}
function Feedback({ tone = "ok" } = {}, ...children) {
  const isErr = tone === "err";
  return h("div", {
    role: isErr ? "alert" : "status",
    style: isErr ? errStyle : okStyle
  }, ...children);
}
function Stat({ icon = "", value, unit = "", tone = "neutral" } = {}) {
  const toneColor = tone === "warn" ? color.warn : tone === "danger" ? color.danger : tone === "ok" ? color.ok : tone === "accent" ? color.accent : color.text2;
  return h(
    "span",
    {
      style: {
        display: "inline-flex",
        alignItems: "baseline",
        gap: "2px",
        fontSize: font.caption,
        color: color.text3,
        whiteSpace: "nowrap",
        // 数字等宽：统计行里「12 章 / 34 台账 / 128 伏笔」横向对比时个位对齐，不跳宽
        fontVariantNumeric: "tabular-nums"
      }
    },
    icon ? h("span", { style: { fontSize: "10px" } }, icon) : null,
    h("span", { style: { fontWeight: weight.semibold, fontSize: font.small, color: toneColor } }, String(value)),
    unit ? h("span", null, unit) : null
  );
}
function StageRail({ stage } = {}) {
  const idx = phaseIndex(stage);
  const current = idx >= 0 ? PHASES[idx] : null;
  return h(
    "div",
    { style: stackStyle(space.xs) },
    h(
      "div",
      {
        style: { display: "flex", gap: "2px", alignItems: "center" },
        title: current ? `当前阶段：${current.label}（${current.entry}）` : "阶段未标记"
      },
      PHASES.map((p, i) => h("span", {
        key: p.id,
        "aria-hidden": "true",
        // 纯装饰；可读名称在 title 与下方 Chip 上
        style: {
          flex: "1 1 0",
          height: "3px",
          borderRadius: radius.pill,
          // 已过段用半透 accent、当前段全亮 + 外环——3px 小条上「现在到哪了」
          // 靠色差说话，不能只靠那圈 1.5px 的环（0.13.2 审查：同色根本分不出）。
          background: i < idx ? tint(color.accent, 42) : i === idx ? color.accent : color.border2,
          opacity: i === idx ? 1 : i < idx ? 0.9 : 1,
          boxShadow: i === idx ? `0 0 0 1.5px ${tint(color.accent, 30)}` : "none"
        }
      }))
    ),
    h(
      "div",
      { style: { display: "flex", alignItems: "center", gap: space.xs } },
      Chip({ tone: "accent" }, current ? current.label : "未标阶段"),
      current ? h(
        "span",
        { style: { ...hintStyle, fontSize: font.caption } },
        `${idx + 1}/${PHASES.length}`
      ) : null
    )
  );
}
function Empty({ icon = "·", title, hint = null, action = null } = {}) {
  return h(
    "div",
    { style: emptyStateStyle },
    h("span", { style: emptyIconStyle }, icon),
    h("div", { style: emptyTitleStyle }, title),
    hint ? h("div", { style: { ...hintStyle, fontSize: font.caption, lineHeight: 1.7 } }, hint) : null,
    action ? h("div", { style: { display: "flex", gap: space.sm, marginTop: space.xs } }, ...action) : null
  );
}
function KV({ k } = {}, ...children) {
  return h(
    "div",
    { style: { display: "flex", gap: space.md, alignItems: "flex-start" } },
    h("span", {
      style: {
        flex: "none",
        minWidth: "52px",
        fontFamily: color.mono,
        fontSize: font.caption,
        color: color.text3,
        paddingTop: "2px"
      }
    }, k),
    h("span", { style: { flex: "1 1 auto", minWidth: 0, fontSize: font.small, wordBreak: "break-word" } }, ...children)
  );
}
function Fold({ title, open = false, tone = "plain" } = {}, ...children) {
  const c = card({ tone, pad: space.md });
  return h(
    "details",
    { style: c, open },
    h("summary", {
      style: {
        cursor: "pointer",
        fontSize: font.small,
        color: color.text2,
        fontWeight: weight.medium,
        listStylePosition: "inside"
      }
    }, title),
    h("div", { style: { marginTop: space.sm } }, ...children)
  );
}
function Mono(_props = {}, ...children) {
  return h("span", { style: { fontFamily: color.mono, fontSize: font.caption, color: color.text3 } }, ...children);
}

// src/client/genre.js
var MAP = {
  fantasy: "奇幻",
  xuanhuan: "玄幻",
  xianxia: "仙侠",
  xiuzhen: "修真",
  wuxia: "武侠",
  scifi: "科幻",
  sciencefiction: "科幻",
  romance: "言情",
  mystery: "悬疑",
  suspense: "悬疑",
  thriller: "惊悚",
  horror: "恐怖",
  urban: "都市",
  city: "都市",
  game: "游戏",
  esports: "电竞",
  history: "历史",
  military: "军事",
  comedy: "喜剧",
  drama: "剧情",
  sliceoflife: "日常"
};
function genreLabel(genre) {
  const raw = String(genre ?? "").trim();
  if (!raw) return "";
  const key = raw.toLowerCase().replace(/[^a-z]/g, "");
  return MAP[key] ?? raw;
}

// src/client/views/project-list.js
function projectMatches(p, query) {
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) return true;
  return [p.title, p.name, p.genre ? genreLabel(p.genre) : ""].some((v) => String(v ?? "").toLowerCase().includes(q));
}
function statsOf(p) {
  const fh = p.foreshadows ?? {};
  const stats = [];
  if (p.chapters !== null && p.chapters !== void 0) stats.push(Stat({ icon: "📄", value: p.chapters, unit: "章" }));
  if (p.facts) stats.push(Stat({ icon: "🧾", value: p.facts, unit: "台账" }));
  if (fh.total) {
    stats.push(Stat({
      icon: "🪡",
      value: `${fh.open}/${fh.total}`,
      unit: "伏笔",
      tone: fh.overdue > 0 ? "warn" : "neutral"
    }));
  }
  if (p.castCount) stats.push(Stat({ icon: "👥", value: p.castCount, unit: "角色" }));
  return stats;
}
function ProjectListView({ state: s }) {
  const creating = s.creating;
  const filtering = s.projects.length > 8;
  const query = s.filter ?? "";
  const shown = filtering ? s.projects.filter((p) => projectMatches(p, query)) : s.projects;
  return h(
    "div",
    { style: stackStyle(space.lg) },
    // ── 创建 ──
    Card(
      { tone: "inset", pad: space.md },
      h(
        "div",
        { style: { display: "flex", gap: space.sm } },
        h("input", {
          // 非受控（defaultValue + key）：每键只进 state 不重渲染；
          // 创建成功后 panel bump titleReset，key 变化即清空输入框。
          key: `title-${s.titleReset ?? 0}`,
          "data-field": "title",
          defaultValue: s.title,
          placeholder: "新书书名…",
          "aria-label": "新书书名",
          style: { ...inputStyle, flex: "1 1 auto" }
        }),
        Btn({ variant: "primary", action: "create", disabled: creating }, creating ? "创建中…" : "创建")
      ),
      h(
        "div",
        { style: { display: "flex", alignItems: "center", gap: space.sm, marginTop: space.sm } },
        Btn({ variant: "ghost", size: "sm", action: "refresh-projects" }, "↻ 刷新"),
        Btn({ variant: "ghost", size: "sm", action: "import-file" }, "⇪ 导入本地")
      )
    ),
    s.error ? Feedback({ tone: "err" }, s.error) : null,
    s.notice ? Feedback({ tone: "ok" }, s.notice) : null,
    // 会话过滤空、回落显示全部时的说明（0.13.2：宿主 slot 会话标识与书写入的 id 不同源）
    s.sessionFallback === true ? h(
      "div",
      { style: { ...hintStyle, fontSize: font.caption, marginBottom: space.sm } },
      `本会话名下暂时没有匹配到书，先显示全部 ${s.projects.length} 本 —— 书都能正常打开；新建的书会归属到本会话。`
    ) : null,
    // ── 列表 ──
    s.loading ? h("div", { style: hintStyle }, "加载中…") : s.projects.length === 0 ? Empty({
      icon: "🔨",
      title: "本会话还没有项目",
      hint: "输入书名创建一个；或在会话里让 AI 调 novel_project init —— 书建好后会自动出现在这里。"
    }) : h(
      "div",
      { style: stackStyle(space.md) },
      filtering ? h(
        "div",
        { style: stackStyle(space.xs) },
        h("input", {
          "data-field": "project-filter",
          value: s.filter ?? "",
          placeholder: "筛选：书名 / 题材…",
          "aria-label": "筛选书目",
          style: inputStyle
        }),
        h(
          "div",
          { style: { ...hintStyle, fontSize: font.caption } },
          `${shown.length}/${s.projects.length} 本`
        )
      ) : null,
      shown.length === 0 ? Empty({ icon: "·", title: "没有匹配的书", hint: "换个关键词，或清空筛选框。" }) : null,
      ...shown.map((p) => h(
        "div",
        {
          key: p.name,
          style: { ...card(), padding: 0, overflow: "hidden", display: "flex", flexDirection: "column" }
        },
        h(
          "div",
          { style: { display: "flex", minWidth: 0 } },
          // 书脊：一条 3px 竖条，扫一眼就知道卡片边界在哪
          h("div", { style: { flex: "none", width: "3px", background: color.accent, opacity: 0.75 } }),
          h(
            "div",
            { style: { flex: "1 1 auto", minWidth: 0, padding: `${space.lg}px` } },
            // 标题行：整块可点（button 才能进 Tab 序 / 被读屏读到 / 回车触发）
            // `...TAP` 给它悬停/按下反馈 —— 交互态只能来自 css.js
            h(
              "button",
              {
                ...TAP,
                "data-action": "open",
                "data-id": p.name,
                style: {
                  display: "block",
                  width: "100%",
                  textAlign: "left",
                  cursor: "pointer",
                  // 热区只向上/左/右扩：底部若也负边距，会把下面的标签行
                  // 拉上来贴住按钮的 hover 高亮背景（0.13.1 用户实测重叠）。
                  padding: `${space.xs}px ${space.sm}px 0`,
                  margin: `-${space.xs}px -${space.sm}px 0`,
                  borderRadius: "8px",
                  border: "none",
                  font: "inherit",
                  color: "inherit"
                }
              },
              h(
                "div",
                { style: { display: "flex", alignItems: "center", gap: space.sm } },
                h("span", {
                  style: {
                    fontWeight: weight.semibold,
                    fontSize: font.lead,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap"
                  }
                }, p.title || p.name),
                p.style?.built ? Chip({ tone: "ok" }, "有基线") : null
              )
            ),
            h(
              "div",
              { style: { display: "flex", gap: space.xs, marginTop: space.xs } },
              p.genre ? Chip({}, genreLabel(p.genre)) : null,
              p.maxChapter ? Chip({}, `写到第 ${p.maxChapter} 章`) : null
            ),
            h("div", { style: { marginTop: space.md } }, StageRail({ stage: p.stage })),
            statsOf(p).length > 0 ? h("div", { style: { display: "flex", flexWrap: "wrap", gap: `${space.xs}px ${space.lg}px`, marginTop: space.md } }, ...statsOf(p)) : null,
            h(
              "div",
              { style: { display: "flex", alignItems: "center", gap: space.xs, marginTop: space.md } },
              Btn({ variant: "ghost", size: "sm", action: "goto-lorebook", id: p.name }, "📖 世界书"),
              Btn({ variant: "ghost", size: "sm", action: "rename-open", id: p.name }, "✎ 改名"),
              Btn({ variant: "ghost", size: "sm", action: "clone-open", id: p.name }, "⧉ 克隆"),
              h("span", { style: { flex: "1 1 auto" } }),
              Btn({ variant: "danger", size: "sm", action: "list-delete", id: p.name }, "删除")
            ),
            // 列表内联改名（目录名=id 不动，只改标题）
            s.rename && s.rename.id === p.name ? h(
              "div",
              { style: { display: "flex", gap: space.sm, marginTop: space.sm } },
              h("input", {
                "data-field": "rename-value",
                value: s.rename.value,
                placeholder: "新书名…",
                "aria-label": "新书名",
                style: { ...inputStyle, flex: "1 1 auto" }
              }),
              Btn(
                { variant: "primary", action: "rename-confirm", disabled: s.renaming },
                s.renaming ? "保存中…" : "确定"
              ),
              Btn({ action: "rename-cancel" }, "取消")
            ) : null,
            // 克隆为模板（老书连章节带资产复制成新书；目录名是稳定身份，必填）
            s.clone && s.clone.id === p.name ? h(
              "div",
              { style: { display: "flex", gap: space.sm, marginTop: space.sm } },
              h("input", {
                "data-field": "clone-value",
                value: s.clone.value,
                placeholder: "新书目录名（如：万刃-模板）",
                "aria-label": "新书目录名",
                style: { ...inputStyle, flex: "1 1 auto" }
              }),
              Btn(
                { variant: "primary", action: "clone-confirm", disabled: s.cloning },
                s.cloning ? "克隆中…" : "克隆"
              ),
              Btn({ action: "clone-cancel" }, "取消")
            ) : null,
            // 删除二次确认（误触可取消）
            s.listDeleteId === p.name ? h(
              "div",
              {
                style: {
                  display: "flex",
                  alignItems: "center",
                  gap: space.sm,
                  marginTop: space.sm,
                  padding: `${space.sm}px ${space.md}px`,
                  borderRadius: "8px",
                  background: tint(color.danger, 10)
                }
              },
              h("span", { style: { fontSize: font.small, color: color.danger } }, "删除这本书？"),
              h("span", { style: { flex: "1 1 auto" } }),
              Btn({
                variant: "danger",
                action: "list-delete",
                id: p.name,
                disabled: s.listDeleting
              }, s.listDeleting ? "删除中…" : "确认删除"),
              Btn({ action: "list-delete-cancel", disabled: s.listDeleting }, "取消")
            ) : null
          )
        )
      ))
    ),
    // ── 未归属的旧书（0.5.0 之前的书没有会话戳）──
    s.unclaimed && s.unclaimed.length > 0 ? Card(
      { tone: "inset", pad: space.md },
      Section(
        {
          icon: "📦",
          title: `未归属的书（${s.unclaimed.length}）`,
          right: Btn({ size: "sm", action: "claim" }, "全部认领")
        },
        h(
          "div",
          { style: { ...hintStyle, fontSize: font.caption } },
          "这些书建在会话归属功能之前。认领后归本会话，之后才会出现在上面的列表里。"
        ),
        h(
          "div",
          { style: stackStyle(space.xs) },
          ...s.unclaimed.map((p) => h(
            "div",
            {
              key: p.name,
              style: { display: "flex", alignItems: "center", gap: space.sm }
            },
            h("span", {
              style: {
                flex: "1 1 auto",
                minWidth: 0,
                fontSize: font.small,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap"
              }
            }, p.title || p.name),
            Btn({ variant: "ghost", size: "sm", action: "claim", id: p.name, disabled: s.busy }, "认领")
          ))
        )
      )
    ) : null,
    h(
      "p",
      { style: footerStyle },
      "列表只显示本会话创建或参与过的项目；写作、门禁、审计都在会话里由 novel_* 工具驱动。"
    )
  );
}

// src/client/views/chapters.js
function ChapterListView({ state: s }) {
  const pb = s.playback ?? { status: "idle", currentNo: null };
  if (s.chapterListLoading) return h("div", { style: hintStyle }, "章节目录加载中…");
  if (!s.chapterList.length) {
    return Empty({
      icon: "🎧",
      title: "这本书还没有章节",
      hint: "在会话里让 AI 调 novel_write_chapter 开写，写完这里就会出现目录，可以朗读与连播。",
      action: [Btn({ size: "sm", action: "back" }, "← 返回基本信息")]
    });
  }
  const firstNo = s.chapterList[0].no;
  const playing = pb.status === "playing";
  const paused = pb.status === "paused";
  const startNo = pb.currentNo ?? firstNo;
  const totalChars = s.chapterList.reduce((sum, c) => sum + (c.chars ?? 0), 0);
  const controls = Card(
    { tone: playing || paused ? "accent" : "plain", pad: space.md },
    h(
      "div",
      { style: { display: "flex", alignItems: "center", gap: space.sm } },
      !playing && !paused ? Btn({ variant: "primary", size: "sm", action: "play-from", id: startNo }, `▶ 从第 ${startNo} 章开始听`) : playing ? Btn({ variant: "primary", size: "sm", action: "playback-pause" }, "⏸ 暂停") : Btn({ variant: "primary", size: "sm", action: "playback-resume" }, "▶ 继续"),
      Btn({ variant: "ghost", size: "sm", action: "playback-stop", disabled: !playing && !paused }, "⏹ 停止"),
      h("span", { style: { flex: "1 1 auto" } }),
      Stat({ icon: "📄", value: s.chapterList.length, unit: "章" }),
      Stat({ icon: "·", value: totalChars.toLocaleString(), unit: "字" })
    ),
    h(
      "div",
      {
        role: "status",
        // 「正在读第几章」是异步变化，读屏要能听到
        style: { ...hintStyle, fontSize: font.caption, marginTop: space.sm }
      },
      playing || paused ? `正在读：第 ${pb.currentNo} 章${paused ? "（已暂停）" : ""}` : "读完一章自动接下一章；章号有缺口会跳到下一个存在的章。"
    )
  );
  const rows = s.chapterList.map((c) => {
    const isCurrent = pb.currentNo === c.no && (playing || paused);
    return h(
      "div",
      {
        key: c.no,
        style: {
          display: "flex",
          alignItems: "center",
          gap: space.sm,
          padding: `${space.sm}px ${space.md}px`,
          borderRadius: "8px",
          background: isCurrent ? tint(color.accent, 10) : color.surface1,
          border: `1px solid ${isCurrent ? tint(color.accent, 32) : color.border2}`,
          // 长书目（几百章）跳过视口外的行不渲染内容——窄栏里滑目录不再整页卡
          contentVisibility: "auto",
          containIntrinsicSize: "auto 44px"
        }
      },
      h("span", {
        style: {
          flex: "none",
          width: "30px",
          fontFamily: color.mono,
          fontSize: font.caption,
          color: isCurrent ? color.accent : color.textDim,
          fontWeight: isCurrent ? weight.bold : weight.normal
        }
      }, String(c.no)),
      h("span", {
        style: {
          flex: "1 1 auto",
          minWidth: 0,
          fontSize: font.small,
          fontWeight: isCurrent ? weight.semibold : weight.normal,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap"
        }
      }, c.title || `第 ${c.no} 章`),
      isCurrent && playing ? Chip({ tone: "accent" }, "♪ 播报中") : null,
      c.version > 1 ? Chip({}, `v${c.version}`) : null,
      h("span", { style: { ...hintStyle, fontSize: font.caption, whiteSpace: "nowrap" } }, `${c.chars ?? 0} 字`),
      Btn({ variant: "ghost", size: "sm", action: "read-chapter", id: c.no, title: `阅读第 ${c.no} 章`, ariaLabel: `阅读第 ${c.no} 章` }, "📖"),
      Btn({ variant: "ghost", size: "sm", action: "play-from", id: c.no, title: `从第 ${c.no} 章开始听`, ariaLabel: `从第 ${c.no} 章开始听` }, "▶")
    );
  });
  const reader = s.reader ? Card(
    { tone: "accent", pad: space.md },
    h(
      "div",
      { style: { display: "flex", alignItems: "center", gap: space.sm } },
      h("span", {
        style: { flex: "1 1 auto", minWidth: 0, fontWeight: weight.semibold, fontSize: font.small }
      }, `📖 第 ${s.reader.no} 章 · ${s.reader.title}`),
      Btn({ variant: "secondary", size: "sm", action: "play-from", id: s.reader.no, title: `从第 ${s.reader.no} 章开始听` }, "▶ 朗读本章"),
      Btn({ variant: "ghost", size: "sm", action: "close-reader", title: "收起阅读器", ariaLabel: "收起阅读器" }, "✕")
    ),
    h("div", {
      style: {
        marginTop: space.sm,
        maxHeight: "420px",
        overflowY: "auto",
        fontSize: font.small,
        lineHeight: 1.85,
        whiteSpace: "pre-wrap",
        color: color.text
      }
    }, s.reader.loading ? "正文加载中…" : s.reader.text || "（本章正文为空）")
  ) : null;
  return h(
    "div",
    { style: stackStyle(space.md) },
    controls,
    s.error ? Feedback({ tone: "err" }, s.error) : null,
    reader,
    h("div", { style: stackStyle(space.xs) }, ...rows)
  );
}

// src/client/views/overview.js
var preStyle = {
  margin: 0,
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  fontSize: font.small,
  lineHeight: 1.8
};
function factLine(f) {
  return h(
    "div",
    {
      style: {
        display: "flex",
        alignItems: "baseline",
        gap: space.xs,
        fontSize: font.small,
        padding: "1px 0"
      }
    },
    h("span", { style: { color: color.text2, fontWeight: weight.medium } }, f.entity ?? "？"),
    h("span", { style: { color: color.textDim, fontSize: font.caption } }, f.key ?? "？"),
    h("span", { style: { color: color.textDim, fontSize: font.caption } }, "→"),
    h("span", { style: { flex: "1 1 auto", minWidth: 0, wordBreak: "break-word" } }, f.value ?? "？")
  );
}
function ProjectOverviewView({ state: s }) {
  const el = s.elements;
  if (s.elementsLoading) return h("div", { style: hintStyle }, "要素加载中…");
  if (!el) {
    return Empty({
      icon: "📂",
      title: "要素没读出来",
      hint: "可能这本书刚建、还没有任何沉淀文件。点上方「刷新」重试一次。"
    });
  }
  const meta = el.meta ?? {};
  const facts = Array.isArray(el.facts) ? el.facts : [];
  const foreshadows = Array.isArray(el.foreshadows) ? el.foreshadows : [];
  const chars = Array.isArray(el.characters) ? el.characters : [];
  const castNames = (meta.cast ?? []).map((c) => typeof c === "string" ? c : c?.name).filter(Boolean);
  const outlineCount = el.outline?.chapterOutlines?.length ?? 0;
  const writtenMax = (s.chapterList ?? []).reduce((m, c) => Math.max(m, c.no ?? 0), 0);
  const fmtDate = (iso) => {
    if (!iso) return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" });
  };
  const profile = Card(
    { tone: "plain" },
    h(
      "div",
      { style: { display: "flex", alignItems: "center", gap: space.sm, flexWrap: "wrap" } },
      h("span", { style: { fontWeight: weight.semibold, fontSize: font.lead } }, meta.title || s.selected),
      meta.genre ? Chip({ tone: "neutral" }, genreLabel(meta.genre)) : null,
      meta.stage ? Chip({ tone: "accent" }, String(meta.stage)) : null
    ),
    h(
      "div",
      { style: { ...stackStyle(space.xs), marginTop: space.md } },
      KV({ k: "创建" }, fmtDate(meta.createdAt)),
      KV({ k: "更新" }, fmtDate(meta.updatedAt)),
      KV({ k: "角色" }, castNames.length ? castNames.join("、") : "—")
    ),
    meta.logline ? h("div", {
      style: {
        marginTop: space.md,
        padding: `${space.sm}px ${space.md}px`,
        borderLeft: `2px solid ${tint(color.accent, 55)}`,
        borderRadius: "0 6px 6px 0",
        background: tint(color.accent, 6),
        fontSize: font.small,
        color: color.text2,
        lineHeight: 1.7
      }
    }, meta.logline) : null
  );
  const tiles = Card(
    { tone: "inset", pad: space.md },
    h(
      "div",
      { style: { display: "flex", flexWrap: "wrap", gap: `${space.sm}px ${space.xl}px` } },
      Stat({ icon: "🗺", value: el.outline?.full ? "有" : "无", unit: "大纲", tone: el.outline?.full ? "ok" : "warn" }),
      Stat({ icon: "📑", value: outlineCount, unit: "细纲" }),
      Stat({ icon: "👤", value: chars.length, unit: "角色卡" }),
      Stat({ icon: "📖", value: el.worldbookCount ?? 0, unit: "世界书" }),
      Stat({ icon: "🔤", value: el.glossaryCount ?? 0, unit: "术语" }),
      Stat({ icon: "🧾", value: facts.length, unit: "台账" }),
      Stat({ icon: "🪡", value: foreshadows.length, unit: "伏笔" })
    )
  );
  const outlineBlock = el.outline?.full ? Fold(
    { title: "📖 全书大纲", open: false },
    h("div", { style: preStyle }, el.outline.full)
  ) : Empty({ icon: "🗺", title: "还没有全书大纲", hint: "在会话里让 AI 调 novel_outline 生成，生成后这里会显示全文。" });
  const castBlock = chars.length > 0 ? h(
    "div",
    { style: stackStyle(space.xs) },
    ...chars.map((c) => Fold({ title: `👤 ${c.name}` }, h("div", { style: preStyle }, c.text || "（空卡）")))
  ) : Empty({
    icon: "👥",
    title: "还没有角色卡",
    hint: "在会话里让 AI 调 novel_cast 生成。" + (castNames.length ? `已登记但无卡的角色：${castNames.join("、")}` : "")
  });
  const settingBlock = h(
    "div",
    { style: stackStyle(space.sm) },
    h(
      "div",
      { style: { display: "flex", alignItems: "center", gap: space.md, flexWrap: "wrap" } },
      Stat({ icon: "📖", value: el.worldbookCount ?? 0, unit: "条世界书" }),
      Stat({ icon: "🔤", value: el.glossaryCount ?? 0, unit: "条术语" })
    ),
    (el.worldbookCount ?? 0) + (el.glossaryCount ?? 0) === 0 ? Empty({ icon: "🧭", title: "设定还是空的", hint: "在会话里让 AI 调 novel_world 沉淀世界观；也可以在「世界书」里手动加。" }) : null
  );
  const byChapter = /* @__PURE__ */ new Map();
  for (const f of facts) {
    const no = f.chapter ?? 0;
    if (!byChapter.has(no)) byChapter.set(no, []);
    byChapter.get(no).push(f);
  }
  const chaptersSorted = [...byChapter.keys()].sort((a, b) => a - b);
  const timelineBlock = chaptersSorted.length > 0 ? Fold(
    { title: `🕰 事实时间线（${facts.length} 条 / ${chaptersSorted.length} 章）`, open: facts.length <= 24 },
    h(
      "div",
      { style: stackStyle(0) },
      ...chaptersSorted.map((no, gi) => h(
        "div",
        {
          key: no,
          style: {
            display: "flex",
            gap: space.md,
            minWidth: 0,
            // 时间线一开可能上百章的账；视口外的分组不渲染内容
            contentVisibility: "auto",
            containIntrinsicSize: "auto 96px"
          }
        },
        // 左：竖轴（圆点 + 连线；最后一节不画线）
        h(
          "div",
          {
            style: {
              flex: "none",
              width: "10px",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              paddingTop: "5px"
            }
          },
          h("span", {
            style: {
              width: "6px",
              height: "6px",
              borderRadius: "50%",
              background: no === 0 ? color.textDim : color.accent,
              flex: "none"
            }
          }),
          gi < chaptersSorted.length - 1 ? h("span", { style: { flex: "1 1 auto", width: "1px", background: color.border2, minHeight: "8px" } }) : null
        ),
        // 右：章标签 + 该章全部事实
        h(
          "div",
          { style: { flex: "1 1 auto", minWidth: 0, paddingBottom: space.md } },
          h(
            "div",
            { style: { fontSize: font.caption, color: color.text3, marginBottom: "2px" } },
            no > 0 ? `第 ${no} 章` : "未定章"
          ),
          ...(byChapter.get(no) ?? []).map((f, i) => h("div", { key: i }, factLine(f)))
        )
      ))
    )
  ) : Empty({
    icon: "⏳",
    title: "账本还是空的",
    hint: "开始写章后，novel_write_chapter 会自动把状态变化记进时间线（谁在哪章变成了什么）。"
  });
  const foreshadowBlock = foreshadows.length > 0 ? Fold(
    { title: `🪡 伏笔（${foreshadows.length} 个）` },
    h(
      "div",
      { style: stackStyle(space.sm) },
      ...foreshadows.map((f, i) => {
        const paid = Number.isInteger(f.payoffChapter);
        const overdue = !paid && Number.isInteger(f.plan) && writtenMax > f.plan;
        return h(
          "div",
          {
            key: i,
            style: {
              display: "flex",
              flexDirection: "column",
              gap: "2px",
              paddingBottom: space.sm,
              borderBottom: i < foreshadows.length - 1 ? `1px solid ${color.border1}` : "none"
            }
          },
          h(
            "div",
            { style: { display: "flex", alignItems: "center", gap: space.sm, flexWrap: "wrap" } },
            Mono({}, f.id ?? "？"),
            Chip(
              { tone: paid ? "ok" : overdue ? "warn" : "neutral" },
              paid ? `已回收·第 ${f.payoffChapter} 章` : overdue ? `超期·计划第 ${f.plan} 章` : `未回收·计划第 ${f.plan ?? "？"} 章`
            ),
            h("span", { style: { ...hintStyle, fontSize: font.caption } }, `第 ${f.chapter ?? "？"} 章埋`)
          ),
          f.setup ? h("div", { style: { ...preStyle, fontSize: font.caption, color: color.text2 } }, f.setup) : null
        );
      })
    )
  ) : null;
  return h(
    "div",
    { style: stackStyle(space.xl) },
    Section({ icon: "📚", title: "档案" }, profile, tiles),
    Section({ icon: "🗺", title: "大纲" }, outlineBlock),
    Section({ icon: "👥", title: "角色卡" }, castBlock),
    Section({ icon: "🧭", title: "设定" }, settingBlock),
    Section({ icon: "⏳", title: "时间线 · 账本" }, timelineBlock),
    foreshadowBlock ? Section({ icon: "🪡", title: "伏笔" }, foreshadowBlock) : null
  );
}

// src/client/views/project-detail.js
function Segmented({ tab }) {
  const item = (value, label) => {
    const active = tab === value;
    return h("button", {
      "data-action": "detail-tab",
      "data-tab": value,
      // 四态（常态 / 悬停 / 按下 / 选中）全部由 css.js 的 [data-nf-seg] 规则管：
      // 「选中」是状态不是伪类，用 data-active 表达，CSS 才能一次排好优先级
      //（底色若内联，选中项一悬停就会丢掉"选中"的样子）。
      "data-nf-seg": "1",
      "data-active": active ? "1" : "0",
      style: {
        flex: "1 1 0",
        padding: `${space.xs + 1}px ${space.md}px`,
        border: "none",
        borderRadius: "7px",
        cursor: "pointer",
        fontFamily: "inherit",
        fontSize: font.small,
        fontWeight: active ? weight.semibold : weight.normal
      }
    }, label);
  };
  return h("div", {
    style: {
      display: "flex",
      gap: "2px",
      padding: "2px",
      borderRadius: "9px",
      background: color.inset
    }
  }, item("info", "📋 基本信息"), item("chapters", "🎧 章节听书"));
}
function issueRow(issue, i, total) {
  const isErr = issue.severity === "error";
  return h(
    "div",
    {
      key: i,
      style: {
        display: "flex",
        gap: space.sm,
        alignItems: "flex-start",
        paddingTop: space.sm,
        marginTop: i === 0 ? 0 : space.sm,
        borderTop: i === 0 ? "none" : `1px solid ${color.border1}`
      }
    },
    h(
      "span",
      { style: { flex: "none", fontSize: font.small, color: isErr ? color.danger : color.warn } },
      isErr ? "✗" : "⚠"
    ),
    h(
      "div",
      { style: { flex: "1 1 auto", minWidth: 0 } },
      h("div", { style: { fontSize: font.small, lineHeight: 1.65 } }, issue.message ?? ""),
      h(
        "div",
        { style: { marginTop: "2px", display: "flex", gap: space.sm, flexWrap: "wrap" } },
        Chip({ tone: isErr ? "danger" : "warn" }, issue.where ?? ""),
        Mono({}, issue.code ?? ""),
        total > 12 && i === 11 ? Chip({}, `…另有 ${total - 12} 条`) : null
      )
    )
  );
}
function batchRow(r, i) {
  const ok = r.ok === true;
  return h(
    "div",
    {
      key: i,
      style: { display: "flex", alignItems: "flex-start", gap: space.sm, fontSize: font.small, padding: "2px 0" }
    },
    h("span", { style: { flex: "none", color: ok ? color.ok : color.danger } }, ok ? "✓" : "✗"),
    h("span", { style: { flex: "none", color: color.text3, minWidth: "52px" } }, `第 ${r.chapter} 章`),
    h(
      "span",
      { style: { flex: "1 1 auto", minWidth: 0, wordBreak: "break-word", color: ok ? color.text2 : color.danger } },
      ok ? `${r.title ?? ""} ${r.chars ? `${r.chars} 字` : ""} v${r.version ?? 1}${r.noai?.level ? ` · 去AI味 ${r.noai.level}` : ""}` : r.reason ?? r.contentGate?.reason ?? "未通过门禁"
    )
  );
}
function ProjectDetailView({ state: s }) {
  const chapters = s.chapterList ?? [];
  const maxWritten = chapters.reduce((m, c) => Math.max(m, c.no ?? 0), 0);
  const nextNo = maxWritten + 1;
  const pendingProposals = (s.proposals || []).filter((p) => p.status === "pending");
  const revising = s.revising ?? null;
  const crumb = h(
    "div",
    { style: { display: "flex", alignItems: "center", gap: space.sm, minWidth: 0 } },
    Btn({ variant: "ghost", size: "sm", action: "back" }, "← 返回"),
    h("span", {
      style: {
        fontWeight: weight.semibold,
        fontSize: font.lead,
        minWidth: 0,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap"
      }
    }, s.detail?.title || s.selected || ""),
    s.detail?.stage ? Chip({ tone: "accent" }, phaseLabel(s.detail.stage)) : null
  );
  const cont = s.continuity;
  const continuityBlock = Card(
    { tone: cont && cont.ok === false ? "danger" : "plain" },
    h(
      "div",
      { style: { display: "flex", alignItems: "center", gap: space.sm } },
      h("span", { style: { fontWeight: weight.semibold, fontSize: font.small } }, "🩺 全书体检"),
      cont ? Chip(
        { tone: cont.ok ? "ok" : "danger" },
        cont.ok ? "未发现硬伤" : `${cont.stats?.errors ?? 0} 处硬伤`
      ) : null,
      h("span", { style: { flex: "1 1 auto" } }),
      Btn({
        size: "sm",
        variant: cont ? "ghost" : "secondary",
        action: "continuity",
        disabled: s.continuityLoading
      }, s.continuityLoading ? "体检中…" : cont ? "↻ 重跑" : "开始体检")
    ),
    s.continuityLoading ? h("div", { style: { ...hintStyle, marginTop: space.sm } }, "正在核对账本、伏笔、时间线与文件……") : !cont ? h(
      "div",
      { style: { ...hintStyle, fontSize: font.caption, marginTop: space.sm, lineHeight: 1.7 } },
      "查的是「死人复活 / 账本前后矛盾 / 伏笔超期未收 / 章号断档 / 人物卡缺失」这类机器判得出来的硬伤 —— 全部是纯本地计算，不花 token。"
    ) : h(
      "div",
      { style: { marginTop: space.md } },
      h(
        "div",
        { style: { display: "flex", flexWrap: "wrap", gap: `${space.xs}px ${space.lg}px`, marginBottom: cont.issues?.length ? space.sm : 0 } },
        Stat({ icon: "📄", value: cont.stats?.chapters ?? 0, unit: "章" }),
        Stat({ icon: "🧾", value: cont.stats?.facts ?? 0, unit: "台账" }),
        Stat({ icon: "🪡", value: cont.stats?.foreshadows ?? 0, unit: "伏笔" }),
        Stat({ icon: "⚰️", value: cont.stats?.deaths ?? 0, unit: "死亡实体" }),
        Stat({
          icon: "⚠️",
          value: cont.stats?.errors ?? 0,
          unit: "硬伤",
          tone: (cont.stats?.errors ?? 0) > 0 ? "danger" : "ok"
        }),
        Stat({
          icon: "·",
          value: cont.stats?.warnings ?? 0,
          unit: "警告",
          tone: (cont.stats?.warnings ?? 0) > 0 ? "warn" : "neutral"
        })
      ),
      cont.issues?.length > 0 ? h(
        "div",
        null,
        ...cont.issues.slice(0, 12).map((it, i) => issueRow(it, i, cont.issues.length)),
        // 截断的其余条目可展开：只给计数不给出口，等于让人干瞪眼
        cont.issues.length > 12 ? Fold(
          { title: `展开其余 ${cont.issues.length - 12} 条` },
          ...cont.issues.slice(12).map((it, i) => issueRow(it, i + 12, cont.issues.length))
        ) : null
      ) : h(
        "div",
        { style: { ...okStyle, fontSize: font.small } },
        "账本、伏笔、时间线、文件都对得上。"
      )
    ),
    s.continuityError ? Feedback({ tone: "err" }, s.continuityError) : null
  );
  const diag = s.diagnosis;
  const diagnosisBlock = Card(
    { tone: "plain" },
    h(
      "div",
      { style: { display: "flex", alignItems: "center", gap: space.sm } },
      h("span", { style: { fontWeight: weight.semibold, fontSize: font.small } }, "📐 黄金三章诊断"),
      h("span", { style: { flex: "1 1 auto" } }),
      Btn({
        size: "sm",
        variant: diag ? "ghost" : "secondary",
        action: "diagnose",
        disabled: s.diagnosisLoading
      }, s.diagnosisLoading ? "诊断中…" : diag ? "↻ 重跑" : "开始诊断")
    ),
    s.diagnosisLoading ? h("div", { style: { ...hintStyle, marginTop: space.sm } }, "正在按词表给前三章打分……") : !diag ? h(
      "div",
      { style: { ...hintStyle, fontSize: font.caption, marginTop: space.sm, lineHeight: 1.7 } },
      "对前三章做确定性打分：钩子强度 / 开场质量 / 冲突密度 / 信息灌输度（0-100）。纯词表算法，零 token —— 与会话里调 novel_diagnose 是同一个函数。"
    ) : h(
      "div",
      { style: { marginTop: space.md } },
      h("div", { style: { ...okStyle, fontSize: font.small, marginBottom: space.sm } }, diag.overall),
      h(
        "div",
        { style: { display: "flex", flexWrap: "wrap", gap: `${space.xs}px ${space.lg}px`, marginBottom: space.sm } },
        ...(diag.perChapter ?? []).map((c) => h(
          "div",
          {
            key: c.chapter,
            style: { fontSize: font.caption, color: color.text3, lineHeight: 1.9 }
          },
          `第 ${c.chapter} 章《${c.title}》`,
          h(
            "div",
            { style: { fontFamily: color.mono, fontSize: font.caption } },
            `钩子 ${c.hook} · 开场 ${c.opening} · 冲突 ${c.conflict} · 灌输 ${c.infodump}`
          )
        ))
      ),
      (diag.issues ?? []).length > 0 ? h(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: `${space.xs}px` } },
        ...(diag.issues ?? []).slice(0, 8).map((it, i) => h("div", {
          key: i,
          style: { ...hintStyle, fontSize: font.caption }
        }, `· ${it}`))
      ) : null
    ),
    s.diagnosisError ? Feedback({ tone: "err" }, s.diagnosisError) : null
  );
  const proposalsBlock = Card(
    { tone: pendingProposals.length > 0 ? "warn" : "plain" },
    h(
      "div",
      { style: { display: "flex", alignItems: "center", gap: space.sm } },
      h("span", { style: { fontWeight: weight.semibold, fontSize: font.small } }, "📝 待批准提案"),
      pendingProposals.length > 0 ? Chip({ tone: "warn" }, String(pendingProposals.length)) : null,
      h("span", { style: { flex: "1 1 auto" } }),
      s.proposalBusy ? h("span", { style: { ...hintStyle, fontSize: font.caption } }, "处理中…") : null
    ),
    s.proposalsLoading ? h("div", { style: { ...hintStyle, fontSize: font.caption, marginTop: space.sm } }, "加载中…") : s.proposalsError ? h(
      "div",
      { style: { display: "flex", flexDirection: "column", gap: space.xs, marginTop: space.sm } },
      h(
        "div",
        { style: { ...hintStyle, fontSize: font.caption, color: color.danger, lineHeight: 1.7 } },
        `⚠️ 提案队列加载失败：${s.proposalsError}——这**不是**「没有待批」，点重试再拉一次。`
      ),
      Btn({ variant: "secondary", action: "reload-proposals" }, "重试")
    ) : pendingProposals.length === 0 ? h(
      "div",
      { style: { ...hintStyle, fontSize: font.caption, marginTop: space.sm, lineHeight: 1.7 } },
      "没有待批的修订。模型改稿（含面板上的润色/校对）都先落到这里，由你点「应用」才生成新版本。"
    ) : h(
      "div",
      { style: stackStyle(space.xs) },
      ...pendingProposals.map((p) => {
        const busy = s.proposalBusy === p.id;
        const open = s.proposalDetail?.id === p.id;
        const when = p.createdAt ? String(p.createdAt).slice(5, 16).replace("T", " ") : "";
        const what = p.missing ? "⚠️ 提案文件缺失（索引还在、文件被删）——建议直接丢弃" : p.reason || p.preview || "（模型未附说明——点「查看」读全文再决定）";
        const detail = s.proposalDetail;
        return h(
          "div",
          {
            key: p.id,
            style: {
              display: "flex",
              flexDirection: "column",
              gap: space.xs,
              padding: `${space.sm}px ${space.md}px`,
              borderRadius: "8px",
              background: color.surface2
            }
          },
          // 行 1：哪一章 + 章标题 + 何时提的 + 三个动作
          h(
            "div",
            { style: { display: "flex", alignItems: "center", gap: space.sm, flexWrap: "wrap" } },
            h(
              "span",
              { style: { flex: "1 1 auto", minWidth: 0, fontSize: font.small, fontWeight: weight.semibold } },
              `第 ${p.chapter} 章${p.title ? " · " + p.title : ""}`,
              h(
                "span",
                { style: { ...hintStyle, fontSize: font.caption, marginLeft: space.sm, fontWeight: weight.normal } },
                `${p.id}${when ? " · " + when : ""}`
              )
            ),
            Btn({ size: "sm", action: "proposal-view", id: p.id }, open ? "收起" : "👁 查看"),
            Btn(
              { size: "sm", variant: "primary", action: "proposal-apply", id: p.id, disabled: busy },
              busy ? "…" : "应用"
            ),
            Btn({ size: "sm", variant: "danger", action: "proposal-discard", id: p.id, disabled: busy }, "丢弃")
          ),
          // 行 2：提案要干嘛（一句话说明 / 摘要）
          h("div", { style: { ...hintStyle, fontSize: font.caption, lineHeight: 1.7 } }, what),
          // 行 3：展开的全文（应用前可通读修订稿）
          open && (detail.loading ? h("div", { style: { ...hintStyle, fontSize: font.caption } }, "加载全文中…") : detail.error ? h("div", { style: { ...errStyle, fontSize: font.caption } }, detail.error) : h("div", {
            style: {
              maxHeight: "260px",
              overflowY: "auto",
              whiteSpace: "pre-wrap",
              fontSize: font.caption,
              lineHeight: 1.8,
              color: color.text2,
              padding: space.sm,
              borderRadius: "6px",
              background: color.surface1
            }
          }, detail.data?.content ?? "（提案内容为空）"))
        );
      })
    )
  );
  const chapterOptions = Array.from({ length: Math.max(1, (s.detail?.chapters ? Object.keys(s.detail.chapters).length : 0) + 1) }, (_, i) => i + 1);
  const editBlock = Card(
    { tone: "plain" },
    h(
      "div",
      { style: { display: "flex", alignItems: "center", gap: space.sm, flexWrap: "wrap" } },
      h("span", { style: { fontWeight: weight.semibold, fontSize: font.small } }, "✍️ 本章编辑"),
      h("span", { style: { flex: "1 1 auto" } }),
      h("select", {
        "data-field": "chapterNo",
        value: String(s.chapterNo),
        "aria-label": "切换到第几章",
        style: { ...inputStyle, width: "auto", padding: "3px 6px" }
      }, chapterOptions.map((no) => h("option", { key: no, value: String(no) }, `第 ${no} 章`)))
    ),
    // 需要模型的三个动作：润色/校对走真端点，写章给可复制提示
    h(
      "div",
      { style: { ...rowWrapStyle(space.xs), marginTop: space.sm } },
      Btn({
        size: "sm",
        variant: "accent",
        action: "polish",
        disabled: revising !== null || s.chapterNo > maxWritten
      }, revising === "polish" ? "润色中…" : "✨ 润色"),
      Btn({
        size: "sm",
        variant: "secondary",
        action: "proofread",
        disabled: revising !== null || s.chapterNo > maxWritten
      }, revising === "proofread" ? "校对中…" : "🔍 校对"),
      Btn({
        size: "sm",
        variant: "ghost",
        action: "write",
        disabled: s.batchBusy
      }, s.batchBusy ? "写作中…" : "🪶 写章"),
      h(
        "span",
        { style: { ...hintStyle, fontSize: font.caption } },
        s.chapterNo > maxWritten ? "这一章还没落盘 —— 点写章直接过门禁链落盘" : "写章=生成新版本（旧稿保留）；润色/校对的产物是提案"
      )
    ),
    s.error ? Feedback({ tone: "err" }, s.error) : null,
    s.notice ? Feedback({ tone: "ok" }, s.notice) : null,
    // 应用提案后的门禁提示：服务端已把这版正文过了一遍内容门禁（lib/proposals.js），
    // 应用是用户主权（不拦），但「改出了死人复活 / 隐藏人物泄底」必须当场看见。
    s.gateNotice ? h(
      "div",
      {
        role: "alert",
        style: { ...stackStyle, marginTop: space.sm, gap: space.xs }
      },
      h(
        "div",
        { style: warnStyle },
        `⚠ 刚应用的第 ${s.gateNotice.chapter} 章 v${s.gateNotice.version} 有门禁提示：`
      ),
      ...(s.gateNotice.blocking ?? []).map((m, i) => h("div", { key: `gb${i}`, style: errStyle }, `✗ ${m}`)),
      ...(s.gateNotice.warnings ?? []).map((m, i) => h("div", { key: `gw${i}`, style: warnStyle }, `· ${m}`))
    ) : null,
    // 未保存离开确认：返回 / 换章前有改动时，先问一句
    s.discardPending ? h(
      "div",
      {
        style: {
          display: "flex",
          alignItems: "center",
          gap: space.sm,
          marginTop: space.md,
          padding: `${space.sm}px ${space.md}px`,
          borderRadius: "8px",
          background: tint(color.warn, 12),
          border: `1px solid ${tint(color.warn, 30)}`
        }
      },
      h("span", { style: { flex: "1 1 auto", fontSize: font.small, color: color.warn } }, "本章有未保存的改动"),
      Btn({ size: "sm", variant: "danger", action: "discard-confirm" }, "丢弃改动"),
      Btn({ size: "sm", action: "discard-cancel" }, "取消")
    ) : null,
    // 稿纸区（key 带版本号，刷新章节时强制重建以吸收新的 defaultValue）
    h("textarea", {
      "data-field": "draft",
      key: `draft-${s.draftVersion}`,
      defaultValue: s.draft,
      placeholder: "本章正文…",
      "aria-label": "本章正文",
      rows: 9,
      style: { ...manuscriptStyle, marginTop: space.md, display: "block" }
    }),
    h(
      "div",
      { style: { display: "flex", alignItems: "center", gap: space.xs, marginTop: space.sm, flexWrap: "wrap" } },
      Btn({ size: "sm", variant: "primary", action: "save" }, "💾 保存"),
      Btn({ size: "sm", variant: "ghost", action: "refresh" }, "↻ 刷新"),
      Btn(
        { size: "sm", variant: "ghost", action: "export", disabled: s.exporting },
        s.exporting ? "导出中…" : "⇩ 导出"
      ),
      Btn({ size: "sm", variant: "ghost", action: "goto-lorebook", id: s.selected }, "📖 世界书"),
      h("span", { style: { flex: "1 1 auto" } }),
      s.deleteState === "confirm" ? Btn({ size: "sm", action: "delete-cancel" }, "取消删除") : null,
      // 'busy'（请求在途）也必须有自己的样子：只判 'confirm' 会让按钮在 await
      // 窗口里退回「删除」，看着像确认被吞掉。控制器已忽略重复点击，这里补视觉。
      Btn(
        { size: "sm", variant: "danger", action: "delete", disabled: s.deleteState === "busy" },
        s.deleteState === "busy" ? "删除中…" : s.deleteState === "confirm" ? "确认删除这本书？" : "删除"
      )
    ),
    // 能力边界（0.13.2 起如实呈现）：写章/诊断/体检面板直做；导入与全量审计仍在会话
    h(
      "div",
      { style: { ...hintStyle, fontSize: font.caption, marginTop: space.md, lineHeight: 1.7 } },
      "写章（走门禁链落盘）、黄金三章诊断、全书体检都已在面板直做。仍需会话的：",
      h("code", {
        style: {
          fontFamily: color.mono,
          background: color.surface2,
          borderRadius: "4px",
          padding: "0 4px"
        }
      }, "novel_import"),
      "（导书）、带一致性/平台审稿/敏感自查参数的 ",
      h("code", {
        style: {
          fontFamily: color.mono,
          background: color.surface2,
          borderRadius: "4px",
          padding: "0 4px"
        }
      }, "novel_audit"),
      "（结果进审计流，面板的机审子集已在「全书体检」覆盖）。"
    )
  );
  const batch = s.batchResult;
  const batchBlock = Fold(
    {
      title: `⚡ 批量起草（从第 ${s.batchFrom ?? nextNo} 章起 ${s.batchCount ?? 3} 章）`
    },
    h(
      "div",
      { style: { ...hintStyle, fontSize: font.caption, lineHeight: 1.7, marginBottom: space.md } },
      "并发生成、串行提交：每一章照样过机审、内容门禁、账本、契约指标，",
      "单章被拦下不影响其它章。没有细纲或细纲未批准的章会直接被挡（可勾选强制）。"
    ),
    h(
      "div",
      { style: { display: "flex", alignItems: "center", gap: space.sm, flexWrap: "wrap" } },
      // label 包住控件：点文字即聚焦输入框，读屏也能念出字段名
      h(
        "label",
        { style: { display: "flex", alignItems: "center", gap: space.xs, fontSize: font.small, color: color.text3 } },
        "起始章",
        h("input", {
          "data-field": "batch-from",
          type: "number",
          min: 1,
          value: String(s.batchFrom ?? nextNo),
          style: { ...inputStyle, width: "64px" }
        })
      ),
      h(
        "label",
        { style: { display: "flex", alignItems: "center", gap: space.xs, fontSize: font.small, color: color.text3 } },
        "数量",
        h("input", {
          "data-field": "batch-count",
          type: "number",
          min: 1,
          max: 20,
          value: String(s.batchCount ?? 3),
          style: { ...inputStyle, width: "64px" }
        })
      ),
      h(
        "label",
        { style: { display: "flex", alignItems: "center", gap: space.xs, fontSize: font.small, color: color.text3 } },
        "并发",
        h("select", {
          "data-field": "batch-concurrency",
          value: String(s.batchConcurrency ?? 1),
          style: { ...inputStyle, width: "auto", padding: "3px 6px" }
        }, [1, 2, 3, 4].map((n) => h("option", { key: n, value: String(n) }, String(n))))
      )
    ),
    h(
      "label",
      { style: { display: "flex", alignItems: "center", gap: space.xs, fontSize: font.caption, color: color.text3, marginTop: space.sm } },
      h("input", {
        "data-field": "batch-force",
        type: "checkbox",
        defaultChecked: s.batchForce === true
      }),
      "强制：跳过「细纲未批准 / 熔断计数」两道（内容门禁不跳）"
    ),
    h(
      "div",
      { style: { marginTop: space.md } },
      Btn(
        { variant: "primary", action: "draft-batch", disabled: s.batchBusy },
        s.batchBusy ? "起草中…（可能几分钟）" : "开始批量起草"
      )
    ),
    batch ? h(
      "div",
      { style: { marginTop: space.lg } },
      h(
        "div",
        { style: { display: "flex", flexWrap: "wrap", gap: `${space.xs}px ${space.lg}px`, marginBottom: space.sm } },
        Stat({ icon: "✓", value: batch.stats?.committed ?? 0, unit: "落盘", tone: "ok" }),
        Stat({
          icon: "✗",
          value: batch.stats?.failed ?? 0,
          unit: "被拦",
          tone: (batch.stats?.failed ?? 0) > 0 ? "danger" : "neutral"
        }),
        Stat({ icon: "⚙", value: batch.concurrency ?? 1, unit: "并发" })
      ),
      ...(batch.warnings ?? []).map((w, i) => h("div", { key: i, style: { ...hintStyle, fontSize: font.caption } }, `· ${w}`)),
      h("div", { style: { marginTop: space.sm } }, ...(batch.results ?? []).map(batchRow))
    ) : null
  );
  const infoView = h(
    "div",
    { style: stackStyle(space.lg) },
    ProjectOverviewView({ state: s }),
    continuityBlock,
    diagnosisBlock,
    proposalsBlock,
    editBlock,
    batchBlock
  );
  return h(
    "div",
    { style: stackStyle(space.lg) },
    crumb,
    Segmented({ tab: s.detailTab }),
    s.detailTab === "chapters" ? ChapterListView({ state: s }) : infoView
  );
}

// src/client/views/lorebook.js
function LorebookView({ state: s }) {
  const editing = s.loreForm.mode !== "none";
  const on = s.loreEntries.filter((e) => e.enabled).length;
  return h(
    "div",
    { style: stackStyle(space.lg) },
    h(
      "div",
      { style: { display: "flex", alignItems: "center", gap: space.sm } },
      Btn({ variant: "ghost", size: "sm", action: "back-from-lore" }, "← 返回"),
      h("span", { style: { fontWeight: weight.semibold, fontSize: font.lead } }, "世界书"),
      h("span", { style: { ...hintStyle, fontSize: font.caption } }, `${on}/${s.loreEntries.length} 条启用`),
      h("span", { style: { flex: "1 1 auto" } }),
      Btn({ size: "sm", variant: "primary", action: "lore-new" }, "＋ 新建")
    ),
    s.error ? Feedback({ tone: "err" }, s.error) : null,
    s.notice ? Feedback({ tone: "ok" }, s.notice) : null,
    // 新建 / 编辑表单
    editing ? Card(
      { tone: "accent", pad: space.md },
      h(
        "div",
        { style: { fontWeight: weight.semibold, fontSize: font.small, marginBottom: space.sm } },
        s.loreForm.mode === "new" ? "新建条目" : "编辑条目"
      ),
      h(
        "div",
        { style: stackStyle(space.sm) },
        h("input", { "data-field": "lore-name", defaultValue: s.loreForm.name, placeholder: "条目名称（如：城西乱葬岗）", "aria-label": "条目名称", style: inputStyle }),
        h("input", { "data-field": "lore-keywords", defaultValue: s.loreForm.keywords, placeholder: "触发关键词，逗号分隔（如：乱葬岗,红泥）", "aria-label": "触发关键词", style: inputStyle }),
        h("textarea", {
          "data-field": "lore-content",
          defaultValue: s.loreForm.content,
          placeholder: "注入内容：这段设定会原样进上下文，写清事实而不是氛围词。",
          "aria-label": "注入内容",
          rows: 4,
          style: { ...inputStyle, lineHeight: 1.8, resize: "vertical" }
        }),
        h(
          "div",
          { style: { display: "flex", alignItems: "center", gap: space.lg, flexWrap: "wrap" } },
          h(
            "label",
            { style: { display: "flex", alignItems: "center", gap: space.xs, fontSize: font.small, color: color.text2 } },
            h("input", { "data-field": "lore-always", type: "checkbox", defaultChecked: s.loreForm.alwaysActive }),
            "常驻注入"
          ),
          h(
            "label",
            { style: { display: "flex", alignItems: "center", gap: space.xs, fontSize: font.small, color: color.text2 } },
            "优先级",
            h("input", {
              "data-field": "lore-priority",
              type: "number",
              defaultValue: s.loreForm.priority,
              style: { ...inputStyle, width: "64px" }
            })
          )
        ),
        h(
          "div",
          { style: { display: "flex", gap: space.sm } },
          Btn({ variant: "primary", action: "lore-save", disabled: s.loreBusy }, s.loreBusy ? "保存中…" : "保存"),
          Btn({ action: "lore-cancel" }, "取消")
        )
      )
    ) : null,
    // 条目列表
    s.loreEntries.length === 0 ? Empty({
      icon: "📖",
      title: "还没有世界书条目",
      hint: "世界书是「按关键词自动注入」的设定库：写到的词一出现，对应设定就会进上下文，不必每次重复交代。"
    }) : h(
      "div",
      { style: stackStyle(space.sm) },
      ...s.loreEntries.map((entry) => h(
        "div",
        {
          key: entry.id,
          style: { ...card({ pad: space.md }), opacity: entry.enabled ? 1 : 0.62 }
        },
        h(
          "div",
          { style: { display: "flex", alignItems: "center", gap: space.sm, flexWrap: "wrap" } },
          h("span", {
            style: {
              fontWeight: weight.semibold,
              fontSize: font.small,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              minWidth: 0
            }
          }, entry.name),
          entry.always_active ? Chip({ tone: "accent" }, "常驻") : null,
          !entry.enabled ? Chip({ tone: "danger" }, "已停用") : null,
          h("span", { style: { flex: "1 1 auto" } }),
          Mono({}, `P${entry.priority}`)
        ),
        entry.keywords?.length ? h(
          "div",
          { style: { display: "flex", gap: space.xs, flexWrap: "wrap", marginTop: space.sm } },
          ...entry.keywords.map((k, i) => Chip({ key: i }, k))
        ) : h(
          "div",
          { style: { ...hintStyle, fontSize: font.caption, marginTop: space.xs } },
          entry.always_active ? "无关键词 —— 靠「常驻」注入" : "无关键词 —— 不会被触发，等于没注入"
        ),
        entry.content ? h("div", {
          style: {
            ...hintStyle,
            fontSize: font.caption,
            marginTop: space.sm,
            lineHeight: 1.7,
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            overflow: "hidden"
          }
        }, entry.content) : null,
        h(
          "div",
          { style: { display: "flex", gap: space.xs, marginTop: space.sm, flexWrap: "wrap", alignItems: "center" } },
          Btn({ size: "sm", variant: "ghost", action: "lore-edit", id: entry.id }, "编辑"),
          Btn(
            { size: "sm", variant: "ghost", action: "lore-toggle", id: entry.id },
            entry.enabled ? "停用" : "启用"
          ),
          h("span", { style: { flex: "1 1 auto" } }),
          // 删除两步确认：第一次点只点亮确认行（控制器 lore-delete 分支），
          // 误触可取消——条目一删关键词/优先级/内容全没了，不能一键即走。
          s.loreDeleteId === String(entry.id) ? h(
            "span",
            { style: { display: "flex", alignItems: "center", gap: space.xs } },
            Btn({ size: "sm", action: "lore-delete-cancel" }, "取消删除"),
            Btn(
              { size: "sm", variant: "danger", action: "lore-delete", id: entry.id, disabled: s.loreBusy },
              s.loreBusy ? "删除中…" : "确认删除这条设定？"
            )
          ) : Btn({ size: "sm", variant: "danger", action: "lore-delete", id: entry.id }, "删除")
        )
      ))
    ),
    h(
      "p",
      { style: { ...hintStyle, fontSize: font.caption, margin: 0, lineHeight: 1.7 } },
      "关键词命中的条目 + 常驻条目会一起进上下文；同一轮内容里优先级高的在前。"
    )
  );
}

// src/client/views/settings.js
function cap(can, text) {
  return h(
    "div",
    { style: { display: "flex", gap: space.sm, alignItems: "flex-start", fontSize: font.small } },
    h("span", { style: { flex: "none", color: can ? color.ok : color.textDim, width: "12px" } }, can ? "✓" : "·"),
    h("span", { style: { flex: "1 1 auto", minWidth: 0, color: can ? color.text2 : color.text3, lineHeight: 1.7 } }, text)
  );
}
function SettingsView() {
  return h(
    "div",
    { style: stackStyle(space.lg) },
    h(
      "div",
      { style: { display: "flex", alignItems: "center", gap: space.sm } },
      Btn({ variant: "ghost", size: "sm", action: "back-from-settings" }, "← 返回"),
      h("span", { style: { fontWeight: weight.semibold, fontSize: font.lead } }, "⚙ 设置"),
      h("span", { style: { flex: "1 1 auto" } }),
      Chip({}, "v" + (window.__NOVEL_FORGE_VERSION__ || "?"))
    ),
    // ── 注册了什么 ──
    Card(
      { tone: "plain" },
      Section(
        { icon: "🧩", title: "已装配" },
        h(
          "div",
          { style: stackStyle(space.sm) },
          // ⚠️ 不写死工具数：注册数随版本变（0.13.x 已从 17 涨到 20+），
          // 数字一落字就是下一版必过期的漂移炸弹（common.js 注释同款教训）。
          KV({ k: "tools" }, "全部 novel_* 工具已注册"),
          KV({ k: "通道" }, "宿主工具面 + MCP 双通道"),
          KV({ k: "硬约束" }, "账本 / 门禁 / 机审 / 提案制 —— 判定权在代码，不在模型"),
          KV({ k: "旁路引擎" }, "润色 / 校对 / 打标 / 起草 四通道（不占主对话、不写会话记录）"),
          KV({ k: "检索" }, "node:sqlite + FTS5 + 中文二元切分（无 embedding，纯本地）")
        )
      )
    ),
    // ── 面板能做什么 / 不能做什么 ──
    Card(
      { tone: "plain" },
      Section(
        { icon: "🖱", title: "这个面板能直接做" },
        h(
          "div",
          { style: stackStyle(space.xs) },
          cap(true, "读章、改稿、存稿、导出、删除、改名、认领旧书"),
          cap(true, "一键润色 / 校对 —— 走旁路引擎，产物是提案，你点「应用」才生效"),
          cap(true, "批量起草 —— 并发生成、串行提交，每章照样过全部门禁"),
          cap(true, "全书体检 —— 死人复活 / 账本矛盾 / 伏笔超期 / 章号断档（零 token）"),
          cap(true, "批准或丢弃模型提的修订；管理世界书；章节朗读连播"),
          cap(true, "克隆为模板 —— 一键把老书连章节、大纲、人物、世界书、账本、伏笔复制成新书")
        )
      ),
      h(
        "div",
        { style: { marginTop: space.lg } },
        Section(
          { icon: "💬", title: "只能回会话里做" },
          h(
            "div",
            { style: stackStyle(space.xs) },
            // M16 修复：本清单说「写章 / 结构诊断面板做不了」早就不成立——
            // 面板有「写单章」（走批量端点，同一门禁链）和「结构诊断」按钮（纯词表打分，零 token）
            cap(false, "写章（novel_write_chapter）—— 面板「写单章」可落盘单章；拼全书上下文包的完整写作流仍在会话"),
            cap(false, "去AI味评级 / 平台审稿 / 润色分析 —— 重活仍在会话工具"),
            cap(false, "生成大纲、角色卡、细纲、设定（novel_outline / novel_cast / novel_world）"),
            cap(false, "导入既有文稿（novel_import）"),
            cap(false, "书库「饲料」—— 喂外部小说、对比结构画像（novel_library：import / list / compare）")
          )
        )
      )
    ),
    h(
      "p",
      { style: footerStyle },
      "在会话里调用 novel_* 工具驱动写作；本面板只负责「确定性那部分」——",
      "凡是需要模型参与的动作，都会在审计里留下 actor 记录。"
    )
  );
}

// src/client/css.js
var PANEL_ATTR = "data-dsh-novel-forge-panel";
var STYLE_ID = "dsh-novel-forge-css";
var ROOT = `[${PANEL_ATTR}]`;
var DARK = ":where(body[data-ds-dark-theme])";
function decl(style) {
  return Object.entries(style).filter(([, v]) => v !== void 0 && v !== null && v !== "").map(([k, v]) => `${k.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase())}:${v}`).join(";");
}
var rule = (sel, style) => `${sel}{${decl(style)}}`;
function buttonRules() {
  const out = [];
  for (const variant of BTN_VARIANTS) {
    const skin = btnSkin[variant];
    if (!skin) continue;
    const sel = `${ROOT} [data-nf-btn][data-variant="${variant}"]`;
    out.push(rule(sel, skin.rest));
    out.push(rule(`${sel}:hover:not(:disabled)`, skin.hover));
    out.push(rule(`${sel}:active:not(:disabled)`, {
      ...skin.active,
      // "按下"的物理感：下沉 1px + 内阴影。**不改几何尺寸**，所以按钮不会跳。
      transform: "translateY(1px)",
      boxShadow: "inset 0 1px 3px rgba(0,0,0,.16)"
    }));
  }
  return out;
}
function buildCss() {
  return [
    `/* dsh-novel-forge 面板交互态（由 src/client/css.js 生成，勿手改）*/`,
    // ── 按钮基座：三态的前提是"外观由 CSS 说了算" ──
    rule(`${ROOT} [data-nf-btn]`, {
      borderWidth: "1px",
      borderStyle: "solid",
      borderColor: "transparent",
      background: "transparent",
      color: color.text,
      transition: "background-color .13s ease, border-color .13s ease, color .13s ease, box-shadow .13s ease, transform .06s ease",
      WebkitTapHighlightColor: "transparent",
      touchAction: "manipulation"
      // 消除移动端双击缩放延迟
    }),
    // 焦点环给**所有**可点元素，不只 [data-nf-btn]：分段控件（详情页 tab）、
    // 书卡标题按钮（TAP）、头部 ⚙ 都是裸 <button>——没有这条，键盘用户
    // 在面板最高频的入口上是「聚焦了但看不见」。
    rule(`${ROOT} button:focus-visible, ${ROOT} summary:focus-visible`, {
      outline: `2px solid ${color.accent}`,
      outlineOffset: "1px"
    }),
    rule(`${ROOT} [data-nf-btn]:disabled`, { opacity: ".45", cursor: "default" }),
    ...buttonRules(),
    // ── 可点区域（卡片 / 目录行 / 分段控件 / 标题块）──
    // 这些元素的**底色来自内联 card()**，内联优先级更高 → hover/active 必须 `!important`
    // 才压得过。只压这两个伪类，常态外观一概不动。
    rule(`${ROOT} [data-nf-tap]`, {
      transition: "background-color .13s ease, border-color .13s ease, box-shadow .13s ease, transform .06s ease",
      touchAction: "manipulation"
    }),
    rule(`${ROOT} [data-nf-tap]:hover`, {
      background: `${color.hover} !important`,
      borderColor: `${color.border3} !important`
    }),
    rule(`${ROOT} [data-nf-tap]:active`, {
      background: `${color.pressed} !important`,
      transform: "translateY(1px)"
    }),
    // ── 分段控件（📋 基本信息 / 🎧 章节听书）──
    // 「选中」是**状态**不是伪类，所以用 `data-active` 表达，让 CSS 一次管好
    // rest / hover / active / selected 四态。四态都写在样式表里才不会互相打架
    //（之前底色与字色内联，选中项一悬停就会丢掉"选中"的样子）。
    rule(`${ROOT} [data-nf-seg]`, {
      background: "transparent",
      color: color.text3,
      boxShadow: "none",
      touchAction: "manipulation"
    }),
    rule(`${ROOT} [data-nf-seg]:hover:not([data-active="1"])`, { background: color.hover }),
    rule(`${ROOT} [data-nf-seg]:active:not([data-active="1"])`, {
      background: color.pressed,
      transform: "translateY(1px)"
    }),
    rule(`${ROOT} [data-nf-seg][data-active="1"]`, {
      background: color.surface3,
      color: color.text,
      boxShadow: `inset 0 0 0 1px ${color.border2}`
    }),
    // ── 输入：聚焦要看得见（宿主右侧栏里全是输入框，没焦点环很难用）──
    rule(`${ROOT} input:focus, ${ROOT} textarea:focus, ${ROOT} select:focus`, {
      borderColor: `${color.accent} !important`,
      boxShadow: `0 0 0 2px ${tint(color.accent, 22)} !important`,
      outline: "none"
    }),
    rule(`${ROOT} input, ${ROOT} textarea, ${ROOT} select`, {
      transition: "border-color .13s ease, box-shadow .13s ease"
    }),
    rule(`${ROOT} ::placeholder`, { color: color.textDim }),
    // ── 折叠标题（原生 <details>，不吃事件代理）──
    rule(`${ROOT} summary:hover`, { color: `${color.text} !important` }),
    rule(`${ROOT} summary:focus-visible`, {
      outline: `2px solid ${color.accent}`,
      outlineOffset: "2px",
      borderRadius: `${radius.sm}px`
    }),
    // ── 标题字重与行距（右侧栏窄，标题太轻会糊）──
    // ⚠️ 裸 <button> 的 UA 默认灰底（ButtonFace）会透出来 —— 书卡标题按钮走 TAP
    // 不走 Btn，0.13.1 里书名底下那条"灰色横条"就是它（用户看作"与下方重叠"）。
    // 这里统一抹掉 UA 外观；真按钮（[data-nf-btn] / [data-nf-seg]）的规则
    // 权重更高，不受影响。
    rule(`${ROOT} button`, { font: "inherit", background: "transparent", border: "none" }),
    // ── 深色专属微调 ──
    // 用 `:where()` 把选择器权重降到 0，**否则会压过上面的 `:active` 内阴影**
    // （`body[data-x] [y]` 比 `[y]:active` 权重更高）。这类"降权重"是深色补丁的通用手法。
    rule(`${DARK} ${ROOT} [data-nf-tap]`, {
      boxShadow: "inset 0 1px 0 rgba(255,255,255,.04)"
    }),
    rule(`${DARK} ${ROOT} [data-nf-btn][data-variant="secondary"]`, {
      background: "rgba(255,255,255,.05)",
      borderColor: "rgba(255,255,255,.10)"
    }),
    rule(`${DARK} ${ROOT} [data-nf-btn][data-variant="secondary"]:hover:not(:disabled)`, {
      background: "rgba(255,255,255,.10)",
      borderColor: "rgba(255,255,255,.18)"
    }),
    `/* ── 尺度备查（改间距只动 styles.js，这里仅声明面板不引入外边距抖动）── */
${ROOT} *{box-sizing:border-box}
${ROOT} :where(h1,h2,h3,p){margin:0}
${ROOT} [data-nf-gap]{gap:${space.sm}px}
/* 窄栏里长单词/长路径不撑破布局 */
${ROOT} :where(span,div,p,code){overflow-wrap:anywhere}`,
    // ── 动效弱化（系统开了「减少动态效果」时）──
    // 位移与过渡都停：按下反馈只剩内阴影/底色，信息不丢、不晃。
    // 收成单行：静态自检要求每条含 `{` 的行都带面板根限定，@media 独占一行会破例。
    `@media (prefers-reduced-motion: reduce){${ROOT} [data-nf-btn],${ROOT} [data-nf-tap],${ROOT} [data-nf-seg],${ROOT} input,${ROOT} textarea,${ROOT} select{transition:none}${ROOT} [data-nf-btn]:active:not(:disabled),${ROOT} [data-nf-tap]:active,${ROOT} [data-nf-seg]:active:not([data-active="1"]){transform:none}}`
  ].join("\n");
}
function ensureStyles(doc = globalThis.document) {
  if (!doc) return null;
  let existing = null;
  try {
    existing = doc.getElementById ? doc.getElementById(STYLE_ID) : null;
    if (!existing && doc.querySelector) existing = doc.querySelector(`#${STYLE_ID}`);
  } catch {
    existing = null;
  }
  if (existing) {
    const css = buildCss();
    if (existing.textContent !== css) existing.textContent = css;
    return existing;
  }
  let el = null;
  try {
    el = doc.createElement("style");
  } catch {
    return null;
  }
  if (!el) return null;
  try {
    el.id = STYLE_ID;
    el.textContent = buildCss();
  } catch {
  }
  const host = doc.head ?? doc.body ?? null;
  if (!host || typeof host.appendChild !== "function") return null;
  try {
    host.appendChild(el);
  } catch {
    return null;
  }
  return el;
}

// src/client/panel.js
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
        { style: { padding: "16px", color: color.danger, fontSize: "12.5px", lineHeight: 1.7, whiteSpace: "pre-wrap" } },
        "面板渲染失败：" + String(this.state.error?.message ?? this.state.error)
      );
    }
    return this.props.children;
  }
} : null;
function createForgeController({ sessionId = null, resolveSessionId = null, onChange = () => {
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
  const syncSession = () => {
    if (typeof resolveSessionId !== "function") return;
    try {
      const id = resolveSessionId();
      if (typeof id === "string" && id !== "" && id !== state.sessionId) state.sessionId = id;
    } catch {
    }
  };
  const withSession = (path) => {
    syncSession();
    if (!state.sessionId) return path;
    const sep = path.includes("?") ? "&" : "?";
    return `${path}${sep}session=${encodeURIComponent(state.sessionId)}`;
  };
  let openSeq = 0;
  let chapterSeq = 0;
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
    const seq = openSeq;
    state.elementsLoading = true;
    notify();
    try {
      const elements = await apiFetch(`/projects/${encodeURIComponent(bookId)}/elements`);
      if (seq !== openSeq) return;
      state.elements = elements;
    } catch {
      if (seq === openSeq) state.elements = null;
    } finally {
      if (seq === openSeq) {
        state.elementsLoading = false;
        notify();
      }
    }
  };
  const loadChapterList = async (id) => {
    const bookId = id || state.selected;
    if (!bookId) return;
    const seq = openSeq;
    state.chapterListLoading = true;
    notify();
    try {
      const list = await apiFetch(`/projects/${encodeURIComponent(bookId)}/chapters`);
      if (seq !== openSeq) return;
      state.chapterList = list;
    } catch {
      if (seq === openSeq) state.chapterList = [];
    } finally {
      if (seq === openSeq) {
        state.chapterListLoading = false;
        notify();
      }
    }
  };
  const refreshProjects = async () => {
    syncSession();
    state.loading = true;
    state.error = "";
    notify();
    console.info("[novel-forge] GET /projects" + (state.sessionId ? `?session=${state.sessionId}` : "（无会话）"));
    try {
      state.projects = await apiFetch(withSession("/projects"));
      if (state.projects.length === 0 && state.sessionId) {
        state.projects = await apiFetch("/projects");
        state.sessionFallback = state.projects.length > 0;
      } else {
        state.sessionFallback = false;
      }
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
  const cloneProject = async () => {
    const c = state.clone;
    if (!c || !c.id) return;
    const newBook = String(c.value ?? "").trim();
    if (!newBook) {
      state.error = "新书目名不能为空";
      notify();
      return;
    }
    state.cloning = true;
    state.error = "";
    notify();
    try {
      const v = await apiFetch(`/projects/${encodeURIComponent(c.id)}/clone`, {
        method: "POST",
        body: JSON.stringify({ newBook, title: newBook, session: state.sessionId ?? void 0 })
      });
      state.notice = v?.next ?? `已克隆：${c.id} → ${newBook}`;
      state.clone = null;
      await refreshProjects();
    } catch (error) {
      state.error = String(error?.message ?? error);
    } finally {
      state.cloning = false;
      notify();
    }
  };
  const deleteListProject = async (id) => {
    if (state.listDeleting) return;
    state.listDeleting = true;
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
      state.listDeleting = false;
      notify();
    }
  };
  const openProject = async (id) => {
    const seq = ++openSeq;
    const cseq = ++chapterSeq;
    state.selected = id;
    state.view = "detail";
    state.detail = null;
    state.chapterNo = 1;
    state.draft = "";
    state.error = "";
    state.detailTab = "info";
    state.elements = null;
    state.discardPending = null;
    state.rename = null;
    state.listDeleteId = null;
    state.clone = null;
    state.deleteState = null;
    state.gateNotice = null;
    state.listDeleting = false;
    state.proposals = [];
    state.proposalsError = null;
    state.proposalBusy = null;
    state.proposalDetail = null;
    state.continuity = null;
    state.continuityError = "";
    state.batchResult = null;
    state.revising = null;
    state.diagnosis = null;
    state.diagnosisError = "";
    state.reader = null;
    player.stop();
    notify();
    try {
      const [detail, text] = await Promise.all([
        apiFetch(`/projects/${encodeURIComponent(id)}`),
        apiFetch(`/projects/${encodeURIComponent(id)}/chapters/1`).catch(() => "")
      ]);
      if (seq !== openSeq) return;
      state.detail = detail;
      if (cseq === chapterSeq) {
        state.baseline = text ?? "";
        state.draft = text ?? "";
        state.draftVersion++;
        state.draftModified = false;
        state.undoStack = [];
      }
    } catch (error) {
      if (seq === openSeq) state.error = String(error?.message ?? error);
    }
    if (seq !== openSeq) return;
    notify();
    await Promise.all([loadChapterList(id), loadElements(id), loadProposals(id)]);
  };
  const loadChapter = async (no) => {
    if (!state.selected) return;
    const seq = ++chapterSeq;
    state.chapterNo = no;
    state.discardPending = null;
    notify();
    try {
      const text = await apiFetch(`/projects/${encodeURIComponent(state.selected)}/chapters/${no}`);
      if (seq !== chapterSeq) return;
      state.baseline = text ?? "";
      state.draft = text ?? "";
      state.draftVersion++;
      state.draftModified = false;
      state.undoStack = [];
    } catch {
      if (seq !== chapterSeq) return;
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
    const seq = openSeq;
    state.proposalsLoading = true;
    state.proposalsError = null;
    notify();
    try {
      const value = await apiFetch(`/projects/${encodeURIComponent(bookId)}/proposals`);
      if (seq !== openSeq) return;
      state.proposals = Array.isArray(value?.proposals) ? value.proposals : [];
    } catch (error) {
      if (seq === openSeq) {
        state.proposals = [];
        state.proposalsError = String(error?.message ?? error);
      }
    } finally {
      if (seq === openSeq) {
        state.proposalsLoading = false;
        notify();
      }
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
      const gate = value.gate;
      state.gateNotice = gate && ((gate.blocking?.length ?? 0) > 0 || (gate.warnings?.length ?? 0) > 0) ? { chapter: value.chapter, version: value.version, ...gate } : null;
      if (state.gateNotice) {
        const bits = [...state.gateNotice.blocking ?? [], ...state.gateNotice.warnings ?? []];
        state.notice += ` ⚠ 门禁提示 ${bits.length} 条（详见下方）`;
      }
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
      if (state.proposalDetail?.id === proposalId) state.proposalDetail = null;
      await loadProposals(state.selected);
    } catch (error) {
      state.error = String(error?.message ?? error);
    } finally {
      state.proposalBusy = null;
      notify();
    }
  };
  const toggleProposalDetail = async (proposalId) => {
    if (!state.selected) return;
    if (!proposalId) {
      state.error = "拿不到提案号（查看钮上应有 data-id）";
      notify();
      return;
    }
    if (state.proposalDetail?.id === proposalId && !state.proposalDetail.loading) {
      state.proposalDetail = null;
      notify();
      return;
    }
    state.proposalDetail = { id: proposalId, loading: true, data: null, error: "" };
    notify();
    try {
      const value = await apiFetch(`/projects/${encodeURIComponent(state.selected)}/proposals/${encodeURIComponent(proposalId)}`);
      if (state.proposalDetail?.id !== proposalId) return;
      state.proposalDetail = { id: proposalId, loading: false, data: value, error: "" };
    } catch (error) {
      if (state.proposalDetail?.id !== proposalId) return;
      state.proposalDetail = { id: proposalId, loading: false, data: null, error: String(error?.message ?? error) };
    } finally {
      notify();
    }
  };
  const REVISION_TIMEOUT_MS = 6e5;
  const revisionErrorText = (error, mode) => {
    const raw = String(error?.message ?? error);
    const what = mode === "proofread" ? "校对" : "润色";
    if (/ENGINE_UNAVAILABLE|引擎未就绪/.test(raw)) return `${what}需要模型服务：本进程还没有可用的模型路由，先在会话里正常对话一次再试。`;
    if (/NO_ROUTE/.test(raw)) return `${what}通道没有可用路由：检查插件配置里的 engine.channels.${mode}。`;
    if (/GUARD_BLOCKED|守卫/.test(raw)) return `${what}结果被守卫拦下（改动过大或与原文偏离太多），已丢弃——正文没动。`;
    if (/ABORTED/.test(raw)) return `${what}被中止。`;
    return raw;
  };
  const runRevision = async (mode) => {
    if (!state.selected || state.revising) return;
    state.revising = mode;
    state.error = "";
    state.notice = "";
    notify();
    try {
      const value = await apiFetch(
        `/projects/${encodeURIComponent(state.selected)}/chapters/${state.chapterNo}/${mode}`,
        {
          method: "POST",
          timeoutMs: REVISION_TIMEOUT_MS,
          // session = 面板锚定的会话 id：服务端拿它找活的父 agent 起子代理
          // （SubagentStartRequest.parent 必填，缺了宿主直接炸进程——0.13.2 事故）。
          body: JSON.stringify({ session: state.sessionId ?? void 0 })
        }
      );
      const what = mode === "proofread" ? "校对" : "润色";
      const delta = Number(value?.deltaChars ?? 0);
      state.notice = `${what}完成：提案 ${value.proposalId}（${value.chars} 字，改动 ${delta >= 0 ? "+" : ""}${delta}）—— 到「待批准提案」里点应用才生效`;
      await loadProposals(state.selected);
    } catch (error) {
      state.error = revisionErrorText(error, mode);
    } finally {
      state.revising = null;
      notify();
    }
  };
  const loadContinuity = async () => {
    if (!state.selected) return;
    const seq = openSeq;
    state.continuityLoading = true;
    state.continuityError = "";
    notify();
    try {
      const result = await apiFetch(`/projects/${encodeURIComponent(state.selected)}/continuity`);
      if (seq !== openSeq) return;
      state.continuity = result;
    } catch (error) {
      if (seq !== openSeq) return;
      state.continuity = null;
      state.continuityError = String(error?.message ?? error);
    } finally {
      if (seq === openSeq) {
        state.continuityLoading = false;
        notify();
      }
    }
  };
  const loadDiagnosis = async () => {
    if (!state.selected || state.diagnosisLoading) return;
    const seq = openSeq;
    state.diagnosisLoading = true;
    state.diagnosisError = "";
    notify();
    try {
      const result = await apiFetch(`/projects/${encodeURIComponent(state.selected)}/diagnose`);
      if (seq !== openSeq) return;
      state.diagnosis = result;
    } catch (error) {
      if (seq !== openSeq) return;
      state.diagnosis = null;
      state.diagnosisError = String(error?.message ?? error);
    } finally {
      if (seq === openSeq) {
        state.diagnosisLoading = false;
        notify();
      }
    }
  };
  const writeSingleChapter = async () => {
    if (!state.selected || state.batchBusy) return;
    const no = state.chapterNo || 1;
    state.batchFrom = String(no);
    state.batchCount = "1";
    state.batchConcurrency = "1";
    await runBatch();
  };
  const runBatch = async () => {
    if (!state.selected || state.batchBusy) return;
    state.batchBusy = true;
    state.error = "";
    state.notice = "";
    state.batchResult = null;
    notify();
    try {
      state.batchResult = await apiFetch(`/projects/${encodeURIComponent(state.selected)}/draft-batch`, {
        method: "POST",
        timeoutMs: 9e5,
        body: JSON.stringify({
          from: Number(state.batchFrom) || 1,
          count: Number(state.batchCount) || 1,
          concurrency: Number(state.batchConcurrency) || 1,
          force: state.batchForce === true,
          session: state.sessionId ?? void 0
        })
      });
      const st = state.batchResult?.stats ?? {};
      state.notice = `批量起草完成：落盘 ${st.committed ?? 0} 章，被拦 ${st.failed ?? 0} 章`;
      await Promise.all([loadChapterList(state.selected), loadProposals(state.selected)]);
      state.continuity = null;
      state.diagnosis = null;
      const batchFrom = Number(state.batchFrom) || 1;
      const batchCount = Number(state.batchCount) || 1;
      if ((st.committed ?? 0) > 0 && state.selected !== null && state.chapterNo >= batchFrom && state.chapterNo < batchFrom + batchCount) {
        await loadChapter(state.chapterNo);
        state.notice += `；第 ${state.chapterNo} 章已在编辑器里重载为最新版本`;
      }
    } catch (error) {
      const raw = String(error?.message ?? error);
      state.error = /ENGINE_UNAVAILABLE|引擎未就绪/.test(raw) ? "批量起草需要模型服务：本进程还没有可用的模型路由。" : raw;
    } finally {
      state.batchBusy = false;
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
        // 题材：面板没有题材输入框，留空就不传（服务端默认「未分类」），
        // 别再学早期把 'fantasy' 写死在默认值里（书卡上全是英文 chip 的来历）。
        body: JSON.stringify({ title: state.title.trim(), genre: state.genre.trim() || void 0, session: state.sessionId ?? void 0 })
      });
      state.title = "";
      state.titleReset = (state.titleReset ?? 0) + 1;
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
    const bookId = state.selected;
    const no = state.chapterNo;
    const snapshot = state.draft;
    try {
      await apiFetch(`/projects/${encodeURIComponent(bookId)}/chapters/${no}`, {
        method: "POST",
        body: JSON.stringify({ title: `第 ${no} 章`, text: snapshot })
      });
      if (state.selected === bookId && state.chapterNo === no && state.draft === snapshot) {
        state.notice = `已保存：第 ${no} 章`;
        state.baseline = snapshot;
        state.draftModified = false;
        state.undoStack = [];
      } else {
        state.notice = `已保存：第 ${no} 章——但编辑器已切走或继续改动，当前改动仍未保存`;
      }
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
      state.deleteState = "confirm";
    }
    notify();
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
    state.clone = null;
    state.deleteState = null;
    state.gateNotice = null;
    await refreshProjects();
  };
  const handleAction = async (action, target) => {
    syncSession();
    state.error = "";
    state.notice = "";
    switch (action) {
      case "reload-proposals":
        state.proposalsError = null;
        await loadProposals(state.selected);
        break;
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
      // 克隆为模板：与改名同款内联表单（clone = {id, value}）。互斥——开一个关另一个
      case "clone-open": {
        const id = target.dataset.id;
        if (!id) {
          state.error = "拿不到要克隆的书（按钮上应有 data-id）";
          notify();
          break;
        }
        state.clone = { id, value: "" };
        state.rename = null;
        state.listDeleteId = null;
        notify();
        break;
      }
      case "clone-confirm":
        await cloneProject();
        break;
      case "clone-cancel":
        state.clone = null;
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
        const no = Number(target.dataset.id);
        if (!Number.isFinite(no) || no <= 0) {
          state.error = `拿不到要播的章号（播放钮上应有 data-id，实际是 "${target.dataset.id ?? ""}"）`;
          notify();
          break;
        }
        try {
          await player.playFrom(no);
        } catch (error) {
          state.error = String(error?.message ?? error);
          notify();
        }
        break;
      }
      case "read-chapter": {
        state.detailTab = "chapters";
        const no = Number(target.dataset.id);
        if (!Number.isFinite(no) || no <= 0) {
          state.error = `拿不到要读的章号（阅读钮上应有 data-id，实际是 "${target.dataset.id ?? ""}"）`;
          notify();
          break;
        }
        const meta = state.chapterList.find((c) => c.no === no);
        state.reader = { no, title: meta?.title ?? `第 ${no} 章`, text: "", loading: true };
        notify();
        try {
          const text = await apiFetch(`/projects/${encodeURIComponent(state.selected)}/chapters/${no}`);
          if (state.reader?.no === no) {
            state.reader = { no, title: meta?.title ?? `第 ${no} 章`, text: String(text ?? ""), loading: false };
          }
        } catch (error) {
          if (state.reader?.no === no) state.reader = null;
          state.error = `读不出第 ${no} 章正文：${String(error?.message ?? error)}`;
        }
        notify();
        break;
      }
      case "close-reader":
        state.reader = null;
        notify();
        break;
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
        await writeSingleChapter();
        break;
      case "polish":
        await runRevision("polish");
        break;
      case "proofread":
        await runRevision("proofread");
        break;
      case "continuity":
        await loadContinuity();
        break;
      case "draft-batch":
        await runBatch();
        break;
      case "diagnose":
        await loadDiagnosis();
        break;
      case "import-demo":
      case "import-file":
        needsModel("请在会话中调用 novel_import 导入");
        break;
      case "save":
        await saveChapter();
        break;
      // M14 修复：刷新会重拉当前章、覆盖编辑器——有未保存改动时走同一套
      // 「确认丢弃」流程（与切章一致），不再静默把草稿冲掉
      case "refresh":
        if (state.selected && state.chapterNo) {
          if (state.draftModified) {
            state.discardPending = { kind: "chapter", no: state.chapterNo };
            notify();
          } else await loadChapter(state.chapterNo);
        }
        break;
      // 提案：应用 / 丢弃都是**用户主权动作**（工具面刻意不提供，见 lib/proposals.js）
      case "proposal-view":
        await toggleProposalDetail(target.dataset.id);
        break;
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
        if (state.deleteState === "busy") break;
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
        state.loreDeleteId = null;
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
          state.loreDeleteId = null;
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
      // 删除两步确认（与列表页删书同款）：第一次点只点亮确认行，再点才真删——
      // 世界书条目删了就没了（关键词、优先级、内容全在一条里），误触不可逆。
      case "lore-delete":
        if (state.loreDeleteId === target.dataset.id) {
          state.loreDeleteId = null;
          await deleteLoreEntry(target.dataset.id);
        } else {
          state.loreDeleteId = target.dataset.id;
          notify();
        }
        break;
      case "lore-delete-cancel":
        state.loreDeleteId = null;
        notify();
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
    const field2 = e.target?.dataset?.field;
    if (field2 === "title") {
      state.title = e.target.value;
    } else if (field2 === "project-filter") {
      state.filter = e.target.value;
      notify();
    } else if (field2 === "draft") {
      state.draft = e.target.value;
      state.draftModified = e.target.value !== state.baseline;
    } else if (field2 === "rename-value") {
      if (state.rename) state.rename.value = e.target.value;
    } else if (field2 === "clone-value") {
      if (state.clone) state.clone.value = e.target.value;
    } else if (field2 === "chapterNo") {
      const no = Number(e.target.value);
      if (no > 0) {
        if (state.draftModified) {
          state.discardPending = { kind: "chapter", no };
          notify();
        } else void loadChapter(no);
      }
    } else if (field2 === "lore-name") state.loreForm.name = e.target.value;
    else if (field2 === "lore-keywords") state.loreForm.keywords = e.target.value;
    else if (field2 === "lore-content") state.loreForm.content = e.target.value;
    else if (field2 === "lore-priority") state.loreForm.priority = e.target.value;
    else if (field2 === "batch-from") state.batchFrom = e.target.value;
    else if (field2 === "batch-count") state.batchCount = e.target.value;
    else if (field2 === "batch-concurrency") state.batchConcurrency = e.target.value;
    else if (field2 === "batch-force") state.batchForce = e.target.checked === true;
  };
  const onChangeEvent = (e) => {
    const field2 = e.target?.dataset?.field;
    if (field2 === "lore-always") state.loreForm.alwaysActive = e.target.checked;
    else if (field2 === "batch-concurrency") state.batchConcurrency = e.target.value;
    else if (field2 === "batch-force") state.batchForce = e.target.checked === true;
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
    state.clone = null;
    state.loreDeleteId = null;
    state.filter = "";
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
    syncSession,
    loadProposals,
    stopPlayback: () => player.stop()
  };
}
function panelSubtitle(s) {
  if (s.view === "detail") {
    const title = s.detail?.title || s.selected || "这本书";
    const n = (s.chapterList ?? []).length;
    return n > 0 ? `${title} · 已写 ${n} 章` : title;
  }
  if (s.view === "lorebook") return `${s.selected || "默认"} · 世界书`;
  if (s.view === "settings") return "能力清单";
  const total = (s.projects ?? []).length;
  if (s.loading && total === 0) return "载入中…";
  const unclaimed = (s.unclaimed ?? []).length;
  return `${total} 本书` + (unclaimed > 0 ? ` · ${unclaimed} 本待认领` : "");
}
function ForgePanel(props) {
  const sessionId = props?.sessionId ?? null;
  const resolveSessionId = props?.resolveSessionId ?? null;
  const [, forceTick] = useState(0);
  const controllerRef = useRef(null);
  const nodeRef = useRef(null);
  if (controllerRef.current === null) {
    controllerRef.current = createForgeController({
      sessionId,
      resolveSessionId,
      onChange: () => forceTick((n) => n + 1)
    });
  }
  const controller = controllerRef.current;
  useEffect(() => {
    controller.setSession(sessionId);
  }, [sessionId]);
  useEffect(() => {
    ensureStyles();
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
      style: rootStyle
    },
    // 品牌条：图标块 + 标题（含版本）+ 副题 + 会话范围
    h(
      "div",
      { style: headerStyle },
      h("div", { style: brandMarkStyle }, "🔨"),
      h(
        "div",
        { style: { flex: "1 1 auto", minWidth: 0 } },
        h(
          "div",
          { style: { display: "flex", alignItems: "center", gap: space.sm } },
          h("span", { style: titleStyle }, "锻炉"),
          h("span", { style: chip() }, "v" + (window.__NOVEL_FORGE_VERSION__ || "?"))
        ),
        h("div", { style: subtitleStyle }, panelSubtitle(s))
      ),
      h("span", {
        style: { ...chip({ tone: s.sessionId ? "accent" : "neutral" }), alignSelf: "flex-start" }
      }, s.sessionId ? "本会话" : "全部项目"),
      // 设置入口常驻在头部：详情页/世界书页都够不到列表页那个按钮，
      // 用户想看一眼「面板到底能做什么」时不该先退回列表
      h("button", {
        "data-action": "goto-settings",
        // 走按钮皮肤：底/描边/字色交给 css.js，这样它有悬停与按下反馈
        "data-nf-btn": "1",
        "data-variant": "secondary",
        title: "设置 · 能力清单",
        "aria-label": "设置 · 能力清单",
        style: {
          flex: "none",
          cursor: "pointer",
          fontFamily: "inherit",
          fontSize: "13px",
          lineHeight: 1,
          padding: "5px 7px",
          borderRadius: "8px"
        }
      }, "⚙")
    ),
    h(
      "div",
      { style: bodyStyle },
      s.view === "projects" ? h(ProjectListView, { state: s }) : null,
      s.view === "detail" ? h(ProjectDetailView, { state: s }) : null,
      s.view === "lorebook" ? h(LorebookView, { state: s }) : null,
      s.view === "settings" ? h(SettingsView) : null
    )
  );
  return ForgeBoundary ? h(ForgeBoundary, null, view) : view;
}

// src/client/index.js
var PLUGIN_VERSION = "0.13.9";
window.__NOVEL_FORGE_VERSION__ = PLUGIN_VERSION;
var inject = ["slots", "sidebarRightTabs", "sidebarRight", "sessions"];
function apply(ctx) {
  console.info("[novel-forge] client apply v" + PLUGIN_VERSION + " — 注册右侧栏 tab");
  try {
    registerForgeTab(ctx, (props) => ForgePanel({
      ...props,
      resolveSessionId: () => currentSessionId(ctx)
    }));
  } catch (error) {
    console.error("[novel-forge] 右侧栏 tab 注册失败（可从右侧栏 guide 页手动进入）", error);
  }
  try {
    const dispose = openForgeTab(ctx);
    if (typeof ctx.effect === "function") ctx.effect(() => dispose);
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
  FETCH_TIMEOUT_MS,
  // 交互态样式表：测试要能验证「三态规则齐不齐」「注入是不是单例」
  buildCss,
  ensureStyles,
  PANEL_ATTR,
  STYLE_ID,
  // 视图原语：Feedback 的 role 契约、列表筛选的匹配与渲染
  projectMatches,
  ProjectListView,
  Feedback,
  // Btn（无障碍名是否真落到 props）与章节目录视图（图标按钮的 aria-label 端到端）
  Btn,
  ChapterListView
};

		return module.exports;
	}
});

