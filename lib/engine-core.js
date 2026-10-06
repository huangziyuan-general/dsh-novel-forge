// lib/engine-core.js — 旁路引擎的**纯逻辑区**（从 engine.js 抽出）。
//
// 这里零 IO、不碰宿主 ctx、不 import @deepseek-ai/*：常量、流式收集器、结束原因判定、
// 退避公式、消息字面量、错误人话映射都能在纯 node 下单测。
// 宿主装配（createEngine / 服务解析 / 重试循环）留在 engine.js。

/** 宿主 setTimeout 的上限（对齐 @deepseek-ai/dsh-timeout 的 MAX_TIMER_DELAY_MS）。 */
export const MAX_TIMER_DELAY_MS = 2147483647;

/** 通道名。通道分离只能在插件自己这层做——`GenerateOptions.purpose` 是封闭联合，不是插件分类槽。 */
export const CHANNEL_NAMES = ['polish', 'proofread', 'annotate', 'draft'];

/** parent 锚定落空后的重试等待：宿主 agent 注册表是懒注册的（重启后逐个出现）。 */
export const PARENT_RETRY_DELAY_MS = 2000;

/**
 * 每通道的默认预算。都是「一次调用」的量级，故意给得宽松：
 * 润色是整章输出、起草是整章生成，超时按分钟算；打标是短输出，压到 60s。
 * 重试次数不在这里——它是全局 engine.retries，只能被通道覆写（单一旋钮比九处默认好懂）。
 */
export const CHANNEL_DEFAULTS = {
    // 0.13.2 真机复诊（三轮收敛）：8192 → 16384 → **不设限**。maxTokens: 0 = 插件
    // 不传输出上限，子代理继承宿主按模型校准的默认（宿主自己写整章从不截断，它才是
    // 权威）；插件猜一个大数只会截断推理模型——思考 token 和整章重写都占这个额度，
    // 多大的猜测都可能烧穿。显式配置 engine.channels.*.maxTokens 正整数才设限；
    // annotate 保留 512：短标签任务，截断无害且控成本。timeoutMs 600s 是给长文
    // 通道的真实生成时间（16k 输出 @ 40-70 tok/s 要 4-7 分钟）。
    polish: { maxTokens: 0, timeoutMs: 600000 },
    proofread: { maxTokens: 0, timeoutMs: 600000 },
    annotate: { maxTokens: 512, timeoutMs: 60000 },
    draft: { maxTokens: 0, timeoutMs: 600000 },
};

/** 全局默认重试次数（engine.retries 未配时生效）。 */
export const DEFAULT_RETRIES = 2;

/** 通道用途说明——报错与审计里给人看的话。 */
export const CHANNEL_LABELS = {
    polish: '润色（整章改写提案）',
    proofread: '机械校对（错别字/标点/易混字）',
    annotate: '打标（检索索引）',
    draft: '起草（整章生成）',
};

export const RETRYABLE_FAILURE_CODES = new Set([
    'RATE_LIMIT', 'NETWORK', 'PROVIDER_UNAVAILABLE', 'SERVER_ERROR',
    'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'EPIPE', 'FETCH_FAILED',
    'EMPTY_RESPONSE',
]);

// ── 纯函数区（可单测，无 IO 无宿主）─────────────────────────────────────────

/**
 * 给一个上游 signal 套上超时，返回可释放的 {signal, dispose}。
 * 对齐宿主 deadline() 的语义：超时以 reason 携带 code 中断（而不是静默 abort），
 * 这样上层能分清「用户取消」和「调用超时」。
 */
export function deadline(upstream, timeoutMs, code = 'ENGINE_TIMEOUT') {
    if (!(timeoutMs > 0) || !Number.isFinite(timeoutMs)) {
        return { signal: upstream ?? new AbortController().signal, dispose() {} };
    }
    if (timeoutMs > MAX_TIMER_DELAY_MS) {
        throw new Error(`engine: timeoutMs 不能超过 ${MAX_TIMER_DELAY_MS}`);
    }
    const timer = new AbortController();
    const id = setTimeout(() => {
        const err = new Error(`模型调用超时（${Math.round(timeoutMs / 1000)} 秒无结果）`);
        err.name = 'TimeoutError';
        err.code = code;
        timer.abort(err);
    }, timeoutMs);
    return {
        signal: upstream !== undefined ? AbortSignal.any([upstream, timer.signal]) : timer.signal,
        dispose() { clearTimeout(id); },
    };
}

/** 把流式 chunk 拼成文本块与结束原因。等价于宿主的 BlockAssembler，但零依赖、更薄。 */
export class StreamCollector {
    constructor() {
        this._parts = new Map();
        this._order = [];
        this._finish = null;
        this._usage = null;
        this._toolCalls = 0;
    }

    push(chunk) {
        if (chunk === null || typeof chunk !== 'object') return;
        switch (chunk.type) {
            case 'block-start':
                if (!this._parts.has(chunk.index)) {
                    this._order.push(chunk.index);
                    this._parts.set(chunk.index, { type: chunk.blockType, text: '' });
                }
                return;
            case 'text-delta':
            case 'reasoning-delta': {
                const type = chunk.type === 'text-delta' ? 'text' : 'reasoning';
                let part = this._parts.get(chunk.index);
                if (part === undefined) {
                    this._order.push(chunk.index);
                    part = { type, text: '' };
                    this._parts.set(chunk.index, part);
                }
                part.text += String(chunk.text ?? '');
                return;
            }
            case 'tool-call-delta':
                this._toolCalls += 1;
                return;
            case 'block-end':
                if (chunk.block?.type === 'tool-call') this._toolCalls += 1;
                return;
            case 'usage':
                this._usage = chunk.usage ?? null;
                return;
            case 'finish':
                this._finish = chunk.reason ?? { kind: 'stop' };
                return;
            default:
                return;
        }
    }

    /** 正文块按流序拼接（推理块不计入）。 */
    get text() {
        return this._order
            .map((i) => this._parts.get(i))
            .filter((p) => p !== undefined && p.type === 'text')
            .map((p) => p.text)
            .join('');
    }

    get reasoning() {
        return this._order
            .map((i) => this._parts.get(i))
            .filter((p) => p !== undefined && p.type === 'reasoning')
            .map((p) => p.text)
            .join('');
    }

    /** 结束原因；流没给就按 stop 处理（对齐宿主 BlockAssembler 的兜底）。 */
    get finish() {
        return this._finish ?? { kind: 'stop' };
    }

    get usage() {
        return this._usage;
    }

    get toolCallCount() {
        return this._toolCalls;
    }
}

/**
 * 结束原因 → 处置结论。**不能一律重试**：输出被截断时重试同样截断。
 * @returns {ok, kind, retryable, code, message, advice}
 */
export function classifyFinish(finish) {
    const kind = finish?.kind ?? 'stop';
    switch (kind) {
        case 'stop':
            return { ok: true, kind, retryable: false, code: null, message: '', advice: '' };
        case 'max-tokens':
            return {
                ok: false, kind, retryable: false, code: 'TRUNCATED',
                message: '模型输出达到 maxTokens 被截断——重试只会再截断一次',
                advice: '把任务拆小（分批润色/分段起草）或调高该通道的 maxTokens',
            };
        case 'aborted':
            return {
                ok: false, kind, retryable: false, code: 'ABORTED',
                message: finish?.failure?.message ?? '调用被取消或超时中断',
                advice: '面板重新发起即可；若反复超时，调高该通道的 timeoutMs',
            };
        case 'tool-calls':
            return {
                ok: false, kind, retryable: false, code: 'TOOL_CALLS',
                message: '模型在纯文本工序里请求调用工具（跑偏了）',
                advice: '重发一次；若稳定复现，说明提示词里混进了工具调用指令',
            };
        case 'error': {
            const failure = finish?.failure ?? {};
            const code = String(failure.code ?? 'PROVIDER_ERROR');
            return {
                ok: false, kind, retryable: RETRYABLE_FAILURE_CODES.has(code), code,
                message: failure.message ?? '模型服务返回错误',
                advice: RETRYABLE_FAILURE_CODES.has(code) ? '可重试的瞬时故障' : '这类错误重试无意义，先查路由与凭证',
            };
        }
        default:
            return {
                ok: false, kind, retryable: false, code: 'UNKNOWN_FINISH',
                message: `无法识别的结束原因「${kind}」`,
                advice: '可能是宿主协议变了，升级插件或提 issue',
            };
    }
}

/** 指数退避 + 抖动（抖动避免 N 章并发同时重试把服务打穿）。 */
export function retryDelayMs(attempt, { base = 400, cap = 6000, rand = Math.random } = {}) {
    const exp = Math.min(cap, base * 2 ** Math.max(0, attempt - 1));
    return Math.round(exp / 2 + rand() * (exp / 2));
}

/** 拼一条插件身份的 user 消息（消息级归因，宿主据此记账/审计）。 */
export function buildUserMessage(text, pluginId = 'dsh-novel-forge') {
    return {
        id: `${pluginId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        role: 'user',
        content: [{ type: 'text', text: String(text ?? '') }],
        source: { kind: 'plugin', plugin: pluginId },
    };
}

/** 抛出来的错误 → 人话 {code, message, advice}。面板要能直接展示。 */
export function describeEngineError(error) {
    const raw = error?.code !== undefined && error.code !== null ? String(error.code) : '';
    const detail = error?.message ?? String(error);
    const map = {
        AUTH: ['凭证无效', '当前 provider 的 API key 被拒——请在 dsh 里重新登录或换 provider'],
        INVALID_CREDENTIAL: ['凭证无效', '同上：重配 API key'],
        NO_ADAPTER: ['路由没有可用适配器', '当前 provider/model 组合找不到后端——检查 dsh 的模型配置'],
        QUOTA_EXCEEDED: ['额度用尽', '换 provider 或等额度恢复；这类错误重试无效'],
        RATE_LIMIT: ['触发限流', '稍后重试；并发起草请降到 1–2'],
        CONTEXT_WINDOW_EXCEEDED: ['输入超出模型上下文窗口', '缩减输入（分段润色 / 缩短细纲）后重试'],
        ENGINE_TIMEOUT: ['调用超时', '调高该通道 timeoutMs，或把任务拆小'],
        ECONNRESET: ['网络连接被重置', '检查网络后重试'],
        ENOTFOUND: ['域名解析失败', '检查网络 / 代理设置'],
    };
    if (map[raw] !== undefined) {
        return { code: raw, message: map[raw][0], advice: map[raw][1], detail };
    }
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
        return { code: raw || 'ABORTED', message: '调用被取消或超时中断', advice: '重新发起即可', detail };
    }
    return { code: raw || 'ENGINE_FAILURE', message: detail, advice: '把这条错误连同通道名一起反馈，便于定位', detail };
}
