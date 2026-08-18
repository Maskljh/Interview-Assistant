# 模拟面试助手 - 一键启动脚本
# 用法: 双击运行 或 在项目根目录执行 .\start.ps1
# 会启动: Docker(MySQL/Redis) + 后端 server.exe + 前端 preview(5174)

Write-Host "=== 模拟面试助手 启动 ===" -ForegroundColor Cyan

# 1. 启动 Docker 容器 (MySQL/Redis)
Write-Host "[1/3] 启动 Docker 容器..." -ForegroundColor Yellow
try {
    docker start feat-v2b-voice-mysql-1 feat-v2b-voice-redis-1 2>$null
    if (-not $?) {
        docker compose up -d 2>$null
    }
    Start-Sleep -Seconds 6
    Write-Host "      MySQL/Redis 已启动" -ForegroundColor Green
} catch {
    Write-Host "      Docker 启动失败，请确认 Docker Desktop 已运行" -ForegroundColor Red
}

# 2. 启动后端 (固定路径 server.exe，避免 go run 临时路径被防火墙拦截)
Write-Host "[2/3] 启动后端 API (:8080)..." -ForegroundColor Yellow
$backend = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq "C:\Users\l\Desktop\Interview Assistant\server.exe" }
if ($backend) {
    Write-Host "      后端已在运行 (PID $($backend.Id))" -ForegroundColor Green
} else {
    # 读取 .env 设置环境变量
    Get-Content "C:\Users\l\Desktop\Interview Assistant\.env" | ForEach-Object {
        if ($_ -match '^\s*([^#][^=]*)=(.*)$') {
            [System.Environment]::SetEnvironmentVariable($matches[1].Trim(), $matches[2].Trim(), 'Process')
        }
    }
    Start-Process -FilePath "C:\Users\l\Desktop\Interview Assistant\server.exe" -WorkingDirectory "C:\Users\l\Desktop\Interview Assistant" -WindowStyle Hidden
    Start-Sleep -Seconds 3
    Write-Host "      后端已启动" -ForegroundColor Green
}

# 3. 启动前端 preview (5174, PWA 完整版)
Write-Host "[3/3] 启动前端 (:5174)..." -ForegroundColor Yellow
$front = Get-NetTCPConnection -LocalPort 5174 -State Listen -ErrorAction SilentlyContinue
if ($front) {
    Write-Host "      前端已在运行 (:5174)" -ForegroundColor Green
} else {
    Start-Process -FilePath "npm" -ArgumentList "run", "preview" -WorkingDirectory "C:\Users\l\Desktop\Interview Assistant\frontend" -WindowStyle Hidden
    Start-Sleep -Seconds 5
    Write-Host "      前端已启动" -ForegroundColor Green
}

# 显示局域网 IP
$ip = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.InterfaceAlias -eq 'WLAN' -and $_.IPAddress -notlike '169.254*' } | Select-Object -First 1 -ExpandProperty IPAddress)
Write-Host ""
Write-Host "=== 启动完成 ===" -ForegroundColor Cyan
Write-Host "电脑访问:   http://localhost:5174"
Write-Host "手机访问:   http://$ip` :5174" -ForegroundColor Green
Write-Host "后端健康:   http://$ip` :8080/healthz" -ForegroundColor Green
Write-Host ""
Write-Host "若手机打不开 8080，请检查:"
Write-Host "  1. 防火墙/安全软件放行 server.exe 与 8080 端口"
Write-Host "  2. 手机与电脑在同一 Wi-Fi"
