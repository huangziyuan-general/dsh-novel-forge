#!/bin/bash
# 真机写章回合测试（需要可用的模型额度）。
# 把 101 章的真书复制进一个带时间戳的临时根，用 `dsh --profile headless --json`
# 跑一次完整写章链（status → 细纲 → approve → 场景 → briefing → write_chapter），
# 事件流与 stderr 落在临时根旁边。全程不碰原书；每次跑都用新目录，不删任何东西
# （清理由人决定，走系统回收站）。
#
# 用法：bash scripts/real-turn-test.sh
# 已知坑：headless profile 目前会因 sessionController/workspaceController 缺席把本插件
# 挂成 pending（真机实证 2026-10-12）——该依赖改成嵌套 fiber 之前，这个跑法拿不到 novel_* 工具。
set -uo pipefail

SRC="/Users/huangshengju/Documents/novel/开局觉醒加特林"
REPO="/Users/huangshengju/Documents/other/dsh-novel-forge"
BK="$REPO/真机测试备份"
STAMP="$(date +%Y%m%d-%H%M%S)"
ROOT="$BK/ws-$STAMP"
OUT="$BK/headless-events-$STAMP.jsonl"
ERR="$BK/headless-stderr-$STAMP.log"

mkdir -p "$ROOT"
cp "$SRC/novel.json" "$BK/novel.json.pre" 2>/dev/null || true
cp -R "$SRC" "$ROOT/开局觉醒加特林"
echo "[prep] STAMP=$STAMP 复制 $(du -sh "$ROOT/开局觉醒加特林" | cut -f1)，章数 $(node -e "
const j=require('$ROOT/开局觉醒加特林/novel.json');console.log(Object.keys(j.chapters).length)")"

export PATH=/Users/huangshengju/.npm-global/bin:$PATH
cd "$ROOT"
# --patch：给 headless 补 arkcoding 路由（不给 providers 就没有 openai-completions
# 适配器，光切默认模型必报 NO_ADAPTER；不给 patch 则走默认 deepseek-official —— 那把
# 凭据没余额，就是之前 402 的真来源）。见 scripts/arkc-headless.patch.yml。
dsh --profile headless --patch "$REPO/scripts/arkc-headless.patch.yml" --json \
  "继续写《开局觉醒加特林》的第 102 章。按小说锻炉的工作流走完再落盘：novel_project status 看清进度 → novel_outline save_chapter 写第102章细纲（含「## 本章必写场景」与「## 本章禁止偏离项」）→ novel_outline approve → novel_scene save 声明本章出场人物 → novel_briefing 拿上下文包 → 按细纲成稿后 novel_write_chapter 落盘（正文 2000-4000 字，带上 summary 与 facts_updates）。只写这一章，写完停下汇报本章要点和下一章建议。" \
  > "$OUT" 2> "$ERR"
echo "[done] exit=$? 事件 $(wc -l < "$OUT") 行 / stderr $(wc -l < "$ERR") 行 → $OUT"

# ── 用量与行为读取 + 真机门禁 ────────────────────────────────────────────────
# 数据源就是本次的 --json 事件流（step_end 带 usage、tool_call/tool_result 带工具轨迹），
# 不去猜 ~/.dsh/sessions 下哪个分组是本次的（猜错就采样 0 条、把成功的跑读成空表）。
# 要看**未截断**的工具出入参（事件流对大结果打 truncated:true，简报正文只剩前 ~3k 字），
# 走会话持久化取证：node scripts/read-turn-usage.mjs ~/.dsh/sessions/<cwd 分组>
# 门禁（--assert）：峰值上下文 ≤ 120k（健康 ~87k / 死亡螺旋 183k）、退路读取 = 0、
# 宿主拒收 = 0、步数 > 0——任何一项越线 exit 1。**不许失败后改阈值硬压**，先修因；
# 确需调阈值（比如换了更大的上下文模型），连同理由改这里的注释。
node "$REPO/scripts/read-turn-usage.mjs" --events "$OUT" --assert || {
  echo "✘ 真机门禁未过：拒绝/退路读取/峰值超限，先按事件流定位成因再重跑"; exit 1;
}

