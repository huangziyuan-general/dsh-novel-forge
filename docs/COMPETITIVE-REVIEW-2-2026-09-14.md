# 竞品对比报告（第二批）· 2026-09-14

对三个 dsh 小说插件的代码级解剖：`dsh-tool-writing`、`deepseek-harness-novel-studio`、`@ethanyoq/dsh-ai-novel-writer`。
与第一批（大肥鱼 / 多核协同 / peterwangze）及本插件（dsh-novel-forge）合并成七方对照。

## 0. 数据来源

| 项 | 值 |
|---|---|
| 抓取方式 | 只读克隆到 `/tmp/novel-plugin-review2/`（**未安装进 dsh**） |
| 索引来源 | `/tmp/novel-plugin-review/plugins.json`（awesome-dsh-plugin 市场快照，2500+ 条） |
| 仓库 | `x2802490130-prog/dsh-tool-writing`、`qinpeizhan77/deepseek-harness-novel-studio`、`EthanYoQ/AI-Novel-Writer`(子目录 `plugins/dsh-ai-novel-writer`) |
| 克隆时间 | 2026-09-14 14:40 |

## 1. 定位速览

| | dsh-tool-writing | novel-studio | dsh-ai-novel-writer | **本插件 forge** |
|---|---|---|---|---|
| 作者 | x2802490130-prog | qinpeizhan77 | EthanYoQ | 仙尊 |
| 版本 | 0.8.1 | 3.4.2-beta.3 | 0.1.0 | 0.6.6 |
| 市场分类 | tools | ui | workflow | ui |
| stars / 下载 | 9 / 2592 | 3 / 531 | **824**（仓库级） / 1002 | — |
| 一句话 | 48 工具的重装备写文引擎 | 一致性校验驱动的小说工作台 | 审批门极简作者链路 | 会话归属的右侧栏锻炉 |

**三种路线分野**：tw = **工具密度**（什么都做成工具）；studio = **数据校验**（GUI + 状态机 + 代码判定）；ethan = **工具面收窄**（只留 3 个，其余能力用不挂载的方式关掉）。

## 2. 定量对照

| 维度 | tw | studio | ethan | forge |
|---|---|---|---|---|
| 工具数 | **48** | 0 | **3** | 17 |
| 代码行数 | 5376（纯 JS） | 13309（TS/TSX） | 15323（TS） | 8225（JS） |
| 前端 | 树外 remote 插件 | 完整 React 应用（11 组件 + web-dist） | 400–440px 侧边抽屉（TS 直写 DOM） | 右侧栏 tab（原生 DOM） |
| 存储 | 文件 + SQLite 向量索引 | 单 JSON 状态 + 事件哈希链 | 文件 + SQLite(proposal 队列) | 文件 + sessions 归属 |
| 独立 LLM 直调 | ✅ 独立 key 四通道 | ❌ | ❌ | ❌ |
| 代码级质量判定 | ⚠️ 半（LLM 出结论） | ✅ 全（continuity 纯函数） | — | ⚠️ 半（gate 纯函数管流程） |
| 审批与写作分离 | 🟡 gate 可选 | 🟡 human gate 存状态 | ✅ 工具层彻底分离 | 🟡 propose + apply（同面） |
| 市场验证 | 下载最高 | 最少 | stars 最高 | 内测 |

## 3. 逐家解剖

### 3.1 dsh-tool-writing（tw）— 工具密度冠军

**48 个 `novel_*` 工具全集中在 `lib/tools.js`（2642 行），按能力分成九组：**

| 组 | 工具 |
|---|---|
| 项目 | init / scaffold / rename / check / plan / status |
| 设定 | lore / brief / setting_extract / characters / char_state / worldstate / card |
| 大纲 | outline / choice / decision / threads |
| 写作 | draft / continue / batch / polish / sync / summarize |
| 审校 | audit（章后八项）/ review（一致性）/ proofread（机械）/ market（起点+番茄）/ censor（敏感）/ autoproof |
| 记忆 | foreshadow / evolution / distill / handbook / ledger（正典五表） |
| 检索 | search / semantic / vsearch / embed |
| 书库 | library_import / list / read / search / analyze / delete |
| 运维 | usage / export / epub / organize / brainstorm / research / simulate |

**架构上唯一的实质差异 —— 旁路直调**：

`lib/engine.js` 用**独立 DeepSeek key**（`DSH_WRITING_API_KEY`，回退主 key），直连 `https://api.deepseek.com/chat/completions`，按 `keyRole`（polish / draft / sync / agent）分四通道。`novel_batch` 用 worker 池 `Promise.all` 并发起草多章（`concurrency` 参数）。

> 意义：写作不占用主 agent 的上下文与额度，且能并发。这是 tw 与大肥鱼共有的、**本插件完全缺失**的能力。

**门禁设计 —— `gate` 参数（默认 false）**：

`novel_continue` / `novel_draft` 带 `gate` 选项，开启后写完跑一次阻断质检，四个维度：①事实矛盾 ②违背故事承诺书 ③上一章欠账未回应 ④物理/视角硬伤。**有问题自动修复一轮再落盘**。同一段落还有「追读力注入」硬约束：*上一章欠账未回应前，本章不许开新钩子；每 600–900 字给一次微兑现*。

**autoproof 的保守规则值得单独抄**（`lib/autoproof.js`）：
- 只对**唯一匹配**（`count === 1`）做字级替换
- replace 长度不得超过 find 的 2 倍 + 2
- **高危易混字黑名单**（恨/戍/戌/柝/祗/祇/菅/圮）：replace 引入了 find 里没有的这些字 → 判定为校对模型自己写错，跳过
- 首行（章节标题）不参与替换
- 「可议项」（重复意象/低效比喻）只写报告，**绝不代改**

**问题**：48 工具的功能重叠严重（`search`/`semantic`/`vsearch` 三个检索入口；`lore`/`brief`/`setting_extract` 三个设定入口），模型选择成本高，且 gate 默认关闭等于不设防。

### 3.2 deepseek-harness-novel-studio — 一致性校验最硬

**零工具 + 5 个 SKILL.md**（novel-project-workflow / novel-proof-scene / novel-premise-tournament / novel-engine-stress-test / novel-state-review）。工具面是空的，能力靠 skill 与 GUI 承载。

**唯一一家做真·代码级一致性判定**（`src/core/continuity.ts`，纯函数 `validateContinuity`）：

| 校验 | 严重度 |
|---|---|
| 人物关系指向已删除/不存在的端点 | error |
| 关系自指 | warning |
| 时间点关联章节已失效 | warning |
| 状态变化找不到人物/关系 | error |
| **死亡人物在后续章节再次出现** | warning |
| 场景参与人物已被删除 | error |
| 人物同时被设为「出场」与「隐藏」 | warning |
| **死亡人物被安排进入当前场景** | error |

叙事模式 `flashback` / `dream` 自动豁免死亡校验。角色状态用**时间线推演**（`effectiveCharacterStatusAtChapter`：按 milestone.order 累加 status 变化），而不是读一个静态字段。

**上下文裁剪也最精细**（`buildWritingContextPlan`）：按场景契约 `participantIds` / `hiddenCharacterIds` 挑人物，世界观按标题/标签命中正文才注入（上限 6），时间线只留相关者近 10 条。**被 `hidden` 的人物 AI 完全看不到**——这是「悬念保护」的实现方式。写入上下文前还挂 `buildWritingContextPlan` → 门禁 UI 在 `ContextPanel.tsx`（「继续门」）。

**数据层**：单 JSON 状态 + `hashEvent` 事件哈希链 + schema version 6 + `RevisionConflictError`。human gate 作为状态机里的字段（`project.humanGate.status`，`action.type === 'human-decision'`）。

**问题**：工具面为 0 意味着**没有跨会话的 REST 层**，能力全绑在 React 应用里；换到 dsh 对话流里，模型能做的反而比 tw 少。

### 3.3 @ethanyoq/dsh-ai-novel-writer — 审批门的教科书

**只有 3 个工具**，但设计密度最高。核心是**从工具面把能力关掉**：

`presets/ai-novel-writer-v2/agent.cordis.yml` 注释原文：
> *"It intentionally mounts no shell, general filesystem tool, text replacement tool, or Code Mode transport."*

三个工具的分工：

| 版本 | 工具 | 写入路径 |
|---|---|---|
| V1 | `novel_read` + `novel_apply_change` | Harness **原生一次性审批**（对话里的单文件 diff 卡，「允许一次」） |
| V2 | `novel_read` + `novel_propose_change` | 提案进 **pending inbox**（非权威），**浏览器侧** apply 才落盘 |

**防伪造三层**：
1. 服务端记录 `session` / `call identity` / **canonical argument hash**，persona 明确写 *"never attempt to supply or guess those values"*
2. **SHA-256 revision 乐观并发**：写入带 `baseRevision`（上次读到的哈希），不匹配返回 `STALE_REVISION`。persona 强调 *"never retype baseText into tool arguments"*（模型不重打旧文本，避免复制错误）
3. **单次单变更**：*"A proposal must contain exactly one typed change"*，无多资产事务

**失败即停**：*"If novel_read or novel_propose_change fails, stop this request; do not retry, probe, or substitute another write call."* + *"Never retry an unchanged proposal after receiving its pending receipt."*

**V2 store**（`novel-store.ts` 3241 行）：`.ai-novel/novel.db`，`proposals` + `proposal_changes` 两表，去重靠参数哈希，重启恢复 pending，pending 上限 20、单包 2 MiB。浏览器只传不透明 `WorkspaceId`，**不传路径、不传 JSON patch**，Host 用 Workspace registry 反解目录并拒绝未知 id。

**关键差距**（对本插件最致命的一条）：V2 的 **apply 动作在浏览器闭环通道 `/ai-novel` 里，模型根本没有 apply 工具**。也就是「批准钥匙在用户手里」是**工具面保证**的，不靠 persona 自觉。

**问题**：README 自陈 *"0.1.0 preview is frozen, no short-term feature work planned"*——**已停止维护**。且 V2 只有不到桌面端 10% 的能力。

## 4. 三个横切维度（本报告的核心结论）

### 4.1 工具面大小：48 / 17 / 3 —— 不是越多越好

| 模型 | 代表 | 代价 |
|---|---|---|
| 宽工具面 | tw（48） | 重叠严重，模型选择成本高；每次请求工具 schema 都进 KV cache |
| 中工具面 | forge（17） | 覆盖主线，边界较清 |
| 窄工具面 | ethan（3） | 表达力受限，但**不可能越权** |

ethan 的逻辑：**能写坏东西的能力，根本不给模型**。想改项目 → 只能提提案。这比"给工具 + 靠 prompt 求它别乱来"可靠。

### 4.2 门禁归属 —— 真正的分水岭

| 判定权 | 家 | 机制 | 可绕过性 |
|---|---|---|---|
| **工具层** | ethan | 无 apply 工具，浏览器闭环 | **不可绕** |
| 代码层（流程） | **forge `lib/gate.js`** | `gateChapterWrite` 检查 `approvals.outline[n]`，未批→throw；`force:true` 放行**记审计** | 需显式 force |
| 代码层（内容） | studio | `validateContinuity` 纯函数 | 不阻断写入，只报 issue |
| 状态层 | studio | `humanGate.status` + `human-decision` action | 状态机内 |
| LLM 自检 | tw（gate）、大肥鱼 | 再调一次模型问「有没有问题」 | 模型自答，可放过 |

**关键澄清（本次自查修正）**：本插件的门禁此前被低估。`novel_write_chapter` 在 `execute` 里真的会先问 `gateChapterWrite`，未批准就 throw——这是**代码强制**，不是口头约定。`novel_propose` 也是真提案制（propose 不动正文，apply 才生成 vK+1 且旧版保留）。

**但仍有一处与 ethan 的实质差距**：`novel_propose` 的 `apply` 是**模型可调的工具参数**（`enum: ['propose','list','apply','prune']` 全在工具面）。模型完全可以 propose 完自己 apply。ethan V2 把 apply 挪出了工具面。

### 4.3 旁路直调 —— 本插件的空缺

tw（独立 key 四通道 + 并发）和大肥鱼（`captureRoute` 监听 `llm/stream`）都能**绕开主 agent 上下文**自己调模型。本插件没有。

收益：① 写作不吃主对话窗口 ② 可并发起草 ③ 校对/蒸馏这类"内部工序"不污染对话历史。
代价：需要用户配 key、要处理流式与错误、要独立计费。

## 5. 可借鉴清单

### P0（低成本高收益，建议立即做）

1. **把 `novel_propose` 的 `apply` 从工具面摘出**，改由面板按钮 + REST 端点触发（浏览器侧）。这是 ethan 的核心设计，本插件已有 propose 基础设施，只差这一步。**成本：1 个端点 + 面板按钮；收益：批准钥匙真正回到用户手里。**
2. **抄 studio 的 `validateContinuity` 到 `novel_audit`**：死亡人物再现、关系失效端点、场景契约冲突。这些是**确定性检查**，不需要 LLM，纯函数、可单测、零 token 成本。**成本：1 个 lib 文件 + 单测。**
3. **抄 tw 的 autoproof 保守三原则**到 `novel_polish`：唯一匹配才改 / replace 不得成倍扩张 / 高危易混字黑名单。防的是**校对模型自己写错**——本插件目前没有这层保护。

### P1（中等）

4. **场景级上下文裁剪**（studio）：写章时只注入本章 `participantIds` 的人物，支持 `hidden`（悬念保护）。本插件现在是全书注入，token 浪费且容易泄底。
5. **`novel_write_chapter` 的 gate 结果落审计**：现在 force 只进 reason，应该像 tw 的 `maint` 一样把「硬关卡：发现 N 个阻断级问题」写进章节元数据与面板。

### P2（架构级）

6. **旁路直调 PoC**：先只在 `/polish` 与 `/proofread` 两个内部工序上试点独立 key，不动主写作链路。
7. **失败即停的 persona 纪律**（ethan）：*"工具失败就停，不要重试、探针、换别的写工具"*——本插件 persona 缺少这条，模型在超时后容易乱试。

## 6. 一句话结论

三家各赢一个维度：**tw 赢在能力密度与旁路直调**，**studio 赢在代码级一致性判定**，**ethan 赢在门禁的不可绕过性**。本插件的差异化不在工具数量（17 个已够），而在 **UI（右侧栏 tab + 会话归属）**——这是七家里唯一把「面板跟会话走」做出来的。下一步最该补的不是加工具，而是 **P0 的三条**：apply 钥匙外移、确定性校验入库、校对保守三原则。
