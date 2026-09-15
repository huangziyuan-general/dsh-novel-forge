// src/client/genre.js — 题材显示名归一。
//
// 为什么存在：面板创建表单早期把题材默认值写死成英文 'fantasy'（还没有题材输入框），
// 一批书的数据里存的是英文小写。工具侧建书默认是「未分类」，模型给的通常是中文。
// 这里在**显示层**做一次归一：常见英文题材映射成中文，其余原样透传——
// 不改用户数据，映射表外的值（比如自造的复合题材）不受影响。

const MAP = {
	fantasy: '奇幻',
	xuanhuan: '玄幻',
	xianxia: '仙侠',
	xiuzhen: '修真',
	wuxia: '武侠',
	scifi: '科幻',
	sciencefiction: '科幻',
	romance: '言情',
	mystery: '悬疑',
	suspense: '悬疑',
	thriller: '惊悚',
	horror: '恐怖',
	urban: '都市',
	city: '都市',
	game: '游戏',
	esports: '电竞',
	history: '历史',
	military: '军事',
	comedy: '喜剧',
	drama: '剧情',
	sliceoflife: '日常',
};

/**
 * 题材显示名。空值返回 ''（调用方用真值判断决定要不要渲染 chip）；
 * 命中映射表（忽略大小写/连字符/空格）给中文，否则原样返回。
 */
export function genreLabel(genre) {
	const raw = String(genre ?? '').trim();
	if (!raw) return '';
	const key = raw.toLowerCase().replace(/[^a-z]/g, '');
	return MAP[key] ?? raw;
}
