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
#   TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID あれば結果を通知する。
#                                         未設定なら ~/.telegram-bot-token と
#                                         ~/.telegram-chat-id を読む
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

# --- 収集はブランチ collect/auto の上で行う ---
# main の上で収集すると、まだマージされていない前回の収集結果を毎回
# 「新規」として作り直す。その未追跡ファイルが collect/auto 側の同名ファイルと
# ぶつかり、後から checkout しようとしても中断される。作業ツリーが綺麗な
# うちに切り替えておけば、この衝突は原理的に起きない。
# 切り替えに失敗したときは main の上で commit しない（差分は手元に残す）。
ON_BRANCH=""
if [ -z "$DRY" ]; then
  BRANCH_NOW="$(git rev-parse --abbrev-ref HEAD)"
  DIRTY="$(git status --porcelain | head -1)"

  if [ "$BRANCH_NOW" != "main" ]; then
    echo "main 以外（$BRANCH_NOW）で作業中なので PR は作らない。差分は手元に残す" >&2
  elif [ -n "$DIRTY" ]; then
    echo "未コミットの変更があるので PR は作らない。差分は手元に残す" >&2
  elif ! command -v gh > /dev/null 2>&1; then
    echo "gh が見つからないので PR は作らない。差分は手元に残す" >&2
  else
    # --prune を付ける。PR をマージしてブランチを消しても、手元の
    # origin/collect/auto は残る。残ったままだと「残骸あり」と誤判定して、
    # 既に無いリモートブランチを消しにいってエラーを吐く。
    git fetch origin --prune --quiet
    # 前回の PR がまだ開いていればその続きに積む。開いた PR が無いのに
    # ブランチだけ残っているのはマージ済みの残骸なので、そこから積むと
    # 古い data/ の上に積むことになる。消して main から切り直す。
    if [ -n "$(gh pr list --head collect/auto --state open --json url --jq '.[0].url' 2> /dev/null)" ]; then
      BASE=origin/collect/auto
    else
      BASE=origin/main
      if git rev-parse --verify --quiet origin/collect/auto > /dev/null; then
        git push --quiet origin --delete collect/auto || true
      fi
    fi

    if git checkout -B collect/auto "$BASE" --quiet; then
      ON_BRANCH=1
      # 収集はこのブランチの上で走る。tools/ も data/wrestlers/ も
      # ブランチ側のものが使われるので、main に入った修正や新しい選手を
      # 取り込んでおかないと、古いコードと古い名寄せ表で収集してしまう。
      if ! git merge --no-edit --quiet origin/main > /dev/null 2>&1; then
        git merge --abort > /dev/null 2>&1
        git checkout main --quiet
        ON_BRANCH=""
        echo "collect/auto に main を取り込めなかった（衝突）。PR は作らない。手で解消すること" >&2
      fi
      if [ -n "$ON_BRANCH" ]; then
        # どこで落ちても main に戻す。戻せなければ次回の実行が
        # 「main 以外で作業中」として自分で止まる。
        trap 'git checkout main --quiet 2> /dev/null || echo "main に戻せなかった。手元のブランチを確認すること" >&2' EXIT
      fi
    else
      echo "collect/auto に切り替えられなかったので PR は作らない。差分は手元に残す" >&2
    fi
  fi
fi

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
# 次の作業で意図せず巻き込む。ここまで来ていれば collect/auto の上に居る。
PR_URL=""
if [ -n "$ON_BRANCH" ] && [ -n "$(git status --porcelain data/)" ]; then
  # 念のためもう一度見る。main に居たら絶対に commit しない。
  HEAD_NOW="$(git rev-parse --abbrev-ref HEAD)"
  if [ "$HEAD_NOW" != "collect/auto" ]; then
    echo "collect/auto に居ない（$HEAD_NOW）ので commit しない。差分は手元に残す" >&2
  else
    git add data/
    git commit --quiet -m "公式サイトから興行データを取り込む

tools/collect/daily.sh による自動収集。詳細は PR 本文のレポートを参照。"
    # ブランチ名ではなく HEAD を push する。同名のローカルブランチが
    # 古いまま残っていると、それを押し込んで「成功」してしまう。
    if git push --quiet origin HEAD:collect/auto; then
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
  fi
fi

# 通知の鍵も環境変数が無ければファイルから読む。GitHub Secrets はローカル
# 運用では使えないので、手元に置いたファイルを既定の置き場にする。
: "${TELEGRAM_BOT_TOKEN:=$([ -r "$HOME/.telegram-bot-token" ] && cat "$HOME/.telegram-bot-token" || echo "")}"
: "${TELEGRAM_CHAT_ID:=$([ -r "$HOME/.telegram-chat-id" ] && cat "$HOME/.telegram-chat-id" || echo "")}"
export TELEGRAM_BOT_TOKEN TELEGRAM_CHAT_ID

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
