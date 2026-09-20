# 兼容矩阵 COMPATIBILITY

| dsh-novel-forge | 宿主 dsh（已验证） | 依据 |
| --- | --- | --- |
| 0.2.x – 0.13.x | 0.1.5-rc.1 | 本仓库开发与测试所用的宿主版本；插件只消费稳定面 |
| 0.13.1+（旁路引擎双路传输） | 同上 | web profile 走 `subagents`，直连 `ctx.llm` 保留（见下方依赖表） |

## 我们依赖的宿主面（升级宿主前逐条核对）

插件刻意把宿主面收敛到最稳定的一层，全部位于 Node 半（工具/提示注册），不触碰 client 内部 API：

| 依赖 | 来源 | 说明 |
| --- | --- | --- |
| `ctx.tools.register(tool)` | `@deepseek-ai/dsh-tools` | 工具注册 |
| `defineTool({name, description, parameters, output, isConcurrencySafe, timeoutMs, execute})` | `@deepseek-ai/dsh-tools` | 与 `dsh-files` 0.5.x 同款用法 |
| `ctx.fs.resolve / stat / readText / writeText` | `@deepseek-ai/dsh-fs` | 全部文件读写走宿主 fs（受沙箱与审批策略约束）；`writeText` 由本地后端自动创建父目录 |
| 宿主 fs **没有删除面** | `@deepseek-ai/dsh-fs` | **0.12.0 起明确依赖此事实**：FileSystem 服务只有 `resolve / stat / readText / streamText / listDir / writeText`。所以本插件所有「删除」都只能是**软删除**——`novel_library delete` 只移索引、原文留在磁盘（返回里必须说清），`novel_propose prune` 同理只清索引。将来宿主即使补上删除面，书库仍保留软删除语义（饲料删错了没法找回） |
| `ctx.fs.listDir` | `@deepseek-ai/dsh-fs` | 0.2.1 起依赖：`novel_clone_project` 经 `fsio.listNames` 扫描细纲目录（未批准细纲一并复制）。若宿主移除该面，克隆退化为"只复制已批准/已写章" |
| `ctx.systemPrompt.section({name, order, text})` | 宿主 system-prompt 服务 | 工作流纪律注入 |
| `exec.agent?.session?.header?.cwd` | 工具执行上下文 | 会话工作目录解析（`dsh-files` 同款） |
| `ctx.llm.stream(options)` | `@deepseek-ai/dsh-llm`（0.1.5-rc.2） | **0.11.0 起**：D1 旁路引擎直连传输（CLI profile 若暴露根级 llm）。**可选依赖**——引擎在**调用时**自检 `ctx.llm`，缺失则降级走 subagents（插件照常装载）。`purpose` 是封闭联合 `'compaction' \| 'session-title'`，**不要**用它做通道路由 |
| `ctx.subagents.start('spawn', {…})` | 宿主 subagents 服务 | **0.13.1 起是 web profile 的主传输**：润色/校对/打标/起草经子代理跑（`parent` 必填且必须 await，`result.output` 取文本，`stopReason` 分类重试性）。web 架构里 `ctx.llm` 在插件所在 fiber 解析不到——第三方插件无一例外走 subagents |
| `ctx.agents.get / ctx.agents.resume` | 宿主 agents 服务 | **0.13.2 起父会话锚定**：agent id == session id；`get` 只在会话 agent 驻留时有值，不驻留用 `resume({ resumeSessionId })` 按需物化（面板 REST 无执行边界）。inject 须同时声明 `subagents` 与 `agents`，缺一不可（cordis 只物化声明过的服务） |
| `ctx.agentDefaultModel` | `dsh-agent-default-model` | 旁路通道的默认路由来源（不给 `engine.channels.*` 覆盖时继承它） |
| `ctx.sandboxPolicy.resolve({session})` / `resolve({})` | `@deepseek-ai/dsh-sandbox-policy` | **0.13.7 起**：写盘第 5 参线程会话策略（与内置 fs 工具同参位），写界 = 会话工作区。**可选降级**：服务缺失 / resolve 抛错 → 第 5 参缺省，宿主自身兜底 = 旧行为。`resolve` 只认 `{session, mode}`、无显式 root 入口——**REST 面无 exec**，且 live 会话在册窗口有限（见下行）+ 面板写是用户动作、不该继承会话的 model 侧 mode 覆盖，故 REST 面保持 `resolve({})` 请求形状、由 fsio **用绑定的书根覆写 `workspaceRoot`**（mode 仍归 resolver；不伪造会话壳——`sessionProjections.stateOf` 对未知会话抛错）。宿主拒绝错误是 `FsError` 带 `code: 'FS_SANDBOX_DENIED'`（dsh-fs-sandbox L157/164），插件识别优先匹配 code、文案包含只作旧宿主兜底 |
| `ctx.sessions`（**宿主/浏览器两套同名服务，别混谈**） | 宿主 = `@deepseek-ai/dsh-session`（base 层装载）；浏览器 = `dsh-api-session-controller/client.js` | **dsh 0.1.5-rc.2 源码核过**。宿主半：SessionStore 注册名 `sessions`、`list()` 可调（dsh-session L1311-1315；`provide("sessions")` 只在 client 半出现，grep 该模式会漏掉 Service 基类注册——别再犯），但 store 是**内存态、由创建 fiber 持有**（L1305-1315 注释）→ 会话只在 **agent 轮运行期间**在册，面板空闲期 REST 读到≈空。浏览器半：网关 RemoteSnapshot（`getSnapshot()+subscribe()`），面板 JS 读会话 id 走它（invariant 10），服务端别碰。因此面板扫书根的 live 源 = **agent 轮运行期的即时源 + 空闲期≈空**——空闲期新工作区进场靠持久源内容签名失效（projcache 目录态落盘），live 每次现算零成本 |
| `node:sqlite`（`DatabaseSync` + FTS5） | Node 运行时自带（22.19+ / 24+） | **0.11.0 起**：G1 检索索引。**非宿主依赖，是运行时依赖**——不可用时检索自动退化为子串匹配，其余功能不受影响。不引入 `better-sqlite3` |
| `@deepseek-ai/schemastery` | 宿主自带 | Config schema |
| 通道 maxTokens 语义 | 引擎层约定 | `engine.channels.<通道>.maxTokens` **默认 0＝不传**，继承宿主按模型校准的上限；显式设小会被推理模型（思考+整章重写）烧穿输出预算（`stopReason=max-tokens` → `OUTPUT_TRUNCATED`，不重试）。长文通道（polish/proofread/draft）`timeoutMs` 默认 600000，面板请求超时对齐 |
| 宿主主题 CSS 变量 `--dsw-alias-*` | `@deepseek-ai/dsh-client-ui-theme` | **0.13.0 起明确依赖**：右侧栏面板的样式全部走宿主主题变量（`link` / `state-*-primary` / `bg-layer-*` / `border-l*` / `button-primary-fill` + `label-primary-foreground` 等）。**只用真名**——0.13.0 之前用的 `accent-strong` / `accent-soft` / `label-danger` / `bg-primary` 四个名字**宿主里根本不存在**，`var()` 全落到写死的深色回退值，跟随主题从未生效。不确定时先核该包的导出表；软底/软描边用 `color-mix(in srgb, <语义色> N%, transparent)` 可自动跟随浅/深主题 |

## 已知断裂史（改这些行为时务必 bump 主版本）

- 宿主 0.1.2-rc.1 → 0.1.3：移除 `@deepseek-ai/dsh-client-runtime`、客户端 API 表面断裂（社区插件 dsh-novel-writing / dsh-novel-solo 均发布过紧急兼容版）。本插件 **不 import 任何 client 半模块**，理论上面不受影响，但升级后仍请先在隔离 profile 冒烟。
- `output.schema` 与 execute 返回值必须逐字段一致（`additionalProperties: false`），漏声明字段会得到 INVALID_TOOL_OUTPUT。
