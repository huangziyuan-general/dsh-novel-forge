# MCP 落地指南：在 Claude / Cursor / 任意 MCP 客户端中使用 novel_* 工具

无需安装 DSH 宿主：dsh-novel-forge 自带一个零依赖的 stdio MCP Server，把同一套
`novel_*` 工具（门禁/账本/审计/基线全在工具层）暴露给任意 MCP 客户端。一本小说 =
工作区里的一个目录；所有门禁、账本与审计行为与宿主内完全一致。

## 前置

- **Node.js ≥ 20**。长篇检索索引用到 `node:sqlite`（Node ≥ 22 体验完整；缺席时自动退化为关键词匹配，其余功能不受影响）。
- **dsh-novel-forge ≥ 1.7.2**（`npx` 直跑形态的版本要求；更早版本在宿主外启动有缺陷）。
- 一份小说工作区目录（空目录即可，第一本书用 `novel_project init` 创建）。

## 三种安装形态

下面三种形态任选其一，`env` 一律相同（见下节 `NOVEL_FORGE_ROOT`）。

### A. npx 直跑（推荐，零安装）

```json
{
  "mcpServers": {
    "novel-forge": {
      "command": "npx",
      "args": ["-y", "dsh-novel-forge"],
      "env": { "NOVEL_FORGE_ROOT": "/你的小说工作区" }
    }
  }
}
```

### B. 全局安装后常驻

```bash
npm install -g dsh-novel-forge
```

```json
{
  "mcpServers": {
    "novel-forge": {
      "command": "dsh-novel-forge-mcp",
      "args": [],
      "env": { "NOVEL_FORGE_ROOT": "/你的小说工作区" }
    }
  }
}
```

### C. 源码 clone（开发者）

```bash
git clone https://github.com/huangziyuan-general/dsh-novel-forge.git
```

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

## 分客户端接入

### Claude Code

一行命令接入（默认只进当前项目；加 `-s user` 让所有项目可用）：

```bash
claude mcp add novel-forge -e NOVEL_FORGE_ROOT=/你的小说工作区 -- npx -y dsh-novel-forge
```

### Claude Desktop

编辑配置文件（不在 `mcpServers` 里就新建该键），加入上面任一形态的 JSON，然后重启 Claude Desktop：

- macOS：`~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows：`%APPDATA%\Claude\claude_desktop_config.json`

### Cursor

`~/.cursor/mcp.json` 里加入同一份 `mcpServers` JSON（或 Settings → MCP → Add server 粘贴同样内容），重启 Cursor。

### Codex

`~/.codex/config.toml` 追加：

```toml
[mcp_servers.novel-forge]
command = "npx"
args = ["-y", "dsh-novel-forge"]
env = { NOVEL_FORGE_ROOT = "/你的小说工作区" }
```

### 任意 stdio MCP 客户端

同一份 `mcpServers` JSON（`command` + `args` + `env`）。协议为 JSON-RPC 2.0 over
stdio，零第三方依赖——宿主 peer 包缺席也能启动（输出校验退化为不校验，工具本体照常）。

## NOVEL_FORGE_ROOT（务必显式设置）

- 取值 = 小说工作区根目录；缺省为进程 cwd。
- GUI 客户端（Claude Desktop / Cursor）的 cwd 不可控——不设置会落到安装目录，找不到你的书。

## 验证

接入后在对话里说「列出小说工具」：应看到 **24 个** `novel_*` 工具；再说
「用 novel_project init 建一本测试书」，`NOVEL_FORGE_ROOT` 下出现新书目录即通。

## 能力边界

- **全功能**：写章门禁、机审、账本（事实/关系/弧线/认知/叙事契约）、伏笔、检索、导入导出、克隆、全书体检等零模型工具。
- **受限**：需要旁路模型的工具（一键润色/校对/语义拆书/档案抽取/批量起草的模型调用）在 MCP 通道返回带指引的报错——它们依赖 DSH 宿主的模型路由；提案审批、批量留痕、三路合并等面板可视化也只在 DSH 宿主内。
- **数据安全**：宿主外的 fs 后端带与宿主相同的 containment 与版本守卫语义；书稿只落在你指定的 `NOVEL_FORGE_ROOT` 下。
