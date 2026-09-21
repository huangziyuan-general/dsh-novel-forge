---
name: novel
description: Use when the user asks to write, create, outline, or continue a novel/小说/网文（开书/新书/下一章/续写/细纲/大纲/世界观/人物卡/伏笔/发书），or when novel_* tools or the 锻炉面板 workflow are involved. Enforces dsh-novel-forge discipline: briefing before writing, ledger after every change, stage gates, one chapter at a time.
---

# 小说锻炉工作流

长篇一致性靠工程不靠记忆。所有 novel_* 工具在本插件里；面板（锻炉 tab）是同一套数据的图形入口。

## 首要原则（违反即返工）

1. **一次只写一章**。写完立即停下，向用户汇报本章要点 + 下一章建议，等用户决定。绝不擅自连写。
2. **写前必 briefing，写后必落账**：`novel_briefing` 拿上下文包再动笔；正文里的人物状态变化（境界/位置/持有/关系）通过 `novel_write_chapter` 的 `facts_updates` 落账。
3. **回溯用账本不凭记忆**：引用「第 N 章时」的状态用 `novel_ledger status_at`；查某值哪章改的用 `timeline`；找前文段落用 `novel_search query`（没索引先 build）。
4. **门禁是硬的**：细纲未 approve 不能写章；字数 2000–4000；同章被拒 3 次熔断——回去改细纲/场景契约，不要换措辞硬压。
5. **修改已存章走 `novel_propose`**（生成提案，永不覆盖旧版）。提案的「应用」是用户主权动作——提完就停，告诉用户到面板点「应用」，绝不说「已生效」。

## 开新书（无书时按序走）

1. `novel_project init`（book/genre/logline 一句话立意）
2. `novel_project promise` 写故事承诺书（本书承诺什么爽点、绝不做的事——每次写章自动注入）
3. 设定固化：`novel_worldbook add`（关键词触发或 always 常驻）；人物 `novel_character save`（多角色同台务必建 voice 语言基因卡：句长/口头禅/禁忌）
4. `novel_outline save_book` 全书大纲
5. 逐章循环：`novel_outline save_chapter`（含 `## 本章必写场景` 与 `## 本章禁止偏离项` 契约段）→ `novel_outline approve` → `novel_scene save`（出场人物/隐藏人物/禁项；有反转要藏时 hidden 人物档案不进上下文、正文出现其名会被拦）→ `novel_write_chapter`（title/content/summary/facts_updates）
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
