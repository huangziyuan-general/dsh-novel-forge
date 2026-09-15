// src/client/views/chapters.js — 「章节听书」标签：目录 + 语音连播。
//
// 纯渲染：只读 state（chapterList / playback），交互全走 data-action，
// 由 panel.js 的原生点击代理接住。播放边界（连播到哪章为止）由
// hasChapter 依据 chapterList 决定 —— 目录就是播放清单。
//
// 版面：置顶一条播放条（正在读哪章、暂停/继续/停止），下面是目录。
// 目录行的信息优先级：**播放态 > 章号/标题 > 字数 > 播放钮**。
import { h } from '../react.js';
import { color, space, font, weight, hintStyle, errStyle, tint, stackStyle } from '../styles.js';
import { Card, Btn, Chip, Empty, Stat } from '../ui.js';

export function ChapterListView({ state: s }) {
	const pb = s.playback ?? { status: 'idle', currentNo: null };

	if (s.chapterListLoading) return h('div', { style: hintStyle }, '章节目录加载中…');

	if (!s.chapterList.length) {
		return Empty({
			icon: '🎧',
			title: '这本书还没有章节',
			hint: '在会话里让 AI 调 novel_write_chapter 开写，写完这里就会出现目录，可以朗读与连播。',
			action: [Btn({ size: 'sm', action: 'back' }, '← 返回基本信息')],
		});
	}

	const firstNo = s.chapterList[0].no;
	const playing = pb.status === 'playing';
	const paused = pb.status === 'paused';
	const startNo = pb.currentNo ?? firstNo;
	const totalChars = s.chapterList.reduce((sum, c) => sum + (c.chars ?? 0), 0);

	// ── 播放条 ──
	const controls = Card({ tone: playing || paused ? 'accent' : 'plain', pad: space.md },
		h('div', { style: { display: 'flex', alignItems: 'center', gap: space.sm } },
			!playing && !paused
				? Btn({ variant: 'primary', size: 'sm', action: 'play-from', id: startNo }, `▶ 从第 ${startNo} 章开始听`)
				: playing
					? Btn({ variant: 'primary', size: 'sm', action: 'playback-pause' }, '⏸ 暂停')
					: Btn({ variant: 'primary', size: 'sm', action: 'playback-resume' }, '▶ 继续'),
			Btn({ variant: 'ghost', size: 'sm', action: 'playback-stop', disabled: !playing && !paused }, '⏹ 停止'),
			h('span', { style: { flex: '1 1 auto' } }),
			Stat({ icon: '📄', value: s.chapterList.length, unit: '章' }),
			Stat({ icon: '·', value: totalChars.toLocaleString(), unit: '字' }),
		),
		h('div', { style: { ...hintStyle, fontSize: font.caption, marginTop: space.sm } },
			playing || paused
				? `正在读：第 ${pb.currentNo} 章${paused ? '（已暂停）' : ''}`
				: '读完一章自动接下一章；章号有缺口会跳到下一个存在的章。'),
	);

	// ── 目录 ──
	const rows = s.chapterList.map((c) => {
		const isCurrent = pb.currentNo === c.no && (playing || paused);
		return h('div', {
			key: c.no,
			style: {
				display: 'flex', alignItems: 'center', gap: space.sm,
				padding: `${space.sm}px ${space.md}px`,
				borderRadius: '8px',
				background: isCurrent ? tint(color.accent, 10) : color.surface1,
				border: `1px solid ${isCurrent ? tint(color.accent, 32) : color.border2}`,
			},
		},
			h('span', {
				style: {
					flex: 'none', width: '30px', fontFamily: color.mono,
					fontSize: font.caption, color: isCurrent ? color.accent : color.textDim,
					fontWeight: isCurrent ? weight.bold : weight.normal,
				},
			}, String(c.no)),
			h('span', {
				style: {
					flex: '1 1 auto', minWidth: 0, fontSize: font.small,
					fontWeight: isCurrent ? weight.semibold : weight.normal,
					overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
				},
			}, c.title || `第 ${c.no} 章`),
			isCurrent && playing ? Chip({ tone: 'accent' }, '♪ 播报中') : null,
			c.version > 1 ? Chip({}, `v${c.version}`) : null,
			h('span', { style: { ...hintStyle, fontSize: font.caption, whiteSpace: 'nowrap' } }, `${c.chars ?? 0} 字`),
			Btn({ variant: 'ghost', size: 'sm', action: 'read-chapter', id: c.no, title: `阅读第 ${c.no} 章` }, '📖'),
			Btn({ variant: 'ghost', size: 'sm', action: 'play-from', id: c.no, title: `从第 ${c.no} 章开始听` }, '▶'),
		);
	});

	// ── 阅读卡（点行内 📖 展开）：正文可滚动，顺手能切朗读 ──
	// 可以一边听一边看：reader 与 playback 互不干扰。
	const reader = s.reader ? Card({ tone: 'accent', pad: space.md },
		h('div', { style: { display: 'flex', alignItems: 'center', gap: space.sm } },
			h('span', {
				style: { flex: '1 1 auto', minWidth: 0, fontWeight: weight.semibold, fontSize: font.small },
			}, `📖 第 ${s.reader.no} 章 · ${s.reader.title}`),
			Btn({ variant: 'secondary', size: 'sm', action: 'play-from', id: s.reader.no, title: `从第 ${s.reader.no} 章开始听` }, '▶ 朗读本章'),
			Btn({ variant: 'ghost', size: 'sm', action: 'close-reader', title: '收起阅读器' }, '✕'),
		),
		h('div', {
			style: {
				marginTop: space.sm,
				maxHeight: '420px', overflowY: 'auto',
				fontSize: font.small, lineHeight: 1.85,
				whiteSpace: 'pre-wrap', color: color.text,
			},
		}, s.reader.loading ? '正文加载中…' : (s.reader.text || '（本章正文为空）')),
	) : null;

	return h('div', { style: stackStyle(space.md) },
		controls,
		s.error ? h('div', { style: errStyle }, s.error) : null,
		reader,
		h('div', { style: stackStyle(space.xs) }, ...rows),
	);
}
