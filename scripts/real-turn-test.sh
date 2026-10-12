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
BK="/Users/huangshengju/Documents/other/dsh-novel-forge/真机测试备份"
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
dsh --profile headless --json \
  "继续写《开局觉醒加特林》的第 102 章。按小说锻炉的工作流走完再落盘：novel_project status 看清进度 → novel_outline save_chapter 写第102章细纲（含「## 本章必写场景」与「## 本章禁止偏离项」）→ novel_outline approve → novel_scene save 声明本章出场人物 → novel_briefing 拿上下文包 → 按细纲成稿后 novel_write_chapter 落盘（正文 2000-4000 字，带上 summary 与 facts_updates）。只写这一章，写完停下汇报本章要点和下一章建议。" \
  > "$OUT" 2> "$ERR"
echo "[done] exit=$? 事件 $(wc -l < "$OUT") 行 / stderr $(wc -l < "$ERR") 行 → $OUT"
