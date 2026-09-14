# dsh-novel-forge · 小说锻炉

DeepSeek Harness（DSH）小说创作插件。设计主线只有一条：

> **代码强制 > 提示词自觉。** 凡是"靠模型自觉"的约束都会失效——
> 一致性、门禁、审计必须是工具层/数据层的硬约束。

AI 长篇写作的通病不是玄学，每一个都有对应的工程解法。本插件把其中"有明确对错"的部分做进代码：

| AI 写作通病 | 本插件的硬约束 | 落点 |
| --- | --- | --- |
| 设定/战力崩坏 | 事实账本：同章改值=冲突拒绝；世界书关键词自动注入 | `novel_ledger` / `novel_worldbook` |
| 模型"看不见前文" | 写前简报按预算组装上下文包（细纲→人物卡→账本→伏笔→世界书→上章结尾） | `novel_briefing` |
| 口头跳阶段 | 阶段门禁：细纲未批准，`novel_write_chapter` 直接拒绝 | `novel_outline approve` |
| 跨章复读/水文 | 8 字 shingle 与前文重复检测，超阈值拒绝保存 | `novel_write_chapter` 机审 |
| 章-末-无-钩-子 | 章末钩子启发式（问句/悬念/省略/感叹），缺了给警告 | `novel_audit` |
| AI 味 | 六维结构性扫描：模板句/库存词密度/情绪直写/句式模板/段落节奏方差/信息稀释（纯本地，零模型费用） | `novel_noai_scan` |
| 偷偷覆盖正文 | 提案制：修订走提案→用户确认→生成新版本，旧版永不覆盖 | `novel_propose` |
| 审稿放水 | 机审与模型审分离：审计产出确定性数字，模型审稿必须引用证据 | `novel_audit` |

人物 OOC 的缓解（语言基因卡自动注入）在 `novel_character` + `novel_briefing`；
"立意与审美属于人"——插件不生产立意，它把 `logline` 放进每次写章的上下文包里提醒双方。

## 安装

```bash
# 本地开发（符号链接，改码即生效）
dsh plugin --profile web add link:/path/to/dsh-novel-forge

# 发布后
dsh plugin --profile web add npm:dsh-novel-forge
dsh plugin --profile web add github:<owner>/dsh-novel-forge
```

安装后重启 DSH web 即生效：17 个 `novel_*` 工具进入工具目录，agent 预设「小说锻炉」
自动部署到 `~/.dsh/.agent-presets/novel-forge/`（已存在则跳过，永不覆盖；
`DSH_NOVEL_FORGE_REDEPLOY=1` 强制重铺，`DSH_NOVEL_FORGE_SKIP_DEPLOY=1` 关闭）。

宿主版本要求与依赖面清单见 [COMPATIBILITY.md](./COMPATIBILITY.md)。

## 17 个工具

| 工具 | 职责 | 硬约束 |
| --- | --- | --- |
| `novel_project` | init / status / set_stage / repair 书目工程 | 防重复创建；阶段可显式重置；repair 索引-磁盘对账 |
| `novel_outline` | 全书大纲 / 第N章细纲 / **批准** | 写章门禁的钥匙 |
| `novel_character` | 人物卡（含语言基因卡） | 写章自动注入 |
| `novel_worldbook` | 世界书条目（add/update/list/remove + import/export） | 设定只认这里；update 保 id |
| `novel_briefing` | 写前上下文包（预算裁剪 + 术语表 + **原著锚段**） | 一致性供给侧 |
| `novel_write_chapter` | 写章落盘 | 门禁→机审→账本→版本化，四道全过才保存 |
| `novel_ledger` | 事实账本（含 note）+ 伏笔埋/收/改期 | 同章改值拒绝；章号超前拒绝；超期伏笔告警 |
| `novel_noai_scan` | 六维去 AI 味扫描 | 纯本地零费用 |
| `novel_audit` | 确定性章节审计 | 机审证据 |
| `novel_style` | 文笔六维基线（μ±σ 带）+ **氛围光谱 12 轴**（热血/悬疑/惊悚/压抑/甜宠/温情/悲情/诙谐/爽感/神秘/肃杀/苍凉）：build 建基线 / check 对照（含主导氛围漂移） | 纯本地零费用；只报数不贴标签 |
| `novel_propose` | 提案 / 列表 / 应用 / 清理 | 旧版永不覆盖；prune 清已终态索引 |
| `novel_import` | 本地书籍导入（preview/import/**backfill 门禁回补**） | 纯函数切分章节；建书+版本化落盘；回补粗纲让导入书回到门禁体系 |
| `novel_export` | 导出整本（md/txt + stats） | 按版本顺序拼装，写 `导出/` |
| `novel_diagnose` | 黄金三章四维诊断（钩子/开场/冲突/灌输） | 确定性数字，机审与模型审分离 |
| `novel_polish` | 段落级病灶定位 + 润色提案提交 | 润色也走提案制，永不覆盖旧稿 |
| `novel_glossary` | 术语表（add/remove/list） | 随上下文包注入，防专有名词乱译 |
| `novel_clone_project` | 整书克隆为模板 | 阶段重置规划、提案清空，旧书不动 |

参数刻意只用了标量（字符串/整数/布尔），结构化数据用分隔行表达
（如账本更新 `实体|键|值[|备注]`）——对量化小模型也友好。

## 数据布局（一本书 = 工作区里的一个目录）

```
我的书/
├─ novel.json            # 机器状态：阶段/批准/章节索引/cast/提案索引
├─ 大纲/全书大纲.md
├─ 大纲/细纲/第3章.md
├─ 人物/林晚.md           # 人物卡（Markdown，briefing 原文注入）
├─ 设定/世界书.json        # [{id, keywords[], content, always, priority}]
├─ 设定/术语表.json        # [{term, definition}]
├─ 正文/第3章-雨夜来客-v2.md   # 版本化，永不覆盖
├─ 账本/facts.json        # [{entity, key, value, chapter, note}]
├─ 账本/伏笔.json          # [{id, setup, chapter, plan, payoffChapter}]
└─ .novel/
   ├─ audit.jsonl         # 全动作审计（谁在哪章做了什么、何时被拒）
   └─ proposals/P3-xxx.json
```

全部在会话工作区内、走宿主 `ctx.fs`（受沙箱与审批策略约束），可直接进 Git / Obsidian。

## 典型会话流

```
novel_project init → novel_outline save_book → novel_character save（建语言基因卡）
→ novel_worldbook add（固化核心设定）→ 循环：
    novel_outline save_chapter + approve
    → novel_briefing（拿上下文包）
    → 按细纲成稿 → novel_write_chapter（门禁/机审/账本/落盘）
    → novel_noai_scan + novel_audit（证据）→ 你自己（或让模型引用证据）审稿
    → 修订：novel_propose propose → 用户确认 → apply（生成 v2）
```

## 配置（cordis.patch.yml）

| 项 | 默认 | 说明 |
| --- | --- | --- |
| minChapterChars | 500 | 单章下限（机审拒绝线） |
| maxChapterChars | 12000 | 单章上限 |
| contextBudgetChars | 6000 | 写前简报上下文包预算 |
| scanTopK | 8 | 扫描报告每维最多列出的问题数 |
| repetitionWindow | 10 | 跨章重复检测的滑动窗口（与前 N 章比对） |
| skipPresetDeploy | false | 跳过预设部署 |

## MCP 双通道（宿主外复用）

同一套 novel_* 工具（门禁/账本/审计/基线全在工具层）也可通过 stdio MCP 暴露给
Claude Desktop / Cursor 等任意 MCP 客户端——工作区根取 `NOVEL_FORGE_ROOT`
（缺省为进程 cwd），一本小说 = 工作区里的一个目录：

```json
{
  "mcpServers": {
    "novel-forge": {
      "command": "node",
      "args": ["/path/to/dsh-novel-forge/mcp/server.mjs"],
      "env": { "NOVEL_FORGE_ROOT": "/你的小说工作区" }
    }
  }
}
```

零依赖实现（原生 JSON-RPC 2.0 over stdio）；宿主外的 fs 后端带同样的
containment 与版本守卫语义。锚段写作与氛围光谱均为纯本地计算。

## 右侧栏「锻炉」面板（浏览器半）

浏览器半的源码在 `src/client/`（ESM，按职责拆分），**发布物**是构建产物 `lib/client.js`
（经典脚本 + `__ModuleLoader__.load({ id, factory })`）。dsh 只读 `exports["./client"]`，
所以**改完 `src/client/` 必须 `npm run build`**（`npm test` 会自动先跑构建）。

### 入口：右侧栏 tab 的「三步契约」

0.5.0 起入口回到**官方右侧栏**，不再往左侧栏注入 DOM：

| 步 | API | 缺了会怎样 |
| --- | --- | --- |
| ① 声明类型 | `ctx.sidebarRightTabs.register({ id, kind, title, guide })` | 没有类型可引用 |
| ② 注册内容 | `ctx.slots.register({ name: 'sidebar.right.pane.tab', key: <id> }, Panel)` | 有格子、内容空白 |
| ③ 打开 tab | `ctx.sidebarRight.openTab(<kind>)` | **前两步全白做 —— 一格都不多，也不报任何错** |

`openTab` 在 seat 挂载前调用会直接抛错（引擎有意设计），所以走「延迟 400ms + 每 250ms 重试、
窗口 30 秒」；`guide` 里留了入口胶囊 —— 自动打开失败或被用户关掉时，从右侧栏 guide 页手动进。

### 显示时机：本会话有项目才出现

- 当前会话 id 从 `ctx.sessions.list`（`ObservableSnapshot<SessionListState>.current`）读，不猜 URL、不抠 DOM；
- **本会话有项目才自动打开** tab —— 没写过小说的会话不打扰；
- 书是会话里的 AI 调工具建的，客户端收不到通知 → 会话切换时查一次 + 未打开时每 8 秒轮询一次；
  一旦为某个会话开过就不再重复（关掉是用户的自由，不跟用户抢）。

### 项目跟会话走

`novel.json.sessions` 记录「拥有这本书的会话」：`novel_project init` / `novel_import` /
`novel_clone_project` 创建时写下创建会话；其它工具碰到这本书时自动补录当前会话（旧书因此自动认领）。
面板的列表/创建/认领请求一律带 `session`，服务端按它过滤：

- `GET /projects?session=<id>` —— 本会话的书（面板列表）
- `GET /projects?scope=unclaimed` —— 0.5.0 之前建的书（无会话戳），面板底部给「认领」入口
- `POST /projects/claim` —— 把未归属的书认领到本会话

### 宿主模块表契约（踩过的大坑）

dsh 的 client 运行时**播种**一批模块，插件只能从这里取（构建时一律 `external`，不重复打包）：

| 模块 | 说明 |
| --- | --- |
| `react` | `createElement` / `Component` / `Fragment` / hooks —— **没有 `createRoot`** |
| `react-dom/client` | `createRoot` 的唯一来源（0.4.x 自建 root 时踩过，见下） |
| `cordis` | 上下文与 `ctx.effect`（回调**立刻执行**，其返回值登记为清理函数） |

0.4.x 的面板是**自建 root 的全屏抽屉**，那时把 `createRoot` 取成了 `react.createRoot`（`undefined`），
真机症状极具迷惑性：**点一次没反应、再点一次整屏空白** —— 首次抛错、容器留在 `display:none`；
第二次只切了 `display`，露出空的 fixed 全屏层。现在面板交给右侧栏 slot 框架渲染
（我们只返回 element，不自己 createRoot），这条坑从根上消失；历史留在这儿，别再走回去。

**数据通道**：面板走本插件自己的 REST `/api/novel-forge/*`，每个请求带 `x-dsh-novel-forge`
fence 头（服务端缺头即 403）。视图只读 `state`，交互统一走 `data-action` + 容器级原生点击代理
（宿主里 React 合成事件不可靠）。

**改了 `lib/client.js` 必须重启 DSH web**（client bundle 在进程启动时快照、已公告响应不可变），
随后浏览器硬刷新。排障看 console 的 `[novel-forge]` 前缀日志（`client apply v…` / `已打开右侧栏 tab`）；
自动打开没生效时可从右侧栏 guide 页进，或在 console 敲 `window.__novelForge.open()`。

## 开发与测试

```bash
npm run setup-dev   # 把 DSH checkout 的宿主 SDK 真包 symlink 进本地 node_modules
npm run build       # src/client/ → lib/client.js（改客户端源码后必须跑；npm test 会自动跑）
npm test            # node --test：94 个用例（纯逻辑单测 + 假 fs 全链路冒烟 + 真校验器输出契约 + headless 行为测试）
node scripts/demo.mjs   # 端到端演示：init→细纲→写章→账本→扫描→提案 全流程
```

约定见 [AGENTS.md](./AGENTS.md)：纯逻辑与 io 分离、output.schema 与返回值逐字段一致、
`@deepseek-ai/*` 一律 peerDependencies、机器状态 JSON / 人类文档 Markdown。

## v0.1 已知边界

- 去 AI 味词库与阈值是**启发式**，只能抓显性病，不承诺"根治"——结构性指标（节奏方差/信息稀释）是它比纯词库强的地方。
- 审稿的"模型审"部分不内置（工具不调模型）：`novel_audit` 产出证据，审稿在会话里进行；独立审稿模型路由留给 v0.2。
- **GUI 工作台已可用**（0.6.0）：右侧栏「锻炉」tab —— 常驻独立入口（0.5.1 起不再门控），
  项目列表按**会话**过滤（项目跟会话走），0.5.0 之前建的老书可从面板底部「认领」到当前会话。
  项目详情含两个标签：**📋 基本信息**（读章 · 保存 · 导出 · 诊断）与
  **🎧 章节听书**（目录 + 语音连播：从任意章开始听、暂停/继续/停止、读完自动接下一章；
  Web Speech 合成，正文切块防 Chrome 长文本停摆）。写操作走 `/api/novel-forge` REST。
  **「一键写章 / 润色 / 诊断」需要模型参与**，面板只给引导 —— 真动作在会话里由 `novel_*` 工具完成。
- 跨章重复检测是滑动窗口（默认前 10 章，`repetitionWindow` 可调）——超出窗口的复读抓不到；世界书递归激活限 2 轮。
