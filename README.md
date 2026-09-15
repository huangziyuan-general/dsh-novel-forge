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
| 章节字数失控 | 机审门槛默认 **2000–4000 字**（网文连载单章标准，目标 3000）；写前简报带「本章字数目标」段 | `novel_write_chapter` 机审 / `novel_briefing` |
| 章-末-无-钩-子 | 章末钩子启发式（问句/悬念/省略/感叹），缺了给警告 | `novel_audit` |
| AI 味 | 六维结构性扫描：模板句/库存词密度/情绪直写/句式模板/段落节奏方差/信息稀释（纯本地，零模型费用） | `novel_noai_scan` |
| 偷偷覆盖正文 | 提案制：修订走提案→用户确认→生成新版本，旧版永不覆盖 | `novel_propose` |
| 审稿放水 | 机审与模型审分离：审计产出确定性数字，模型审稿必须引用证据 | `novel_audit` |
| 悬念提前泄底 | 场景契约：隐藏人物**档案不进上下文**（连账本/摘要里的痕迹也擦掉），正文出现其名=内容门禁拦下 | `novel_scene` |
| 写偏/漏写细纲 | 细纲契约段（必写场景 / 禁止偏离项）由代码算覆盖率与偏离度，命中禁项拒绝落盘，指标落盘可看趋势 | `novel_write_chapter` |
| 多角色千人一腔 | 语言基因卡结构化注入（句长/逻辑/口头禅/绝不说/小动作/语域），审稿核对禁忌词 | `novel_character voice` |
| 长篇上下文爆炸 | 契约在场时只注入本章出场人物的卡，世界书按白名单取 | `novel_briefing` |
| 设定没定就想写大纲 | 九阶段状态机：每阶段入场条件由**代码**判定，缺什么直接列出来；越级须 force 且前置阶段记 `skipped` | `novel_project phase` |
| 同一章反复写不对 | 熔断：同章连续驳回 3 次即**拒写**（不是提醒），逼回去改设定；细纲重批/契约更新即解除 | `novel_write_chapter` |
| 不合平台口味 | 平台审稿两张表：起点看结构/章末钩子/移动端段长，番茄看前 1000 字爽点/打脸/憋屈时长 | `novel_audit platform` |
| 踩平台红线 | 敏感自查七类（涉政/色情擦边/未成年/赌博毒品/暴力/封建迷信/现实机构影射），命中给行号与改法 | `novel_audit censor` |
| 内部工序占满主对话 | 旁路直调：润色/校对/打标/起草走独立流，**不占主对话、不写会话记录**，自带超时/重试/真中止；结果只出提案 | `lib/engine.js` |
| 逐章挤牙膏 / 批量起草绕过门禁 | 并发生成、**串行提交**：每章仍过同一道门禁，单章失败不回滚整批；书里没有场景契约时并发自动降为 1 | `draft-batch` |
| 写到百章后"看不见前文" | 本地检索索引：按**记忆碎片**把段落找回来（中文手工二元切分，零依赖 `node:sqlite`）；索引是派生物，删了重跑即得 | `novel_search` |

人物 OOC 的缓解（语言基因卡**结构化**注入）在 `novel_character voice` + `novel_briefing`；
"这个角色第几章才揭晓"的悬念保护在 `novel_scene`（隐藏人物对模型完全不可见）；
"立意与审美属于人"——插件不生产立意，它把 `logline` 放进每次写章的上下文包里提醒双方。

## 安装

```bash
# 本地开发（符号链接，改码即生效）
dsh plugin --profile web add link:/path/to/dsh-novel-forge

# 发布后
dsh plugin --profile web add npm:dsh-novel-forge
dsh plugin --profile web add github:<owner>/dsh-novel-forge
```

安装后重启 DSH web 即生效：20 个 `novel_*` 工具进入工具目录，agent 预设「小说锻炉」
自动部署到 `~/.dsh/.agent-presets/novel-forge/`（已存在则跳过，永不覆盖；
`DSH_NOVEL_FORGE_REDEPLOY=1` 强制重铺，`DSH_NOVEL_FORGE_SKIP_DEPLOY=1` 关闭）。

宿主版本要求与依赖面清单见 [COMPATIBILITY.md](./COMPATIBILITY.md)。

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
| `novel_ledger` | 事实账本（含 note）+ **时点推演**（`status_at` 第 n 章快照 / `timeline` 演化线）+ 伏笔埋/收/改期 | 同章改值拒绝；章号超前拒绝；超期伏笔告警；推演按章号累加（同章取后写），补录不改历史 |
| `novel_noai_scan` | 六维去 AI 味扫描 | 纯本地零费用 |
| `novel_audit` | 确定性章节审计 + 契约指标（覆盖率/偏离度）+ `continuity` 全书一致性 + `voice` 语言基因核对 + `platform` **起点/番茄双平台审稿** + `censor` **敏感自查七类** | 机审证据；平台体检表给出可执行改法 |
| `novel_style` | 文笔六维基线（μ±σ 带）+ **氛围光谱 12 轴**（热血/悬疑/惊悚/压抑/甜宠/温情/悲情/诙谐/爽感/神秘/肃杀/苍凉）：build 建基线 / check 对照（含主导氛围漂移） | 纯本地零费用；只报数不贴标签 |
| `novel_propose` | 提案 / 列表 / 应用 / 清理 | 旧版永不覆盖；prune 清已终态索引 |
| `novel_import` | 本地书籍导入（preview/import/**backfill 门禁回补**） | 纯函数切分章节；建书+版本化落盘；回补粗纲让导入书回到门禁体系 |
| `novel_export` | 导出整本（md/txt + stats） | 按版本顺序拼装，写 `导出/` |
| `novel_diagnose` | 黄金三章四维诊断（钩子/开场/冲突/灌输） | 确定性数字，机审与模型审分离 |
| `novel_polish` | 段落级病灶定位 + 润色提案提交 | 润色也走提案制，永不覆盖旧稿 |
| `novel_search` | 长篇检索（build 建/增量建索引 / query 按记忆碎片找回 / annotate 补语义标签 / status）：返回章号+摘录+命中比例 | 索引是**派生物**（`书/.novel/index.db`），删了重跑即得——不作为事实来源；无 sqlite 运行时自动退化 |
| `novel_library` | **书库饲料**（import/list/read/analyze/delete）：拆对标作品的结构画像——章长曲线（含波动 cv）/对话密度/段落节奏/章末钩子率/高频意象；给 `compare_book` 与自己的书**并排**给数 | 零 token 全本地；只读饲料，**不参与本书一致性判定**；`delete` 只移索引（宿主 fs 无删除能力） |
| `novel_glossary` | 术语表（add/remove/list） | 随上下文包注入，防专有名词乱译 |
| `novel_clone_project` | 整书克隆为模板 | 阶段重置立意、提案与熔断计数清空；世界书/账本/伏笔/术语表/**场景契约/语言基因**一并带走 |

参数刻意只用了标量（字符串/整数/布尔），结构化数据用分隔行表达
（如账本更新 `实体|键|值[|备注]`）——对量化小模型也友好。

## 数据布局（一本书 = 工作区里的一个目录）

```
我的书/
├─ novel.json            # 机器状态：九阶段/各阶段 PhaseReport/批准/章节索引/cast/提案索引/熔断计数
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
   ├─ index.db            # 检索索引（派生物：删了重跑 novel_search build 即得，不进 Git 更好）
   └─ proposals/P3-xxx.json
```

工作区根下还可以有一个与各书目**平级**的 `书库/`——外部小说饲料，多本书共享：

```
书库/
├─ library.json           # [{id, title, origin, chapters, chars, importedAt}]
└─ 对标样本/原文.txt        # 只读饲料：不进上下文包、不参与本书一致性判定
```

全部在会话工作区内、走宿主 `ctx.fs`（受沙箱与审批策略约束），可直接进 Git / Obsidian。

## 典型会话流

```
novel_project init → novel_project phase（看九阶段看板，按提示补齐入场条件）
→ novel_outline save_book → novel_character save（建语言基因卡）
→ novel_worldbook add（固化核心设定）→ novel_project phase stage:outline/volume（分卷）
→ 循环：
    novel_outline save_chapter + approve
    → novel_briefing（拿上下文包；有场景契约就按契约裁剪）
    → 按细纲成稿 → novel_write_chapter（九阶段门禁/机审/账本/内容门禁/契约指标/熔断/落盘）
    → novel_noai_scan + novel_audit（证据）→ 你自己（或让模型引用证据）审稿
    → 发书前：novel_audit platform:qidian|fanqie + novel_audit censor:true
    → 修订：novel_propose propose → 用户确认 → apply（生成 v2）
```

## 第五批：重资产三件事（旁路引擎 / 批量起草 / 长篇检索）

### D1 · 旁路直调：内部工序不进主对话

润色、校对、打标、起草本质是**内部工序**——走主对话会把上下文撑爆，还会污染会话历史。
这四条通道直接**旁路**调用宿主已有的模型服务（`ctx.llm.stream`），开独立流、拿完就丢：

- **零新增配置**：不用配 key、不用选 provider。通道默认**继承当前路由**，
  需要时在 `engine.channels.<通道>` 里按通道覆盖（模型/温度等）。
- **自带超时 / 重试 / 真中止**：宿主的重试策略不覆盖手搓调用，所以这里自己实现
  （指数退避默认 2 次；用 `Promise.race` 消费流，对不听话的适配器也能立刻断开）。
- **优雅降级**：宿主不提供 llm 时插件照常装载，调用返回可读原因而不是崩。
- **只出提案**：润色/校对结果是提案，改正文要用户在面板上批准（沿用提案制）。

对应 REST：`POST /projects/:id/polish`、`POST /projects/:id/proofread`。
失败会翻成语义化状态码：`503` 引擎未就绪 / `409` 无可用路由 / `422` 越护栏 /
`499` 已中止 / `502` 上游失败。

### D2 · 并发批量起草：并发生成，串行提交

`POST /projects/:id/draft-batch`（`from` / `count` / `concurrency` / `force`）。
并发上限 4、**默认 1**；每章仍走同一套落盘门禁，**单章失败不回滚整批**。
书里没有场景契约时并发自动降为 1（没有「必须写什么」的锚点，多章并发只会批量跑偏）。
`force` 能越过「细纲未批准」「已熔断」，但**永远越不过「已写」**。

### G1 · 长篇检索：把「那段大概写了什么」找回来

`novel_search` 四个动作：`build` 建/增量建索引、`query` 检索、`annotate` 补语义标签、
`status` 看状态。

```
novel_search build  →  novel_search query q:"戴斗笠的人"
                     →  返回 第N章#块  + 摘录 + 命中比例（默认闸门 0.25，记不清调到 0.15）
                     →  novel_search annotate  （用旁路引擎给块打标，让「决斗」也能召回
                                                 只写了「刀收回袖中」的那段）
```

- **零依赖**：Node 22+ 自带的 `node:sqlite`（不引 `better-sqlite3`）。
- **中文自己切分**：FTS5 默认分词器与 `trigram` 对中文都实测 0 命中，
  所以用手工二元切分（2 万块查询实测 ~11ms）。
- **索引是派生物**：落在 `书/.novel/index.db`，删了重跑 `build` 即得，
  **永不参与一致性判定**——正文与 `novel.json` 才是真相。
- **无 sqlite 的运行时**自动退化为子串匹配：功能弱但「找一段」仍可用，且不报错。

## 第六批：收官两件事（状态时点推演 / 书库饲料）

第五批之后回查总览表，发现 18 条里还剩两条没落地，本批补齐（另两条 H1/H2 判定不做，
理由见 [`docs/FUSION-PLAN-2026-09-14.md`](./docs/FUSION-PLAN-2026-09-14.md) 的「未落地项盘点」）。
**A~G 的 18 条至此 18/18。**

### B2 · 状态时点推演：回答「第 12 章时他是什么状态」

`query` 只给**最新值**——写到第 80 章想回溯第 12 章他在哪、什么境界，或者核对
「第 40 章断腿、第 50 章还能跑」，拿最新值是算不出来的。新增两个动作：

- `novel_ledger status_at at:12`：**第 12 章时点快照**。取 `chapter ≤ 12` 的记录里章号最大的
  一条（同章取最后写入）。**不能取数组最后一条**——补录早期章节是常态（先写第 12 章、
  后补第 3 章），那样会把新值覆盖成旧值。
- `novel_ledger timeline entity:林晚`：单实体状态演化线（按章升序），
  对账「这个值是哪一章被改掉的」。

配套：`novel_audit continuity:true` 新增**账本级**的「死后仍在活动」判定——与既有的
正文名字扫描互补：那个会误伤「有人提起亡者」「灵位遗物」，这个扫模型主动落的账，
误报率低得多，且能抓到名字压根没出现的状态矛盾。

### G2 · 书库饲料：把「凭感觉学」换成看数字

全插件唯一**不服务于「写下去」**的能力（学别人怎么写）。所以刻意与书目体系隔离：
饲料不是稿件，没有审计、**不进上下文包**、**不参与本书一致性判定**
（对照标准是别人，不是本书）。

```
novel_library import（给 path 读工作区文本文件，或直接粘 text）
→ novel_library analyze（结构画像）
→ novel_library analyze compare_book:我的书（与自己的书并排给数）
```

`analyze` 出的是**纯本地零 token** 的可参照数字：章节长度曲线（均值/中位/极值/**波动 cv**）、
对话密度、段落节奏、**章末钩子率**（复用 `hook.js` 四类判定）、前 3 章均长、单句均长、
高频意象。拆 1–2 部同题材对标，就知道「该写多长、多少对话、章末怎么收」——
不是照抄，是有参照。落点在**工作区根的 `书库/`**（与各书目平级，多本书共享）。

两个刻意的设计：
- **`delete` 只移索引，不删原文**——宿主 `ctx.fs` 服务**不提供删除能力**
  （只有 resolve/stat/readText/streamText/listDir/writeText），所以返回里明确说清原文还在磁盘上。
  同名导入也直接拒绝：饲料删错了没法找回，宁可让用户显式 delete。
- **重复短语不做分词**（无依赖可用，且中文分词器对网文特有名词更差）：3–4 字 n-gram 频次 +
  抑制周期串的**错位窗口**（「青铜古灯」重复三次会顺带产生「古灯青铜」「灯青铜古」）。

## 配置（cordis.patch.yml）

| 项 | 默认 | 说明 |
| --- | --- | --- |
| minChapterChars | 500 | 单章下限（机审拒绝线） |
| maxChapterChars | 12000 | 单章上限 |
| contextBudgetChars | 6000 | 写前简报上下文包预算 |
| scanTopK | 8 | 扫描报告每维最多列出的问题数 |
| repetitionWindow | 10 | 跨章重复检测的滑动窗口（与前 N 章比对） |
| skipPresetDeploy | false | 跳过预设部署 |
| engine.channels.\* | 继承当前路由 | 旁路通道（polish/proofread/annotate/draft）的模型、温度等覆盖；不给就用当前路由 |
| engine.retries | 2 | 旁路调用的指数退避重试次数（宿主策略不覆盖手搓调用，所以在此自管） |
| engine.attachSession | false | 旁路流是否写进会话记录；默认不写（这才是"不占主对话"） |

> `engine` 整块都可省略——省略即「用当前路由、重试 2 次、不写会话」，也就是最省心的默认。
> 宿主没有模型服务时插件照常装载，只有真正调用旁路通道时才返回可读错误。

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

### 界面：三层设计系统 + 把已做的能力接上界面（0.13.0 重做）

样式分**三层**：语义色（宿主 `--dsw-alias-*` token）→ 尺度（`space` / `radius` / `font` /
`weight`）→ 组件（`card` / `btn` / `chip` / `field` / `meter` / `emptyState` / `stageRail` /
`fold`）。视图**不再各自手拼 style 对象**——同一件事只写一次，改一次配色不必翻六个文件。
原语层在 `src/client/ui.js`（`Card / Section / Btn / Chip / Stat / StageRail / Meter /
Empty / KV / Fold / Mono`）。

> ⚠️ **token 名必须真实存在。** 宿主里**没有** `--dsw-alias-accent-strong` 这类名字——
> 0.13.0 之前面板一直在用四个不存在的 token，于是每处 `var()` 都落到写死的**深色回退值**，
> 面板**跟随主题从未生效过**（浅色主题下就是「一块深色糊字」，这才是「难看」的真根因）。
> 真实可用的有 `link`（强调）/ `state-error|warn|success-primary` / `bg-layer-1|2|3` /
> `bg-overlay` / `border-l1..l4` / `button-primary-fill` + `label-primary-foreground` 等；
> 软底与软描边用 `color-mix(in srgb, <语义色> N%, transparent)`，**自动跟随浅/深主题**。
> **加任何新 token 前，先核 `dsh-client-ui-theme` 的导出表。**

本版还把服务端**早已实现、界面却没入口**的四个真端点接上了：

| 界面动作 | 端点 | 说明 |
| --- | --- | --- |
| 一键润色 | `POST /projects/:id/chapters/:n/polish` | 走 D1 旁路引擎；产物是**提案**，不落正文 |
| 机械校对 | `POST /projects/:id/chapters/:n/proofread` | 同上，守卫更严（篇幅上限 1.06） |
| 全书体检 | `GET /projects/:id/continuity` | 死人复活 / 账本矛盾 / 伏笔超期 / 章号断档 / 人物卡缺失；**零 token** |
| 批量起草 | `POST /projects/:id/draft-batch` | 并发生成、串行提交；逐章成败摊开，被拦不算整批失败 |

一键写章**仍是 501**——它要走 briefing + 落盘门禁，只能在会话里做；设置页把这条边界**如实标注**，
不再拿一个点了没反应的按钮糊过去。头部常驻一个 ⚙，任何页面一步可达设置（能力清单）。

### 交互态：`src/client/css.js`（0.13.1 起）

内联样式的优先级**高于**任何 `:hover` / `:active` 规则——纯内联 UI 的按钮**天然不可能有**
悬停/按下反馈。所以交互态走一层真 CSS：`buildCss()` 以面板根属性为作用域生成样式表，
`ensureStyles()` 幂等注入。分工是「**外观走样式表、布局走内联**」：
`Btn` 只输出 `data-nf-btn` + `data-variant` + `data-size` 三个标记，底色/描边/字色/
按下位移（`translateY(1px)` + 内阴影）全部由 CSS 按变体给出；可点区域标 `data-nf-tap`，
分段控件 `data-nf-seg` + `data-active`。每个变体 rest / hover / active 三态齐备，
`:disabled` 豁免——这些由用例逐变体断言，缺一条测试就红。
另外两处 token **语义**误用也在本版修正：`label-dimmed` 不是文字色（浅色下近白），
弱化文字回归 `label-tertiary`；`bg-overlay` 深色下是中亮灰，输入底回归 `bg-layer-1`。
**token 名存在 ≠ 用对了，核名之外还要核语义。**

### 事件契约：`data-action` / `data-id` / `data-tab`

视图里所有可交互元素都带 `data-action`，控制器 `handleAction` 按它分发；要带参数的再补
`data-id`（书名 / 章号 / 条目 id，`Btn({ id })` 渲染成的就是它）与 `data-tab`。
**这三个字段名是视图与控制器之间唯一的接口**——两边对不上不会报错、不会警告，
只会「点了没反应」。0.13.0 的真实故障正是这个：

- 视图写 `Btn({ action: 'play-from', id: c.no })` → 渲染出 `data-id`；
- 控制器读的却是 `dataset.no`，而**全项目从未写过 `data-no`** →
  `Number(undefined)` = `NaN` 进播放器 → 状态转一圈**回到原样**，看起来像没执行。

> ⚠️ **改动作名或参数名时，视图与控制器必须同时改**；写测试要用**真机渲染出来的属性**，
> 别照着实现手编 `dataset`（那样实现读错字段，用例照样全绿）。
> 两道机器闸门兜底：`npm run audit` 的**孤儿 `dataset.X` 读取**检查，
> 以及预览页的**按钮扫射**（逐视图点击每个 `data-action`，报「没送达代理」/「送达了但界面无变化」）。

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
npm run audit       # 静态自检：① 调用了但没导入/声明 / 导入了但没用 ② 孤儿 dataset.X 读取（也在 npm test 前置里跑）
npm run preview     # 生成可交互 UI 预览 preview/forge-ui.html（内联真产物 + 宿主真 token，离线可开）
npm test            # node --test：194 个用例（纯逻辑单测 + 假 fs 全链路冒烟 + 真校验器输出契约 + headless 行为测试）
node scripts/demo.mjs   # 端到端演示：init→细纲→写章→账本→扫描→提案 全流程
```

预览页里有个**按钮扫射**按钮（`[data-do="sweep"]`）：遍历每个视图逐一点击所有
`data-action`，报出「点击没送达事件代理」与「送达了但界面无变化」。排查「按钮点了没反应」
时先跑它 —— 它比人眼快，也比人眼全（0.13.0 的死按钮就是这么定位的）。

约定见 [AGENTS.md](./AGENTS.md)：纯逻辑与 io 分离、output.schema 与返回值逐字段一致、
`@deepseek-ai/*` 一律 peerDependencies、机器状态 JSON / 人类文档 Markdown。

## v0.1 已知边界

- 去 AI 味词库与阈值是**启发式**，只能抓显性病，不承诺"根治"——结构性指标（节奏方差/信息稀释）是它比纯词库强的地方。
- 审稿的"模型审"部分**仍然不内置**：`novel_audit` 只产出确定性证据，审稿在会话里进行；
  独立审稿模型路由仍留给后续版本。第五批的旁路引擎（D1）只服务**内部工序**
  （润色/校对/打标/起草），不改变"审计工具不调模型"这条线。
- 旁路引擎的覆盖粒度是**通道级**（polish/proofread/annotate/draft），不是"每本书级"；
  四条通道共用同一份重试策略。
- 批量起草并发上限 **4**（避免打爆 provider 的限流），默认 1；并发只作用于**起草**，
  提交始终串行。
- G1 是**词法检索 + LLM 标签增强**，不是 embedding 语义检索——宿主没有 embedding 模态是根因；
  索引是单文件 sqlite，十万块级的超大书尚未压测。`annotate` 会产生真实 token 成本
  （默认每次最多 20 块，可分批慢慢补）。
- **GUI 工作台已可用**（0.6.0）：右侧栏「锻炉」tab —— 常驻独立入口（0.5.1 起不再门控），
  项目列表按**会话**过滤（项目跟会话走），0.5.0 之前建的老书可从面板底部「认领」到当前会话。
  0.13.0 起界面收进**三层设计系统**并跟随宿主浅/深主题，润色/校对/体检/批量起草四个真端点接上界面；
  本地看效果用 `npm run preview`（跑真产物 + 真 token，不漂移），**一键写章仍留在会话里**（工具面不缩）。
  项目详情含两个标签：**📋 基本信息**（读章 · 保存 · 导出 · 诊断）与
  **🎧 章节听书**（目录 + 语音连播：从任意章开始听、暂停/继续/停止、读完自动接下一章；
  每行 **📖 阅读 / ▶ 朗读**——阅读卡展开正文可滚动、可顺手切朗读，看与听互相独立；
  Web Speech 合成，正文切块防 Chrome 长文本停摆）。写操作走 `/api/novel-forge` REST。
  **「一键写章 / 润色 / 诊断」需要模型参与**，面板只给引导 —— 真动作在会话里由 `novel_*` 工具完成。
  第五批起，润色/校对/批量起草也有了 REST 入口（`/polish`、`/proofread`、`/draft-batch`），
  它们走**旁路引擎**，不再需要模型先在会话里"开个头"。
- 跨章重复检测是滑动窗口（默认前 10 章，`repetitionWindow` 可调）——超出窗口的复读抓不到；世界书递归激活限 2 轮。
