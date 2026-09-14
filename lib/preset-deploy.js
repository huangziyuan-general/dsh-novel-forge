// lib/preset-deploy.js — 把随包预设幂等部署到 ~/.dsh/.agent-presets/novel-forge/。
//
// 这是插件唯一直接用 node:fs 的地方：预设目录在宿主 home（工作区之外），
// 属于插件基础设施（dsh-novel-solo / dsh-novel-writing 同款做法）。
//
// 部署策略（0.7.0 起从「存在即跳过」升级为**版本感知**）：
//   首次          → 直接部署
//   同版本        → 跳过
//   版本不同      → 逐文件比对：用户没改过的直接更新；改过的先备份 `.user.bak` 再更新
//
// 为什么必须升级：persona 承载写作纪律（如「一次只写一章」），
// 旧的「存在即跳过」会让插件升级带的纪律**永远不生效**——
// 改了源码但用户盘上还是老 persona，等于白改。
//
// 环境变量：DSH_NOVEL_FORGE_REDEPLOY=1 强制覆盖；DSH_NOVEL_FORGE_SKIP_DEPLOY=1 跳过。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export const PRESET_ID = 'novel-forge';

const MANIFEST = '.deploy.json';

/** 文件内容指纹（判断「源变了没」「用户改过没」）。 */
function digest(text) {
    return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function readVersion() {
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf8'));
        return pkg.version ?? 'unknown';
    } catch { return 'unknown'; }
}

function readJson(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { return null; }
}

/**
 * 部署随包预设。
 * @returns {{deployed:boolean, skipped:boolean, reason:string, target:string, version?:string, backups?:string[]}}
 *   只记录不抛——部署失败不该拖垮插件装载。
 */
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

    const version = readVersion();
    const forceDeploy = force || process.env.DSH_NOVEL_FORGE_REDEPLOY === '1';
    const exists = fs.existsSync(targetDir);
    const prev = readJson(path.join(targetDir, MANIFEST));

    // 同版本且非强制 → 无事可做（绝大部分启动走这条）
    if (exists && !forceDeploy && prev?.version === version) {
        return { deployed: false, skipped: true, reason: `预设已是 v${version}`, target: targetDir };
    }

    const entries = fs.readdirSync(sourceDir)
        .filter((f) => { try { return fs.statSync(path.join(sourceDir, f)).isFile(); } catch { return false; } });

    fs.mkdirSync(targetDir, { recursive: true });
    const backups = [];
    for (const entry of entries) {
        const srcPath = path.join(sourceDir, entry);
        const dstPath = path.join(targetDir, entry);
        const srcText = fs.readFileSync(srcPath, 'utf8');

        // 用户手改过的文件：先备份再更新，别静默吞掉他的修改
        if (exists && !forceDeploy && fs.existsSync(dstPath)) {
            const dstText = fs.readFileSync(dstPath, 'utf8');
            const dstHash = digest(dstText);
            const recorded = prev?.files?.[entry];
            const userModified = dstHash !== digest(srcText)
                && (recorded === undefined || dstHash !== recorded);
            if (userModified) {
                const bak = `${dstPath}.user.bak`;
                fs.copyFileSync(dstPath, bak);
                backups.push(bak);
                logger(`预设 ${entry} 被改过，已备份 ${path.basename(bak)} 后更新`);
            }
        }

        fs.copyFileSync(srcPath, dstPath);
    }

    const files = {};
    for (const entry of entries) files[entry] = digest(fs.readFileSync(path.join(sourceDir, entry), 'utf8'));
    fs.writeFileSync(path.join(targetDir, MANIFEST), `${JSON.stringify({
        version, deployedAt: new Date().toISOString(), files,
    }, null, 2)}\n`);

    const reason = !exists
        ? '首次部署'
        : forceDeploy
            ? 'force/REDEPLOY 覆盖'
            : `从 v${prev?.version ?? '未知'} 升级到 v${version}`;
    logger(`预设已部署（${reason}）→ ${targetDir}`);
    return { deployed: true, skipped: false, reason, target: targetDir, version, backups };
}
