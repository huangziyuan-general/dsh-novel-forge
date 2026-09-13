// src/client/styles.js — 全部内联样式常量。
//
// 设计约束：不引入 CSS 文件 / 不引入新包；颜色一律走宿主的 dsw-* 自定义属性，
// 每个都带一个深色回退值，保证宿主没定义时也可读。
// （宿主设计系统的 token 只在 --dsw-alias-* 命名空间，插件不自己发明颜色。）

export const rootStyle = {
	boxSizing: 'border-box', height: '100%', minHeight: 0,
	display: 'flex', flexDirection: 'column', gap: '8px',
	padding: '12px 12px 16px', overflow: 'auto',
	color: 'var(--dsw-alias-label-primary, #e6e6e6)',
	fontSize: '13px', lineHeight: 1.6,
};

export const headerStyle = {
	display: 'flex', alignItems: 'center', gap: '8px',
	padding: '10px 14px', borderBottom: '1px solid var(--dsw-alias-border-l3, #333)',
	flex: '0 0 auto', background: 'var(--dsw-alias-bg-primary, #1a1a1a)',
};

export const badgeStyle = {
	flex: 'none', padding: '1px 8px', borderRadius: '999px',
	background: 'var(--dsw-alias-accent-soft, rgba(80,120,255,.18))',
	color: 'var(--dsw-alias-accent-strong, #8ab4ff)', fontSize: '11px',
};

export const cardStyle = {
	flex: 'none', border: '1px solid var(--dsw-alias-border-l3, #333)',
	borderRadius: '10px', padding: '10px 12px',
	background: 'var(--dsw-alias-bg-overlay, transparent)',
};

export const rowStyle = { display: 'flex', alignItems: 'flex-start', gap: '8px', flex: 'none' };

export const kStyle = {
	flex: 'none', minWidth: '56px',
	fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
	fontSize: '11px', color: 'var(--dsw-alias-label-secondary, #9aa0aa)', paddingTop: '2px',
};

export const vStyle = { flex: 'auto', minWidth: 0, wordBreak: 'break-word' };

export const btnStyle = {
	flex: 'none', background: 'transparent',
	border: '1px solid var(--dsw-alias-border-l3, #333)', borderRadius: '6px',
	color: 'var(--dsw-alias-label-secondary, #9aa0aa)',
	fontSize: '11px', padding: '2px 8px', cursor: 'pointer', fontFamily: 'inherit',
};

export const inputStyle = {
	padding: '4px 6px', border: '1px solid var(--dsw-alias-border-l3, #333)',
	borderRadius: '4px', width: '100%', boxSizing: 'border-box',
	background: 'var(--dsw-alias-bg-primary, #1a1a1a)',
	color: 'var(--dsw-alias-label-primary, #e6e6e6)',
};

export const errStyle = {
	flex: 'auto', minWidth: 0,
	color: 'var(--dsw-alias-label-danger, #ff8a8a)',
	fontSize: '11.5px', wordBreak: 'break-word',
};

export const footerStyle = {
	margin: '0', color: 'var(--dsw-alias-label-tertiary, #6b7280)',
	fontSize: '11px', flex: 'none',
};

/** 成功/提示文案（绿）。 */
export const okStyle = { color: '#2a7', fontSize: '12px' };

/** 次要说明文字（灰）。 */
export const hintStyle = { color: '#888' };

/** 空列表占位。 */
export const emptyStyle = { color: '#888' };

/** 卡片容器（项目/世界书条目共用）。 */
export const itemCardStyle = {
	padding: '8px 10px',
	border: '1px solid var(--dsw-alias-border-l3, #333)',
	borderRadius: '6px',
	background: 'var(--dsw-alias-bg-overlay, transparent)',
};

/** 次级小按钮。 */
export const miniBtnStyle = { ...btnStyle, fontSize: '11px', padding: '2px 6px' };

/** 危险按钮（删除）。 */
export const dangerBtnStyle = { ...btnStyle, color: '#c33' };

/** 主色按钮（保存）。 */
export const primaryBtnStyle = { ...btnStyle, borderColor: '#2a7', color: '#156' };

/** 副色按钮（导入本地 / 润色）。 */
export const accentBtnStyle = { ...btnStyle, borderColor: '#29a', color: '#156' };
