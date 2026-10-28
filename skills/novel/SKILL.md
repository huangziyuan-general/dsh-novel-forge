---
name: novel
description: Use when the user asks to write, create, outline, or continue a novel/小说/网文（开书/新书/下一章/续写/细纲/大纲/世界观/人物卡/伏笔/发书），or when novel_* tools or the 锻炉面板 workflow are involved. Enforces dsh-novel-forge discipline: briefing before writing, ledger after every change, stage gates, one chapter at a time.
---

# 小说锻炉工作流

长篇一致性靠工程不靠记忆。所有 novel_* 工具在本插件里；面板（锻炉 tab）是同一套数据的图形入口。

## 首要原则（违反即返工）

1. **一次只写一章**。写完立即停下，向用户汇报本章要点 + 下一章建议，等用户决定。绝不擅自连写。
2. **写前必 briefing，写后必落账**：`novel_briefing` 拿上下文包再动笔；正文里的人物状态变化（境界/位置/持有/关系）通过 `novel_write_chapter` 的 `facts_updates` 落账，并建议带 `facts_evidence`（多行「实体|键|正文原句」）——证据会硬校验**必须逐字摘自本章正文**（忽略空白差异），找不到整章拒绝保存，所以要么照抄原句、要么别传。**认知变化同章声明**：人物初次得知某事、或读者知道了新真相，带 `cognition_updates`（多行「谁|知道|信息」/「谁|不知道|信息」/「读者|知道|信息」）——认知账本会在后续章节的简报里守住「谁知道什么」的边界（信息差、身份保密、伏笔未揭都靠它），简报「人物认知边界」段的「不知道」清单是硬边界，笔下人物绝不能未卜先知。另外：简报 warnings 里出现「硬约束被截断/整块被预算挤掉」时，照告警里的恢复路径（read 原文件 / `novel_ledger query`）补齐来源再动笔，不要按截断版写。
3. **回溯用账本不凭记忆**：引用「第 N 章时」的状态用 `novel_ledger status_at`；查某值哪章改的用 `timeline`；找前文段落用 `novel_search query`（没索引先 build）。
4. **门禁是硬的**：细纲未 approve 不能写章；**每章字数按「本书自定义区间 > 投放平台口径 > 插件默认（2000–4000）」判定**——一律以 `novel_briefing` 的「本章字数目标」段为准，别拿工具描述里的默认数或上一本书的数字硬套（番茄 1500–3000 建议落 2800–2990；起点 2000–4000）；同章被拒 3 次熔断——回去改细纲/场景契约，不要换措辞硬压。
5. **改稿两条通道，按目的选**：自己动笔改稿（含机审驳回后重写同一章）→ `novel_write_chapter`，同章追加新版本、旧版永不覆盖；要把修订登记成等用户批准的提案 → `novel_propose`（只登记，不动正文）。提案的「应用/丢弃」是用户主权动作——提完就停，告诉用户到面板点，绝不说「已生效」；同一章已有 pending 提案时不要重复提。
6. **收尾=纯文字汇报，禁止 present**：正文由 `novel_write_chapter` 落盘即送达（面板立即可见），收尾汇报直接输出文字。不要调用宿主 present 交付章节（真机 85/108 次自拼路径失败并引发输出退化），也不要生成「present 预期失败→跳过」之类的占位步骤——收尾链路里没有这一步。
7. **工具回合零前置说明**：调 `novel_write_chapter` 的那个回合，开头直接调工具（细纲→approve→场景→简报→写章，每步直接发起），一个字的前置说明都不写——单回合输出预算是稀缺资源（输入越大预算越小），前置解释 + 正文挤爆预算 = 工具调用中途截断、整回合白跑（200 章大书实测故障形状）。要说明的话，落盘成功后的收尾汇报里说。
8. **回溯用摘录不整章读**：回合内核对前文优先 `novel_search`（`action:query`，检索词参数名 `q`）拿章号+摘录 / `novel_ledger status_at`、`timeline` 的时点值，不整章 `read` 正文——回合开头读进来的大块文本会一路挤占本回合所有后续步骤的输出预算。
9. **引号用国标弯引号**：正文引号一律“”‘’（一层双线、二层单线交替），禁用直角引号「」『』——GB/T 15834—2011 横排文稿标准（RLHF 养成的直角引号偏好在这里不适用）。写章/提案落盘时会自动转换并在 warnings 计数，但那是兜底。

## 开新书（无书时按序走）

1. `novel_project init`（book/genre/logline 一句话立意）——**开书前先问一句每章字数**：用户给了就写成 `chars: "2500-3500"`（落库成本书事实，之后所有门禁/简报/提案都按它判），给了平台就写 `platform`（qidian/fanqie/jjwxc/qimao/feilu），两个都不要就别传（回落到插件默认口径，不许自己替用户定）。用户中途想改：`novel_project action=chars`。
2. `novel_project promise` 写故事承诺书（本书承诺什么爽点、绝不做的事——每次写章自动注入）
3. 设定固化：`novel_worldbook add`（关键词触发或 always 常驻）；人物 `novel_character save`（多角色同台务必建 voice 语言基因卡：句长/口头禅/禁忌）
4. `novel_outline save_book` 全书大纲
5. 逐章循环：`novel_outline save_chapter`（含 `## 本章必写场景` 与 `## 本章禁止偏离项` 契约段）→ `novel_outline approve` → `novel_scene save`（出场人物/隐藏人物/禁项；有反转要藏时 hidden 人物档案不进上下文、正文出现其名会被拦）→ `novel_write_chapter`（title/content/summary/facts_updates，可选 facts_evidence、cognition_updates）
   - 「必写场景」格式照抄这个样子（拍写在场景行内括号里，或场景行下方的「拍：…」独立行，两种都认；**「：」前的摘要短语要能在正文里逐字出现，拍不要求逐字**）：

     ```markdown
     ## 本章必写场景

     - 渡口夜审：货单对不上，掌柜的汗比话多。（拍：船工当众发难）（拍：账册摊开对笔迹）（拍：一炷香内破绽自现）
     - 巷口追击：有人比马队先到了一步。
       拍：翻墙、截巷、换衣三段跑位
       拍：追到死巷才发现追错人，真目标已出城
     ```
6. 伏笔：`novel_ledger foreshadow_setup` 必带 plan（预计回收章）；回收时 `foreshadow_payoff`。超期未回收优先安排，别开新钩盖旧账。

## 续写已有书

1. `novel_project status` 看阶段/章节/账本概况
2. `novel_briefing` 组上下文包（锚段是语感样本——模仿味道，不抄词句）
3. 按上一节第 5 步逐章循环推进
4. 写完若干章跑 `novel_project check` 全书一致性体检（死人复活/伏笔倒挂/索引缺失）

## 写作纪律

- 先想画面再动笔；情绪用动作/环境/留白暗示，不直写；不用模板句与库存词（`novel_noai_scan` 交稿前扫）
- 续写长篇先 `novel_style build` 建六维基线，交稿前 `check` 对照——出带维度报偏离方向，不把数字翻译成写作规则
- 每 600–900 字一次微兑现（信息/小反转/情绪落点），章末留钩子——但不许用新悬念掩盖旧欠账
- 字数不足被退稿时：把细纲场景写细写透，不是注水

## 质检与发布

- `novel_audit`：platform 按（起点吃长线结构与章末钩子 / 番茄吃前千字爽点）；`censor:true` 发书前必跑（启发式预筛，命中仍须人工复核）
- 机审数字（novel_audit / novel_noai_scan / novel_diagnose）是证据，审稿结论必须引用
- 导出 `novel_export`（md/txt，只允许落到 书/导出/ 内）

## 面板联动

面板按钮（润色/校对/导出/提案应用/批量起草）走旁路引擎，产物一律是提案（用户点「应用」才生效）；批量起草并发的第 2 章起看不到前章正文，连环悬念章不要并行。
