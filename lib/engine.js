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

import {
	MAX_TIMER_DELAY_MS, CHANNEL_NAMES, PARENT_RETRY_DELAY_MS,
	CHANNEL_DEFAULTS, DEFAULT_RETRIES, CHANNEL_LABELS, RETRYABLE_FAILURE_CODES,
	deadline, StreamCollector, classifyFinish, retryDelayMs, buildUserMessage, describeEngineError,
} from './engine-core.js';

// 纯逻辑区（常量 / 流收集 / 结束原因判定 / 错误人话）落在 engine-core.js 便于单测；
// 这里原样重导出，保持 engine.js 的对外导出面不变（RETRYABLE_FAILURE_CODES 仅内部用）。
export {
	MAX_TIMER_DELAY_MS, CHANNEL_NAMES, PARENT_RETRY_DELAY_MS,
	CHANNEL_DEFAULTS, DEFAULT_RETRIES, CHANNEL_LABELS,
	deadline, StreamCollector, classifyFinish, retryDelayMs, buildUserMessage, describeEngineError,
} from './engine-core.js';

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
    /** 候选会话 id 链：显式 sessionId（面板当前会话）优先，其后是书归属会话等候选（去重、剔空）。 */
    function candidatesOf(sessionId, sessionIds) {
        return [typeof sessionId === 'string' ? sessionId : '', ...(Array.isArray(sessionIds) ? sessionIds : [])]
            .filter((id, i, arr) => typeof id === 'string' && id !== '' && arr.indexOf(id) === i);
    }

    /**
     * NO_PARENT_AGENT 结构化错误：报错必须自己说清「哪一层没通过」——否则每轮排查
     * 都要重新猜（0.13.2 两轮真机复诊的教训：静默吞掉的 resume 异常让根因晚现一轮）。
     */
    function noParentError(candidates, diag, lastResumeError) {
        const d = [...diag];
        if (lastResumeError !== '') d.push('resume 失败：' + lastResumeError);
        const suffix = d.length > 0 ? '（诊断：' + d.join('；') + '）' : '';
        const got = candidates.length > 0
            ? '试过 ' + candidates.length + ' 个会话 id（' + candidates.map((s) => s.slice(0, 16)).join('、') + '…），注册表查询与按需物化（resume）都未拿到活动 agent'
            : '没拿到任何可锚定的会话 id';
        return { code: 'NO_PARENT_AGENT', message: '模型调用需要锚定一个父会话（子代理要从父会话继承工作区与谱系）：' + got + '，当前也不在任何会话的执行边界里。' + suffix, advice: '按「诊断」段处理：agents 不可解析→重启 dsh 并确认插件版本；resume 失败→把报错原样发给维护者。' };
    }

    /**
     * 父 agent 锚定（候选链 + 懒注册等待重试），runViaSubagent 与批量起草共用。
     * 候选链语义：
     *   ① 显式 sessionId（面板当前会话，REST 层穿进来）
     *   ② sessionIds 候选（书自己的归属会话——创建它的会话 agent 大概率活着，
     *      且其工作区必然是书所在工作区，语义上比「当前会话」更正确）
     *   ③ **按需物化**：候选会话没驻留时 agents.resume({resumeSessionId}) 把
     *      持久化会话的 agent 拉起来（等价于 web 应用后台打开这条会话），返回的
     *      handle 直接当 parent。0.13.2 真机复诊：孙宇测试会话存在、agent 不在册
     *      ——get 永远落空；面板旁路调用不能指望用户恰好开着书所在会话。
     *   ④ currentInitiator()（会话内工具路径：打标/检索处在宿主的发起边界里；
     *      REST 处理器不在任何发起边界，这里天然 undefined，不会误挂别人的会话）
     * ⚠️ 注册表是**懒注册 + 会退出**的（真机实测：重启后 agent 逐个出现、
     * 会话关闭即消失）——整链落空时等 2 秒把 get/resume 再走一轮。
     * ⚠️ 批量起草并发>1 时**只调一次**、结果经 run({ parent }) 传下去——多章
     * 并发各自 agents.resume 同一持久化会话有撞宿主持久化写锁的风险（0.13.3 复盘）。
     * @returns {{ ok: true, parent: object } | { ok: false, error: NO_PARENT_AGENT }}
     */
    async function anchorParent({ channel = 'anchor', sessionId, sessionIds, signal } = {}) {
        const agents = readService('agents');
        const candidates = candidatesOf(sessionId, sessionIds);
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
        if (parent === null) return { ok: false, error: noParentError(candidates, diag, lastResumeError) };
        return { ok: true, parent };
    }

    async function runViaSubagent(channel, subagents, { system, prompt, maxTokens, timeoutMs, signal, sessionId, sessionIds, sharedParent }) {
        const budget = budgetFor(channel);
        const tokenCap = Number.isInteger(maxTokens) && maxTokens > 0 ? maxTokens : budget.maxTokens;
        const limitMs = Number.isInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : budget.timeoutMs;
        // 通道显式配了 provider+model 就带给子代理；没配就让子代理继承宿主默认路由
        const route = routeFor(channel);
        const routeView = route ?? { provider: '(inherited)', model: '(inherited)', source: 'subagent' };
        // M7 修复：attempts 此前恒为 1——engine.retries 只对直连路径生效，子代理路径
        //（web profile 的主路径）一次瞬时故障就整章报废。接上与 run() 同款的重试循环：
        // 只重试瞬时码（SUBAGENT_FAILED / EMPTY_RESPONSE），超时/截断/取消不重试。
        const maxRetries = Number.isInteger(budget.retries) && budget.retries >= 0 ? budget.retries : 0;
        let attempts = 0;
        // parent 锚定语义（候选链/懒注册/按需物化）见 anchorParent() 注释。
        // sharedParent 由批量起草预解析传入（并发>1 只锚定一次，防多章并发
        // resume 同一会话）；null = 调用方已锚定失败——快速报错，不再逐章
        // 各等 2 秒、各 resume 一遍。
        let parent;
        if (sharedParent !== undefined) {
            parent = sharedParent;
            if (parent === null) {
                return { ok: false, attempts, route: routeView, error: noParentError(candidatesOf(sessionId, sessionIds), ['父锚定由调用方（批量起草）预解析且未成功——完整诊断见首次锚定的报错'], '') };
            }
        } else {
            const a = await anchorParent({ channel, sessionId, sessionIds, signal });
            if (!a.ok) return { ok: false, attempts, route: routeView, error: a.error };
            parent = a.parent;
        }
        try {
            let lastFailure = null;
            for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
                attempts = attempt;
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
                    lastFailure = { code: 'SUBAGENT_FAILED', message: `子代理未完成（stopReason=${String(result?.stopReason ?? 'unknown')}）`, advice: '重发一次；若稳定复现，看 dsh 日志里该 run 的报错' };
                } else {
                    const text = subagentText(result);
                    if (text.trim() !== '') {
                        return { ok: true, text, finishKind: 'stop', usage: null, attempts, route: routeView };
                    }
                    lastFailure = { code: 'EMPTY_RESPONSE', message: '子代理返回了空内容', advice: '重发一次；若稳定复现，缩短提示词' };
                }
                // 瞬时故障还有重试额度 → 退避后重来（超时/截断/取消不走这里）
                if (attempt <= maxRetries) {
                    await wait(retryDelayMs(attempt));
                }
            }
            return { ok: false, attempts, route: routeView, error: lastFailure };
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
        system, prompt, maxTokens, timeoutMs, retries, signal, sessionId, sessionIds, onDelta, parent,
    } = {}) {
        if (!CHANNEL_NAMES.includes(channel)) {
            return { ok: false, attempts: 0, route: null, error: { code: 'UNKNOWN_CHANNEL', message: `未知通道「${channel}」`, advice: `可用通道：${CHANNEL_NAMES.join('、')}` } };
        }
        const llm = llmService();
        if (llm === null) {
            // 直连不可用 → 试 subagents 备用传输（web profile 里 llm 不在根 fiber，这是主路径）
            const subagents = subagentService();
            if (subagents !== null) {
                return runViaSubagent(channel, subagents, { system, prompt, maxTokens, timeoutMs, signal, sessionId, sessionIds, sharedParent: parent });
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
        /** 父 agent 锚定（批量起草并发前只调一次，结果经 run({ parent }) 传下去）。 */
        anchor: anchorParent,
        /** 是否具备模型能力（面板据此决定按钮可用性）：直连 llm 或 subagents 任一可用即可。 */
        isAvailable: () => llmService() !== null || subagentService() !== null,
        unavailableReason,
    };
}

