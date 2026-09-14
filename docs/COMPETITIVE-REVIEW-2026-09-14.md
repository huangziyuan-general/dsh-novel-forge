# DSH 小说插件四方对比分析

日期：2026-09-14　范围：dsh-novel-forge（自有）vs 大肥鱼 / 多核协同 / peter

样本来源：

| 插件 | 仓库 | 版本 | Star | 技术栈 |
|---|---|---|---|---|
| **dsh-novel-forge**（自有） | 本地 `~/Documents/other/dsh-novel-forge` | 0.6.6 | — | 纯 JS（ESM）+ esbuild 打包客户端 |
| **大肥鱼 · 小说工坊** | `akira399/dsh-novel-writer` | 0.1.8 | 56 | TypeScript + tsdown + vitest + React（`.tsx`） |
| **多核协同写作模式** | `sailoumili/novel-writer` | — | 24 | 零代码：YAML 预设 + 59 行注册 JS |
| **dsh-novel-writing** | `peterwangze/dsh-novel-writing` | 0.5.2 | 4 | JS + `.governance` 治理体系 |

---

## 一、结论速览

1. **「输入设定就一路写到底」是四家的通病，不是锻炉独有**。三家都没在代码层强制「写完停下来等人」；唯一在铁律里写了「每章动笔前申请许可、不擅自连写多章」的是**多核协同**（纯 prompt，零强制力）。
2. **门禁的硬度的唯一分水岭是「判定权在谁手里」**：
   - **peter** 是唯一把质量判定做成**代码计算**的（看护卡 → 场景覆盖率 / 偏离度 / 禁止项命中），但它仍留了 `force` 逃生门。
   - **大肥鱼**状态机最漂亮（九阶段、变更审计带 actor），但 `commit` 的 `errorCount/passed` 由**模型自己传**，服务端不重跑校验——门禁的钥匙同样在模型手里。
   - **锻炉**的 `approve` 也是模型可调工具，同一性质。
3. **大肥鱼功能面最宽**（41 工具 + 62 个 prompt 资产 + 自带 LLM 直调 + 桌面版），**锻炉在「可追溯的写作流水线」上最深**（事实账本 / 提案制修订 / 章节版本化 / 审计 / 听书 / 会话归属），**多核协同最轻**（零维护，但全靠模型自觉），**peter 重在「写→发布」闭环**。
4. **两个独立团队踩了同一个客户端坑**：大肥鱼的 `workshop-drawer.tsx` 注释里写着「React 合成事件失效 → 全改原生事件代理」——与锻炉 0.4.3 的结论一字不差。这是 DSH 客户端的结构性坑，不是谁写错。

---

## 二、规模与形态

| 维度 | 锻炉 | 大肥鱼 | 多核协同 | peter |
|---|---|---|---|---|
| 自有工具数 | **17** | **41**（lorebook 12 + novel 29） | **0**（用宿主 subagent/fs） | **11** |
| 主机侧代码 | 6,383 行（30 文件） | 8,273 行 TS | 59 行 | 7,080 行 JS |
| 客户端代码 | 1,842 行（15 文件） | `workshop-drawer.tsx` 1,536 行 + 其他 | 无 | `lib/client.js` |
| 测试 | **110 用例 / 2,433 行**（行为测试 + 反向验证） | 29 文件 / 3,552 行（vitest） | 无 | 有 test/ |
| Prompt 资产 | preset（1 个）+ 工具内嵌提示 | **62 个 md 模板**（创作/诊断/润色/文风/世界书） | 278 行组合（含 5 个岗位模板） | 16 个 agent md |
| 数据模型 | `novel.json` + Markdown + `账本/*.json` + `.novel/audit.jsonl` + 版本化章节文件 | `book.json` + `docs/<phase>.md` + `chapters/ch<N>.md` + lorebook + variables + `audit.jsonl` | **全部靠 prompt 约定**（《叙事宪法》《世界白皮书》《人物档案.json》《伏笔台账》《章节目录》） | 项目目录 + 看护卡 + 发布配置 |
| GUI | 右侧栏常驻面板（自建 REST + slot 契约）；四视图 + 语音听书 | React 抽屉工作台（全功能）+ Electron 桌面版 | 无 | 可视化工作台（client.js） |
| 治理工程 | CHANGELOG + AGENTS.md + 契约自检脚本 | 迁移计划/开发计划文档（10 万字符）+ vitest | README 双语 | **`.governance/`**（triage/review/decision-log/evidence-log） |

---

## 三、逐家分析

### 3.1 大肥鱼 · 小说工坊（akira399，56★）

**最强的地方：功能覆盖面 + 工程完整度。**

- **41 个工具**，世界书一家就 12 个（分组、移动、导入导出、开关…），粒度细到「条目级」。
- **九阶段状态机**（`src/core/workflow/engine.ts`，197 行纯函数）：
  `topic → setting → character → outline → volume → chapter → writing → revision → done`
  - 阶段态：`locked / in_progress / review / approved / skipped`
  - `submit` 是唯一推进入口；校验不过 → **`review` 挂起**（不自动推进），需 `force` 放行或 `reopen` 驳回
  - 审计事件带 **actor（user / agent / system）**，可查「谁放的行」
  - `rollback` 只在 revision/done 期可用，回退会解锁后续已批准阶段
- **自带 LLM 直调**（`src/core/llm/client.ts`）：监听 `llm/stream` 瀑布流**捕获主模型路由**，之后用 `llm.stream` 自己调模型做改写/诊断/摘要 —— 所以它的「一键润色」不必回到会话里，插件内闭环。无路由时降级为「需要模型」提示。
- **62 个 prompt 模板**按用途分组（creation-* / diagnose-* / polish-* / style-* / lorebook-*），`novel_prompts` 工具可 list/get/render（带变量渲染）——把 prompt 当资产管，可迭代、可换风格。
- 另有：世界书**注入器**（关键词匹配 + always_active 常驻）、黄金三章诊断、市场调研（借 web_search 落盘 report 供选题引用）、变量引擎（正文内 `<JSONPatch>` 更新书级变量）、向导（意图路由 `novel_wizard`，中文正则匹配意图 → 阶段）、本地书籍导入、成稿导出。
- **方法论走 SKILL**（`assets/skills/novel-writing-workflow/SKILL.md`，45 行），preset 是空壳。

**短板 / 可乘之机：**

- **门禁是「软」的**：`novel_commit` 的 `errorCount` / `passed` 是**模型传的参数**（默认 0），服务端 `commitPhase()` 直接把 report 灌给状态机，**不重新校验产物**。模型只要不老实，一路 commit 到底毫无阻力。
- **没有「停下等用户确认」**：SKILL 只约束「不许跳阶段、未 commit 不得自称完成」，不约束「不许连写」。
- 工具面宽 → schema 噪音大；12 个 lorebook 工具对一个写小说的会话来说是负担（它靠 preset 不做工具瘦身）。

### 3.2 多核协同写作模式（sailoumili，24★）

**最强的地方：把「停」和「分工」写进了铁律，且零维护成本。**

- 零代码：一个 278 行的 agent 组合，把 dsh 原生 `subagent` 用成了「1 队长 + 5 专职子代理」。
- 分工：世界 / 剧情 / 人物 / 文笔 / 复核，各自有独立岗位模板（职责、输入文件、产出文件）。
  - **文笔**是唯一执笔者（想突破设定要交「破格申请」）
  - **复核**只挑错不改写，**三色灯**判决（🔴致命→打回重写 / 🟡警告 / 🟢通过）
  - **熔断**：同一章被复核连续打回 3 次 → 队长召集全体重新校准《叙事宪法》，不硬压
  - 队长**不写稿**（专职拍板，避免既当运动员又当裁判）
- 通信纪律：「数据靠文件传，不靠对话传；一次只派一件事；只给子代理需要的切片」。子代理上下文隔离，避免串味。
- **节奏纪律（关键）**：
  > 「每步完成后**先向用户汇报、等确认再继续**」
  > 「每章动笔前**向用户申请许可，不擅自连写多章**」
  > 「用户没给题材/梗概时，先问清题材、核心梗概、篇幅与节奏偏好」
- 章节版本管理：`第N章-vX.md` 只增不覆盖，读只读最高版本。

**短板：**

- **零强制力**：没有工具、没有状态机、没有审计，数据结构全是 prompt 约定 —— 模型不遵守就没有任何兜底，文件乱了也没人拦。
- **上下文成本高**：每章要派 2–3 个子代理，每个子代理重读设定文件，token 消耗与延迟显著高于单 agent。
- 无 GUI、无账本、无统计；跨会话续写只能靠模型自己读文件重建状态。

### 3.3 dsh-novel-writing（peterwangze，4★）

**最强的地方：唯一做了「代码级硬门禁 + 发布闭环」的。**

- **11 个工具**，其中 `novel_gate_check` 是真门禁：
  > 解析「看护卡」的必写场景与禁止偏离项，输出**覆盖率 / 偏离度 / 缺失场景 / 命中禁止项**，`passed` 由**代码计算**
  - `novel_chapter_write` 保存时**也跑门禁**（`{ force, source: 'agent' }`），不通过即阻断——`force` 才绕过
  - 这是四家里唯一把「质量判定」从模型手里拿走的。虽然留了 force 逃生门，但**默认是拦**。
- 写→发布闭环：`novel_publish`（多平台发布配置）、`novel_data_ingest`（数据回流）、`novel_requests`（请求队列）、`novel_review_submit`。
- 多 agent：16 个 agent 定义（creation-strategist / content-writer / continuity-reviewer / plot-logic-reviewer / commercial-editor / engagement-reviewer / character-world-reviewer / data-analyst / launch-strategist …），偏「商业网文工业化」。
- `.governance/` 治理：change-triage（BUG/COMPAT/UX 编号）、review 轮次、decision-log、evidence-log —— 工程管理最重。
- 文档：`docs/DESIGN.md`、`docs/RESEARCH.md`、`docs/market-research-full.md`（含市场调研）。

**短板：**

- 面向「自动化流水线 + 发布」，写作体验（阅读 / 改稿 / 听）弱；star 少（4），社区验证不足。
- 门禁依赖「看护卡」——看护卡本身是 prompt/配置产物，卡不准则门禁失真。
- 治理文档体量大（8.4MB 仓库大半是流程文件），个人创作场景偏重。

### 3.4 dsh-novel-forge（自有）

**已建立的优势（相对于三方）：**

- **可追溯的写作流水线**最深：`账本/facts.json`（按章的事实时间线，entity·key→value）、`伏笔.json`（埋设/回收/逾期）、`.novel/audit.jsonl`（append-only 审计）、章节版本文件（`第N章-标题-vX.md`）、提案制修订（`novel_propose`，改已存章节必须有提案）。
- **17 个工具的分工与硬依赖**：`novel_briefing`（写前简报）→ `novel_contextpack`（上下文包）→ `novel_write_chapter`（门禁 + 机审落盘）→ `novel_noai_scan`（去 AI 味）→ 账本自动记账。
- **独有能力**：**章节语音连播听书**（四家唯一）、**项目跟会话走**（novel.json.sessions + 右侧栏面板按会话过滤）、**MCP 独立模式**（`mcp-standalone.js`，脱离 dsh 也能用）、多工作区扫描（0.6.6）。
- **测试文化**：110 个**行为测试**（真跑 `apply()` 断言 DOM 事实）+ 反向验证（把 bug 改回去测试必须变红）。大肥鱼是 vitest 单测为主，多核零测试，peter 有 test/ 但规模小。
- 右侧栏 slot 契约面板（不用自建 root，规避了「点一次没反应」那类事故）。

**短板（对手的强项）：**

- **无 LLM 直调**：润色 / 写章 / 诊断必须回到会话由模型执行（REST 端点直接返 501）。大肥鱼插件内闭环，用户体验顺滑得多。
- **prompt 资产薄**：无题材/文风模板库，无向导意图路由，无审稿 prompt（去 AI 味是代码词典扫描，不是模型审）。
- **门禁钥匙在模型手里**：`novel_outline approve` + `novel_write_chapter` 门禁都是模型可调；且**没有「停下等确认」的节奏纪律**（这正是「一口气跑到章节结束」的根因之一）。
- **无发布闭环**、无桌面版、无市场调研能力。
- 客户端功能（听书/要素总览很亮）但工程治理文档不如 peter 系统。

---

## 四、关键维度横向定级

| 维度 | 锻炉 | 大肥鱼 | 多核协同 | peter |
|---|---|---|---|---|
| 功能覆盖 | B+ | **A** | C | B |
| 数据可追溯（账本/审计/版本） | **A** | A− | D | B− |
| 门禁硬度（判定权在代码 vs 模型） | C+ | C+ | D | **B+** |
| 防「模型自走到底」 | C | C | **B+**（仅 prompt） | C |
| 上下文经济性 | A− | B+ | C（多子代理重读） | B |
| 写作体验（读/改/听） | **A** | B+ | C | C+ |
| 工程质量（测试/治理） | **A** | A− | D | B+ |
| 维护成本（越低越好） | B | C（8273 行 TS + 62 资产） | **A**（278 行） | C |
| 生态位 | 创作者的写作工作台 | 开源用户的开箱即用工坊 | 方法论预设 | 商业网文自动化流水线 |

---

## 五、可借鉴清单（按优先级）

**P0 — 直接解决「一口气写到底」**

1. **节奏纪律写进 preset**（学多核协同）：`每章写完必须汇报本章并等用户确认才写下一章；首次创作必须先把大纲+细纲交给用户过目`。纯 prompt，但这是三方共识里唯一被证明「用户能感知到」的做法。
2. **门禁钥匙收归用户**（学 peter 的判定权收归代码 + 大肥鱼的 review 挂起态）：
   - `novel_outline approve` 增加人工确认标记：必须带 `userSaidSo`（用户在会话里的原话片段）；缺了即拒。
   - 或更硬：把 approve 只留给面板（REST 通道 = 用户手点），模型侧调用直接返回「请用户在锻炉面板批准」。

**P1 — 能力补齐（对手的强项）**

3. **LLM 直调**（大肥鱼的杀手锏）：监听 `llm/stream` 捕获路由 → 插件内直接调模型。价值：REST 的「一键润色 / 一键诊断 / 一键写章」从 501 变成真能跑；面板不必把所有动作推回会话。
4. **prompt 资产库**：把去 AI 味、润色维度、题材风格（玄幻/都市/悬疑…）、审稿清单抽成模板文件 + `novel_prompts` 式工具（list/get/render），让用户/自己可迭代。
5. **世界书关键词注入**：写章上下文包按「本章出场人物/地点关键词」命中世界书条目注入（锻炉有 worldbook-io，但注入是人工挑选）。

**P2 — 体验与扩展**

6. **子代理分工**（多核协同）：把「复核」「润色」做成可选子代理调用（锻炉的 `novel_diagnose` / `novel_noai_scan` 已近似，可升级为「独立上下文复核员」）。
7. **发布闭环**（peter）：导出 + 平台发布配置（网文平台章节格式、敏感词预检）。
8. **桌面/独立运行**：锻炉的 MCP 独立模式已是雏形，可扩成「不依赖 dsh web 的本地写作台」。

**不建议学**

- 41 个工具的粒度（lorebook 条目级 CRUD 可以合并成 2–3 个带 action 的工具，减少 schema 噪音）。
- 空白 preset + 全部工具注册（不做工具瘦身会让小模型更飘）。

---

## 六、附：可直接落地的三件事

1. preset 增补节奏纪律（30 分钟，纯文本）；
2. `novel_outline approve` / `novel_write_chapter` 增加「用户明示同意」参数与拒收逻辑（半天）；
3. LLM 直调 PoC：在 server-api 的 `/polish` 端点上接通（一天，之后面板「一键润色」真能用）。
