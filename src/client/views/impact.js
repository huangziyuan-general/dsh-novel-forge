// src/client/views/impact.js — 前章影响清单的只读展示。
import { h } from '../react.js';
import { errStyle, font, hintStyle, space, stackStyle, warnStyle } from '../styles.js';
import { Chip, Fold } from '../ui.js';

export function ImpactReportView({ state: s }) {
	if (s.impactLoading) return h('div', { style: hintStyle }, '正在核对后章来源…');
	if (s.impactError) return h('div', { style: errStyle }, s.impactError);
	const report = s.impact;
	if (!report || s.impactChapter !== s.chapterNo) return null;
	return h('div', { style: { ...stackStyle(space.xs), marginTop: space.sm } },
		h('div', { style: { fontSize: font.small, fontWeight: 600 } },
			`前章影响清单 · ${report.affected.length} 章需复核 · ${report.unknown.length} 章不可判定`),
		h('div', { style: hintStyle }, report.notice),
		report.affected.length === 0 && report.unknown.length > 0
			? h('div', { style: { ...warnStyle, fontSize: font.small } },
				'没有可确认的受影响章 ≠ 没影响：下列章节缺少来源记录，无法判定。')
			: null,
		...report.affected.map((item) => h('div', { key: item.chapter, style: warnStyle },
			h('span', null, `第 ${item.chapter} 章 · ${item.title} `),
			Chip({ tone: 'warn' }, item.kind === 'direct' ? '直接影响' : `经第 ${item.via} 章传递`),
			h('div', null, item.reasons.join('；')),
			h('div', null, `对应细纲：${item.outline?.exists === true ? '存在，需同步复核' : item.outline?.exists === false ? '缺失' : '状态未知'}`),
		)),
		report.unknown.length > 0 ? Fold({ title: `无法判定的 ${report.unknown.length} 章（不代表没有影响）` },
			...report.unknown.map((item) => h('div', { key: item.chapter, style: hintStyle },
				`第 ${item.chapter} 章 · ${item.title}：${item.reason}`)),
		) : null,
	);
}
