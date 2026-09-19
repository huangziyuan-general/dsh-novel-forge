// src/client/views/settings.js — 设置视图。
//
// 只读的「能力清单」：让用户在 UI 里确认插件到底装了什么、哪些事面板能自己做、
// 哪些必须回到会话里做。写操作（开关 / 数据目录）预留给后续的 /settings 端点。
//
// 为什么值得写细：这份清单直接影响「遇到事该去哪」——把面板做不了的事写清楚，
// 用户就不会对着一个点了没反应的按钮发呆（0.12 之前好几次都是这么卡住的）。
import { h } from '../react.js';
import { color, space, font, weight, footerStyle, stackStyle } from '../styles.js';
import { Card, Btn, Chip, KV, Section } from '../ui.js';

/** 能力行：左侧打勾/点，右侧一句人话。 */
function cap(can, text) {
	return h('div', { style: { display: 'flex', gap: space.sm, alignItems: 'flex-start', fontSize: font.small } },
		h('span', { style: { flex: 'none', color: can ? color.ok : color.textDim, width: '12px' } }, can ? '✓' : '·'),
		h('span', { style: { flex: '1 1 auto', minWidth: 0, color: can ? color.text2 : color.text3, lineHeight: 1.7 } }, text),
	);
}

export function SettingsView() {
	return h('div', { style: stackStyle(space.lg) },

		h('div', { style: { display: 'flex', alignItems: 'center', gap: space.sm } },
			Btn({ variant: 'ghost', size: 'sm', action: 'back-from-settings' }, '← 返回'),
			h('span', { style: { fontWeight: weight.semibold, fontSize: font.lead } }, '⚙ 设置'),
			h('span', { style: { flex: '1 1 auto' } }),
			Chip({}, 'v' + (window.__NOVEL_FORGE_VERSION__ || '?')),
		),

		// ── 注册了什么 ──
		Card({ tone: 'plain' },
			Section({ icon: '🧩', title: '已装配' },
				h('div', { style: stackStyle(space.sm) },
					// ⚠️ 不写死工具数：注册数随版本变（0.13.x 已从 17 涨到 20+），
					// 数字一落字就是下一版必过期的漂移炸弹（common.js 注释同款教训）。
					KV({ k: 'tools' }, '全部 novel_* 工具已注册'),
					KV({ k: '通道' }, '宿主工具面 + MCP 双通道'),
					KV({ k: '硬约束' }, '账本 / 门禁 / 机审 / 提案制 —— 判定权在代码，不在模型'),
					KV({ k: '旁路引擎' }, '润色 / 校对 / 打标 / 起草 四通道（不占主对话、不写会话记录）'),
					KV({ k: '检索' }, 'node:sqlite + FTS5 + 中文二元切分（无 embedding，纯本地）'),
				),
			),
		),

		// ── 面板能做什么 / 不能做什么 ──
		Card({ tone: 'plain' },
			Section({ icon: '🖱', title: '这个面板能直接做' },
				h('div', { style: stackStyle(space.xs) },
					cap(true, '读章、改稿、存稿、导出、删除、改名、认领旧书'),
					cap(true, '一键润色 / 校对 —— 走旁路引擎，产物是提案，你点「应用」才生效'),
					cap(true, '批量起草 —— 并发生成、串行提交，每章照样过全部门禁'),
					cap(true, '全书体检 —— 死人复活 / 账本矛盾 / 伏笔超期 / 章号断档（零 token）'),
					cap(true, '批准或丢弃模型提的修订；管理世界书；章节朗读连播'),
					cap(true, '克隆为模板 —— 一键把老书连章节、大纲、人物、世界书、账本、伏笔复制成新书'),
				),
			),
			h('div', { style: { marginTop: space.lg } },
				Section({ icon: '💬', title: '只能回会话里做' },
					h('div', { style: stackStyle(space.xs) },
						// M16 修复：本清单说「写章 / 结构诊断面板做不了」早就不成立——
						// 面板有「写单章」（走批量端点，同一门禁链）和「结构诊断」按钮（纯词表打分，零 token）
						cap(false, '写章（novel_write_chapter）—— 面板「写单章」可落盘单章；拼全书上下文包的完整写作流仍在会话'),
						cap(false, '去AI味评级 / 平台审稿 / 润色分析 —— 重活仍在会话工具'),
						cap(false, '生成大纲、角色卡、细纲、设定（novel_outline / novel_cast / novel_world）'),
						cap(false, '导入既有文稿（novel_import）'),
						cap(false, '书库「饲料」—— 喂外部小说、对比结构画像（novel_library：import / list / compare）'),
					),
				),
			),
		),

		h('p', { style: footerStyle },
			'在会话里调用 novel_* 工具驱动写作；本面板只负责「确定性那部分」——',
			'凡是需要模型参与的动作，都会在审计里留下 actor 记录。'),
	);
}
