// lib/ledger-flavor.js — 账感/人感（「食杂店账本味」检测，纯函数，零 IO、零模型调用）。
//
// 缺口（用户 2026-11-26 钦定）：多本书写出来「不是算账就是算账的路上」——系统面板、
// 结算、反馈、收益逐行念给读者听，章里没有活人接住数值。根源一半在门禁侧：
// 「系统闭环」类可核验条款把 结算/反馈/收益 列成每章必达词，等于逼模型每章见账。
// 本模块量的是**结果面**（正文像不像账本），并给出**处方**（缺哪层人感就怎么做）：
// 这就是「根据风格推断怎么做」——量出病，开药方，不只是报病名。
//
// 判定（三条件同时成立才算记账体，单维高不算——面板词多是系统流题材的属性，
// 不是病；病 = 词多 + 没人说话 + 没活人接）：
//   dialogueRatio < 0.12（对话占比低：账是面板念的，不是吵出来的）
//   ledgerPerK   >= 6   （结算串密度高）
//   humanPerK    < 6    （人感词低：数值落下来没人接、没反应、没情绪）
//
// 口径纪律：countAll 借 noai.js（单一计数器，不抄）；对话占比口径同 audit.js
// （引号内字数占比）；人感词表与幽默轴同源但**不 import lexicon**——幽默轴词表
// 服务于氛围光谱（每千字命中），这里要的是「活人反应」判据，词表语义不同（反应
// 词 攥/眼皮/炸锅 不在 12 轴里），各持一份、注释指回来源。

import { countAll } from './noai.js';

/** 结算串词（面板念账的信号词；全是 ≥2 字词，防单字误报）。
 *  注意「双倍/反馈引擎」这类**设定名**不在此列——它们是题材不是账本味；
 *  账本味来自「结算、到账、收益、倒计时、任务完成」这类**流水话术**。 */
const LEDGER_TERMS = [
    '结算', '到账', '入账', '收益', '面板', '光幕', '翻倍', '涨幅',
    '倍率', '数值', '倒计时', '任务完成', '配额', '奖励', '弹出', '红字', '滚雪球',
];

/** 人感词（活人在场的信号：情绪反应/身体反应/旁观反应；幽默轴同源词 + 反应词）。
 *  词表刻意偏「具体的人在做具体的事」——抽象词（高兴/开心）不算，它们可以被
 *  面板话术顺带带出；攥紧/炸锅/交头接耳 必须是活人才有。 */
const HUMAN_TERMS = [
    '炸锅', '哄笑', '交头接耳', '嘀咕', '念叨', '起哄', '倒吸', '撇嘴', '翻白眼',
    '心里', '眉头', '眼皮', '喉头', '攥', '咬牙', '跺脚', '拍桌', '拽住', '唾沫',
    '瞪', '咧嘴', '叹气', '骂', '脸红', '耳根', '心头', '后背', '直突突', '笑', '嘿',
];

export const LEDGER_THRESHOLDS = {
    minChars: 400,      // 短于此按不适用（碎章量不出密度）
    dialogueRatioMax: 0.12, // 对话占比低于此 = 账是面板念的
    ledgerPerKMin: 6,   // 结算串每千字 ≥6 = 流水话术密度
    humanPerKMin: 6,    // 人感词每千字 <6 = 数值没人接
    overLedgerPerK: 12, // 高于此另开「结算连弹合并」处方
};

const perK = (hits, chars) => (chars > 0 ? (hits / chars) * 1000 : 0);
const round2 = (n) => Math.round(n * 100) / 100;

/** 对话字数占比：中文弯/直双引号内字数 ÷ 去空白总字数。
 *  注意比 audit.js 的 dialogueRatio 更严——那边按「含引号的行」整行计（引号行里的
 *  叙述混进分子），这里只算引号内纯对白；同一章本值恒 ≤ audit 值。阈值 0.12 是按
 *  纯对白口径定的，别拿 audit 值直接套。 */
export function dialogueRatioOf(text) {
    const clean = String(text ?? '').replace(/\s/g, '');
    if (clean.length === 0) return 0;
    let dialogue = 0;
    for (const m of clean.match(/[“"][^”"]*[”"]/g) ?? []) dialogue += m.length - 2;
    return Math.round((dialogue / clean.length) * 1000) / 1000;
}

/**
 * 一章的账感/人感测量 + 处方。
 * @returns {{
 *   applicable, chars,
 *   dialogueRatio, ledgerPerK, humanPerK, ledgerHits,
 *   ledgerish,                    // 三条件同时成立
 *   missingLayers: string[],      // 'dialogue' | 'reaction' | 'over-settled'
 *   prescriptions: string[],      // 可执行改写指令（按缺失层生成，空 = 本章人感够）
 * }}
 */
export function measureLedgerFlavor(text, opts = {}) {
    const t = String(text ?? '');
    const chars = t.replace(/\s/g, '').length;
    const minChars = opts.minChars ?? LEDGER_THRESHOLDS.minChars;
    const dialogueRatio = dialogueRatioOf(t);
    const ledgerHits = LEDGER_TERMS.reduce((n, w) => n + countAll(t, w), 0);
    const humanHits = HUMAN_TERMS.reduce((n, w) => n + countAll(t, w), 0);
    const ledgerPerK = round2(perK(ledgerHits, chars));
    const humanPerK = round2(perK(humanHits, chars));

    const applicable = chars >= minChars;
    const missingLayers = [];
    const prescriptions = [];
    const ledgerish = applicable
        && dialogueRatio < LEDGER_THRESHOLDS.dialogueRatioMax
        && ledgerPerK >= LEDGER_THRESHOLDS.ledgerPerKMin
        && humanPerK < LEDGER_THRESHOLDS.humanPerKMin;

    if (ledgerish) {
        if (dialogueRatio < LEDGER_THRESHOLDS.dialogueRatioMax) {
            missingLayers.push('dialogue');
            prescriptions.push(
                `把面板念账改成对话：本章 ${ledgerHits} 处结算/收益话术大半是系统独白——挑 2-3 处改成两个人你一句我一句把账吵出来，数值从嘴里蹦出来，不是从光幕上滚出来`);
        }
        if (humanPerK < LEDGER_THRESHOLDS.humanPerKMin) {
            missingLayers.push('reaction');
            prescriptions.push(
                '数值砸下来那一拍要给具体的人接住：谁炸了锅、谁心里骂骂咧咧、谁眼皮直跳——数字不能自己落地');
        }
        if (ledgerPerK >= LEDGER_THRESHOLDS.overLedgerPerK) {
            missingLayers.push('over-settled');
            prescriptions.push(
                '结算连弹合并：同章「叮」弹两次以上只留一次，中间过程一句带过，省下的篇幅写结算之后人怎么反应');
        }
    }

    return {
        applicable, chars, dialogueRatio, ledgerPerK, humanPerK, ledgerHits,
        ledgerish, missingLayers, prescriptions,
    };
}

/**
 * 记账体批次债（commit 链接线，判据镜像 promiseDebtItems 的「窗口攒够才成债」）：
 * 近 3 章（含本章）≥2 章判定记账体 → 一条 minor 债（可欠着，回头核对）。
 * 单章记账体只走 content-gate ⑫ 维 warning，不落债（报信号不判死刑，同 P2 档）。
 */
export function ledgerFlavorDebtItems({ content = '', chapter = 0, history = [] } = {}) {
    if (!Number.isInteger(chapter) || chapter < 1) return [];
    const prevRows = (Array.isArray(history) ? history : [])
        .filter((h) => h && Number.isInteger(h.no) && h.no < chapter && typeof h.content === 'string')
        .sort((a, b) => a.no - b.no)
        .slice(-2);
    const self = measureLedgerFlavor(content);
    const ledgerishCount = [
        ...prevRows.map((r) => measureLedgerFlavor(r.content)),
        self,
    ].filter((m) => m.ledgerish).length;
    if (ledgerishCount < 2) return [];
    const m = self;
    return [{
        code: 'ledger-flavor',
        message: `记账体连续出现（近 3 章 ${ledgerishCount} 章账感超线：对话占比 ${m.dialogueRatio}·结算密度 ${m.ledgerPerK}/千字·人感 ${m.humanPerK}/千字）——正文在往食杂店流水账滑。回头核对：把面板念账改成人物对话、数值落点后接一个活人反应；可核验条款里若把 结算/收益 列成必达词，先改掉（必达词会逼模型每章见账）`,
    }];
}
