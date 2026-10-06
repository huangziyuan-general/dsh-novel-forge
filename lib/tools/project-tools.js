// lib/tools/project-tools.js — 书目四件套 barrel。
// 实现按工具拆到 project-tool / outline-tool / character-tool / worldbook-tool；
// 这里只做转出，保持 lib/index.js 的导入点不变。

export { defineProjectTool } from './project-tool.js';
export { defineOutlineTool } from './outline-tool.js';
export { defineCharacterTool } from './character-tool.js';
export { defineWorldbookTool } from './worldbook-tool.js';
