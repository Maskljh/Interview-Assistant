# 启动后端（脱离会话，供 Start-Process 调用）
$ErrorActionPreference = 'Stop'
cd "C:\Users\l\Desktop\Interview Assistant"
Get-Content ".env" | ForEach-Object {
    if ($_ -match '^\s*([^#][^=]*)=(.*)$') {
        [System.Environment]::SetEnvironmentVariable($matches[1].Trim(), $matches[2].Trim(), 'Process')
    }
}
& ".\server.exe" *> "C:\Users\l\Desktop\Interview Assistant\backend.log"
