// lib/engine.js — D1 · 旁路直调引擎。
//
// 面板的「一键润色 / 一键校对」今天返 501（需要模型参与，请在聊天里调）。这条链路的
// 真实代价不是「没法做」，而是**内部工序反噬主对话**：校对往返把会话窗口塞满、烧主额度、
// 还把创作主线淹没在「这里改成 X」的噪音里。引擎就是把这个回路从会话里搬出来。
//
// 三条边界（都是核过宿主接口后的结论，不是推测）：
//   ① **dsh 内不需要配 key**。宿主已把模型开成服务：`ctx.llm.stream(options)`（waterfall
//      可拦截），`ctx.agentDefaultModel` 给出用户已配好的路由。MCP 独立模式（无宿主）才需要
//      真·独立 key + 裸 HTTP —— 那是后端 B，本文件只实现后端 A，接口留好。
//   ② **不注入 `llm` 服务**。cordis 的 `inject` 只有必选没有可选（对象形态是拦截配置，不是
//      {required, optional}），注进去等于「宿主缺 llm 就整个插件不加载」。这里改为**调用时自检**
//      + 优雅降级，插件在无宿主环境下依然能装能跑其它工具。
//   ③ **宿主不给旁路调用重试**。`dsh-llm-retry` 挂在 agent loop 的请求恢复点上，手搓的调用
//      不吃这套 → 超时 / 退避重试 / 取消 / 按 finish.kind 分流全得自带。
//
// 本文件刻意**零宿主依赖**（不 import @deepseek-ai/dsh-llm）：消息字面量自己拼、流式自己累加。
// 这样它在纯 node 下可单测，也不会因为宿主包不在 node_modules 里而加载失败。

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

const RETRYABLE_FAILURE_CODES = new Set([
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

// ── 引擎实例 ────────────────────────────────────────────────────────────────

/**
 * 建引擎。ctx 缺 llm 服务时**不抛错**，只标记不可用——插件的其它 20 个工具照常用。
 *
 * @param ctx        cordis 上下文（只读 ctx.llm / ctx.agentDefaultModel）
 * @param config     插件配置（config.engine.channels / retries / attachSession）
 * @param logger     可选 logger
 * @param sleep      可注入（测试里跳过真实等待）
 * @param rand       可注入（测试里去掉抖动随机性）
 */
export function createEngine({ ctx, config = {}, logger = null, sleep = null, rand = Math.random } = {}) {
    const cfg = config.engine ?? {};
    const channels = cfg.channels ?? {};
    const globalRetries = Number.isInteger(cfg.retries) && cfg.retries >= 0 ? cfg.retries : DEFAULT_RETRIES;
    const attachSession = cfg.attachSession === true;
    const wait = sleep ?? ((ms) => new Promise((resolve) => { setTimeout(resolve, ms); }));

    /**
     * cordis 读服务：服务**已注册**（在任何可达 fiber 的 store 里）即可解析，无需 inject；
     * **未注册时属性访问直接抛错**（"cannot get property X without inject"）——
     * 装配期（boot）宿主服务大多还没注册，所以这里必须捕获并把抛错当作「暂时缺失」。
     * 可用性的判定因此天然是**调用时**的：boot 时探测会得到 false，跑起来后就是真值。
     */
    const readService = (prop) => {
        try {
            const direct = ctx?.[prop];
            if (direct !== undefined) return direct;
            if (typeof ctx?.get === 'function') return ctx.get(prop);
        } catch { /* cordis: 未注册/未 inject 的属性访问会抛 —— 视为缺失 */ }
        return undefined;
    };

    /** 宿主 LLM 服务。取不到（未注册/无此服务）就当没有。 */
    const llmService = () => {
        const direct = readService('llm');
        if (direct !== undefined && direct !== null && typeof direct.stream === 'function') return direct;
        return null;
    };

    /**
     * 备用传输：subagents 服务（dsh-subagent）。
     *
     * 0.13.1 真机实测：web profile 里 `llm` 服务不在根 fiber（第三方插件无一例外全走
     * subagents——mnemon 的 inject 就是证据），novel-forge 挂在根上，`ctx.llm` 永远解析
     * 不到 → 润色/校对恒 ENGINE_UNAVAILABLE。subagents 才是根级服务，子代理的
     * `result.output` 给最终助手文本，agentOptions 可带 provider/model/maxTokens。
     * 这里做**特征探测**（typeof start === 'function'），缺服务时照样优雅降级。
     */
    const subagentService = () => {
        try {
            // 走 readService（属性 + ctx.get 双路）：inject 声明让宿主把服务物化到
            // 插件 ctx；个别宿主版本只把服务挂作用域链——get() 才解析得到。
            const s = readService('subagents');
            if (s !== undefined && s !== null && typeof s.start === 'function') return s;
        } catch { /* cordis：未注册服务的属性访问会抛 —— 视为缺失 */ }
        return null;
    };

    const unavailableReason = () => (llmService() === null && subagentService() === null
        ? '宿主未提供模型服务（ctx.llm 与 subagents 都不可用）——MCP 独立模式或引擎未就绪。请在聊天中调用对应工具，或配置独立 key 后走 directHttp 后端。'
        : null);

    /** 从子代理结果里抽最终文本（output / lastAssistantMessage 是 content-block 数组）。 */
    const subagentText = (result) => {
        const out = result?.output ?? result?.lastAssistantMessage;
        if (Array.isArray(out)) return out.map((b) => (typeof b === 'string' ? b : b?.text ?? '')).join('');
        if (typeof out === 'string') return out;
        return '';
    };

    /**
     * 经 subagents 跑一次调用。start(provider, opts) → run；run.result →
     * { stopReason, output? }。'completed' 即成功。特征探测失败或 API 变形
     * 都返回**结构化失败**（面板展示人话），绝不抛。
     */
    async function runViaSubagent(channel, subagents, { system, prompt, maxTokens, timeoutMs, signal, sessionId, sessionIds }) {
        const budget = budgetFor(channel);
        const tokenCap = Number.isInteger(maxTokens) && maxTokens > 0 ? maxTokens : budget.maxTokens;
        const limitMs = Number.isInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : budget.timeoutMs;
        // 通道显式配了 provider+model 就带给子代理；没配就让子代理继承宿主默认路由
        const route = routeFor(channel);
        const routeView = route ?? { provider: '(inherited)', model: '(inherited)', source: 'subagent' };
        const attempts = 1;
        // ⚠️ parent 是宿主 start 请求的**必填**字段（SubagentStartRequest.parent：
        // 「派生 workspace、谱系、委托深度」）——0.13.2 真机事故：不传 parent，
        // startInProcessRun → resolveChildDepth(undefined) 读 .options 直接 TypeError，
        // 且 rejection 无人接会把整个 dsh web 进程打挂（"fatal load failure"）。
        // 父 agent 解析走**候选链**（agent id 与 session id 同源）：
        //   ① 显式 sessionId（面板当前会话，REST 层穿进来）
        //   ② sessionIds 候选（书自己的归属会话——创建它的会话 agent 大概率活着，
        //      且其工作区必然是书所在工作区，语义上比「当前会话」更正确）
        //   ③ **按需物化**：候选会话没驻留时 agents.resume({resumeSessionId}) 把
        //      持久化会话的 agent 拉起来（等价于 web 应用后台打开这条会话），返回的
        //      handle 直接当 parent。0.13.2 真机复诊：孙宇测试会话存在、agent 不在册
        //      ——get 永远落空；面板旁路调用不能指望用户恰好开着书所在会话。
        //   ④ currentInitiator()（会话内工具路径：打标/检索处在宿主的发起边界里；
        //      REST 处理器不在任何发起边界，这里天然 undefined，不会误挂别人的会话）
        // ⚠️ 注册表是**懒注册 + 会退出**的（真机实测：重启后 agent 逐个出现、
        // 会话关闭即消失）——整链落空时等 2 秒把 get/resume 再走一轮。
        const agents = readService('agents');
        const candidates = [typeof sessionId === 'string' ? sessionId : '', ...(Array.isArray(sessionIds) ? sessionIds : [])]
            .filter((id, i, arr) => typeof id === 'string' && id !== '' && arr.indexOf(id) === i);
        // 诊断账：锚定失败时报错必须能自己说出「哪一层没通过」——否则每轮排查都要
        // 重新猜（0.13.2 两轮真机复诊的教训：静默吞掉的 resume 异常让根因晚现一轮）。
        const diag = [];
        if (typeof agents?.get !== 'function' && typeof agents?.resume !== 'function') {
            diag.push('agents 服务不可解析（readService 落空）——检查插件 inject 是否声明 agents');
        }
        let lastResumeError = '';
        const tryGet = (id) => {
            try { return typeof agents?.get === 'function' ? (agents.get(id) ?? null) : null; } catch { return null; }
        };
        const tryResume = async (id) => {
            try {
                if (typeof agents?.resume !== 'function') return null;
                const h = await agents.resume({ resumeSessionId: id, ...(signal ? { signal } : {}) });
                return h ?? null;
            } catch (e) {
                lastResumeError = String(e?.message ?? e).slice(0, 160);
                return null;
            }
        };
        const anchorChain = async () => {
            for (const id of candidates) {
                const a = tryGet(id);
                if (a !== null) return a;
            }
            for (const id of candidates) {
                const h = await tryResume(id);
                if (h !== null) {
                    try { logger?.info?.(`[novel-forge] ${channel} 父 agent 按需物化：${id.slice(0, 16)}…`); } catch { /* 日志失败不影响主流程 */ }
                    return h;
                }
            }
            try { return typeof agents?.currentInitiator === 'function' ? (agents.currentInitiator() ?? null) : null; } catch { return null; }
        };
        let parent = await anchorChain();
        if (parent === null && candidates.length > 0) {
            await wait(PARENT_RETRY_DELAY_MS);
            parent = await anchorChain();
        }
        if (parent === null) {
            // 报错带上实际试过哪些 id（截断）——「面板没传」和「传了但物化不了」一眼分清
            const got = candidates.length > 0
                ? '试过 ' + candidates.length + ' 个会话 id（' + candidates.map((s) => s.slice(0, 16)).join('、') + '…），注册表查询与按需物化（resume）都未拿到活动 agent'
                : '没拿到任何可锚定的会话 id';
            if (lastResumeError !== '') diag.push('resume 失败：' + lastResumeError);
            const suffix = diag.length > 0 ? '（诊断：' + diag.join('；') + '）' : '';
            return { ok: false, attempts, route: routeView, error: { code: 'NO_PARENT_AGENT', message: '模型调用需要锚定一个父会话（子代理要从父会话继承工作区与谱系）：' + got + '，当前也不在任何会话的执行边界里。' + suffix, advice: '按「诊断」段处理：agents 不可解析→重启 dsh 并确认插件版本；resume 失败→把报错原样发给维护者。' } };
        }
        try {
            const call = deadline(signal, limitMs, 'ENGINE_TIMEOUT');
            const aborted = new Promise((resolve) => {
                if (call.signal.aborted === true) resolve('__abort__');
                else call.signal.addEventListener('abort', () => resolve('__abort__'), { once: true });
            });
            let result;
            try {
                // 必须 awaited：start() 会做能力校验/发布，任何 rejection 都要进下面的
                // catch 变结构化失败——裸调不 await 的 rejection 是 unhandled，宿主进程直接退。
                const handle = await subagents.start('spawn', {
                    label: `novel-forge:${channel}`,
                    parent,
                    prompt: [{ type: 'text', text: prompt }],
                    ...(system ? { persona: system } : {}),
                    maxDepth: 1,
                    toolFilter: { allow: [] },   // 纯文本任务：子代理不带任何工具
                    signal: call.signal,
                    agentOptions: {
                        // tokenCap=0 时不传 maxTokens：继承宿主按模型校准的默认上限
                        //（推理模型的思考 token 也占输出额度，插件猜数只会截断）
                        ...(tokenCap > 0 ? { maxTokens: tokenCap } : {}),
                        ...(route !== null ? { provider: route.provider, model: route.model } : {}),
                    },
                });
                result = await Promise.race([handle.result, aborted]);
            } finally {
                call.dispose();
            }
            if (result === '__abort__' || call.signal.aborted === true) {
                const reason = call.signal.reason;
                const code = signal?.aborted === true ? 'ABORTED' : 'ENGINE_TIMEOUT';
                return { ok: false, attempts, route: routeView, error: { code, message: code === 'ABORTED' ? '用户取消了本次调用' : `子代理调用超时（${Math.round(limitMs / 1000)}s）`, advice: code === 'ABORTED' ? '重新发起即可' : '在插件配置里调大该通道 timeoutMs' } };
            }
            if (result?.stopReason === 'max-tokens') {
                return { ok: false, attempts, route: routeView, error: { code: 'OUTPUT_TRUNCATED', message: tokenCap > 0
                    ? `子代理在 ${tokenCap} 输出 token 内没写完（stopReason=max-tokens）——整章重写 + 模型思考都占输出额度`
                    : '子代理没写完就到了输出上限（stopReason=max-tokens；当前继承宿主默认上限）——整章重写 + 模型思考都占输出额度',
                    advice: tokenCap > 0
                        ? `在插件配置 engine.channels.${channel}.maxTokens 调大（当前 ${tokenCap}），或删掉让它继承宿主默认；或换非长思考模型。重试无效，别白烧。`
                        : `在插件配置 engine.channels.${channel}.maxTokens 显式设一个大值（如 32768）覆盖宿主默认；或换非长思考模型。重试无效，别白烧。` } };
            }
            if (result?.stopReason !== 'completed') {
                return { ok: false, attempts, route: routeView, error: { code: 'SUBAGENT_FAILED', message: `子代理未完成（stopReason=${String(result?.stopReason ?? 'unknown')}）`, advice: '重发一次；若稳定复现，看 dsh 日志里该 run 的报错' } };
            }
            const text = subagentText(result);
            if (text.trim() === '') {
                return { ok: false, attempts, route: routeView, error: { code: 'EMPTY_RESPONSE', message: '子代理返回了空内容', advice: '重发一次；若稳定复现，缩短提示词' } };
            }
            return { ok: true, text, finishKind: 'stop', usage: null, attempts, route: routeView };
        } catch (error) {
            if (signal?.aborted === true) {
                return { ok: false, attempts, route: routeView, error: { code: 'ABORTED', message: '用户取消了本次调用', advice: '重新发起即可' } };
            }
            return { ok: false, attempts, route: routeView, error: describeEngineError(error) };
        }
    }

    /** 通道预算：通道覆写 > 通道默认；重试次数走全局值，通道可单独覆写。 */
    function budgetFor(channel) {
        const over = channels[channel] ?? {};
        const base = CHANNEL_DEFAULTS[channel] ?? CHANNEL_DEFAULTS.polish;
        // maxTokens：0 = **不设限**（子代理路径不传 → 继承宿主按模型校准的默认；
        // directHttp 路径不传 → provider 用自己的默认）。显式配置正整数才设限。
        const capOf = (v) => (Number.isInteger(v) && v > 0 ? v : 0);
        return {
            maxTokens: over.maxTokens === undefined ? capOf(base.maxTokens) : capOf(over.maxTokens),
            timeoutMs: Number.isInteger(over.timeoutMs) && over.timeoutMs > 0 ? over.timeoutMs : base.timeoutMs,
            retries: Number.isInteger(over.retries) && over.retries >= 0 ? over.retries : globalRetries,
        };
    }

    /**
     * 路由解析：通道显式配了 provider+model 就用它；否则继承用户当前默认路由。
     * 默认继承是刻意选择——保持零配置，想给润色换便宜模型的人自己配一行。
     */
    function routeFor(channel) {
        const over = channels[channel] ?? {};
        if (typeof over.provider === 'string' && over.provider !== ''
            && typeof over.model === 'string' && over.model !== '') {
            return { provider: over.provider, model: over.model, source: 'channel' };
        }
        const def = readService('agentDefaultModel');
        if (def !== undefined && def !== null && typeof def.provider === 'string' && typeof def.model === 'string') {
            return { provider: def.provider, model: def.model, source: 'default' };
        }
        return null;
    }

    /**
     * 跑一次调用。返回**不抛**——失败也是一种结果（面板要能展示人话错误）。
     * @returns {ok, text, finishKind, usage, attempts, route, error?}
     */
    async function run(channel, {
        system, prompt, maxTokens, timeoutMs, retries, signal, sessionId, sessionIds, onDelta,
    } = {}) {
        if (!CHANNEL_NAMES.includes(channel)) {
            return { ok: false, attempts: 0, route: null, error: { code: 'UNKNOWN_CHANNEL', message: `未知通道「${channel}」`, advice: `可用通道：${CHANNEL_NAMES.join('、')}` } };
        }
        const llm = llmService();
        if (llm === null) {
            // 直连不可用 → 试 subagents 备用传输（web profile 里 llm 不在根 fiber，这是主路径）
            const subagents = subagentService();
            if (subagents !== null) {
                return runViaSubagent(channel, subagents, { system, prompt, maxTokens, timeoutMs, signal, sessionId, sessionIds });
            }
            return { ok: false, attempts: 0, route: null, error: { code: 'ENGINE_UNAVAILABLE', message: unavailableReason(), advice: '这不是错误路径的失败，而是本环境没有模型服务' } };
        }
        const route = routeFor(channel);
        if (route === null) {
            return { ok: false, attempts: 0, route: null, error: { code: 'NO_ROUTE', message: '没有可用的 provider/model 路由', advice: '先在 dsh 里选定模型；或在本插件配置里为该通道显式指定 provider + model' } };
        }
        const budget = budgetFor(channel);
        const tokenCap = Number.isInteger(maxTokens) && maxTokens > 0 ? maxTokens : budget.maxTokens;
        const limitMs = Number.isInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : budget.timeoutMs;
        const maxRetries = Number.isInteger(retries) && retries >= 0 ? retries : budget.retries;

        const messages = [buildUserMessage(prompt)];
        let attempts = 0;
        let lastError = null;

        for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
            attempts = attempt;
            if (signal?.aborted === true) {
                return { ok: false, attempts, route, error: { code: 'ABORTED', message: '调用前已被取消', advice: '重新发起即可' } };
            }
            const call = deadline(signal, limitMs, 'ENGINE_TIMEOUT');
            const collector = new StreamCollector();
            const options = {
                provider: route.provider,
                model: route.model,
                messages,
                system,
                // tokenCap=0 时不传 max_tokens：provider 用自己的模型默认上限
                ...(tokenCap > 0 ? { maxTokens: tokenCap } : {}),
                signal: call.signal,
                // 会话归属默认关闭：带 sessionId 会把请求写进会话日志，正是 D1 要消灭的那种污染。
                ...(attachSession && sessionId !== undefined ? { sessionId } : {}),
            };
            let thrown = null;
            try {
                // 消费流时与中断信号**竞速**：只靠 for await 的话，一个不理会 signal 的适配器
                // 会把我们挂到天荒地老（实测：60ms 超时等了 502ms 才回来）。
                const iterator = llm.stream(options)[Symbol.asyncIterator]();
                const aborted = new Promise((resolve) => {
                    if (call.signal.aborted === true) resolve('__abort__');
                    else call.signal.addEventListener('abort', () => resolve('__abort__'), { once: true });
                });
                for (;;) {
                    const step = await Promise.race([iterator.next(), aborted]);
                    if (step === '__abort__') {
                        // 不能 await return()：生成器体若正卡在一次不可中断的 await 上，
                        // return() 会跟着卡住，超时就白设了。让它自生自灭（signal 已经发出）。
                        void Promise.resolve(iterator.return?.()).catch(() => {});
                        thrown = call.signal.reason ?? Object.assign(new Error('调用被中断'), { name: 'AbortError' });
                        break;
                    }
                    if (step.done === true) break;
                    collector.push(step.value);
                    if (typeof onDelta === 'function') onDelta(step.value);
                }
            } catch (error) {
                thrown = error;
            } finally {
                call.dispose();
            }

            // 无异常但信号已中断（例如流自己在超时后正常结束）：同样按中断处理
            if (thrown === null && call.signal.aborted === true) {
                thrown = call.signal.reason ?? Object.assign(new Error('调用被中断'), { name: 'AbortError' });
            }

            if (thrown !== null) {
                // 用户取消（上游 signal）不重试
                if (signal?.aborted === true) {
                    return { ok: false, attempts, route, error: { code: 'ABORTED', message: '用户取消了本次调用', advice: '重新发起即可' } };
                }
                const verdict = describeEngineError(thrown);
                lastError = verdict;
                const retryable = RETRYABLE_FAILURE_CODES.has(verdict.code) || verdict.code === 'ENGINE_TIMEOUT';
                if (!retryable || attempt > maxRetries) return { ok: false, attempts, route, error: verdict };
                logger?.warn?.(`[novel-forge] 通道 ${channel} 第 ${attempt} 次失败（${verdict.code}），退避重试`);
                await wait(retryDelayMs(attempt, { rand }));
                continue;
            }

            const cls = classifyFinish(collector.finish);
            if (!cls.ok) {
                const error = { code: cls.code, message: cls.message, advice: cls.advice };
                if (!cls.retryable || attempt > maxRetries) return { ok: false, attempts, route, error };
                lastError = error;
                await wait(retryDelayMs(attempt, { rand }));
                continue;
            }

            const text = collector.text;
            if (text.trim() === '') {
                const error = { code: 'EMPTY_RESPONSE', message: '模型返回了空内容', advice: '重发一次；若稳定复现，缩短提示词或换模型' };
                if (attempt > maxRetries) return { ok: false, attempts, route, error };
                lastError = error;
                await wait(retryDelayMs(attempt, { rand }));
                continue;
            }

            return {
                ok: true, text, finishKind: collector.finish.kind,
                usage: collector.usage, attempts, route,
            };
        }

        return { ok: false, attempts, route, error: lastError ?? { code: 'ENGINE_FAILURE', message: '未预期的失败', advice: '' } };
    }

    return {
        channels,
        budgetFor,
        routeFor,
        run,
        /** 是否具备模型能力（面板据此决定按钮可用性）：直连 llm 或 subagents 任一可用即可。 */
        isAvailable: () => llmService() !== null || subagentService() !== null,
        unavailableReason,
    };
}
