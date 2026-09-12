// lib/tools/define-tool.js — defineTool 兼容垫片。
// 背景：dsh 0.1.5-rc.1 的宿主 defineTool 只读 options.output.render（渲染包装
// 函数永远存在，userRender 为 undefined 时调用即抛
// "output.render failed: userRender is not a function"，导致工具输出被判无效）。
// 本插件历史实现把 render 放在选项顶层，单测（假 fs）不走宿主渲染路径所以没暴露。
// 这里把顶层 render / presentationMeta 归位到 output 下，两种写法都兼容。
import { defineTool as hostDefineTool } from '@deepseek-ai/dsh-tools';

// 宿主同时只读 output.render 与 output.presentationMeta，故两层都做归位，
// 顶层与 output 内两种写法均兼容（output 已有值时不覆盖）。
export function defineTool(options) {
    const { render, presentationMeta, ...rest } = options;
    if (rest.output !== undefined) {
        const out = { ...rest.output };
        if (render !== undefined && out.render === undefined) out.render = render;
        if (presentationMeta !== undefined && out.presentationMeta === undefined) out.presentationMeta = presentationMeta;
        rest.output = out;
    }
    return hostDefineTool(rest);
}
