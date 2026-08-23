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

# cron の PATH は /usr/bin:/bin しかなく、nvm 配下の node が見つからない。
# ここで自己完結させる（crontab 側に PATH を書くと二重管理になる）。
if ! command -v npm > /dev/null 2>&1; then
  if [ -s "$HOME/.nvm/nvm.sh" ]; then
    # shellcheck disable=SC1091
    . "$HOME/.nvm/nvm.sh" > /dev/null 2>&1
  fi
fi
if ! command -v npm > /dev/null 2>&1; then
  for d in "$HOME"/.nvm/versions/node/*/bin; do
    [ -x "$d/npm" ] && PATH="$d:$PATH"
  done
  export PATH
fi
if ! command -v npm > /dev/null 2>&1; then
  echo "npm が見つからない。PATH: $PATH" >&2
  exit 1
fi
# gh も cron の PATH には無い（~/.local/bin にある）。
[ -d "$HOME/.local/bin" ] && PATH="$HOME/.local/bin:$PATH" && export PATH

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

# --- 取り込んだ差分を PR にする ---
# 手元運用では PR を作らないと data/ の差分が未コミットのまま溜まり、
# 次の作業で意図せず巻き込む。ブランチを切って push まで行う。
# main への直接コミットはしない。
PR_URL=""
if [ -z "$DRY" ] && [ -n "$(git status --porcelain data/)" ]; then
  BRANCH_NOW="$(git rev-parse --abbrev-ref HEAD)"
  DIRTY_OUTSIDE="$(git status --porcelain -- . ':(exclude)data' | head -1)"

  if [ "$BRANCH_NOW" != "main" ]; then
    echo "main 以外（$BRANCH_NOW）で作業中なので PR は作らない。差分は手元に残す" >&2
  elif [ -n "$DIRTY_OUTSIDE" ]; then
    echo "data/ の外に未コミットの変更があるので PR は作らない。差分は手元に残す" >&2
  elif ! command -v gh > /dev/null 2>&1; then
    echo "gh が見つからないので PR は作らない。差分は手元に残す" >&2
  else
    git fetch origin --quiet
    # 前回の PR が残っていればその続きに積む。無ければ main から切る。
    if git rev-parse --verify --quiet origin/collect/auto > /dev/null; then
      git checkout -B collect/auto origin/collect/auto --quiet
    else
      git checkout -B collect/auto origin/main --quiet
    fi
    git add data/
    git commit --quiet -m "公式サイトから興行データを取り込む

tools/collect/daily.sh による自動収集。詳細は PR 本文のレポートを参照。"
    if git push --quiet -u origin collect/auto; then
      PR_URL="$(gh pr list --head collect/auto --state open --json url --jq '.[0].url')"
      if [ -z "$PR_URL" ]; then
        PR_URL="$(gh pr create --base main --head collect/auto \
          --title "データ収集: $(date '+%F')" \
          --body-file .cache/report.md 2>/dev/null)"
      fi
      echo "PR: ${PR_URL:-作成できず}"
    else
      echo "push に失敗した。差分はブランチ collect/auto に残っている" >&2
    fi
    git checkout main --quiet
  fi
fi

if [ -n "${TELEGRAM_BOT_TOKEN:-}" ]; then
  JOB_STATUS=$([ "$BUILD_STATUS" -eq 0 ] && echo success || echo failure) \
  LABEL="手元実行（3 団体）" \
  PR_URL="$PR_URL" \
  RUN_URL="" \
    bash .github/scripts/notify-telegram.sh || true
fi

# 終了コードは門（検証とビルド）に合わせる。収集の部分失敗で毎日
# 「失敗」に見えると、本当に壊れたときに気付けなくなる。
exit "$BUILD_STATUS"
