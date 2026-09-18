# dsh-novel-forge · 小说锻炉

![release](https://img.shields.io/github/v/release/huangziyuan-general/dsh-novel-forge) ![license](https://img.shields.io/github/license/huangziyuan-general/dsh-novel-forge) ![tests](https://img.shields.io/badge/tests-237%20passing-brightgreen)

DeepSeek Harness（DSH）的小说创作插件。设计主线只有一条：

> **代码强制 > 提示词自觉。** 凡是"靠模型自觉"的约束都会失效——
> 一致性、门禁、审计必须是工具层/数据层的硬约束。

AI 长篇写作的通病不是玄学，每一个都有对应的工程解法。本插件把其中"有明确对错"的部分做进代码：

| AI 写作通病 | 本插件的硬约束 | 落点 |
| --- | --- | --- |
| 设定/战力崩坏 | 事实账本：同章改值=冲突拒绝；世界书关键词自动注入 | `novel_ledger` / `novel_worldbook` |
| 模型"看不见前文" | 写前简报按预算组装上下文包（细纲→人物卡→账本→伏笔→世界书→上章结尾） | `novel_briefing` |
| 口头跳阶段 | 阶段门禁：细纲未批准，`novel_write_chapter` 直接拒绝 | `novel_outline approve` |
| 跨章复读/水文 | 8 字 shingle 与前文重复检测，超阈值拒绝保存 | `novel_write_chapter` 机审 |
| 章节字数失控 | 机审门槛默认 **2000–4000 字**（网文连载单章标准，目标 3000）；写前简报带「本章字数目标」段 | `novel_write_chapter` / `novel_briefing` |
| 章末无钩子 | 章末钩子启发式（问句/悬念/省略/感叹），缺了给警告 | `novel_audit` |
| AI 味 | 六维结构性扫描：模板句/库存词密度/情绪直写/句式模板/段落节奏方差/信息稀释（纯本地，零模型费用） | `novel_noai_scan` |
| 偷偷覆盖正文 | 提案制：修订走提案→用户确认→生成新版本，旧版永不覆盖 | `novel_propose` |
| 审稿放水 | 机审与模型审分离：审计产出确定性数字，模型审稿必须引用证据 | `novel_audit` |
| 悬念提前泄底 | 场景契约：隐藏人物**档案不进上下文**（连账本/摘要里的痕迹也擦掉），正文出现其名=内容门禁拦下 | `novel_scene` |
| 写偏/漏写细纲 | 细纲契约段（必写场景 / 禁止偏离项）由代码算覆盖率与偏离度，命中禁项拒绝落盘 | `novel_write_chapter` |
| 多角色千人一腔 | 语言基因卡结构化注入（句长/逻辑/口头禅/绝不说/小动作/语域），审稿核对禁忌词 | `novel_character voice` |
| 长篇上下文爆炸 | 契约在场时只注入本章出场人物的卡，世界书按白名单取 | `novel_briefing` |
| 设定没定就想写大纲 | 九阶段状态机：每阶段入场条件由**代码**判定，缺什么直接列出来 | `novel_project phase` |
| 同一章反复写不对 | 熔断：同章连续驳回 3 次即**拒写**（不是提醒），改完细纲/契约自动解除 | `novel_write_chapter` |
| 不合平台口味 | 平台审稿两张表：起点看结构/章末钩子/移动端段长，番茄看前 1000 字爽点/打脸/憋屈时长 | `novel_audit platform` |
| 踩平台红线 | 敏感自查七类，命中给行号与改法 | `novel_audit censor` |
| 内部工序占满主对话 | 旁路直调：润色/校对/打标/起草走独立流，不占主对话、不写会话记录；结果只出提案 | `lib/engine.js` |
| 批量起草绕过门禁 | 并发生成、**串行提交**：每章仍过同一道门禁，单章失败不回滚整批 | `draft-batch` |
| 写到百章后"看不见前文" | 本地检索索引：按**记忆碎片**把段落找回来（中文手工二元切分，零依赖） | `novel_search` |

## 快速开始（约 5 分钟）

**前提**：已安装 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）并跑通模型；Node ≥ 22（22.19+ / 24+ 可启用检索索引，否则自动降级，不影响其他功能）。

**第 1 步 · 安装插件**（任选其一）：

```bash
# 从插件商店（GitHub 公开仓库，推荐）
dsh plugin --profile web add github:huangziyuan-general/dsh-novel-forge

# 从 npm
dsh plugin --profile web add npm:dsh-novel-forge

# 本地开发（符号链接，改码即生效）
dsh plugin --profile web add link:/path/to/dsh-novel-forge
```

**第 2 步 · 重启 DSH web，然后浏览器硬刷新**（客户端 bundle 在进程启动时快照，不重启等于没装）。

**第 3 步 · 验证安装**：右侧栏出现「🔨 锻炉」独立 tab；在会话里让模型「列出小说工具」，应能看到 20 个 `novel_*` 工具。同时 agent 预设「小说锻炉」已自动部署到 `~/.dsh/.agent-presets/novel-forge/`（已存在则跳过，永不覆盖；`DSH_NOVEL_FORGE_REDEPLOY=1` 强制重铺，`DSH_NOVEL_FORGE_SKIP_DEPLOY=1` 关闭）。

**第 4 步 · 建第一本书**：在会话里直接对模型说，例如：

> 用 novel_project init 建一本玄幻书《示例书名》，一句话立意是「废柴觉醒了不该属于他的力量」。

**第 5 步 · 跟着九阶段走**：模型会按 立意→设定→人物→大纲→分卷→细纲→正文 的顺序引导，每个阶段缺什么、插件会直接列出来。写章前必须先 `novel_outline approve` 批准该章细纲——这是设计，不是故障。

**第 6 步 · 到面板收结果**：右侧栏「锻炉」tab 里阅读/听书、点润色/校对（产物是**提案**，你在面板点「应用」才生效）、跑全书体检、导出整本。

宿主版本要求与依赖面清单见 [COMPATIBILITY.md](./COMPATIBILITY.md)。

## 会话与面板的分工

- **会话里（模型 + `novel_*` 工具）**：一切创作动作——建书、大纲、细纲、写章、账本、审计。写章必须走会话（简报 + 多道落盘门禁是多轮闭环）。
- **面板（右侧栏「锻炉」）**：阅读与听书、润色/校对（旁路引擎，产物为提案）、全书体检、黄金三章诊断、批量起草、提案审批（应用/丢弃）、书卡管理（改名/删除/克隆）。

典型会话流：

```
novel_project init → novel_project phase（看九阶段看板，按提示补齐入场条件）
→ novel_outline save_book → novel_character save（建语言基因卡）
→ novel_worldbook add（固化核心设定）→ novel_project phase stage:outline/volume（分卷）
→ 循环：
    novel_outline save_chapter + approve
    → novel_briefing（拿上下文包；有场景契约就按契约裁剪）
    → 按细纲成稿 → novel_write_chapter（门禁/机审/账本/内容门禁/契约指标/熔断/落盘）
    → novel_noai_scan + novel_audit（证据）→ 你自己（或让模型引用证据）审稿
    → 发书前：novel_audit platform:qidian|fanqie + novel_audit censor:true
    → 修订：novel_propose propose → 用户在面板确认 → 生成 v2（旧版永不覆盖）
```

## 面板功能一览

| 功能 | 入口 | 说明 |
| --- | --- | --- |
| 项目列表 | 「🔨 锻炉」tab | 按**会话**过滤（项目跟会话走）；改名/删除/克隆；>8 本出筛选框 |
| 认领旧书 | 列表底部 | 0.5.0 之前建的无归属书，一键认领到当前会话 |
| 📋 基本信息 | 详情页 | 档案/大纲/角色卡/时间线总览；读章（📖 阅读卡）、保存、**导出**、**黄金三章诊断** |
| 🎧 章节听书 | 详情页 | 目录 + 语音连播（暂停/继续/停止、读完自动接下一章）；每行 📖 阅读 / ▶ 朗读，看听独立 |
| 一键润色 / 机械校对 | 章节 | 走旁路引擎，产物是**提案**，不直接改正文；校对守卫更严（篇幅上限 1.06） |
| 全书体检 | 详情页 | 死人复活/账本矛盾/伏笔超期/章号断档/人物卡缺失，零 token |
| 黄金三章诊断 | 基本信息卡 | 钩子/开场/冲突/灌输四维数字 + 总评，纯词表零 token |
| 批量起草 | 详情页 | 并发生成、串行提交；逐章成败摊开；并发上限 4、默认 1 |
| 提案审批 | 详情页 | 查看提案全文 → 应用（生成新版本）/ 丢弃；旧版永不覆盖 |

## 20 个工具

| 工具 | 职责 | 硬约束 |
| --- | --- | --- |
| `novel_project` | init / status / **phase（九阶段看板与入场判定）** / set_stage / repair / check / promise | 防重复创建；阶段入场由代码判定；越级记 skipped；repair 索引-磁盘对账 |
| `novel_outline` | 全书大纲 / 第N章细纲 / **批准** | 写章门禁的钥匙 |
| `novel_character` | 人物卡 + **语言基因卡**（voice：句长/逻辑/口头禅/绝不说/小动作/语域，结构化存储） | 写章单独注入成区块；audit voice:true 核对禁忌词 |
| `novel_worldbook` | 世界书条目（add/update/list/remove + import/export） | 设定只认这里；update 保 id |
| `novel_scene` | 场景契约（save/get/list/delete）：本章场景/出场人物/**隐藏人物**/世界书白名单/禁项 | 隐藏人物档案不进上下文且正文不许出现其名；契约外人物不注入（省 token） |
| `novel_briefing` | 写前上下文包（细纲→承诺书→**场景契约**→人物卡→**语言基因卡**→账本→伏笔→世界书→上章结尾→锚段） | 一致性供给侧；按契约裁剪 cast 与世界书 |
| `novel_write_chapter` | 写章落盘 | 门禁→机审→账本→**内容门禁（六维）**→**细纲契约指标**→版本化；契约指标落盘到章节索引 |
| `novel_ledger` | 事实账本（含 note）+ **时点推演**（`status_at` 第 n 章快照 / `timeline` 演化线）+ 伏笔埋/收/改期 | 同章改值拒绝；章号超前拒绝；超期伏笔告警；补录不改历史 |
| `novel_noai_scan` | 六维去 AI 味扫描 | 纯本地零费用 |
| `novel_audit` | 确定性章节审计 + 契约指标 + `continuity` 全书一致性 + `voice` 语言基因核对 + `platform` **起点/番茄双平台审稿** + `censor` **敏感自查七类** | 机审证据；平台体检表给出可执行改法 |
| `novel_style` | 文笔六维基线（μ±σ 带）+ **氛围光谱 12 轴**：build 建基线 / check 对照（含主导氛围漂移） | 纯本地零费用；只报数不贴标签 |
| `novel_propose` | 提案 / 列表 | 修订走提案，用户在面板应用；旧版永不覆盖 |
| `novel_import` | 本地书籍导入（preview/import/**backfill 门禁回补**） | 纯函数切分章节；建书+版本化落盘 |
| `novel_export` | 导出整本（md/txt + stats） | 按版本顺序拼装，写 `导出/` |
| `novel_diagnose` | 黄金三章四维诊断（钩子/开场/冲突/灌输） | 确定性数字，机审与模型审分离 |
| `novel_polish` | 段落级病灶定位 + 润色提案提交 | 润色也走提案制，永不覆盖旧稿 |
| `novel_search` | 长篇检索（build / query / annotate / status）：返回章号+摘录+命中比例 | 索引是**派生物**（`书/.novel/index.db`），删了重跑即得；无 sqlite 自动退化 |
| `novel_library` | **书库饲料**（import/list/read/analyze/delete）：拆对标作品的结构画像——章长曲线/对话密度/段落节奏/章末钩子率/高频意象；`compare_book` 与自己的书并排给数 | 零 token 全本地；只读饲料，不参与本书一致性判定；`delete` 只移索引 |
| `novel_glossary` | 术语表（add/remove/list） | 随上下文包注入，防专有名词乱译 |
| `novel_clone_project` | 整书克隆为模板 | 阶段重置、提案与熔断计数清空；人物卡/世界书/账本/伏笔/术语表/场景契约/语言基因一并带走 |

参数刻意只用了标量（字符串/整数/布尔），结构化数据用分隔行表达
（如账本更新 `实体|键|值[|备注]`）——对量化小模型也友好。

## 数据布局（一本书 = 会话工作区里的一个目录）

```
我的书/
├─ novel.json            # 机器状态：九阶段/批准/章节索引/cast/提案索引/熔断计数
├─ 大纲/全书大纲.md
├─ 大纲/细纲/第3章.md
├─ 人物/林晚.md           # 人物卡（Markdown，briefing 原文注入）
├─ 设定/世界书.json        # [{id, keywords[], content, always, priority}]
├─ 设定/术语表.json        # [{term, definition}]
├─ 设定/场景契约.json      # 按章的出场/隐藏人物、世界书白名单、禁项
├─ 设定/语言基因.json      # 按人物：句长/逻辑/口头禅/绝不说/小动作/语域
├─ 正文/第3章-雨夜来客-v2.md   # 版本化，永不覆盖
├─ 账本/facts.json        # [{entity, key, value, chapter, note}]
├─ 账本/伏笔.json          # [{id, setup, chapter, plan, payoffChapter}]
└─ .novel/
   ├─ audit.jsonl         # 全动作审计（谁在哪章做了什么、何时被拒）
   ├─ index.db            # 检索索引（派生物：删了重跑 novel_search build 即得）
   └─ proposals/P3-xxx.json
```

工作区根下还可以有一个与各书目**平级**的 `书库/`——外部小说饲料，多本书共享
（`library.json` + 原文 txt；不进上下文包、不参与本书一致性判定）。

全部文件都在会话工作区内、走宿主 `ctx.fs`（受沙箱与审批策略约束），可直接进 Git / Obsidian。
卸载插件不影响任何书稿数据。

## 配置（cordis.patch.yml）

| 项 | 默认 | 说明 |
| --- | --- | --- |
| minChapterChars | 2000 | 单章下限（机审拒绝线，网文连载单章标准） |
| maxChapterChars | 4000 | 单章上限（超了提示拆章） |
| contextBudgetChars | 6000 | 写前简报上下文包预算 |
| scanTopK | 8 | 扫描报告每维最多列出的问题数 |
| repetitionWindow | 10 | 跨章重复检测的滑动窗口（与前 N 章比对） |
| skipPresetDeploy | false | 跳过预设部署 |
| engine.channels.\* | 继承当前路由 | 旁路通道（polish/proofread/annotate/draft）按通道覆盖；长文通道（polish/proofread/draft）`timeoutMs` 默认 600000 |
| engine.channels.\*.maxTokens | 0 | 0＝不传，继承宿主按模型校准的上限（推荐保持默认）；显式设小会被推理模型的思考+整章重写烧穿（报 `OUTPUT_TRUNCATED`） |
| engine.retries | 2 | 旁路调用的指数退避重试次数 |
| engine.attachSession | false | 旁路流是否写进会话记录；默认不写（这才是"不占主对话"） |

> `engine` 整块都可省略——省略即「用当前路由、重试 2 次、不写会话」，最省心的默认。
> 宿主没有模型服务时插件照常装载，只有真正调用旁路通道时才返回可读错误。

## MCP 双通道（宿主外复用）

同一套 `novel_*` 工具（门禁/账本/审计/基线全在工具层）也可通过 stdio MCP 暴露给
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
containment 与版本守卫语义。

## 排障 FAQ

| 症状 | 处理 |
| --- | --- |
| 右侧栏没有「🔨 锻炉」tab | 重启 DSH web（bundle 进程启动时快照）→ 浏览器**硬刷新**。console 应有 `[novel-forge] client apply v…` |
| 面板按钮点了没反应 | 先硬刷新；console 看 `[novel-forge]` 日志。开发者可跑 `npm run preview` 的按钮扫射定位 |
| 润色/校对报 `503 引擎未就绪` | 当前 dsh 进程没有可用的模型服务：确认模型路由已配置、插件是最新构建并已重启生效 |
| 润色/校对报 `NO_PARENT_AGENT` | 插件会先按「书归属会话」候选自动物化；仍失败时，到拥有这本书的会话里发一条消息（让会话 agent 驻留），再回面板重试 |
| 润色报 `OUTPUT_TRUNCATED` | 模型输出被上限截断。保持 `engine.channels.*.maxTokens` 默认 0（继承宿主校准值），不要显式设小 |
| 写章被拒「细纲未批准」 | 先 `novel_outline approve`。确要跳过用 force（记审计），不建议 |
| 写章被拒「第N章熔断中」 | 同章连续驳回 3 次触发。回去改细纲或场景契约，改完计数自动清零 |
| 机审说「章末钩子未检出」但明明有 | 章末最后一个字符必须是裸 `？` / `！` / `……`——后跟闭引号（" / 」）会漏检 |
| 机审说「对话占比 0」 | 正文对话请用中文弯引号 ""，直角引号不识别 |
| 细纲覆盖率 0% 但场景写了 | 覆盖率按细纲「必写场景」标题词面匹配（启发式），把场景标题措辞对齐细纲条目即可 |
| 「一键写章」按钮 501 | 设计如此：写章要走 briefing + 多道落盘门禁，只能在会话里做 |

## 开发与测试

```bash
npm run setup-dev   # 把 DSH checkout 的宿主 SDK 真包 symlink 进本地 node_modules
npm run build       # src/client/ → lib/client.js（改客户端源码后必须跑；npm test 会自动跑）
npm run audit       # 静态自检：① 调用了但没导入/声明 ② 孤儿 dataset.X 读取（npm test 前置也跑）
npm run preview     # 生成可交互 UI 预览 preview/forge-ui.html（内联真产物 + 宿主真 token，离线可开）
npm test            # node --test：237 个用例（纯逻辑单测 + 假 fs 全链路冒烟 + headless 行为测试）
node scripts/demo.mjs   # 端到端演示：init→细纲→写章→账本→扫描→提案 全流程
```

开发约定（纯逻辑与 io 分离、output.schema 逐字段一致、peerDependencies、客户端源码/产物分离、
面板入口三步契约等）见 [AGENTS.md](./AGENTS.md)。

## 已知边界

- 去 AI 味词库与阈值是**启发式**，只能抓显性病，不承诺"根治"——结构性指标（节奏方差/信息稀释）是它比纯词库强的地方。
- `novel_audit` 只产出确定性证据，「模型审」在会话里进行；旁路引擎只服务内部工序（润色/校对/打标/起草），不改变「审计工具不调模型」这条线。
- 批量起草并发上限 **4**（默认 1；书里没有场景契约时强制降为 1）；并发只作用于起草，提交始终串行。
- `novel_search` 是**词法检索 + LLM 标签增强**，不是 embedding 语义检索；索引单文件 sqlite，十万块级超大书未压测；`annotate` 产生真实 token 成本（默认每次最多 20 块）。
- 跨章重复检测是滑动窗口（默认前 10 章，可调）——超出窗口的复读抓不到；世界书递归激活限 2 轮。
- 面板听书用 Web Speech 合成，正文切块防 Chrome 长文本停摆；无语音引擎的环境给可读报错。

## License

见 [LICENSE](./LICENSE)。
