// test/derive-guard.test.mjs — 派生面直写守卫（宿主 tools guard 通道）。
//
// 两条红线：
//   · 判定纯函数：novel_* 豁免 / 宿主写工具命中书数据面提示词才拒 / 判不出目标放行
//     （宁漏勿误拒——误拒宿主合法写文件比漏拦更伤）；
//   · 接线层真登记：apply 经 ctx.effect 把 guard 挂进宿主 tools 服务（宿主真机契约：
//     guard 登记返回卸载 disposer；替身已按宿主 ToolsService 镜像，见 helpers/plugin.mjs）。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { derivedWriteDenial, DERIVE_HINTS } from '../lib/derive-guard.js';
import { bootPlugin } from './helpers/plugin.mjs';

test('★ derivedWriteDenial：novel_* 全豁免（合法写派生面的唯一通道）', () => {
    // 即使目标串里全是书数据面提示词，novel_* 也放行（工具链内部才带守卫/审计）
    assert.equal(derivedWriteDenial({ name: 'novel_search', arguments: { } }), undefined);
    assert.equal(
        derivedWriteDenial({ name: 'novel_ledger', arguments: { book: '某书' } }),
        undefined,
    );
    assert.equal(derivedWriteDenial(null), undefined, 'exec 缺失一律放行（不拦未知形状）');
});

test('★ derivedWriteDenial：宿主写工具命中书数据面即拒', () => {
    // bash：命令行里写账本目录 / .novel 目录 / 台账文件名（绝对或相对路径都拦到）
    for (const target of [
        'echo x > 某书/账本/facts.json',
        'echo x >> 某书/账本/facts.json',
        'node -e "fs.writeFileSync(\'某书/.novel/audit.jsonl\', \'\')"',
        'rm -f 某书/.novel/index.db',
        'printf a > 某书/facts.json',
        'cp 备份 某书/伏笔.json',
    ]) {
        const d = derivedWriteDenial({ name: 'bash', arguments: { command: target } });
        assert.ok(d !== undefined && typeof d.reason === 'string', `必须拒：${target}`);
    }
    // write / edit：file_path 命中即拒
    const w = derivedWriteDenial({ name: 'write', arguments: { file_path: '某书/.novel/style-whitelist.json', content: '[]' } });
    assert.ok(w !== undefined, 'write 到 .novel/ 必须拒');
    const e = derivedWriteDenial({ name: 'edit', arguments: { file_path: '某书/账本/facts.json', old_string: 'a', new_string: 'b' } });
    assert.ok(e !== undefined, 'edit 账本文件必须拒');
});

test('★ derivedWriteDenial：不命中书数据面放行（宁漏勿误拒）', () => {
    for (const target of [
        'npm test',
        'echo 夜色落进纸里 > 手稿.md',
        'mkdir -p ~/notes && touch ~/notes/a.txt',
        'cat 某书/正文/第1章.md', // 只读正文 Markdown 不在守卫面（守卫只管数据面）
    ]) {
        assert.equal(
            derivedWriteDenial({ name: 'bash', arguments: { command: target } }),
            undefined,
            `必须放行：${target}`,
        );
    }
    assert.equal(derivedWriteDenial({ name: 'write', arguments: { file_path: 'notes/a.md', content: 'x' } }), undefined);
    assert.equal(derivedWriteDenial({ name: 'bash', arguments: {} }), undefined, '缺参判不出目标 → 放行');
    assert.equal(derivedWriteDenial({ name: 'read', arguments: { file_path: '某书/novel.json' } }), undefined, '非宿主写工具（read）不在判定面 → 放行');
});

test('DERIVE_HINTS 与 store.js 数据面同源（提示词清单漂移即误放/误拦）', () => {
    // .novel/ 与 账本/ 两个目录 + 三个文件裸名（cd 进书目录后的相对写兜底）
    const got = new Set(DERIVE_HINTS);
    const want = ['.novel/', '账本/', 'novel.json', 'facts.json', '伏笔.json'];
    assert.equal(got.size, 5, `清单应恰 5 项（防增删漏更新本测试）：${[...got].join('、')}`);
    for (const h of want) assert.ok(got.has(h), `缺：${h}`);
});

test('★ 接线层：apply 经 ctx.effect 把 guard 真登记进宿主 tools 服务', async () => {
    const p = await bootPlugin();
    try {
        assert.equal(p.guards.length, 1, 'apply 必须登记且只登记一条派生面守卫');
        const guard = p.guards[0];
        // 登记进宿主的就是判定本体（拒绝理由里指路到工具链）
        const denial = guard({ name: 'bash', arguments: { command: 'echo x > 某书/账本/facts.json' } });
        assert.ok(denial !== undefined, '接线后的守卫必须真拦');
        assert.match(denial.reason, /novel_/, '拒绝文案必须指回工具链');
        // 宿主 guard 契约：登记返回的 disposer 注销后，同函数不再在册（替身镜像真机）
        assert.equal(typeof p.ctx.tools.guard(guard), 'function');
    } finally {
        p.cleanup();
    }
});
