#!/usr/bin/env node
// scripts/setup-dev-links.mjs — 本地开发辅助：
// 把 DSH checkout 里 @deepseek-ai/* 真包 symlink 进本项目 node_modules，
// 让单元测试能 import 宿主真实的 defineTool / FsError / schemastery。
// 仅本地开发用，node_modules 不入库。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');
const checkout = process.env.DSH_CHECKOUT
    ?? '/Users/huangshengju/.npm-global/lib/node_modules/@deepseek-ai/dsh';
const sdkDir = path.join(checkout, 'node_modules', '@deepseek-ai');

if (!fs.existsSync(sdkDir)) {
    console.error(`找不到宿主 SDK：${sdkDir}（可用 DSH_CHECKOUT 环境变量覆盖）`);
    process.exit(1);
}

const needed = ['dsh-tools', 'dsh-fs', 'schemastery', 'cordis', 'cosmokit', 'dsh-llm'];
const targetRoot = path.join(projectRoot, 'node_modules', '@deepseek-ai');
fs.mkdirSync(targetRoot, { recursive: true });

for (const name of needed) {
    const src = path.join(sdkDir, name);
    const dest = path.join(targetRoot, name);
    if (!fs.existsSync(src)) {
        console.warn(`跳过（宿主无此包）：${name}`);
        continue;
    }
    fs.rmSync(dest, { force: true });
    fs.symlinkSync(src, dest, 'dir');
    console.log(`linked @deepseek-ai/${name} → ${src}`);
}
console.log('完成。npm test 可用。');
