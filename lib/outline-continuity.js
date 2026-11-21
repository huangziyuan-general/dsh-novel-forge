// lib/outline-continuity.js — 未定稿章节细纲的一致性预检（纯函数，零 token）。
//
// 存在的缺口：死亡再现扫描与关系 stale 判据的扫描域都是**已写正文**——细纲（规划面）
// 里的矛盾要等到写章被内容门禁拒才暴露，那时已经烧过一次模型调用。本模块在细纲
// 「拿到合法身份」的关口（novel_outline approve）把同一套判据提前跑一遍：
//   ① 细纲点名了已死实体（复用 continuity.deathTimeline 的死亡名册 + 同一套闪回豁免正则）；
//   ② 细纲仍在用关系线的过期值（复用 relations.detectStaleRelations 的时点推演判据）。
// 口径与正文面一致：命中报 **warning** 不拦——细纲是规划不是成稿，拦截语义留给写章
// 内容门禁（approve 的 divergence 重合度警告就是同一先例）；同一实体/同一对·维度各报
// 一次，防长细纲刷屏。

import { deathTimeline, FLASHBACK_RE } from './continuity.js';
import { detectStaleRelations } from './relations.js';

/** 细纲长度上限：超长的细纲只按截断文本查（判据是实体名出现与否，截断不改变结论方向）。 */
const MAX_OUTLINE_CHARS = 4000;

/**
 * 预检一条细纲：死亡实体再现 + 关系线过期值。
 * @param chapter   细纲所属章号（关系时点推演的上界：取「写到这一章时」的当前关系值）
 * @param outline   细纲全文
 * @param facts     事实账本行（死亡名册来源）
 * @param relations 关系账本行
 * @returns { issues:[{severity:'warning', code, where, message}] }（与 continuity 的 issue 同 shape）
 */
export function checkOutlineContinuity({ chapter, outline, facts, relations }) {
    const text = String(outline ?? '').slice(0, MAX_OUTLINE_CHARS);
    const issues = [];
    if (text.trim() === '') return { issues };
    // 细纲自带闪回/回忆标记 → 与正文面同一豁免：死人名出现降级不报（豁免判据单一实现，
    // 不在这边再写一份正则）
    const flashback = FLASHBACK_RE.test(text);

    // ① 已死实体：死亡章在本章之前的实体，名字出现在细纲里
    const deaths = deathTimeline(facts);
    const flagged = new Set();
    for (const [entity, d] of deaths) {
        if (typeof entity !== 'string' || entity.trim() === '' || d.chapter >= chapter) continue;
        if (!text.includes(entity) || flagged.has(entity)) continue;
        flagged.add(entity);
        issues.push({
            severity: 'warning',
            code: flashback ? 'outline-dead-flashback' : 'outline-dead-reappear',
            where: `第${chapter}章细纲·${entity}`,
            message: flashback
                ? `「${entity}」在第${d.chapter}章已死，第${chapter}章细纲再次点名——细纲带闪回/回忆标记，按豁免处理；请确认确为回忆场景而非复活`
                : `「${entity}」已在第${d.chapter}章死亡，第${chapter}章细纲仍点名出场——若非复活剧情，改细纲（移除该实体或改写为遗物/追述）；确为闪回请写明「回忆/闪回/梦境」`,
        });
    }

    // ② 关系线过期值：时点推演到本章的当前值之外，细纲还在用更早的值
    const stale = detectStaleRelations({ content: text, relations, chapter });
    for (const h of stale) {
        issues.push({
            severity: 'warning',
            code: 'outline-stale-relation',
            where: `第${chapter}章细纲·${h.a}/${h.b}`,
            message: `关系「${h.a}↔${h.b}·${h.relation}」第${h.nowChapter}章起已是「${h.now}」，细纲仍在用旧值「${h.old}」——同步细纲或先 novel_relation update 推进账本`,
        });
    }
    return { issues };
}
