# 锻炉全屏抽屉 UI 设计方案

> ⚠️ **已作废（历史存档，勿照此实现）。** 本文的入口方案（左侧栏 DOM 注入 + 自建 `React root`
> 的全屏抽屉）**在 0.5.0 被推翻**：入口回到官方右侧栏 tab，面板交给 slot 框架渲染、插件只返回
> element。原因见 README「宿主模块表契约（踩过的大坑）」——自建 root 时把 `createRoot` 取成
> `react.createRoot`（`undefined`），真机症状是「点一次没反应、再点一次整屏空白」。
> 当前界面（三层设计系统 + 视图分工）见 README「右侧栏「锻炉」面板」一节，源码在 `src/client/`。
> **可参考的只剩「写操作走 REST」这一条架构决策**，它是对的、并已落地。

## 目标

把 novel-forge 从"只读仪表盘"升级为"完整工作台"，对齐大胖鱼的交互体验：
- 一键写章（自动调用 briefing + write_chapter）
- 一键润色（调用 novel_polish）
- 世界书 CRUD（调用 novel_worldbook）
- 诊断面板（调用 novel_diagnose）
- 设置卡（启用/隐藏/数据目录）

## 架构决策

### 写操作通道：REST API

当前插件没有 HTTP 服务端。浏览器无法直接调用 cordis 工具。

**方案：新增服务端 REST API 处理器**（对齐大胖鱼的 `/api/novel-writer/*` 模式）

DSH 宿主为插件提供 HTTP 路由挂载点。插件在 `apply()` 中注册路由，浏览器通过 `fetch()` 调用。

```
浏览器 (fetch) → 宿主 HTTP 服务 → 插件路由处理器 → 工具函数 → ctx.fs
```

### UI 入口：左侧栏按钮 + 全屏抽屉

- 左侧栏 DOM 注入入口按钮（MutationObserver 自愈，对齐大胖鱼）
- 点击打开全屏抽屉（React root，原生事件代理）
- 抽屉内：项目列表 / 项目详情 / 世界书 / 设置

### 事件模型：原生事件代理

大胖鱼实测 React 合成事件在宿主环境中失效。采用相同方案：
- React 只做纯渲染（props 传入，无 hooks、无合成事件）
- 交互走 `data-action` 属性 + 外层容器原生 click 代理

## 文件结构（0.4.2 落地版）

初版设计把源码放在 `lib/client/`，但那里与产物 `lib/client.js` **同名**，极易混淆
（实际也确实分叉过：`lib/client/sidebar-entry.js` 里的自愈是修 bug 之前的旧语义）。
现改为 `src/` 放源码、`lib/` 只放产物与 node 半侧 —— 也是 dsh 生态惯例。

```
src/client/                     # ESM 源码（唯一真相）
├── index.js                    # 入口：exports.inject / exports.apply + PLUGIN_VERSION
├── sidebar-entry.js            # 左侧栏入口（DOM 注入 + 双观察自愈）
├── drawer.js                   # 抽屉主框架（状态 / 原生事件代理 / REST 调用）
├── views/
│   ├── project-list.js         # 项目列表视图
│   ├── project-detail.js       # 项目详情（读章/保存/导出/诊断）
│   ├── lorebook.js             # 世界书管理
│   └── settings.js             # 设置卡
├── api.js                      # REST 封装（fence header）
├── state.js                    # 抽屉状态
└── styles.js                   # 全部内联样式

scripts/build-client.mjs        # esbuild：src/client/ → lib/client.js

lib/
├── client.js                   # ⚠️ 构建产物（勿手改；头部带 generated 标记）
├── server-api.js               # 服务端 REST API 处理器
├── index.js                    # 注册 HTTP 路由
└── ...
```

**构建**：`npm run build` → 产出经典脚本 + `__ModuleLoader__` factory；
`react` 走 external 由宿主平台表提供。`npm test` 的 `pretest` 会自动构建。

## REST API 端点设计

基础路径：`/api/novel-forge`

| 方法 | 路径 | 用途 | 对应工具 |
|------|------|------|----------|
| GET | `/projects` | 列出所有书 | novel_project status |
| POST | `/projects` | 创建新书 | novel_project init |
| GET | `/projects/:id` | 书详情 | novel_project status |
| DELETE | `/projects/:id` | 删除书 | 文件系统操作 |
| GET | `/projects/:id/chapters/:no` | 读章节正文 | ctx.fs.readText |
| POST | `/projects/:id/chapters/:no/write` | 一键写章 | novel_briefing + novel_write_chapter |
| POST | `/projects/:id/chapters/:no/polish` | 一键润色 | novel_polish |
| GET | `/projects/:id/diagnose/:chapters` | 诊断 | novel_diagnose |
| GET | `/projects/:id/export` | 导出 | novel_export |
| GET | `/lorebook` | 世界书列表 | novel_worldbook list |
| POST | `/lorebook` | 新建条目 | novel_worldbook add |
| PUT | `/lorebook/:id` | 更新条目 | novel_worldbook update |
| DELETE | `/lorebook/:id` | 删除条目 | novel_worldbook remove |
| POST | `/lorebook/autogen` | AI 生成设定 | novel_worldbook (AI 调用) |
| GET | `/settings` | 读设置 | 命名空间读取 |
| PUT | `/settings` | 写设置 | 命名空间写入 |

## 抽屉 UI 视图流

```
┌─────────────────────────────────────────────┐
│  🔨 锻炉                        [展开] [×]  │
├─────────────────────────────────────────────┤
│                                             │
│  ┌─ 项目列表 ─────────────────────────────┐ │
│  │ 书名 · 阶段 · 章数 · 字数     [世界书] │ │
│  │ 书名 · 阶段 · 章数 · 字数     [世界书] │ │
│  │                                        │ │
│  │ [书名输入] [题材▼] [创建]              │ │
│  │ [导入示例] [导入本地]       [世界书]    │ │
│  └────────────────────────────────────────┘ │
│                                             │
│  ┌─ 项目详情（点击书名后）────────────────┐ │
│  │ ← 返回                                │ │
│  │ 《书名》 · 阶段 · N章 · M字            │ │
│  │                                        │ │
│  │ 章节 [▼ 1] [一键写章] [一键润色]      │ │
│  │                                        │ │
│  │ ┌─ 编辑区 ──────────────────────────┐ │ │
│  │ │ textarea (章节正文)                │ │ │
│  │ └───────────────────────────────────┘ │ │
│  │                                        │ │
│  │ [刷新] [导出txt] [本书世界书] [删除]  │ │
│  │                                        │ │
│  │ ┌─ 结构诊断 ────────────────────────┐ │ │
│  │ │ [诊断本章]  得分 85                │ │ │
│  │ │ · 问题1 · 问题2                   │ │ │
│  │ └───────────────────────────────────┘ │ │
│  └────────────────────────────────────────┘ │
│                                             │
│  ┌─ 世界书 ───────────────────────────────┐ │
│  │ ← 项目   世界书（设定注入）            │ │
│  │ [栏目▼] [AI生成] [+新建] [导出酒馆]   │ │
│  │                                        │ │
│  │ 条目名 · 常驻 · P50                   │ │
│  │ 关键词：xxx, yyy                       │ │
│  │ [编辑] [停用] [删除]                   │ │
│  └────────────────────────────────────────┘ │
└─────────────────────────────────────────────┘
```

## 实现步骤（按依赖顺序）

### Step 1: 服务端 REST API（`lib/server-api.js`）
- 注册 HTTP 路由处理器
- 每个端点对应一个工具函数调用
- 错误处理：统一 `{ ok, value, error }` 响应格式
- 安全：fence header 校验（防止跨域调用）

### Step 2: 左侧栏入口（`lib/client/sidebar-entry.js`）
- DOM 注入 + MutationObserver 自愈
- 点击打开/关闭抽屉
- 支持隐藏开关（localStorage）

### Step 3: 抽屉主框架（`lib/client/drawer.js`）
- React root 创建 + 原生事件代理
- 视图路由：项目列表 / 项目详情 / 世界书 / 设置
- 全局头部（标题 + 展开/收起 + 关闭）

### Step 4: 项目列表（`lib/client/project-list.js`）
- 书籍卡片列表（标题/阶段/章数/字数）
- 创建表单（书名 + 题材下拉）
- 导入按钮（示例/本地文件）

### Step 5: 项目详情（`lib/client/project-detail.js`）
- 章节选择器
- 一键写章按钮（调用 `/write` 端点）
- 一键润色按钮（调用 `/polish` 端点）
- 文本编辑区（textarea + 撤销栈）
- 导出/删除按钮

### Step 6: 世界书管理（`lib/client/lorebook.js`）
- 条目列表（按书分栏）
- 新建/编辑表单
- 启用/停用/删除
- AI 一键生成设定

### Step 7: 设置卡（`lib/client/settings.js`）
- 启用开关
- 数据目录
- 隐藏侧边栏入口

### Step 8: 整合到 client.js ✅ 已完成（0.4.2）

- ~~替换原 ForgePanel 为 drawer 入口~~ → 入口最终改为**左侧栏 DOM 注入**（0.4.0）
- ~~更新 inject 数组~~ → 客户端只用 `slots`；0.4.2 移除了 `dsh.client.inject` 里
  `@deepseek-ai/dsh-client-ui-sidebar-right` 的遗留声明（DOM 注入不需要该包）
- ~~保持 `__internals` 测试契约~~ → v0.4 重写后已无 `__internals`；现契约是
  `exports.inject` / `exports.apply`，由 `test/client.test.mjs` + `test/helpers/dom.mjs`
  的**仿真 DOM 真跑 `apply()`** 守住（不是字符串断言）
- **落地方式（0.4.2 补完）**：源码进 `src/client/`，`npm run build`（esbuild）产出 `lib/client.js`。
  dsh 只加载产物 —— 所以这步是**构建**，不是手工整合。

## 约束

1. **只依赖 react**（平台种子词，不引入新包）
2. **所有样式内联**（CSS custom properties 对齐宿主设计系统）
3. **原生事件代理**（React 合成事件在宿主环境失效）
4. **__internals 导出**（headless 测试可覆盖）
5. **output.schema 一致**（新增返回字段必须同步 schema）
6. **fence header 校验**（REST API 安全门禁）

## 测试策略

- 单元测试：`test/logic.test.mjs` 新增 REST API 路由逻辑测试
- 客户端测试：`test/client.test.mjs` 更新抽屉注册契约
- 端到端：`test/smoke.test.mjs` 新增 REST API 端点冒烟
- 真机验证：重启 DSH web 后检查抽屉 UI 可用性
