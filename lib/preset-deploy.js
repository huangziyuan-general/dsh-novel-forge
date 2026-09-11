// lib/preset-deploy.js — 把随包预设幂等部署到 ~/.dsh/.agent-presets/novel-forge/。
//
// 这是插件唯一直接用 node:fs 的地方：预设目录在宿主 home（工作区之外），
// 属于插件基础设施（dsh-novel-solo / dsh-novel-writing 同款做法）。
// 幂等：目标已存在则跳过（永不覆盖用户改过的预设）；
// DSH_NOVEL_FORGE_REDEPLOY=1 强制覆盖；DSH_NOVEL_FORGE_SKIP_DEPLOY=1 跳过。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const PRESET_ID = 'novel-forge';

/** 返回 { deployed, skipped, reason, target }；只记录，不抛——部署失败不拖垮插件装载。 */
export function deployPreset({ force = false, logger = () => {} } = {}) {
    const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
    const targetDir = path.join(home, '.agent-presets', PRESET_ID);
    const sourceDir = path.join(import.meta.dirname, 'preset', PRESET_ID);

    if (process.env.DSH_NOVEL_FORGE_SKIP_DEPLOY === '1') {
        return { deployed: false, skipped: true, reason: 'DSH_NOVEL_FORGE_SKIP_DEPLOY=1', target: targetDir };
    }
    if (!fs.existsSync(sourceDir)) {
        return { deployed: false, skipped: true, reason: `随包预设缺失：${sourceDir}`, target: targetDir };
    }
    if (fs.existsSync(targetDir) && !(force || process.env.DSH_NOVEL_FORGE_REDEPLOY === '1')) {
        return { deployed: false, skipped: true, reason: '目标已存在（保留用户改动；重装可用 DSH_NOVEL_FORGE_REDEPLOY=1）', target: targetDir };
    }

    fs.mkdirSync(targetDir, { recursive: true });
    for (const entry of fs.readdirSync(sourceDir)) {
        fs.copyFileSync(path.join(sourceDir, entry), path.join(targetDir, entry));
        logger(`已部署预设文件 ${entry} → ${targetDir}`);
    }
    return { deployed: true, skipped: false, reason: force ? 'force/REDEPLOY 覆盖' : '首次部署', target: targetDir };
}
