#!/bin/sh
# LINE.js 管理腳本（macOS / Linux）。在專案根目錄執行，也可從任何位置呼叫。
#
#   ./linejs.sh start            啟動服務（缺依賴或尚未建置時會先安裝、建置；前景執行，Ctrl+C 停止）
#   ./linejs.sh stop             停止正在執行的服務
#   ./linejs.sh restart          停止後重新啟動（沒有在執行時等同 start）
#   ./linejs.sh update [選項]    更新到最新版（選項：--check 只檢查、--verify 要求 tag 簽章）
#   ./linejs.sh login            登入：在終端機顯示 QR code（服務需已啟動）
#   ./linejs.sh logout [--yes]   登出並清除本機登入資料（服務需已啟動）
#   ./linejs.sh token [--yes] [--revoke]  重設機器人 API Token（只顯示一次）；--revoke 撤銷（服務需已啟動）
#
# login／logout／token 透過正在執行的服務完成，不直接碰 session.json。
# stop／restart 依 linejs.pid 找到服務，且只會終止命令列確實是本專案 dist/main.js 的程序。
set -eu

cd "$(dirname "$0")"

usage() {
  sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'
}

die() {
  echo "錯誤：$1" >&2
  exit 1
}

need_node() {
  command -v node >/dev/null 2>&1 || die "找不到 node，請先安裝 Node.js 22 或更新版本。"
  major=$(node -p 'process.versions.node.split(".")[0]')
  [ "$major" -ge 22 ] || die "需要 Node.js 22 或更新版本（目前 $(node -v)）。"
  command -v npm >/dev/null 2>&1 || die "找不到 npm。"
}

# 依賴與建置輸出缺少時補齊；已齊全時不做任何事。
# 只看 node_modules 目錄存在不夠：安裝中斷或 lockfile 已更新時會缺套件，啟動時才炸 ERR_MODULE_NOT_FOUND。
# 重新安裝依賴後一併重建，因為舊的 dist/ 是用舊依賴建出來的。--include=dev：建置需要 devDependencies，
# NODE_ENV=production 時 npm 預設會略過它們。
ensure_ready() {
  rebuild=0
  if ! node scripts/service.mjs deps; then
    echo "▶ 安裝依賴（npm ci）"
    npm ci --include=dev
    rebuild=1
  fi
  if [ "$rebuild" -eq 1 ] || [ ! -f dist/main.js ] || [ ! -f dist/web/index.html ]; then
    echo "▶ 建置（npm run build）"
    npm run build
  fi
}

start_service() {
  need_node
  if pid=$(node scripts/service.mjs running); then
    die "服務已在執行（PID ${pid}）。要重新啟動請用：$0 restart"
  fi
  ensure_ready
  exec node dist/main.js
}

# CLI 執行的是建置後的 dist/，所以同樣先確認已建置。
run_cli() {
  need_node
  ensure_ready
  exec node scripts/cli.mjs "$@"
}

command=${1:-help}
[ "$#" -gt 0 ] && shift

case "$command" in
  start)
    [ "$#" -eq 0 ] || die "start 不接受參數。"
    start_service
    ;;
  stop)
    [ "$#" -eq 0 ] || die "stop 不接受參數。"
    need_node
    exec node scripts/service.mjs stop
    ;;
  restart)
    [ "$#" -eq 0 ] || die "restart 不接受參數。"
    need_node
    node scripts/service.mjs stop
    start_service
    ;;
  update)
    need_node
    exec node scripts/update.mjs "$@"
    ;;
  login | logout | token)
    run_cli "$command" "$@"
    ;;
  help | -h | --help)
    usage
    ;;
  *)
    echo "未知的指令：$command" >&2
    usage >&2
    exit 2
    ;;
esac
