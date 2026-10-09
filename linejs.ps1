# LINE.js 管理腳本（Windows PowerShell 5.1 / PowerShell 7）。在專案根目錄執行，也可從任何位置呼叫。
#
#   .\linejs.ps1 start            啟動服務（缺依賴或尚未建置時會先安裝、建置；前景執行，Ctrl+C 停止）
#   .\linejs.ps1 stop             停止正在執行的服務
#   .\linejs.ps1 restart          停止後重新啟動（沒有在執行時等同 start）
#   .\linejs.ps1 update [選項]    更新到最新版（選項：--check 只檢查、--verify 要求 tag 簽章）
#   .\linejs.ps1 login            登入：在終端機顯示 QR code（服務需已啟動）
#   .\linejs.ps1 logout [--yes]   登出並清除本機登入資料（服務需已啟動）
#   .\linejs.ps1 token [--yes] [--revoke]  重設機器人 API Token（只顯示一次）；--revoke 撤銷（服務需已啟動）
#
# login／logout／token 透過正在執行的服務完成，不直接碰 session.json。
# stop／restart 依 linejs.pid 找到服務，且只會終止命令列確實是本專案 dist/main.js 的程序。
# 若系統禁止執行腳本：powershell -ExecutionPolicy Bypass -File .\linejs.ps1 <指令>
$ErrorActionPreference = 'Stop'
# Windows PowerShell 5.1 預設用系統碼頁讀寫主控台；node 輸出的是 UTF-8，繁體中文需要這行才不會變亂碼。
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Set-Location -LiteralPath $PSScriptRoot

function Show-Usage {
    Get-Content -LiteralPath $PSCommandPath -TotalCount 13 | Select-Object -Skip 1 | ForEach-Object { $_ -replace '^# ?', '' }
}

function Fail([string]$Message, [int]$Code = 1) {
    [Console]::Error.WriteLine("錯誤：$Message")
    exit $Code
}

function Test-Tools {
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail '找不到 node，請先安裝 Node.js 22 或更新版本。' }
    $major = [int](& node -p 'process.versions.node.split(".")[0]')
    if ($major -lt 22) { Fail "需要 Node.js 22 或更新版本（目前 $(& node -v)）。" }
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { Fail '找不到 npm。' }
}

# 外部程式失敗不會自動中止腳本，這裡統一檢查結束碼。
function Invoke-Checked([string]$What, [scriptblock]$Command) {
    & $Command
    if ($LASTEXITCODE -ne 0) { Fail "$What 失敗（結束碼 $LASTEXITCODE）。" $LASTEXITCODE }
}

# 依賴與建置輸出缺少或過期時補齊；都是最新時不做任何事（判斷見 scripts/service.mjs ready）。
# 只看 node_modules／dist 存在不夠：安裝中斷或 lockfile 已更新時會缺套件，啟動時才炸 ERR_MODULE_NOT_FOUND；
# 只 git pull 原始碼時則會繼續跑舊的 dist/。
# 重新安裝依賴後一併重建，因為舊的 dist/ 是用舊依賴建出來的。--include=dev：建置需要 devDependencies，
# NODE_ENV=production 時 npm 預設會略過它們。
function Initialize-Project {
    & node scripts/service.mjs ready
    $status = $LASTEXITCODE
    if ($status -eq 0) { return }
    if ($status -ne 3) {
        Write-Host '▶ 安裝依賴（npm ci）'
        Invoke-Checked 'npm ci' { npm ci --include=dev }
    }
    Write-Host '▶ 建置（npm run build）'
    Invoke-Checked 'npm run build' { npm run build }
}

function Invoke-Node([string[]]$NodeArgs) {
    & node @NodeArgs
    exit $LASTEXITCODE
}

function Start-LineJs {
    Test-Tools
    # running 在服務執行中印出 PID 並回傳 0；沒在執行回傳 1。
    $pidText = & node scripts/service.mjs running
    if ($LASTEXITCODE -eq 0) { Fail "服務已在執行（PID ${pidText}）。要重新啟動請用：.\linejs.ps1 restart" }
    Initialize-Project
    Invoke-Node @('dist/main.js')
}

$command = if ($args.Count -gt 0) { [string]$args[0] } else { 'help' }
$rest = if ($args.Count -gt 1) { [string[]]$args[1..($args.Count - 1)] } else { [string[]]@() }

switch ($command) {
    'start' {
        if ($rest.Count -gt 0) { Fail 'start 不接受參數。' }
        Start-LineJs
    }
    'stop' {
        if ($rest.Count -gt 0) { Fail 'stop 不接受參數。' }
        Test-Tools
        Invoke-Node @('scripts/service.mjs', 'stop')
    }
    'restart' {
        if ($rest.Count -gt 0) { Fail 'restart 不接受參數。' }
        Test-Tools
        Invoke-Checked '停止服務' { node scripts/service.mjs stop }
        Start-LineJs
    }
    'update' {
        Test-Tools
        Invoke-Node (@('scripts/update.mjs') + $rest)
    }
    { $_ -in 'login', 'logout', 'token' } {
        # CLI 執行的是建置後的 dist/，所以同樣先確認已建置。
        Test-Tools
        Initialize-Project
        Invoke-Node (@('scripts/cli.mjs', $command) + $rest)
    }
    { $_ -in 'help', '-h', '--help' } { Show-Usage }
    default {
        [Console]::Error.WriteLine("未知的指令：$command")
        Show-Usage
        exit 2
    }
}
