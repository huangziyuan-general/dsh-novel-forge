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

## 开发与测试

```bash
npm run setup-dev   # 把宿主 checkout 的 @deepseek-ai/* 真包 symlink 进本地 node_modules（仅本地开发）
npm test            # node --test test/（纯逻辑单测 + 假 fs 冒烟）
```

宿主 SDK 路径来自本机 DSH checkout（scripts/setup-dev-links.mjs 内含路径），不要提交 node_modules。

## 数据落盘（一本书 = 一个目录，位于会话工作区）

见 README.md「数据布局」。机器可读状态只有 novel.json / facts.json / 伏笔.json /
.novel/{audit.jsonl,proposals/}；其余是 Markdown 文档。
