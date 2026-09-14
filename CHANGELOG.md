# Changelog

## 0.6.4 (2026-09-14) — 锻炉面板一轮 UI/UX 优化（web-design-guidelines 走查）

对右侧栏面板做过一轮可访问性 / 反馈 / 一致性走查，逐条落地：

- **未保存草稿不再静默丢**（你上一次点名的高价值项）：返回 / 换章前若有改动，先弹「丢弃改动
  / 取消」确认；取消留在原地、草稿保留，确认才真正离开。目录早停等路径一并守卫。
- **打开项目卡改成真 `<button>`**：原来用 `<div data-action="open">`，键盘 / 读屏用户点不开书；
  现在可聚焦、进 Tab 序、回车触发。
- **删除二次确认补「取消」出口**：误触「删除」后可以取消，不必再点一下删。
- **颜色 token 化 + 提对比度**：主/副/危险按钮与成功色原来硬编码 `#156/#2a7/#29a/#c33` 等深色
  hex，深底上几乎看不清，且违背「不自己发明颜色、走 dsw 别名」约束——统一改成
  `--dsw-alias-accent-strong` / `--dsw-alias-label-danger` 并配浅色回退。
- **切章读取失败有反馈**：loadChapter 失败不再静默置空，给一句人话报错。
- **openProject 请求并行**：detail 与第 1 章正文并行拉；elements/chapters 并行。
- **去重刷新**：面板头部与项目列表同屏两个「刷新」→ 只留列表内那个。
- **title 输入受控同步**：书名输入即时 notify，避免受控 value 与 DOM 脱节。
- **补测**：「未保存草稿返回确认 / 取消不丢 / 确认离开」「删除取消不删书」。
  **108/108 全绿**。

## 0.6.3 (2026-09-13) — 代码审查修复：听书真机契约 / 连播跳缺口 / 服务端路径

对 0.6.x 新代码做过一轮逐文件审查，把发现的问题一次修干净：

- **P1 真机必炸**：`tts.js` 原先把普通对象 `{text,lang,...}` 喂给 `speechSynthesis.speak()`，
  而 Web Speech 只收 **`SpeechSynthesisUtterance` 实例**（传普通对象直接 `TypeError`）。
  新增 `defaultUtteranceFactory()`：真机用 `new SpeechSynthesisUtterance()`、无该构造器的
  headless 才退回普通对象。**测试替身按真机契约收口** —— `makeSynth().speak` 现在只收
  实例、普通对象必抛，防「真机炸测试绿」（0.4.2/0.4.3 同款学费的第三条路堵上）。
- **P2 连播早停**：连播/空章跳过原来 `currentNo+1`，章号有缺口（如只有 1、3）会在缺口处
  停。新增 `nextChapterAfter` 依赖（面板按已排序的 chapterList 给「下一存在的章」），
  缺省退化为 `hasChapter(no+1)`。
- **speak 守卫**：`synth.speak(u)` 包 try/catch，引擎对某块同步抛错不再把链卡死在 playing。
- **P3 服务端路径**：`bookId` 一律 `safeDecode`（URL 段是 percent-encoded，中文书名如
  `%E6%98%9F...` 不加解会被当成真实目录名、读盘全败——server-api 比 remote.workspaceFiles
  新，这条从没真机跑过）+ `validBookId` 校验（拒空/`.`/`..`/含分隔符），11 处统一。
- **api.js**：只有自身超时 controller 触发的中止才报「请求超时」；调用方自带 signal 中止报
  「请求已中止」，不再误报成超时。
- **补测**：「普通对象被引擎拒不卡死」「连播按目录跳缺口（1→3→5）」「chunkText 纯函数」。
  **106/106 全绿**。

## 0.6.2 (2026-09-13) — 面板「永远加载中」根治：请求超时 + 可读错误 + 探针日志

- **背景**：真机面板卡「加载中…」。全链路排查（curl 各端点 / 无头浏览器用真实会话 id 复现）
  均正常 —— 服务端 10ms 级响应、面板正常落到空态。代码链路无 bug，遂把矛头对准
  「请求在个别浏览器环境里永不返回」这类无法根治的场景。
- **apiFetch 加固**：① 单请求 12s 超时（AbortController），超时给可读错误
  （提示服务未起 / 被扩展或代理拦截）；② 响应非 JSON（典型：dsh 重启后旧页面被 401 成
  text/plain、代理回 HTML）不再抛 SyntaxError 天书，改为指引「硬刷新」；
  ③ `ok:false` 契约不变。
- **探针日志**：`refreshProjects` 打 `[novel-forge] GET /projects?session=…`，
  失败打 warn —— 用户卡加载时 console 一眼分诊（有出无回=网络层，有回有错=错误可见）。
- 测试 100 → **103**：超时 / 非 JSON / ok:false 三条行为测试；反向验证（改掉超时文案 → 红）。

## 0.6.1 (2026-09-13) — 基本信息标签升级为小说基本要素总览

- **REST**：新增 `GET /projects/:id/elements` 一次聚合五类要素：
  档案（title/genre/logline/stage/时间/cast）、大纲（全书大纲全文 + 细纲份数）、
  角色卡（`人物/*.md` 全文）、设定（世界书/术语表条数）、时间线（facts 按章分组 + 伏笔）。
- `fsio.js` 服务端半新增 `listEntries`（listNames 只回目录，列角色卡 .md 需要文件条目）。
- **客户端**：新视图 `views/overview.js` —— 基本信息 = 要素总览（档案 / 大纲 / 角色卡 /
  设定 / 时间线·账本）+ 底部保留本章编辑区。大纲全文与角色卡用原生 `<details>` 折叠；
  事实时间线按章升序分组展示；每个缺失要素给空态引导（novel_outline / novel_cast /
  novel_world / 写章自动记账）。要素接口失败置空、不影响打开书。
- 测试 99 → **100/100**（新增：elements 拉取与落地、接口失败置空不炸）；
  反向验证（拆掉 loadElements → elements 用例变红）。

## 0.6.0 (2026-09-13) — 详情页两个标签：基本信息 / 章节听书（语音连播）

- **REST**：新增 `GET /projects/:id/chapters` —— 章节目录（`{no,title,chars,version}` 按章号升序），
  既是听书清单也是连播的边界。
- **客户端**：项目详情页顶部两个标签「📋 基本信息 / 🎧 章节听书」；
  章节标签（`views/chapters.js`）按顺序列章，每章一个「▶ 从这章听」，
  顶部控制条支持播放/暂停/继续/停止。
- **TTS（`src/client/tts.js`）**：Web Speech 合成封装 ——
  ① 正文切块（默认 180 字符/块）逐块 speak，规避 Chrome 对超长 utterance
  「读十几秒就停」的老毛病；② **连播**：一块 onend 接下一块，一章读完自动取下一章，
  目录尽头自动收工；③ **代际计数**：stop() / 重新 playFrom 之后，一切迟到的
  onend 一律作废（真实浏览器 cancel 后仍会补发回调，不作废就是「停了又活过来」）；
  ④ 面板卸载 / 换书 / 删书 / 换会话一律 stop —— tab 关了不能还在出声；
  ⑤ 无语音引擎的环境给可读报错，不静默炸。
- 空态：《星海拾骨》这类还没写章节的书，章节标签显示引导
  （「在会话里让 AI 调用 novel_write_chapter 开写」）。
- 测试：client 测试 22 → **27** 条（目录请求、指定起始章连播、尽头自动停、
  stop 即停 + 迟到 onend 作废、暂停/继续、无引擎报错），全量 **99/99**；
  三组反向验证（拆连播链 / 代际计数失效 / 尽头不收工）各让对应用例变红。
- 自检脚本修复一处误报：宿主模块表检查的 `from\s*["']` 正则没有词边界，
  会把压缩产物字符串里的 `"play-from"` 当成 ESM import（报「索要未播种模块 `, `」）。
  加负向后行断言 `(?<![\w-])`，真非法 import 依旧报致命。

## 0.5.1 (2026-09-13) — 锻炉改回右侧栏常驻独立 tab（撤销"会话有项目才显示"门控）

- **现象**：真机上右侧栏不再有那个单独的「🔨 锻炉」。原因：0.5.0 把打开时机收进
  `session-watch` 的「本会话有项目才开」门控——没项目（或 `/projects?session=` API 没命中）
  时只注册了 tab 类型和内容 seat、**不调 `openTab`**，于是右侧栏标签条里没有独立 tab。
- **修复**：`src/client/index.js` 的 `apply` 在注册后**无条件 `openForgeTab(ctx)`**——锻炉恢复成
  右侧栏**常驻独立 tab**（恢复 0.3.x 的行为）。面板内仍按会话语义过滤项目列表，空会话
  渲染引导空态（project-list.js 已有"本会话还没有项目…"），不会露丑。
- `session-watch.js` 的调度能力保留并仍经 `__internals` 导出，但**不再由 apply 门控打开**；
  其"有项目才开 / 切会话重判 / stop 停止轮询"语义改为直接在测试里调 `startForgeAutoOpen` 验证。
- 客户端行为测试同步改写：新增「无项目也独立打开」「独立打开只发生一次」；原「本会话没有项目
  时不显示」断言反转为常驻打开。**94/94 全绿**。
- 见 AGENTS：`npm run build`（pretest 已跑）→ **重启 DSH web**（bundle 进程启动时快照）→ 浏览器硬刷新。

## 0.5.0 (2026-09-13) — 入口回到右侧栏；项目跟会话走

两条产品决定（仙尊定）：**入口放右侧栏**，**且只有用过工具的会话才显示**；
项目 = 会话里的项目，会话里创建了几本就几本。

### ① 入口：左侧栏 DOM 注入 → 官方右侧栏 tab（三步契约）

- **删掉路线 B**：`src/client/sidebar-entry.js`（入口 DOM 注入 + 双观察自愈）与
  `src/client/drawer.js`（自建 root 的全屏抽屉）整体退场 —— 产物里不再出现
  `data-dsh-novel-forge-entry` / `sidebarCol` / `MutationObserver`（测试有一条反向断言守着，
  防两条入口路线并存）。
- **改走官方三步契约**（`src/client/forge-tab.js`）：
  ① `ctx.sidebarRightTabs.register({ id, kind, priority, title, guide })` 声明类型；
  ② `ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name, key: <id>, inject }, Panel))`
  注册内容 seat；③ `ctx.sidebarRight.openTab(kind)` 才真正上屏。
  **只做①②不做③的话，一格都不多、也不报任何错** —— 这一条写进注释，别再误判成加载问题。
- **`openTab` 延迟重试**：seat 未挂载时 `openTab` 直接抛错，故首次延迟 400ms、
  之后每 250ms 重试、窗口 30 秒。
- **`guide` 入口胶囊**：跨会话常驻的手动通道，自动打开失败 / 被关掉时的保底。
- **面板改由 slot 框架渲染**（`src/client/panel.js`）：不再自己 `createRoot`，
  于是 0.4.3 的「点一次没反应、再点一次整屏空白」那一类事故从根上消失。
  控制器（状态 / 业务动作 / 原生事件代理）与组件（ForgePanel）分离，
  控制器是纯闭包 → headless 测试可直接驱动断言。
- `inject` 声明补齐：`['slots', 'sidebarRightTabs', 'sidebarRight', 'sessions']`。

### ② 显示时机：本会话有项目才出现

- 新增 `src/client/session-watch.js`：当前会话 id 从 `ctx.sessions.list`
  （`ObservableSnapshot<SessionListState>.current`）读 —— 不猜 URL、不抠 DOM；
  兼容 `getSnapshot()` / `snapshot()` / 裸对象三种快照形态。
- **有项目才自动打开**：没写过小说的会话不打扰；
- 书是会话里的 AI 调工具建的，客户端收不到通知 → **会话切换立刻查一次 + 未打开时每 8 秒轮询一次**，
  一旦为某个会话开过就不再重复（关掉是用户的自由）。
- 服务端不可达 / 面板未挂载都静默重试，不炸装配。

### ③ 数据：项目跟会话走

- `novel.json` 新增 `sessions: []` —— 「拥有这本书的会话」集合（`lib/store.js`）。
  新增纯函数 `bookInSession` / `isUnclaimed` / `addBookSession`（服务端与面板共用一份判据）。
- **创建时打戳**：`novel_project init`、`novel_import`、`novel_clone_project` 写入创建会话
  （`io.sessionId` ← `exec.agent.session.header.id`，见 `lib/fsio.js` 的 `sessionIdOf`）。
- **碰到就补录**：`requireBook` 里统一补录当前会话（`lib/tools/common.js` 的 `rememberSession`）——
  17 个工具一处接线，另一个会话接续写同一本书也看得见；老书（无 `sessions` 字段）因此自动认领。
  拿不到会话 id 时不写（headless 场景不得凭空造归属），写盘失败静默不阻断写作。
- **REST 按会话过滤**（`lib/server-api.js`）：
  - `GET /projects?session=<id>` 只回本会话的书；`?scope=unclaimed` 回未归属的旧书；不带参数回全量（curl 调试用）；
  - `POST /projects` 接受 `session` 并把戳写进新书；
  - 新增 `POST /projects/claim`：把未归属的书认领到本会话（只动未归属的，不抢别人已归属的书）。
- 面板所有列表/创建/认领请求带 `session`；无会话 id 时降级为全量（头部提示「全部项目」）。

### 测试与工程

- `test/client.test.mjs` **重写为右侧栏契约 + 会话语义的行为测试**（22 例）：
  三步契约逐项断言、`inject` 工厂交 sessionId、`openTab` 时机（无项目不开 / 有项目开一次 /
  换会话重判 / 项目后到补开 / 抛错重试）、控制器请求带会话、创建/认领写会话戳、事件代理 attach/detach、
  以及「左侧栏痕迹退场」的反向断言。
- `test/helpers/dom.mjs` 换成 **headless 装载体**：`makeCtx()`（真语义 `ctx.effect`、
  可控 `openTab`、可切会话的 `sessions.list`）+ 记账式假定时器（时序断言无 flake）
  + 沿 parentElement 冒泡的极简 DOM（真跑事件代理）。
- 三条**反向验证**（退化即红，证明测试有牙齿）：去掉「有项目才开」→ 2 红；
  请求不带 session → 1 红；`init` 不写会话戳 → 1 红。
- 契约自检脚本两处修正：page type（无 `patterns`）有 `definition.title` 时不再误报
  「缺 pane.tab.title」；入口选择器判据放宽到「只有属性名」（打包产物里常见）。
- 全量 94/94 通过。

## 0.4.3 (2026-09-13) — 修「点击无反应 / 变空白页」与「左侧栏 8 个锻炉」

两个真机症状，两个独立根因，**都不是加载链路问题**（产物与重启时间线都对得上）。

### ① 点击入口没反应，或整屏空白 → `createRoot` 取错了包

- **根因**：`mountDrawer` 写的是 `react.createRoot(container)`，而 **React 核心包没有
  `createRoot`** —— 它在 `react-dom/client` 里。官方插件一律
  `let react_dom_client = require("react-dom/client"); react_dom_client.createRoot(node)`；
  宿主播种的模块表（`CHUNK_EXTERNALS`）也是 `react` / `react/jsx-runtime` / `react-dom` /
  `react-dom/client` 四件套。
- **症状为什么这么怪**：第 1 次点击 → `createRoot` 抛 TypeError → 容器已 append 但停在
  `display:none` → **看起来毫无反应**；第 2 次点击 → `container` 已存在，于是只切了 `display`
  → 露出空的 fixed 全屏层 → **整屏空白**。两种表现交替出现，极易误判为「构建没生效」。
- **修复**：
  - 新增 `src/client/react.js` —— **React 与 createRoot 的唯一取用口**
    （`react` 取 `createElement`/`Component`/`Fragment`，`createRoot` 只从 `react-dom/client` 取），
    并带 `diagnoseRenderer()` 把「宿主到底给了什么」摊开。
  - 四个视图与 `drawer.js` 统一改为 `import { h } from './react.js'`，消灭散落的 `react.createElement`。
  - `mountDrawer` 前置守卫：缺 `createRoot` 时**明确抛错**（带缺失清单与 react 实际导出）。
  - `toggleDrawer` 失败时**回收半成品容器** + 弹原生故障卡（`data-dsh-novel-forge-fatal`）——
    **失败必须可见，绝不再留空白遮罩**。
  - 加渲染错误边界 + `render()` try/catch：视图抛错只替换该区域文案，
    不再让 React 卸载整棵树（那是「整屏空白」的第二种成因）。
  - `window.__novelForge.toggle()`：入口挂不上时的保底开关。
- **构建**：`build-client.mjs` 的 `external` 补齐宿主模块表
  （`react` / `react/jsx-runtime` / `react-dom` / `react-dom/client` / `cordis`）。

### ② 左侧栏冒出一列 8 个「小说锻炉」→ 去重路径走不到

- **根因有两层**：
  1. **去重写在 `placeEntry` 里，而已就位的挂载会在 `tryPlace` 里提前 `return`** ——
     那条去重路径**永远走不到**，历史重复节点再怎么刷也洗不掉；
  2. `apply` **没注册 disposer**，插件每重装一次（dsh 重启 / 热更新 / 会话重建）
     就漏一份入口 + 两个观察者，越积越多。
- **修复**：
  - 入口改为**DOM 单例收养**：`acquireEntry` 若发现已有同类节点，就**复用**它并
    把点击处理器换成最新实例的（处理器存在节点的 `__novelForgeOnClick` 上，
    避免收养来的节点还指着上一个实例的幽灵抽屉），同时把多余节点**清扫**掉。
    仲裁权放 DOM 而不是模块变量 —— cordis 反复装配时上一个模块实例还活着，模块变量挡不住跨实例。
  - `tryPlace` / `rootObserver` 里**无条件** `sweep()`，不依赖 `placeEntry` 是否被执行。
  - `mountDrawer` / `disposeDrawer` 按 `data-dsh-novel-forge-drawer` 清扫其它实例遗留的抽屉容器，
    保证页面上只有一个全屏层。
  - `apply` 用 `ctx.effect(() => dispose)` 注册清理（cordis 语义：回调立刻执行、返回值登记为清理函数）。

### ③ 测试：把「假前提」从替身里挖掉

- 旧 headless 替身的 `require` **顺手给 `react` 挂了 `createRoot`** —— 与真机相反，
  等于把「`react.createRoot` 能用」这个假前提固化成绿灯。现在替身的模块表**严格镜像宿主**
  （`react` 明令不给 `createRoot`，`createRoot` 只在 `react-dom/client`），
  并新增断言：**产物只许 require 宿主播种的模块**。
- 旧 `ctx.effect` 替身写成 `(f) => f()`（登记 f 本身且立刻调用），与真机语义相反，
  导致「注册 disposer」这类改动**根本测不出来**。现按官方写法
  （`ctx.effect(() => () => {...})`）复刻：立刻执行、登记返回值。
- 新增 8 条用例：模块取用契约、渲染器缺失不留空白遮罩、同实例反复 apply 唯一、
  跨实例收养唯一、历史 8 个重复被清扫、后冒出的重复被自愈清掉、`ctx.dispose` 后入口移除。
- **反向验证**（证明测试真有牙齿）：把 `createRoot` 改回从 `react` 取 → 2 条变红；
  拆掉收养 → 1 条变红；拆掉无条件清扫 → 1 条变红；还原后全绿。**86/86**。

## 0.4.2 (2026-09-13) — 补上构建链：客户端源码模块化，四视图落地

- **背景**：0.4.0/0.4.1 把浏览器半改成「左侧栏 DOM 注入 + 全屏抽屉」后，按设计文档写的
  `lib/client/drawer.js` / `lib/client/sidebar-entry.js` 是 **ESM**，而 dsh **只加载**
  `exports["./client"]`（`lib/client.js`）—— 这两个文件是**不可达的死代码**；更糟的是
  `sidebar-entry.js` 里的自愈还是 **0.4.1 修掉前的旧语义**（`if (!placed) place()`），
  一旦有人误把它当源码打包进去，入口消失的 bug 会原样复活。设计文档 Step 4-7 的四个视图
  文件（project-list / project-detail / lorebook / settings）也一个都没落地。**三份实现互相分叉。**
- **根因**：缺**构建步骤**。dsh 官方 `dsh-client-modules` 明确「宿主提供的是**已构建的**客户端
  bundle，启动前必须已产出每个 `lib/client.js`」—— 源码可以是 ESM，但发布物必须是经典脚本。
- **修复**：
  - 新增 **`src/client/` 源码树**（ESM，唯一真相）：`index.js`（入口）· `sidebar-entry.js` ·
    `drawer.js` · `views/{project-list,project-detail,lorebook,settings}.js` · `api.js` ·
    `state.js` · `styles.js`。以活跃的 `lib/client.js` 为**行为基准**（保存/导出/写章引导等功能
    一个不少），吸收 `lib/client/drawer.js` 的参数化与 `dispose` 设计。
  - 新增构建脚本 **`scripts/build-client.mjs`**（esbuild）：`src/client/` → `lib/client.js`，
    产出与官方插件一致的 `window.__ModuleLoader__.load({ id, factory })` 经典脚本；
    `react` 走 external，由宿主 `PLATFORM_MODULES` 基座提供（不重复打包）。
  - 加 **`npm run build`** 与 **`pretest`**（测试永远跑当前源码构建出的产物）；
    构建脚本内置**版本守卫**：源码 `PLUGIN_VERSION` ≠ package.json version → 直接构建失败。
  - **移出 `lib/client/` 目录** —— 它与产物 `lib/client.js` 同名，是歧义与分叉的温床。
    源码改用 `src/`（dsh 生态惯例），`lib/` 从此只放产物与 node 半侧。
- **顺带修的两处真问题**：
  - `ENTRY_SELECTOR` 原来只导出、无人使用，会被 esbuild **tree-shake 掉**（连带让契约自检脚本
    误判「没有入口选择器」）。现在 `placeEntry` 用它做**幂等去重**（清掉重复入口），常量变成真用途。
  - `package.json` 的 `dsh.client.inject` 还写着 `@deepseek-ai/dsh-client-ui-sidebar-right` ——
    那是右侧栏 tab 路线的遗留声明，DOM 注入不需要它，已移除。
- **测试**：新增「构建链：四视图已拆成独立源码，产物由 src/client/ 构建而来」用例（四视图源文件存在
  + 产物 generated 头 + 源码/产物版本一致）；更新 smoke 的结构契约断言 —— 不再绑死手写 IIFE 的
  `exports.apply = apply` 形态，改为断言 esbuild 的导出**表内容**。**79/79 全绿**。
- **反向验证**（证明新断言有牙齿，不是"看起来绿"）：手动去掉产物的 generated 头 → 相关用例立刻变红
  （8 pass / 1 fail）；把源码版本改成 `9.9.9` → `npm run build` 以 **exit=1** 拒绝并打印版本漂移。
- **一个教训**：`src/client/sidebar-entry.js` 的注释里为了解释旧 bug 原样写着 `if (!placed) place()`，
  于是「源码不得退回旧自愈语义」那条**文本断言把注释当成了代码**命中（假阳性）。
  该语义本就由行为用例真跑守住 —— 已删掉那条文本断言。**能跑就别 grep。**

## 0.4.1 (2026-09-13) — 修「左侧栏入口被 React 冲掉后永不复生」

- **现象**：0.4.0 把入口从官方右侧栏 tab 换成左侧栏 DOM 注入后，真机上右侧栏不再有「🔨 锻炉」（**这是设计使然**），但**左侧栏那个「小说锻炉」入口也没出现** —— 等于整个锻炉入口消失。
- **根因**：宿主侧栏是 **React 托管**的。旧实现 `mountSidebarEntry` 只走一次：
  ```js
  const tryPlace = () => { try { if (!placed) place(); } catch {} };
  tryPlace();
  if (!placed) { observer = new MutationObserver(...); }   // 插成功就根本不建 observer
  ```
  - 首次插入若落在 React 下一次 reconcile 会整棵替换掉的过渡容器上 → 节点被冲掉；
  - 此时 `placed` 仍是 `true`，`tryPlace` 永远早退，**observer 又压根没建** → 入口**再也回不来**。
- **修复**（对齐参考实现 `dsh-mnemon/lib/client.js` 的写法）：
  - `placeEntry(root, entry)`：以 `newSession` 按钮为锚，且用**族选择器**（`[data-dsh-taskboard-entry], [data-dsh-ssh-entry], [data-dsh-mnemon-entry], [data-dsh-novel-forge-entry]`）排队，避免与其它第三方入口互相顶位；
  - **双观察自愈**：`waitObserver`（等侧栏出现，observe `document.body`）+ `rootObserver`（常驻守着，`!root.contains(entry)` 就重插，`!root.isConnected` 就重解析 root）；
  - 判据从「插过没有」改成「**现在还在不在**」（`document.body.contains(entry)`），这才是幂等的正确写法；
  - 新增 `data-dsh-plugin` / `data-dsh-part` 标记；`apply()` 加 `console.info` 分诊日志（**没有这行 = apply 压根没被调用，问题在加载链路而非本文件**）。
- **测试重写（关键）**：旧 `test/client.test.mjs` 全是 `code.includes('mountSidebarEntry')` 式的**字符串断言** —— 只要有这个名字就绿，于是上面这个真 bug 一路 77/77 绿灯。现改为**行为测试**：`test/helpers/dom.mjs` 提供照抄 dsh 真机 DOM 的仿真环境（`pI_x6G_sidebarCol` / `hHd-Xa_root` / `logoRow` / `newSession`），**真跑 `apply()`**，覆盖：插在正确位置、**被冲掉后自愈**、侧栏后到、**整棵替换后重挂**、点入口挂抽屉、经典脚本结构。**78/78 全绿**；反向验证：把自愈退化回旧语义 → 相关用例立刻变红。
- **诊断教训**：`node --check` 在本包会按 **ESM** 解析（`"type": "module"`），而 dsh 按**经典脚本**执行 bundle —— 混入 `import/export` 会让整包 syntax error 却检查不出来。新自检脚本已把这条做成硬检查。
- **注意**：`lib/client/drawer.js`、`lib/client/sidebar-entry.js` 是 **ESM**，dsh **只加载** `exports["./client"]`（`lib/client.js`），这两个文件目前是**不可达的死代码**，与 bundle 内联版本存在分叉风险。

## 0.3.10 (2026-09-13) — 可选文件缺失不算错：去梢余的可选 read 报错

- **问题**：0.3.9 真机上《星海拾骨》读盘成功，唯独 `style-baseline.json` 如实报出 `workspace-file/not-found`——那是**正常状态**（该书从没跑过 `novel_style build`，基线文件本就不存在）。但 `probeReadBook` 把"没读到"一律推成 `readError`，面板刷了一道红，掩盖了"这书没基线"这个本可正常表达的信息。
- **修复**：specs 加"必需/可选"标记——`novel.json` **必需**（定义一本书，读不出不算书）；`账本/facts.json`、`账本/伏笔.json`、`.novel/style-baseline.json` **可选**（数据累计后才生成，缺失=零/未建，静默跳过、不进 readError）。摘要里缺失可选文件自然降级（facts=0、伏笔 open/0、styleBuilt=false）。
- 摘要门槛收紧：只有在读到 `novel.json` 时才造摘要（可选文件全读到也只算陪衬），杜绝幽灵书目。
- 新增 2 例锁定行为（可选 style not-found 不进 readError + novel 必需缺失才报错）。**85/85 全绿**。
- 刷新 DSH web 页面即可：书目卡《星海拾骨》的红 read 行应消失，行情变成 `规划 · 账本 3 · 伏笔 1/1`（无"有基线"）。

## 0.3.9 (2026-09-13) — 书目发现加预筛：非书目录不再被盲读

- **实机验证结果：0.3.8 的数据面在真实 dsh 上跑通了。** `list(sessionId, ".")` 成功列出工作区根内容；`read` 成功读到书并带出 `absolutePath`；面板如实显示工作区内真书《星海拾骨》的 `planning · 账本 3 · 伏笔 1/1`，并**如实**报出 `style-baseline.json` 的 `workspace-file/not-found`（那本书确实还没建基线）。**面板功能验证通过。**
- **修掉一个真缺陷**：`loadBookConsole` 原先把工作区根下**所有**一级目录都当书，每个盲读 4 个机器文件。实机里工作区根是 `~/Documents/other/`，含 `dsh-novel-forge/`（插件仓库）等非书目录 → 刷出满屏 `workspace-file/not-found`，把真实错误淹没。
- **修复**：新增 `dirHasNovel(wf, sessionId, dir)`——先用 1 次轻量 `list` 判断目录里有没有 `novel.json`，只对真正的锻炉书读盘。**1 次 list 换掉 4 次 read**，既省请求又去噪。任何异常（无 `list` 方法 / `ok:false` / 抛错）一律当"不是书"，候选筛选宁缺勿滥、绝不抛。
- 加扫描上限 `MAX_SCAN=30` / `MAX_BOOKS=12`，防工作区被塞进巨型目录时打爆面板。
- 新增 2 例（非书目录不被误读 + `dirHasNovel` 全异常降级）。**83/83 全绿**。
- **诊断教训**：本次一度误判「面板读到旧数据」，真相是我把验证样本建到了**工作区根的子目录**（`dsh-novel-forge/星海拾骨/`）而不是工作区根下。**dsh 的工作区根 = dsh 进程的启动目录**，样本必须放在它能 `list` 到的那一层。这也是**插件开发目录常在数据目录的子层**时的典型陷阱。先 `list(sessionId, ".")` 把工作区真实内容打出来，比任何猜测都快。

## 0.3.8 (2026-09-13) — 纠正数据面根路径：list 受工作区边界限制，read 不受限

- **推翻 0.3.7 的结论**。0.3.7 从本地 mock 归纳出"根目录只能传工作区绝对根、`$host.home` 就是它"——**这个前提是错的**。它在真实 Host 上 100% 失败，错误码 `workspace-file/outside-workspace`：`"/Users/huangshengju" is outside the workspace`。
- **真契约**（源：依赖包自带文档 `@deepseek-ai/dsh-api-workspace-files` 的 README + types，非猜测）：
  - `list(sessionId, path, signal?)` —— **path 必须落在会话工作区内**（`list` 与 `changes` 受限）；空串是 `gateway/bad-request`。
  - `read(sessionId, path, range, signal?)` / `stat` / `readBytes` / `readAll` / `readRelated` —— **不受工作区边界限制**，接受绝对路径，可读工作区外。原文：「文件读取可以指向工作区外路径；目录列举与已埋点的文件系统观察仍限定于工作区」。
  - 工作区根 = `SessionHeader.cwd`（**单根、不可变**）；`process.cwd()` 只是无 cwd 会话的兜底，且明确"不支持额外可写根"（源：`dsh-sandbox-policy`）。
  - `$host.home` 是 **Host 机器的家目录**，通常正是工作区根的**父目录**——拿它当 list 根必被拒。
- **修复**：
  1. `probeRemote` 的 list 根改用**工作区相对根 `"."`**（备用 `"./"`）；删掉 `$host.home` 形态与空串形态，并在错误里点明"list 只能列会话工作区内的路径"。
  2. `probeReadBook` 的 read 形态改为真实 arity：`read(sessionId, path, {}, signal?)`——**range 是必填对象**，缺参或传 undefined 会以装配错误（arity）reject；0.3.7 的 `read(sessionId, path)` 与 `(sessionId, path, undefined)` 都属缺参。
  3. read 返回值按 `WorkspaceFileText` 取 `text` 字段（不再假定裸字符串），并带出 `absolutePath`；面板新增「盘」行 ＝ 确实读到真实文件的凭证。
  4. `loadBookConsole` 加**两态判定**：工作区根下直接有 `novel.json` ⇒ 根本身就是一本书（bookName 传空串，路径**不带前导斜杠**，否则会变成绝对路径绕过工作区根）；否则把一级子目录当候选书。
  5. 面板「书目」空态给出可执行的修复指引：`DSH_PROJECT=<书库目录> ~/restart-dsh.sh`；`host` 行标注"机器 home，非工作区根"。
- **测试**：改掉"跟着自己实现走"的 mock，让 mock 复刻真实契约——list 对工作区外路径回 `outside-workspace`、read 缺 range 直接抛装配错误。新增 e2) 反向防线（禁止再把 `$host.home` 当根）+ 两个用例（空 bookName 路径无前导斜杠、两态判定）。**82/82 全绿**。
- **教训**：本地 mock 若跟着自己的实现写、而不是跟着被集成的真实接口写，就会产出「全绿但接不上」的假象——0.3.4~0.3.7 连续四版都栽在这一件事上。凡猜调用形态，先读依赖包自带的 README/types。

## 0.3.7 (2026-09-13) — 修列目录：根目录用 $host.home 作为 list 根路径

- **根因（实测错误码收敛）**：`workspaceFiles/list` 收**非空 path**——空串被 `path is required` 拒；对象实参被 `rejected "path"` 拒；实参不足被 `expected 2 business argument(s) plus an optional AbortSignal` 拒。解析逻辑是 `{startsWith("/") ? path : ROOT/path}`，根目录只能传**工作区绝对根**。
- **修复**：`$host.home` 即工作区绝对根（连接侧 fixture 里 `host.home == WORKSPACE_FILES_ROOT`），把 `list(sessionId, host.home)` 列为第一形态，home 缺失才退回空串（诊断用）。`probeRemote` 的 list 尝试自此以 host.home 为根。
- **read 形态校准**：`probeReadBook` 的 read 实参按"2 业务实参 + 可选 signal"口径重排，`read(sessionId, path)` 最优先。
- 测试(e) 改为断言 `host.home` 作为 list 根路径列出成功（含书目目录浮现）。**80/80 全绿**。
- 样例书《星海拾骨》可验证：刷新后书目卡应列入书名目录并读出摘要。

## 0.3.6 (2026-09-13) — 修数据面：remote 子域必须显式声明 inject

- **根因**：`ctx.remote.workspaceFiles` 被 remote Proxy 挡住，报 `cannot get property "remote.workspaceFiles" without inject`。remote 的每个**子域**都要求消费者把 `"remote.<domain>"` 写进 client 的 `inject` 数组，只声明 `"remote"` 不够；对齐官方 sidebar-files / documentpreview（二者都显式声明 `"remote.workspaceFiles"`）。
- **修复**：inject 增 `"remote.workspaceFiles"`（数据面的唯一读盘通道，缺它整块数据面起不来）。同时测试断言从 4 项扩到 5 项（含 `remote.workspaceFiles`），杜绝回退。
- **实证确认调用形态**：服务端 RPC 是 `workspaceFiles/list|read|stat|changes`，收**工作区相对 path**；client 调用为 `workspaceFiles.list(sessionId, path, signal)`——0.3.5 的 `probeReadBook` 形态 0 正好命中。
- 样例书《星海拾骨》（novel.json + 账本 3 条 + 伏笔 1 开）已就位，供刷新后验证书目卡。
- 80/80 全绿。⚠️ 刷新 DSH web 页面装载即可。

## 0.3.5 (2026-09-13) — 数据面渲染：书目控制台（真实读取 + 解析）

- **读盘收敛**：新增 `probeReadBook`，对书目目录读取 4 个机器文件（`novel.json` / `账本/facts.json` / `账本/伏笔.json` / `.novel/style-baseline.json`），`read` 签名同样按多形态降级逐一尝试（对齐 0.3.4 的 list 收敛法）；能读到就顺手 parse——"读盘签名"与"真实渲染"一次收敛，失败带原始错误码不伪造。
- **纯解析层 `lib/book-console.js`（新）**：把文件文本解析成紧凑书目摘要（标题/阶段/已写章/已批准细纲/账本条数/伏笔开没与超期/基线有无），`summarizeBook` 全容错（缺失、非法 JSON、结构不符一律降级不抛）。8 例 node --test 直测（用插件真实数据结构）。
- **client 面渲染**：`ForgePanel` 新增「书目」卡，列出工作区里每本书的量化摘要；`loadBookConsole` 枚举 `list` 出的书目录逐个读盘。面板注册的 `inject` 工厂把 sessionId 带进来。
- **parity 门禁**：client 内联解析（`summarizeBookClient`，浏览器半无 import、需内联）与服务端 `lib/book-console.js` 用同一批样本断言**同口径**，封死"两处实现漂移"。
- **细节修正**：novel 缺失时 client 侧 chapters/approved 与 server 对齐为 `null`（不塌成 0）；一章都没读到时不造幽灵书目，只留 readError。
- 新增 12 例（解析 8 + parity 1 + 读盘收敛 3）。**80/80 全绿**。
- ⚠️ client bundle 按内容 hash 拉取，**刷新 DSH web 页面**即可装载（无需进程重启）；数据面是否读盘成功看「书目」卡的 read 行。

## 0.3.4 (2026-09-13) — 数据面开工：接上 Client Remote + 修面板版本硬编码

- **修版本漂移（真 bug）**：面板徽章硬编码 `v0.3.0`，0.3.1→0.3.3 三轮都没跟着改，界面上挂了三版旧号。
  现抽成常量 `PLUGIN_VERSION`，并新增断言强制它等于 `package.json` 的 `version`——再漂移会被测试当场拦下。
- **接上数据面通道**：`inject` 增 `"remote"`；tab 面板的 slot 注册改为带
  `inject: (sessionId, actions) => …` 工厂，把会话 id 交给组件
  （对齐 `dsh-client-ui-sidebar-documentpreview` 的官方姿势——这是拿到 sessionId 的唯一入口，
  0.3.0 起的注册没写它，面板一直拿不到会话上下文）。
- **选型结论（实证，非猜测）**：client 半读工作区**不必自建 typert 域**。
  官方 `remote.workspaceFiles` 域已提供 `read` / `readBytes` / `stat` / `list` / `changes`，
  足以覆盖书目（`novel.json`）、账本（`facts.json`）、正文与基线的全部读盘需求。
  调用签名是 `(sessionId, path, …args, signal)`（比 d.ts 的 wire 类型多一个 sessionId）；
  `read`/`readBytes`/`stat` 收**绝对路径**，`list` 收**工作区相对路径**。
  自建域需 typert 代码生成链（`Generated by dsh-typert-generator … do not edit`），
  留给 v0.4 需要服务端计算的聚合指标。
- **新增运行时探测**：面板「数据面探测」卡显示 `sessionId` / `$host`（home、isLoopback）/
  可用 remote 域清单 / 工作区根目录列表。`probeRemote` 是纯逻辑，含 `list` 四种调用形态的降级链，
  失败时**原样带回错误码**而非伪造数据——四种形态的错误码能一次性收敛出正确写法。
- 导出 `__internals`（前缀 `__`，非插件对外契约）供 headless 门禁直测探测逻辑，
  把"浏览器半没法测"的又一个坑填成可命令复现的用例。新增 3 例：
  sessionId 注入、版本同步、探测降级与错误聚合。**68/68 全绿**。
- ⚠️ client bundle 在 web 进程内缓存，需**重启 DSH web** 装载（link 已同步，无需重装）。
- 下一步（v0.4）：按探测结果收敛 `list` 形态 → 面板渲染真实书目/账本/伏笔。


## 0.3.3 (2026-09-13) — 修复"锻炉"tab 仍不出现：缺第三步 openTab（0.3.2 只补齐了前两步）

- **真根因**：进右侧栏某格只有一条路——`ctx.sidebarRight.openTab(kind)`（资源类走 `openResource`）。
  `sidebarRightTabs.register` 只是**第一阶段：声明类型**，它本身不产生 tab；0.3.2 补齐了类型声明，
  但**从没有人"打开"过这个类型**，所以右侧栏永远不多出一格。官方 `dsh-client-ui-sidebar-right`
  的类型文档原文：*"Tab types register in two stages… And `openResource`/`openTab` are the navigation
  controller, and **every way into the column is a call to one of them**."*
- **修复 `lib/client.js`（三步齐活）**：
  1. `inject` 补 `"sidebarRight"`——打开 tab 需要导航面（0.3.2 只 inject 了 slots + sidebarRightTabs）。
  2. tab 定义补 `guide` 条目：右侧栏 guide 是常驻 docked 页，任何 session 都能从「🔨 锻炉」胶囊把 tab 拉出来（**长期入口**，切会话后依然可用）。
  3. apply 第三步排一个 400ms 启动延迟调 `openTab("novel-forge")`。seat 未挂载时 openTab 按设计**直接抛**（没有 session 可操作时宁可报错，也不静默写进没人画的 surface），故按 250ms 节拍重试（上限 40 次 ≈ 10s），**开成即停**——用户手动关掉后不再骚扰。
- **诊断钩子**：client 装载/失败会在浏览器 console 打 `[dsh-novel-forge]` 前缀日志，用于区分"bundle 根本没加载"与"加载了但打开失败"两种故障。
- `test/client.test.mjs` 2 例 → 3 例：新增 guide 条目断言、page type（不声明 patterns）断言，以及"seat 未挂载 → 抛 → 重试 → 挂载后打开成功 → 不重复打开"的**假定时器确定性时序断言**（sandbox 里 setTimeout 换成受控记账，不引真实等待、不 flake）。65/65 全绿。
- ⚠️ client 图在 web 进程内缓存，需**重启 DSH web** 装载新 bundle（link 已同步，无需重装）。

## 0.3.2 (2026-09-12) — 修复"锻炉"tab 不出现：缺 sidebarRightTabs tab 类型注册

- **根因**：右侧栏 tab 是"tab 类型 + 内容 seat"两层。光注册 `sidebar.right.pane.tab` seat（0.3.0 所写）不会生成 tab 入口；必须先 `ctx.sidebarRightTabs.register({ id, kind, title })` 创建 tab 类型，内容才按 **id** 派发进 seat（对齐 dsh-client-ui-sidebar-files 的 tab-types+pane 体系）。0.3.0 只做了后一半 → 真机"没有🔨锻炉"。
- **修复**：`lib/client.js` 现在 `inject:["slots","sidebarRightTabs"]`，apply 先 `sidebarRightTabs.register({id:"novel-forge",kind:"novel-forge",title:()=>"锻炉"})`，tab id 同时作为两个 seat 的 key。
- `test/client.test.mjs` 增强：断言 apply 调用 `sidebarRightTabs.register` 恰好一次、id/kind 唯一、title="锻炉"，且 seat key 与 id 同源。64/64 全绿。
- ⚠️ client 图/负判定在 web 进程内缓存，需再次**重启 DSH web** 装载新 bundle（link 已同步，无需重装）后右侧栏应出现"🔨 锻炉"tab。

## 0.3.1 (2026-09-12) — client-half headless 注册验证门禁

- **新增 `test/client.test.mjs`**：用 `node:vm` 以 `__ModuleLoader__` 真实语义加载 `lib/client.js`，物化 `{ inject, apply }`，再用 slots/effect stub 跑 `apply(ctx)` 断言右侧栏两个槽位（`sidebar.right.pane.tab` / `sidebar.right.pane.tab.title`）各注册一次、meta.name 与槽位同名、key=novel-forge、带组件函数。**把"假 ctx 载不了浏览器半"的验证坑填成可命令复现的门禁**——即便无浏览器也能确定性验证 client load 不炸、注册调用正确。
- 同时确认：裸 `react` 是平台可解析种子词（宿主 80 处已打包 client 均如此 require）；`dsh.client.inject` 指向的 `@deepseek-ai/dsh-client-ui-sidebar-right` 为宿主既有可注入服务。
- 排除需重启 web：客户端挂载错误只出现在浏览器 console，不落服务器日志，重启无诊断增益；服务器侧已确认 web 存活（HTTP 401 为登录门禁）且 link 安装、0.3.1 client 产物与声明就位。64/64 测试全绿。

## 0.3.0 (2026-09-12) — 浏览器 client-half（GUI）首块：右侧"锻炉"tab

- **新增 `lib/client.js`**：dsh-novel-forge 第一个浏览器 client 模块，以 `__ModuleLoader__.load` 部署格式（对齐 dsh-client-ui-brand-official / sidebar-files），在右侧栏注册一个"锻炉" tab（面板 + chip 标题）作插件的常驻 UI 挂载点。v1 为静态识别面（插件名/版本/17 工具/双通道/规范三条），证明 client 挂载链路；数据面（书目/账本/风格基线…经 remote 拉取工具态）留到下一里程碑。
- **package.json**：新增 `exports["./client"]` 与 `dsh.client { inject:["@deepseek-ai/dsh-client-ui-sidebar-right"], platform:"web" }`；版本 0.3.0。
- **结构契约回归测试**：`smoke.test.mjs` 新增断言 package.json 的 `./client`/`dsh.client` 声明与 client.js 的 ModuleLoader 标记/load id/apply+inject 导出。62/62 全绿。
- ⚠️ **验证依赖真机**：浏览器半无法在假 ctx 挂载验证。装进 live web profile 后需**重启 DSH web**，右侧栏应出现"🔨 锻炉" tab；结构契约测试守住了产物不漂移，但挂载效果需真机确认。（回滚：撤 dsh.client + exports["./client"] + 删 lib/client.js 即回到纯服务端。）

## 0.2.8 (2026-09-12) — 三项遗留加固

- **MCP 后端符号链接逃逸修复**：`createNodeFsBackend` 的 containment 从词法 `path.relative` 升级为 **realpath 校验**——工作区内的软链指向区外时 stat/read/write 全部拒绝（`FS_SANDBOX_DENIED`）；root 本身是软链时统一到真实路径再比较；待创建新文件对最近存在祖先做 realpath 后拼回剩余段。0.2.6 记录的"低风险加固项"就此关闭。
- **MCP 通道输出契约校验**：`buildStandaloneTools.call` 对返回值跑宿主同款 `validateJsonSchemaValue`（防御性动态导入，SDK 缺席时退化为不校验）——MCP 客户端拿到的数据与宿主通道同一标准，违规抛 `INVALID_TOOL_OUTPUT`。
- **style 词表外置**：`style.js` 的六维词表（模糊限制语/抽象后缀/动作动词/动态助词/「X地」排除表）与 12 轴氛围词表挪到 `lib/data/style-lexicon.json`，与 noai/diagnose 词库同一存放约定；`MOOD_AXES` 改为从词库导出，用户调词不动算法。
- 测试 61/61 全绿（新增：软链逃逸 ×read/write/resolve 三通道、契约探针违规拒绝 + 正常工具不受影响）。

## 0.2.7 (2026-09-12) — 氛围光谱去重修复

- **修复**：`MOOD_AXES` 的 `mystery` 轴 `'线索'` 重复出现，而 `measureMood` 逐词累加命中 → 悬疑轴被双倍计分、系统性抬高。已删数据层重复词，并在 `measureMood` 内用 `new Set(words)` 去重兜底（防词表再次引入重复）。新增回归测试：998 字文本含 1 个"线索"时悬疑轴精确为 1.0/千字（旧实现会得 2.0）。59/59 测试全绿。
- 另：MCP 后端 containment 用 `path.resolve`（不追符号链接）——本地工作区若已有指向区外的符号链接可沿链接读写逃逸，属低风险加固项，暂未改动（见评审记录）。

## 0.2.6 (2026-09-12) — 大肥鱼三连：锚包写作 + 氛围光谱 + MCP 双通道

- **锚包写作**（灵感：dsh-novel-writer 锚包哲学）：`novel_briefing` 上下文包新增
  「原著锚段」区——从最近已写的 3 章里启发式挑出叙述感/对话感各一段代表性段落，
  有基线时附六维指纹行；纪律同一条：照锚段的语感节奏写，勿抄词句，勿把数字当写作规则。
- **氛围光谱 12 轴**：`lib/style.js` 新增 `measureMood`（热血/悬疑/惊悚/压抑/甜宠/
  温情/悲情/诙谐/爽感/神秘/肃杀/苍凉，命中数/千字，宁漏勿误词表）；`novel_style`
  build 附全书各轴均值 + 最浓三轴，check 附本段向量与主导氛围漂移判定
  （from → to，方向参考非错误）。
- **MCP 双通道**：新增零依赖 stdio MCP server（`mcp/server.mjs`，原生 JSON-RPC 2.0），
  把全部 17 个 novel_* 工具暴露给 Claude Desktop / Cursor 等任意 MCP 客户端；
  `lib/mcp-standalone.js` 提供 node:fs 后端（containment + createIfAbsent/
  replaceIfVersion 版本守卫，与宿主沙箱语义对齐）；package.json 增加
  `bin: dsh-novel-forge-mcp`；工作区根 = `NOVEL_FORGE_ROOT`（缺省 cwd）。
- 测试 58/58 绿（新增 6：锚段提取、氛围测量、后端 containment/版本守卫、
  standalone 装配、stdio 子进程 initialize→tools/list→tools/call 全链）；
  真机 headless 验证：build 氛围 top3=苍凉/肃杀/压抑（废土书方向正确），
  briefing 锚段区 + 指纹正常注入（totalChars 2794）。

## 0.2.5 (2026-09-12) — 新增 novel_style 文笔六维基线（第 17 个工具）

- **新增** `lib/style.js` 纯逻辑模块（零依赖、零模型调用）：六维测量——句法复杂度（小句/句）、修饰密度（X的/X地，排除「地铁/地方」等名词词素）、抽象度（抽象后缀词/千字）、动作密度（动词+动态助词/千字）、不确定性（模糊限制语/千字）、留白指数（省略号/破折号+未完句）。按章算 μ±σ 基线带，容差默认 1.5σ 相对占比（夹 10%~100%，单样本退化 35%）。
- **新增** `novel_style` 工具：`build` 测全书各章建基线存 `.novel/style-baseline.json`；`check` 拿某章或给定 text 对照基线，逐维报带内✓/出带⚠与偏差百分比，verdict 三档（in_band / minor_drift / drift），容差可按维覆盖。
- 系统提示新增纪律第 8 条：续写前 build、交稿前 check，出带只报方向、不把数字翻译成写作规则。
- 思路致谢 dsh-novel-writer（siweina，MIT）的六维测量设计；实现口径为本插件自有（密度统一每千字、测量与判断分离与既有审计一致）。
- 测试 53 项全绿（新增 5 项 style 单测）；真机 headless 验证 build+check 通过（顺带抓出并修复 build/check 输出 schema 与实际返回不一致两处）。

## 0.2.4 (2026-09-12) — 垫片补全 presentationMeta 对称归位

- **补齐**：`lib/tools/define-tool.js` 之前只把顶层 `render` 挪进 `output.render`，`presentationMeta` 仍会留在顶层被宿主忽略——注释/0.2.3 说明写的"render / presentationMeta 归位"名不符实。现对称处理：顶层 `render`/`presentationMeta` 都归位到 `output` 下（output 已有值不覆盖），注释与行为一致。当前无工具用 presentationMeta，故纯为消缺 + 消除误导。
- 新增回归测试：顶层 render/presentationMeta 经垫片归位后，`t.output.render(...)` 不再抛 `userRender is not a function`，`presentationMeta` 同样可用（走真实宿主 SDK，48 测试全绿）。

## 0.2.3 (2026-09-12) — 真机冒烟修复：render 兼容 0.1.5-rc.1 宿主

- **修复**：`defineTool` 选项顶层的 `render` 在 dsh 0.1.5-rc.1 宿主上全部失效——宿主只读 `options.output.render`，其渲染包装函数拿到 `undefined` 调用即抛 `output.render failed: userRender is not a function`，工具输出被判 INVALID_TOOL_OUTPUT（16 个工具全数命中）。新增 `lib/tools/define-tool.js` 兼容垫片（顶层 render / presentationMeta 归位到 output 下），6 个工具文件改走垫片导入。单测（假 fs）不走宿主渲染路径故未暴露，真机 headless one-shot 冒烟抓出。
- 真机冒烟 7 步全通：import preview/import → diagnose 四维 → export 落盘 → clone_project（`ctx.fs.listDir` host 面验证，缺失 0）→ polish analyze/submit → propose list/apply（提案制 v1→v2 旧版保留）。

## 0.2.2 (2026-09-12) — 输出契约硬化 + 世界书互操作 + 克隆修复

- **世界书互操作**（新 `lib/worldbook-io.js` 纯函数）：`novel_worldbook import/export` 接受三种形态——JSON 数组、SillyTavern 简化形（`{key/keyword/comment/constant/uid}` 尽力规约）、纯文本行 `关键词1,关键词2 | 内容`；导入按 id 覆盖合并，坏行跳过并报告 errors。
- **输出契约硬化**：可选字段缺省时**省略键**而非给 null（`audit.endingHook.kind`、`repetition.chapter`、伏笔 `plan/payoffChapter` 经 `foreshadowView` 统一裁剪）——宿主对 null 一样判 INVALID_TOOL_OUTPUT；新增**真校验器**冒烟（宿主 `validateJsonSchemaValue` 对真实返回值零违规）。
- **克隆修复**：未批准细纲一并复制（按已写∪已批准并集，经新增 `fsio.listNames`→`ctx.fs.listDir` 扫描细纲目录）；克隆产物 `approvals` 与 `defaultNovel` 同形（此前是 `{}`，新书 approve 会 TypeError）。
- **propose/apply 机审计基线修正**：应用提案后的重复率检测从空 `previous` 改为真实前文窗口（与 write_chapter 同口径）。
- `parseFactLines` 补实体/键名空值校验；`audit.js` 钩子检测复用 `hook.js`。
- **版本计算统一**：`write_chapter` / `propose apply` 的内联正则版本号计算收敛到 `versioning.nextVersion`（唯一入口）；删除无调用方的 `latestChapterFile` / `listChapters`。
- COMPATIBILITY 宿主面清单补 `ctx.fs.listDir`（0.2.1 起实际依赖）。
- 测试 47 全绿。

## 0.2.1 (2026-09-12)

两项收尾：

- **`novel_import backfill`**（门禁回补）：为导入旧书从已存正文确定性生成粗纲（标题/字数/开场/章末钩子/出场人物识别，`lib/import.js roughOutline` 纯函数），`approve:true` 可一并批准（记入审计）。只回补缺失细纲，已有细纲的章不动；续写新章仍走正常 save_chapter + approve。导入→继续写的链路不再逐章手工补纲。
- **诊断词库外置**：`diagnose.js` 的冲突/灌输/开场动作/抒情开场词表挪到 `lib/data/diagnose-lexicon.json`（与 noai-lexicon 同一约定，用户可调词库不动算法）；顺带修正 `conflictWords`/`infoTokens` 缺 `g` 标志导致"命中数加权"实际恒为 1 次的隐性问题。
- 测试 39 全绿（新增：roughOutline 纯函数、词库外置后四维诊断、backfill 端到端含二次回补幂等）。

## 0.2.0 (2026-09-12) — 竞品劣势补齐（Node 半确定性工具，工具 10 → 16）

针对竞品对比里"缺本地导入 / 无润色 + diff / 无黄金三章诊断 / 无导出 / 无克隆 / 世界书薄 / 无术语表"的落地：

- **`novel_import`**：本地书籍导入。`lib/import.js` 纯函数按章节标题切分（无标题则整段一章），preview 只预览不落盘，import 建书 + 每章版本化落盘。
- **`novel_export`**：按版本顺序拼装整本 → `.md` / `.txt`，写 `书/导出/`，返回 stats。
- **`novel_diagnose`**：黄金三章确定性四维诊断（钩子/开场/冲突/信息灌输，0-100），延续"机审与模型审分离"。
- **`novel_polish`**：analyze 返回段落级病灶（AI 味/长段/灌输腔/章末钩子）；submit 把润色稿**走提案制**提交（确认才 apply 成新版本，永不覆盖旧稿）。
- **`novel_glossary`**：术语表 store，写前简报随上下文包注入，防专有名词乱译。
- **`novel_clone_project`**：整书克隆为模板（复制章节/大纲/人物/世界书/账本/伏笔，阶段重置 planning、提案清空）。
- **世界书**：新增 `import`（JSON 数组或 `关键词|内容` 行）/ `export`（JSON）动作。
- 工具 10 → 16；测试 37 全绿。

决策记录：**GUI 工作台暂缓**。宿主浏览器 client-half 需 tsdown 打包 + `window.__ModuleLoader__` 运行时 + 挂进 `@deepseek-ai/dsh-client-ui-*` 槽与命令依赖网，只能在真实 DSH web 装载验证；本仓库未接入该 build 工具链、测试环境也载不了浏览器半。并清掉了 package.json 里悬空的 `dsh.client` 声明（申明有 client-half 却无 `./client` export，真机可能误判）。方案（`dsh.client` 声明 + `./client` export + tsdown 打包 client.js）已调研清楚，待装进真机后另行实现，避免产出不可验证的死代码。

## 0.1.3 (2026-09-11)

七项整改（评审反馈落地）：

- **〔P0〕自动 id 碰撞修复**：伏笔/世界书的自动编号从「数组长度+1」改为「已用最大后缀+1」（`nextSuffixedId`）——手工删过条目后再新增，不再复用旧后缀把已存在条目静默覆盖。
- **中·1** `novel_write_chapter` 去 AI 味只扫一次（审计日志与返回值复用同一结果），消除重复 `scanAiFlavor`。
- **中·2** 上下文包预算把每个 section 的 `<<name>>` header 计入（消除约 3-5% 的预算虚高）。
- **中·3** 世界书新增 `update` 动作（按 id 合并 content/keywords/priority/always，id 不变）。
- **轻·4** 账本查询结果带出 `note`（`novel_ledger` 与 `novel_write_chapter.addedFacts` 的 schema+返回同步）。
- **轻·1** 新增 `novel_project set_stage`：显式阶段重置/纠正通道（对应 `gate.resetStage`，不走只前进的 `advanceStage`）。
- **轻·3** 新增 `novel_propose prune`：清理已终态（非 pending）提案的索引引用；宿主 fs 无删除原语，真文件留作冷归档。
- 测试 36 用例全绿（新增：id gap 安全 ×2、世界书 update/set_stage/prune 冒烟、账本 note）。

## 0.1.2 (2026-09-11)

复查回合的加固（A 方案）：

- `novel_write_chapter` 的 `facts_updates` 补章号护栏：`assertLedgerChapter` 现在同样拦住写章时的账本超前（force 场景也拦，且被拦不留请求文件）。
- 伏笔**改期**通道：`foreshadow_setup` 对同 id 且未回收的伏笔改为更新 plan/setup（而不抛"重复"），已回收的仍拒绝改期；审计区分 `foreshadow/setup` 与 `foreshadow/replan`。
- 文档样例修正：README 数据布局补上世界书的 `priority` 与伏笔的 `plan` 字段。
- 测试 32 用例全绿（新增：伏笔改期逻辑、写章账本超前被拒冒烟）。

## 0.1.1 (2026-09-11)

修复 + 吸收外部方案优点（SillyTavern 世界书 / Crucible Plants & Payoffs / story-long-write 数据化资产）。

修复：

- 上下文包预算：人物卡设总预算（2800 字符均摊）——卡多时不再挤掉账本/伏笔/世界书。
- `novel_audit` 前文循环对不完整索引记录的空指针；跳过缺失文件而非崩溃。
- 账本 chapter 护栏：`update` 章号不得超前于已写章节 +1（模型填错章号会污染账本历史）。
- 跨章重复检测窗口从固定 5 章改为可配置 `repetitionWindow`（默认 10）。
- 去 AI 味扫描对 <1500 字文本输出置信提示（密度指标统计噪声声明）。

新增：

- 世界书条目 `priority`（0-100）：预算不足时高优先级条目先入上下文（SillyTavern 插入序）。
- 世界书**递归激活**：已激活条目内容参与下一轮关键词扫描（限 2 轮，防 runaway）。
- 伏笔 `plan`（预计回收章号）：briefing 对**超期未回收**伏笔硬告警（Crucible 式 payoff 追踪）。
- `novel_project repair`：novel.json 索引与磁盘对账（清理失效文件引用、撤销无细纲批准）。

测试：30 用例全绿（新增 5 个：章号护栏 / 伏笔超期 / 人物卡预算 / 世界书递归+优先级 / repair 端到端）。

## 0.1.0 (2026-09-11)

首个可用版本。主线：**代码强制 > 提示词自觉**。

- 10 个 `novel_*` 工具：project / outline / character / worldbook / briefing /
  write_chapter / ledger / noai_scan / audit / propose。
- 四道写章门禁：细纲批准 → 细纲文件存在 → 机审（字数/重复/要素）→ 账本同章冲突检查。
- 事实账本与伏笔台账（历史保留、跨章推进放行、同章改值拒绝）。
- 写前简报上下文包（细纲→人物卡→账本→伏笔→世界书→上章结尾→摘要→大纲，预算裁剪）。
- 六维结构性去 AI 味扫描（模板句/库存词/情绪直写/句式模板/节奏方差/信息稀释），纯本地计算。
- 确定性章节审计（字数/对话占比/章末钩子/8 字 shingle 重复率/要素覆盖）。
- 修改提案制（propose → 用户确认 → apply 生成新版本；旧版永不覆盖）。
- agent 预设「小说锻炉」随包幂等部署（工具瘦身为创意写作定制）。
- 全动作 audit.jsonl 审计；全部书稿 io 走宿主 ctx.fs（沙箱/审批友好）。
- 测试：25 用例（纯逻辑 + 真实宿主 SDK + 假 fs 全链路）全绿。
