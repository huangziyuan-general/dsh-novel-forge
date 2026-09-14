// src/client/views/chapters.js — 「章节听书」标签：目录 + 语音连播控制。
//
// 纯渲染：只读 state（chapterList / playback），交互全走 data-action，
// 由 panel.js 的原生点击代理接住。播放边界（连播到哪章为止）由
// hasChapter 依据 chapterList 决定 —— 目录就是播放清单。
import { h } from '../react.js';
import { btnStyle, hintStyle, errStyle, miniBtnStyle, itemCardStyle } from '../styles.js';

/** 播放中的行高亮。 */
const playingRowStyle = {
	...itemCardStyle,
	borderColor: 'var(--dsw-alias-accent-strong, #8ab4ff)',
	background: 'var(--dsw-alias-accent-soft, rgba(80,120,255,.12))',
};

export function ChapterListView({ state: s }) {
	const pb = s.playback ?? { status: 'idle', currentNo: null };

	if (s.chapterListLoading) {
		return h('div', { style: hintStyle }, '章节目录加载中…');
	}
	if (!s.chapterList.length) {
		return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
			h('div', { style: hintStyle },
				'本书还没有章节。在会话里让 AI 调用 novel_write_chapter 开写，写完这里就会出现目录。'),
			h('button', { 'data-action': 'back', style: btnStyle }, '← 返回基本信息'),
		);
	}

	const firstNo = s.chapterList[0].no;
	const playing = pb.status === 'playing';
	const paused = pb.status === 'paused';
	const startNo = pb.currentNo ?? firstNo;

	// 播放控制条：播放/暂停/继续 + 停止
	const controls = h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' } },
		!playing && !paused
			? h('button', { 'data-action': 'play-from', 'data-no': String(startNo), style: btnStyle },
				`▶ 从第 ${startNo} 章开始听`)
			: playing
				? h('button', { 'data-action': 'playback-pause', style: btnStyle }, '⏸ 暂停')
				: h('button', { 'data-action': 'playback-resume', style: btnStyle }, '▶ 继续'),
		h('button', {
			'data-action': 'playback-stop', disabled: !playing && !paused, style: btnStyle,
		}, '⏹ 停止'),
		playing || paused
			? h('span', { style: { ...hintStyle, fontSize: '11px' } },
				`正在读：第 ${pb.currentNo} 章${paused ? '（已暂停）' : ''}`)
			: h('span', { style: { ...hintStyle, fontSize: '11px' } }, '读完一章自动接下一章'),
	);

	const rows = s.chapterList.map((c) => {
		const isCurrent = pb.currentNo === c.no && (playing || paused);
		return h('div', { key: c.no, style: isCurrent ? playingRowStyle : itemCardStyle },
			h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
				h('span', { style: { fontWeight: isCurrent ? 700 : 500 } },
					`第 ${c.no} 章 ${c.title || ''}`),
				h('span', { style: { ...hintStyle, fontSize: '11px', marginLeft: 'auto' } },
					`${c.chars ?? 0} 字`),
				h('button', {
					'data-action': 'play-from', 'data-no': String(c.no), style: miniBtnStyle,
					title: `从第 ${c.no} 章开始听`,
				}, isCurrent && playing ? '♪' : '▶'),
			),
		);
	});

	return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
		controls,
		s.error ? h('div', { style: errStyle }, s.error) : null,
		h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } }, rows),
	);
}
