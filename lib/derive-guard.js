// lib/derive-guard.js — 派生面直写守卫（⑥，宿主 tools 服务 guard 通道）。
//
// 存在理由：不变量 1「所有书稿文件读写必须走 ctx.fs」是**开发纪律**，不是**运行期强制**——
// 模型仍可用宿主工具（bash / write / edit）直写书数据文件，绕过版本守卫、台账一致性
// 与审计。事后漂移对账（health.js → novel_project check drift）只能把绕过**显形**，
// 拦不住。本模块在 tools 执行管线的前置层拦：宿主 ToolsService.guard 是**单调拒认**
// （只有拒认、没有放行结果，监听顺序翻不回许可）——非 novel_* 工具对书数据文件的
// 写入被直接拒绝，写派生面的唯一通道回到工具链。
//
// 纯函数（本模块纪律）：判定函数只吃 ToolExecution、返回「拒/放」数据；注册与卸载
// 在 apply 一行（ctx.effect 登记 guard 的 disposer，插件卸载自动注销）。宿主无
// guard 通道时（MCP/测试/旧宿主）apply 跳过注册，降级为事后漂移检测，不牵连 mount。

/** 书数据面提示词清单：目标串里出现即视为书数据文件写入（与 store.js pathsFor 对账——
 * `.novel/` 与 `账本/` 整个目录 + 三个台账/元数据文件名的裸匹配兜底（cd 进目录后的相对写也拦到）。 */
export const DERIVE_HINTS = ['.novel/', '账本/', 'novel.json', 'facts.json', '伏笔.json'];

/**
 * 宿主里真能落文件的工具与参数名（宿主 dsh-tool-bash / dsh-tool-fs 真机核实）：
 * bash 吃 command 命令行，write/edit 吃 file_path。判不出（未知工具 / 缺参）返回 ''。
 */
function writeTargetOf(exec) {
    if (exec?.name === 'bash') return String(exec.arguments?.command ?? '');
    if (exec?.name === 'write' || exec?.name === 'edit') return String(exec.arguments?.file_path ?? '');
    return '';
}

/**
 * 派生面直写拒认判定（ToolGuard 本体，纯函数可直测）。
 * @param exec ToolExecution（name + arguments，宿主管线在 dispatch 前传入）
 * @returns undefined = 放行；{ reason } = 拒认（宿主把 reason 作为该调用的报错文案给模型）
 */
export function derivedWriteDenial(exec) {
    // 插件自有工具豁免：novel_* 是写派生面的合法通道（工具链内部才带版本守卫/台账一致性/审计）。
    if (typeof exec?.name !== 'string' || exec.name.startsWith('novel_')) return undefined;
    const target = writeTargetOf(exec);
    if (target === '') return undefined;
    if (!DERIVE_HINTS.some((h) => target.includes(h))) return undefined;
    return {
        reason: '书的数据文件（.novel/、账本/、novel.json 等）由 novel_* 工具维护——版本守卫、'
            + '台账一致性与审计都在工具链内，直接写会绕过它们并造成派生面漂移。'
            + '请改走工具：检索索引 novel_search build、账本 novel_ledger/novel_relation/novel_arc、'
            + '体检/对账 novel_project check/repair。守卫只拒不放行，确需直写须先卸载本插件。',
    };
}
