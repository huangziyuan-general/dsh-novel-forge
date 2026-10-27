#!/usr/bin/env node
// mcp/server.mjs — dsh-novel-forge 的 MCP 双通道入口（stdio，JSON-RPC 2.0）。
// 零依赖：宿主 peer 包（@deepseek-ai/dsh-tools / schemastery）缺席也能启动——
// 输出校验退化为不校验、Config 走构造壳，工具本体照常（依赖口径见
// lib/tools/define-tool.js 与 lib/mcp-standalone.js 的注释，两处都必须是动态导入）。
//
// 同一套 novel_* 工具（门禁/账本/审计/基线全在工具层），暴露给任意 MCP 客户端：
//   Claude Desktop / Cursor 配置示例：
//   {
//     "mcpServers": {
//       "novel-forge": {
//         "command": "node",
//         "args": ["/path/to/dsh-novel-forge/mcp/server.mjs"],
//         "env": { "NOVEL_FORGE_ROOT": "/你的小说工作区" }
//       }
//     }
//   }
// 工作区根 = NOVEL_FORGE_ROOT 环境变量，缺省为进程 cwd。一本小说 = 工作区里的一个目录。
import { buildStandaloneTools, toInputSchema } from '../lib/mcp-standalone.js';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { version } = require('../package.json');

const root = process.env.NOVEL_FORGE_ROOT ?? process.cwd();
const { tools, call } = await buildStandaloneTools(root);

const toolDefs = tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: toInputSchema(t.parameters),
}));

function reply(id, result) {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function replyError(id, code, message) {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let idx = buffer.indexOf('\n');
    while (idx !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line !== '') handleMessage(line);
        idx = buffer.indexOf('\n');
    }
});
process.stdin.on('end', () => process.exit(0));

function handleMessage(line) {
    let msg;
    try {
        msg = JSON.parse(line);
    } catch {
        return; // 非 JSON 行静默丢弃（MCP stdio 为 newline-delimited JSON）
    }
    const { id, method, params } = msg;
    const isNotification = id === undefined || id === null;

    try {
        switch (method) {
            case 'initialize':
                reply(id, {
                    protocolVersion: params?.protocolVersion ?? '2024-11-05',
                    capabilities: { tools: {} },
                    serverInfo: { name: 'dsh-novel-forge', version },
                });
                return;
            case 'notifications/initialized':
            case 'initialized':
                return; // 通知不回包
            case 'ping':
                reply(id, {});
                return;
            case 'tools/list':
                reply(id, { tools: toolDefs });
                return;
            case 'tools/call': {
                const name = params?.name;
                const args = params?.arguments ?? {};
                call(name, args)
                    .then((result) => {
                        reply(id, {
                            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
                        });
                    })
                    .catch((error) => {
                        reply(id, {
                            content: [{ type: 'text', text: `${error.message}` }],
                            isError: true,
                        });
                    });
                return;
            }
            default:
                if (!isNotification) replyError(id, -32601, `method not found: ${method}`);
        }
    } catch (error) {
        if (!isNotification) replyError(id, -32603, error.message);
    }
}

process.stderr.write(`[dsh-novel-forge-mcp] ready: ${tools.length} tools, workspace=${root}\n`);
