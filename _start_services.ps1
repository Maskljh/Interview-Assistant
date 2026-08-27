# 临时启动脚本：后端 server.exe + 前端 preview(:5174)
# 依赖前置已就绪：Redis 6379 已启动、MySQL 本机 3306 已监听

Write-Host "[1/2] 启动后端 API (:18080)..." -ForegroundColor Yellow
$backend = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq "C:\Users\l\Desktop\Interview Assistant\server.exe" }
if ($backend) {
    Write-Host "      后端已在运行 (PID $($backend.Id))" -ForegroundColor Green
} else {
    Get-Content "C:\Users\l\Desktop\Interview Assistant\.env" | ForEach-Object {
        if ($_ -match '^\s*([^#][^=]*)=(.*)$') {
            [System.Environment]::SetEnvironmentVariable($matches[1].Trim(), $matches[2].Trim(), 'Process')
        }
    }
    Start-Process -FilePath "C:\Users\l\Desktop\Interview Assistant\server.exe" -WorkingDirectory "C:\Users\l\Desktop\Interview Assistant" -WindowStyle Hidden
    Start-Sleep -Seconds 3
    Write-Host "      后端已启动" -ForegroundColor Green
}

Write-Host "[2/2] 启动前端 preview (:5174)..." -ForegroundColor Yellow
$front = Get-NetTCPConnection -LocalPort 5174 -State Listen -ErrorAction SilentlyContinue
if ($front) {
    Write-Host "      前端已在运行 (:5174)" -ForegroundColor Green
} else {
    Start-Process -FilePath "npm" -ArgumentList "run", "preview" -WorkingDirectory "C:\Users\l\Desktop\Interview Assistant\frontend" -WindowStyle Hidden
    Start-Sleep -Seconds 5
    Write-Host "      前端已启动" -ForegroundColor Green
}

Write-Host "=== 启动脚本执行完成 ===" -ForegroundColor Cyan
