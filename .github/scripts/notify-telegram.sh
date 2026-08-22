#!/usr/bin/env bash
# 収集結果を Telegram に送る。2 つのジョブから同じ形で使う。
#
# 本文は jq で組み立てる。レポート由来の文字列（公式サイトの見出しなどを
# 含む）をシェルや JSON に直接埋めない。
# 通知が失敗してもバッチ本体は落とさない（呼び出し側が continue-on-error）。
set -uo pipefail

SUMMARY_FILE="${SUMMARY_FILE:-.cache/summary.txt}"
SUMMARY="$(cat "$SUMMARY_FILE" 2>/dev/null || echo '要約なし（収集前に落ちた可能性）')"

TEXT="$(printf '%s\n%s\n%s\n%s\n%s' \
  "pw-elni 収集 [${JOB_STATUS:-unknown}]" \
  "${LABEL:-}" \
  "$SUMMARY" \
  "${PR_URL:-差分なし}" \
  "${RUN_URL:-}")"

BODY="$(jq -n --arg chat "$TELEGRAM_CHAT_ID" --arg text "$TEXT" \
  '{chat_id: $chat, text: $text, disable_web_page_preview: true}')"

curl -sS --max-time 30 -X POST \
  "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
  -H 'Content-Type: application/json' \
  -d "$BODY" \
  > /dev/null
