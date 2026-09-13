# AGENTS.md — dsh-novel-forge 开发约定

## 项目定位

DSH（DeepSeek Harness）小说创作插件。设计主线：**代码强制 > 提示词自觉**。
凡是"靠模型自觉"的约束都会失效；一致性、门禁、审计必须是工具层/数据层的硬约束。

## 架构不变量（改代码前先读）

1. **所有书稿文件读写必须走 `ctx.fs`**（lib/fsio.js 收口），禁止 `node:fs` 直接碰工作区——
   只有 preset 部署（写 `~/.dsh/.agent-presets/`，工作区之外的基础设施）允许用 node:fs。
2. **纯逻辑与 io 分离**：`lib/{noai,ledger,gate,versioning,audit,contextpack}.js` 必须保持
   纯函数（输入输出皆数据），便于 `node --test` 直测；io 只发生在 `lib/fsio.js` 与工具层。
3. **`output.schema` 与 execute 返回值逐字段一致**（additionalProperties:false），
   新增返回字段必须同步 schema，否则 INVALID_TOOL_OUTPUT。
4. `@deepseek-ai/*` 一律 peerDependencies，绝不放 dependencies（双闭包 boot 崩溃）。
5. 工具名前缀 `novel_`；配置项在 apply() 里 fail-fast 校验。
6. 数据文件：机器状态一律 JSON（novel.json / facts.json / 伏笔.json / .novel/*）；
   人类/模型文档一律 Markdown。不引入 YAML 依赖。
7. **客户端源码与产物分离**：浏览器半源码在 `src/client/`（ESM），**产物** `lib/client.js`
   由 `npm run build`（esbuild）生成 —— **禁止手改产物**（下次构建即覆盖；产物头部有 generated
   标记，测试会检查它）。dsh **只加载产物**，改源码不构建等于没改。
   流程：`npm run build` → 重启 DSH web（bundle 在进程启动时快照）→ 浏览器硬刷新。
   构建脚本会校验源码 `PLUGIN_VERSION` 与 package.json 一致，不一致直接失败（防发行漂移）。
8. **浏览器半只能向宿主模块表取包**（`react` / `react/jsx-runtime` / `react-dom` /
   `react-dom/client` / `cordis`），统一经 `src/client/react.js` 出口。
   ⚠️ **`createRoot` 只在 `react-dom/client` 里，`react` 核心包没有** —— 0.4.x 自建 root 时
   写 `react.createRoot(...)` 真机必 TypeError，症状是「点一次没反应、再点一次整屏空白」。
   0.5.0 起面板交给右侧栏 slot 框架渲染（**不自己 createRoot**），这条坑从根上消失；
   但若哪天又要自建 root，先把 `react.js` 的历史注释读完。
   新增 external 依赖前先确认它在宿主模块表里（否则 bundle 一加载就炸）。
9. **入口只用右侧栏一条路线**（0.5.0 定）：走官方三步契约 ——
   ① `ctx.sidebarRightTabs.register(definition)`、② `ctx.slots.register({ name: 'sidebar.right.pane.tab', key: <id>, inject })`、
   ③ `ctx.sidebarRight.openTab(<kind>)`。**缺第③步 tab 永远不出现且不报错**。
   左侧栏 DOM 注入路线已删除，不得两条路线并存（`data-dsh-novel-forge-entry` /
   `sidebarCol` / `MutationObserver` 在产物里出现即为回归，测试有反向断言）。
   `openTab` 在 seat 挂载前会抛错 ⇒ 必须延迟 + 重试（见 `src/client/forge-tab.js`）。
10. **项目跟会话走**：`novel.json.sessions` 是「拥有这本书的会话」集合，判据一律走
   `lib/store.js` 的 `bookInSession` / `isUnclaimed` / `addBookSession`（服务端与面板共用）。
   创建类工具（init / import / clone）写创建会话；`requireBook` 负责补录当前会话
   （`rememberSession`，静默失败不阻断写作）。**「本会话有项目才显示 tab」**由
   `src/client/session-watch.js` 负责：会话 id 只从 `ctx.sessions.list` 读，不猜 URL / 不抠 DOM。
11. **UI 失败必须可见**：面板在右侧栏里，渲染失败由错误边界（`ForgeBoundary`）就地给出报错文案，
   自动打开失败必须留 `console.warn` + guide 页手动通道；**禁止静默**。

## 开发与测试

```bash
npm run setup-dev   # 把宿主 checkout 的 @deepseek-ai/* 真包 symlink 进本地 node_modules（仅本地开发）
npm run build       # src/client/ → lib/client.js（改客户端源码后必须跑；npm test 的 pretest 会自动跑）
npm test            # node --test test/（纯逻辑单测 + 假 fs 冒烟 + headless 行为测试）
```

**客户端行为测试要真跑，不要 grep 源码**：`test/client.test.mjs` + `test/helpers/dom.mjs`
提供 headless 装载体 —— 真跑 `apply()`，断言**实际注册了什么契约（三步）、实际打了哪些请求**
（会话过滤）、以及 `openTab` 的时序。字符串断言（`code.includes('xxx')`）守不住真 bug ——
0.4.0 的入口消失 bug 就是一路绿灯过去的。
（同理也别拿文本断言当防线：注释里提到某个旧写法会被误判成"代码里还有它"。
例外：`test/client.test.mjs` 末尾那条「左侧栏痕迹必须退场」的反向断言是有意为之的架构护栏。）

**面板组件渲染不出来（node 里没有 React），就测控制器**：`src/client/panel.js` 的
`createForgeController` 是纯闭包，通过 `lib/client.js` 的 `exports.__internals` 暴露给测试 ——
会话过滤、创建带戳、认领 body、事件代理全都能直测。新增面板逻辑时保持这条出口可用。

**替身必须镜像宿主真机，不是镜像我们自己的实现**（这条付过两次学费）：
`test/helpers/dom.mjs` 的模块表故意**不给** `react.createRoot`（真机就没有），
`cordis` 的 `ctx.effect` 按官方语义复刻（回调**立刻执行**、返回值登记为清理函数）。
替身一旦比真机宽松，就会把假前提固化成绿灯：0.4.2 前 `host.home` 被当成工作区根、
0.4.3 前 `react` 被塞了 `createRoot` —— 都是 80/80 全绿、真机 100% 失败的同一类事故。
**改替身前先问：真机上这里到底是什么行为？**

宿主 SDK 路径来自本机 DSH checkout（scripts/setup-dev-links.mjs 内含路径），不要提交 node_modules。

## 数据落盘（一本书 = 一个目录，位于会话工作区）

见 README.md「数据布局」。机器可读状态只有 novel.json / facts.json / 伏笔.json /
.novel/{audit.jsonl,proposals/}；其余是 Markdown 文档。

`novel.json.sessions` 是**会话归属集**（哪些会话拥有这本书）—— 面板按它过滤项目列表，
工具层创建时写入、`requireBook` 补录。它不是书籍内容，改它不需要走 `saveBook` 的 updatedAt 语义。
