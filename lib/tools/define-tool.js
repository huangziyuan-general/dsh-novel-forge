// lib/tools/define-tool.js — defineTool 兼容垫片。
// 背景：dsh 0.1.5-rc.1 的宿主 defineTool 只读 options.output.render（渲染包装
// 函数永远存在，userRender 为 undefined 时调用即抛
// "output.render failed: userRender is not a function"，导致工具输出被判无效）。
// 本插件历史实现把 render 放在选项顶层，单测（假 fs）不走宿主渲染路径所以没暴露。
// 这里把顶层 render / presentationMeta 归位到 output 下，两种写法都兼容。
import { defineTool as hostDefineTool } from '@deepseek-ai/dsh-tools';

export function defineTool(options) {
    const { render, ...rest } = options;
    if (render !== undefined && rest.output !== undefined && rest.output.render === undefined) {
        rest.output = { ...rest.output, render };
    }
    return hostDefineTool(rest);
}
