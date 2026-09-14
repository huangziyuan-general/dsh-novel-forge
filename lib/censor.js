// lib/censor.js — 发书前敏感自查（C5，纯函数，零 token）。
//
// 定位必须说清楚：这是**启发式预筛**，不是合规判定，更不是免责工具。它的价值是
// 「发书/提交审核前把明显的红线词扫一遍，别让手滑把章节送进去」。真正确认能不能发，
// 责任仍在作者与平台审核。
//
// 七类：涉政 / 色情擦边 / 暴力血腥 / 赌博毒品 / 封建迷信 / 现实机构影射 / 未成年红线。
// 涉政类只做**语域识别**（政体术语、群体事件、情报机构等通用标记），
// 刻意不枚举具体敏感词——那既无用（变体无穷）也不该被硬编码。命中即提示人工复核。
//
// 未成年红线用**邻近共现**判定：未成年主体词 与 亲密/情欲词 在 100 字内同时出现
// 才算命中——单出现「小学生」不该报警（校园文天天有）。

/** 分类定义。severity：error = 建议必改；warn = 建议复核。 */
export const CENSOR_CATEGORIES = [
    { key: 'politics', label: '涉政', severity: 'error', hint: '现实政治语域——请人工复核，涉及现实国家/地区/在任职务一律改架空' },
    { key: 'erotica', label: '色情擦边', severity: 'error', hint: '露骨描写会被平台直接下架，改为留白/暗示' },
    { key: 'minor', label: '未成年红线', severity: 'error', hint: '未成年主体 + 亲密描写是绝对红线，必须删改' },
    { key: 'vice', label: '赌博毒品', severity: 'error', hint: '赌博/制毒细节不许写成教程，弱化手法与剂量' },
    { key: 'violence', label: '暴力血腥', severity: 'warn', hint: '血腥细节过实会触发审核，收在「结果」不写「过程」' },
    { key: 'feudal', label: '封建迷信', severity: 'warn', hint: '现代背景下的迷信宣传有风险；架空/玄幻设定可豁免' },
    { key: 'realorg', label: '现实机构影射', severity: 'warn', hint: '真实机构不宜写负面情节，改虚构名称' },
];

export const CENSOR_KEYS = CENSOR_CATEGORIES.map((c) => c.key);

/** 各分类的通用标记词。宁漏勿误——命中后仍需人工判断。 */
const LEXICON = {
    politics: ['总统', '首相', '国会', '议会', '大选', '选举', '执政党', '在野党', '反对党', '政变', '游行', '示威', '抗议', '镇压', '独裁', '专政', '分裂国家', '主权', '领土', '情报局', '情报机构', '间谍', '叛国', '颠覆政权', '政治犯', '特务'],
    erotica: ['呻吟', '娇喘', '喘息的', '酥胸', '玉体', '胴体', '下体', '私处', '情欲', '欲火', '床笫', '赤身', '一丝不挂', '肉体交缠', '翻云覆雨', '交合', '高潮迭起', '放荡', '淫'],
    violence: ['肢解', '碎尸', '开膛', '挖眼', '剥皮', '断肢', '血肉模糊', '脑浆', '内脏', '剖开', '虐杀', '凌迟', '血淋淋', '尸块', '割喉', '掏心'],
    vice: ['吸毒', '冰毒', '海洛因', '摇头丸', '大麻', '贩毒', '制毒', '毒枭', '毒品', '赌场', '赌博', '老虎机', '百家乐', '出老千', '赌资', '筹码换现金', '洗钱'],
    feudal: ['算命', '看相', '风水', '驱邪', '招魂', '符咒', '鬼上身', '跳大神', '开光', '转世投胎', '阴间', '因果报应', '冲喜', '驱鬼', '做法事'],
    realorg: ['公安局', '派出所', '检察院', '中级法院', '最高人民法院', '纪委', '监察委', '新华社', '人民日报', '中央电视台', '红十字会', '消费者协会', '证监会', '银保监'],
};

/** 未成年红线：主体词 × 亲密词 邻近共现。 */
const MINOR_SUBJECTS = ['未成年', '未成年人', '小学生', '初中生', '幼女', '幼童', '儿童', '童养媳', '高中生', '十四岁', '十五岁', '十六岁', '十三岁'];
const INTIMACY_WORDS = ['亲吻', '舌吻', '拥抱入怀', '同床', '床戏', '发生关系', '情欲', '肉体', '赤裸', '脱光', '抚摸', '呻吟', '婚约', '恋人', '女友', '男友', '性'];
const MINOR_WINDOW = 100;

function lineAt(text, index) {
    let line = 1;
    for (let i = 0; i < index && i < text.length; i += 1) if (text[i] === '\n') line += 1;
    return line;
}

function excerptAt(text, index, term) {
    const s = Math.max(0, index - 18);
    const e = Math.min(text.length, index + term.length + 18);
    return `${s > 0 ? '…' : ''}${text.slice(s, e).replace(/\n/g, ' ')}${e < text.length ? '…' : ''}`;
}

function scanTerms(text, terms, limit = 5) {
    const out = [];
    for (const term of terms) {
        let i = text.indexOf(term);
        let count = 0;
        let first = -1;
        while (i !== -1) {
            if (first === -1) first = i;
            count += 1;
            i = text.indexOf(term, i + term.length);
        }
        if (count > 0) out.push({ term, count, line: lineAt(text, first), excerpt: excerptAt(text, first, term) });
    }
    return out.sort((a, b) => b.count - a.count).slice(0, limit);
}

/** 未成年红线：主体词与亲密词在窗口内共现。 */
function scanMinor(text) {
    const hits = [];
    for (const subj of MINOR_SUBJECTS) {
        let si = text.indexOf(subj);
        while (si !== -1) {
            for (const word of INTIMACY_WORDS) {
                let wi = text.indexOf(word, Math.max(0, si - MINOR_WINDOW));
                while (wi !== -1 && wi <= si + subj.length + MINOR_WINDOW) {
                    hits.push({
                        term: `${subj}…${word}`,
                        count: 1,
                        line: lineAt(text, si),
                        excerpt: excerptAt(text, Math.min(si, wi), subj.length + Math.abs(wi - si) + word.length),
                    });
                    break; // 同一主体同一亲密词只记一次
                }
                if (hits.length >= 5) break;
            }
            if (hits.length >= 5) break;
            si = text.indexOf(subj, si + subj.length);
        }
    }
    return hits;
}

/**
 * 敏感自查（纯函数）。
 * @param inputs { content, exempt:['feudal',...] }
 *   exempt 用于按题材豁免（如玄幻设定里的「驱邪/符咒」不必报警）。
 */
export function scanSensitive({ content, exempt = [] } = {}) {
    const text = String(content ?? '');
    const skip = new Set((Array.isArray(exempt) ? exempt : []).map((k) => String(k).toLowerCase()));
    const categories = [];
    for (const cat of CENSOR_CATEGORIES) {
        if (skip.has(cat.key)) continue;
        const hits = cat.key === 'minor' ? scanMinor(text) : scanTerms(text, LEXICON[cat.key] ?? []);
        if (hits.length === 0) continue;
        categories.push({
            key: cat.key, label: cat.label, severity: cat.severity, hint: cat.hint,
            count: hits.reduce((a, h) => a + h.count, 0),
            hits,
        });
    }
    const errorCount = categories.filter((c) => c.severity === 'error').length;
    const warningCount = categories.filter((c) => c.severity === 'warn').length;
    const level = errorCount > 0 ? 'risky' : warningCount > 0 ? 'caution' : 'clean';
    return {
        level,
        chars: text.replace(/\s/g, '').length,
        stats: { errorCount, warningCount, hitCount: categories.reduce((a, c) => a + c.count, 0) },
        categories,
        note: '启发式预筛，只做通用标记词与邻近共现；不构成合规判定，发布前请人工复核。',
    };
}

/** 自查结果 → 终端文本。 */
export function censorDigest(r) {
    if (r.level === 'clean') {
        return `敏感自查：未检出（${r.chars} 字）\n${r.note}`;
    }
    const head = `敏感自查：${r.level === 'risky' ? '⚠ 命中红线词' : '注意'}（${r.stats.errorCount} 类红线 / ${r.stats.warningCount} 类提醒）`;
    const lines = r.categories.map((c) => {
        const mark = c.severity === 'error' ? '✗' : '⚠';
        const body = c.hits.map((h) => `      L${h.line} ${h.term}×${h.count}  「${h.excerpt}」`).join('\n');
        return `${mark} 【${c.label}】${c.count} 处\n${body}\n    → ${c.hint}`;
    });
    return [head, ...lines, r.note].join('\n');
}
