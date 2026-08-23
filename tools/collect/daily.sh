#!/usr/bin/env bash
# 日次の収集を手元で回す。GitHub Actions は使わない（新日本が CI から
# 取得できず、Obsidian の Vault にも CI からは書けないため）。
#
# 使い方:
#   tools/collect/daily.sh            # 3 団体すべて + Obsidian へ書き出し
#   DRY_RUN=1 tools/collect/daily.sh  # data/ に書かずに確認だけ
#
# 鍵は環境変数から読む。リポジトリにもシェル履歴にも残さないこと。
#   GEMINI_API_KEY                        新日本の LLM 抽出に使う。
#                                         無ければ新日本は取りこぼしとして報告される
#   TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID あれば結果を通知する
set -uo pipefail

cd "$(dirname "$0")/../.." || exit 1

DRY=""
[ "${DRY_RUN:-}" = "1" ] && DRY="--dry-run"

# 1 回の実行で LLM を呼ぶ上限。取りこぼしが急に増えても課金が跳ねない。
export LLM_MAX_CALLS="${LLM_MAX_CALLS:-30}"

echo "=== 収集 $(date '+%F %T') ==="
# 収集は部分失敗を許容する設計なので、ここの終了コードは見ない。
# 失敗した団体・興行はレポートと通知に載る。
# shellcheck disable=SC2086
npm run collect -- $DRY || true

echo "=== 検証とビルド ==="
npm run build > /dev/null 2>&1
BUILD_STATUS=$?

if [ "$BUILD_STATUS" -ne 0 ]; then
  # 壊れたデータを Vault に流さない。
  echo "ビルドに失敗したので Obsidian への書き出しは行わない" >&2
else
  echo "=== Obsidian へ書き出し ==="
  npm run obsidian
fi

if [ -n "${TELEGRAM_BOT_TOKEN:-}" ]; then
  JOB_STATUS=$([ "$BUILD_STATUS" -eq 0 ] && echo success || echo failure) \
  LABEL="手元実行（3 団体）" \
  RUN_URL="" \
    bash .github/scripts/notify-telegram.sh || true
fi

# 終了コードは門（検証とビルド）に合わせる。収集の部分失敗で毎日
# 「失敗」に見えると、本当に壊れたときに気付けなくなる。
exit "$BUILD_STATUS"
