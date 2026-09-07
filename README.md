# Interview Assistant — 模拟面试助手

AI 驱动的模拟面试练习工具：粘贴职位描述（JD）创建面试、通过 WebSocket 逐题**语音**作答（TTS 朗读 + 按住说话录音转写）、结束生成多维评分报告。支持简历库、岗位信息库（JD 收藏）、题库、简历-JD 匹配预检、画像与成长分析、**数字人面试官**（3D 头像朗读）、WPS 云文档导入、报告邮件发送，以及**可选的摄像头表情/行为信号分析**（本地运行，画面不上传）。业务数据全部由后端持久化，刷新/换设备不丢失。

---

## 目录

- [技术栈](#技术栈)
- [架构总览](#架构总览)
- [环境要求](#环境要求)
- [快速启动（Docker，推荐）](#快速启动docker推荐)
- [详细启动步骤](#详细启动步骤)
  - [1. Docker 基础设施（MySQL + Redis）](#1-docker-基础设施mysql--redis)
  - [2. 数据库迁移](#2-数据库迁移)
  - [3. 环境变量](#3-环境变量)
  - [4. 运行后端 API](#4-运行后端-api)
  - [5. 运行前端](#5-运行前端)
- [MySQL / Redis 配置核对表](#mysql--redis-配置核对表)
- [常见问题排查](#常见问题排查)
- [功能总览](#功能总览)
- [页面路由](#页面路由)
- [数字人面试官](#数字人面试官)
- [摄像头表情/行为信号分析](#摄像头表情行为信号分析)
- [WPS 集成](#wps-集成)
- [Demo 流程](#demo-流程)
- [测试](#测试)
- [已知限制](#已知限制)
- [项目结构](#项目结构)

---

## 技术栈

| 层 | 技术 | 说明 |
|----|------|------|
| 前端 | React 19 + Vite 8 + TypeScript | SPA，固定开发/预览端口 5174 |
| 后端 | Go 1.22+ / Gin | REST + WebSocket，默认端口 18080 |
| 数据库 | MySQL 8.4（Docker，宿主机映射 **3307**） | 用户、会话、题目、轮次、行为信号 |
| 缓存 | Redis 7（Docker，宿主机映射 **16379**） | 面试直播态、暂存 |
| 语音 | 阿里云智能语音 NLS | ASR（录音转写）+ TTS（朗读题目），**唯一作答方式** |
| 大模型 | DeepSeek | 出题、追问、预检、评分报告 |
| 登录 | WPS OAuth | 真实授权登录（后端唯一账号体系）；前端另保留 6 种表单形态走本地 mock 校验，仅供设计稿演示 |
| 数字人 | @met4citizen/talkinghead | 面试间 3D 数字人面试官（音频驱动口型，动态 import 分包） |
| 可选 | 阿里云 OCR（图片导入）、OSS（文件上传）、摄像头行为分析（浏览器本地 TensorFlow.js）、WPS 云文档/邮箱 | 见各节说明 |

---

## 架构总览

```
┌─────────────┐   REST / WS    ┌──────────────┐    SQL      ┌─────────────┐
│  前端 (Vite) │ ─────────────> │ 后端 (Go/Gin) │ ─────────> │ MySQL 8.4   │
│  :5174      │                │  :18080      │             │ Docker :3307│
└─────────────┘                └──────────────┘    Redis    └─────────────┘
                                        │        ┌─────────> │ Redis 7     │
                                        └───────> │  缓存/直播态  │ Docker :16379│
                                        WPS OAuth │           └─────────────┘
                                        WPS 云文档/邮箱
                                        DeepSeek   └──> 外部 API
                                        阿里云语音 / OCR / OSS
```

| 服务 | 默认地址 | 用途 |
|------|----------|------|
| API（Go/Gin） | `http://127.0.0.1:18080` | REST + WebSocket（前端默认同端口 18080） |
| 前端（Vite） | `http://localhost:5174` | React SPA（端口由 `vite.config.ts` 固定 5174） |
| MySQL 8.4 | `127.0.0.1:3307`（容器内 3306） | 用户、会话、题目、轮次、行为信号 |
| Redis 7 | `127.0.0.1:16379`（容器内 6379） | 面试直播态、暂存 |

> **端口约定（重要）**：
> - MySQL 宿主机映射 **3307**：本机装有旧 MySQL 服务占用 3306，故容器外端口改为 3307。
> - Redis 宿主机映射 **16379**：6379 落在 Windows 默认排除端口范围（6311–6410）内无法绑定，故改用 16379。
> - 所有涉及数据库的配置（`.env` / `.env.example` / `config.go` 默认值）均已对齐上述宿主机端口。

---

## 环境要求

- **Docker Desktop**（推荐，MySQL/Redis 统一通过容器运行；本仓库不依赖本机自装数据库）
- **Go** 1.22+
- **Node.js** 18+ 和 npm
- **阿里云语音 Key（必填）**：语音是唯一的作答方式，缺省时 ASR/TTS 返回 `502`，无法正常作答
- 可选：DeepSeek API Key（出题/评分）、阿里云 OCR Key（图片导入）、OSS Key（文件上传）、WPS 开放平台应用（登录/云文档/报告邮件）

---

## 快速启动（Docker，推荐）

```bash
bash start-dev.sh
```

一键完成以下全部步骤：

1. 检测 Docker 引擎，未运行则自动拉起 Docker Desktop 并等待就绪（最多 120 秒）
2. `docker compose up -d` 启动 MySQL + Redis 容器
3. 等待 MySQL 就绪（`mysqladmin ping` 轮询）
4. **首次启动自动执行全部数据库迁移**（检测到 `interview` 库无表时）
5. 自动停止已占 18080 端口的旧后端进程
6. 编译后端（`backend/server_docker.exe`，Go 缓存写入 `backend/.gotmp/`）
7. 后台启动后端并轮询确认监听 `:18080`

启动前端（可选，开发预览模式）：

```bash
cd frontend && npm install && npm run preview   # http://localhost:5174
```

> **脚本启动的容器**：`start-dev.sh` 只操作**当前项目** `Interview Assistant` 下的 `docker-compose.yml`，生成并启动的容器固定为
> - `interviewassistant-mysql-1`（MySQL，宿主机 3307）
> - `interviewassistant-redis-1`（Redis，宿主机 16379）
>
> 运行后可用 `docker ps` 确认。**它不会启动机器上其他项目的容器**（如 `candimate-*`）——若 `docker ps` 里出现其他前缀（candimate、reservation 等）的容器且占用了相同端口，那是另外的项目自行拉起的，与本脚本无关，需先将其停止或改端口（见下方排查表）。

启动后访问：

- 前端：http://localhost:5174
- 后端健康检查：http://127.0.0.1:18080/healthz （应返回 `{"ok":true}`）

> **Windows 用户**：请先安装并启动 Docker Desktop（首次需等待引擎就绪），脚本会自动检测与拉起。
> 若本机装有旧 MySQL 服务，请保持其停止以免占用 3306（容器内端口）冲突。

---

## 详细启动步骤

### 1. Docker 基础设施（MySQL + Redis）

仓库根目录 `docker-compose.yml` 定义了两个服务：

```yaml
services:
  mysql:
    image: mysql:8.4
    # 容器时区对齐本地（东八区），与后端 DSN 的 loc=Local 保持一致，
    # 避免 created_at（CURRENT_TIMESTAMP 生成）与 started_at（Go 写入）相差 8 小时。
    command: ["mysqld", "--default-time-zone=+08:00"]
    environment:
      MYSQL_ROOT_PASSWORD: 123456      # root 密码（与 .env 的 MYSQL_DSN 一致）
      MYSQL_DATABASE: interview        # 自动创建 interview 库
      TZ: Asia/Shanghai                # 与 command 时区保持一致
    # 本机 MySQL 服务占用 3306，容器改映射到 3307
    ports: ["3307:3306"]
    volumes: ["mysql_data:/var/lib/mysql"]   # 数据持久化卷
  redis:
    image: redis:7
    # 6379 落在 Windows 排除端口范围(6311-6410)内无法绑定，改用 16379
    ports: ["16379:6379"]
volumes:
  mysql_data:
```

手动启动（脚本内部也是执行这条命令）：

```bash
docker compose up -d
```

常用运维命令：

```bash
docker compose ps            # 查看容器状态
docker compose logs -f mysql # 查看 MySQL 日志
docker compose stop          # 停止容器（数据保留）
docker compose down          # 停止并移除容器（数据卷保留）
docker compose down -v       # ⚠️ 停止并删除数据卷（清空全部数据，慎用）
```

**验证连接**：

```bash
docker exec interviewassistant-mysql-1 mysql -uroot -p123456 -e "SELECT 1; SHOW DATABASES;"
docker exec interviewassistant-redis-1 redis-cli ping    # 应返回 PONG
```

> **密码说明**：root 密码统一为 `123456`。如需修改，请同步修改 `docker-compose.yml` 的 `MYSQL_ROOT_PASSWORD`、根目录 `.env` 的 `MYSQL_DSN`、`backend/internal/config/config.go` 的默认值（三处保持一致）。
>
> **时区说明**：MySQL 容器已固定为东八区（`--default-time-zone=+08:00` + `TZ=Asia/Shanghai`），后端 DSN 使用 `loc=Local`，两者必须一致。若修改容器时区，请同步确认 `MYSQL_DSN` 的 `loc` 参数，否则时间会差 8 小时。

### 2. 数据库迁移

迁移脚本位于 `backend/migrations/`，按编号顺序执行（`001_init.sql` … `019_job_info.sql`）。

**通常无需手动执行**：`start-dev.sh` 在首次启动（`interview` 库无表）时自动应用全部迁移。

手动重跑（Docker MySQL，密码 `123456`）：

```bash
for f in backend/migrations/*.sql; do
  docker compose exec -T mysql mysql -uroot -p123456 interview < "$f"
done
```

迁移是幂等的（`IF NOT EXISTS` / `ADD COLUMN`），但建议只在全新库上按顺序执行一次。

### 3. 环境变量

服务端**优先读进程环境变量**（`os.Getenv`）；启动时自动加载仓库根目录的 `.env`（`internal/config/config.go` 用 `godotenv` 加载当前目录及上一级目录的 `.env`，进程环境变量优先）。`.env.example` 是变量模板，本地复制为 `.env` 后按需填写。

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `JWT_SECRET` | **是** | — | JWT 访问令牌签名密钥 |
| `HTTP_ADDR` | 否 | `:18080` | API 监听地址 |
| `MYSQL_DSN` | 否 | `root:123456@tcp(127.0.0.1:3307)/interview?parseTime=true&charset=utf8mb4&loc=Local` | MySQL 连接串（**与 Docker 容器密码 123456、宿主机端口 3307 对齐**） |
| `REDIS_ADDR` | 否 | `127.0.0.1:16379` | Redis 地址（Docker 映射端口） |
| `WPS_CLIENT_ID` | 是 | — | WPS 开放平台应用 ID（登录唯一方式，缺省时登录返回 503） |
| `WPS_CLIENT_SECRET` | 是 | — | WPS 开放平台应用密钥 |
| `WPS_REDIRECT_URI` | 否 | `http://127.0.0.1:18365/callback` | WPS 授权回调地址（须与开放平台登记一致） |
| `WPS_CALLBACK_ADDR` | 否 | `:18365` | WPS 回调专用监听端口 |
| `WPS_SCOPE` | 否 | `kso.user_base.read,kso.drive.readwrite,kso.file.read,kso.file_search.readwrite,kso.mail.readwrite,kso.mailbox.read` | WPS 授权范围（云文档/邮箱集成需要 drive/file/mail 权限） |
| `WPS_FRONTEND_REDIRECT` | 否 | `http://localhost:5174` | 授权成功后前端跳转地址 |
| `DEEPSEEK_API_KEY` | 否* | — | DeepSeek Key，用于出题与报告 |
| `DEEPSEEK_BASE_URL` | 否 | `https://api.deepseek.com` | DeepSeek API 地址 |
| `DEEPSEEK_MODEL` | 否 | `deepseek-chat` | 模型名 |
| `ALIYUN_ACCESS_KEY_ID` | 否** | — | 阿里云语音 ASR/TTS AccessKey ID |
| `ALIYUN_ACCESS_KEY_SECRET` | 否** | — | 阿里云语音 AccessKey Secret |
| `ALIYUN_NLS_APP_KEY` | 否** | — | 阿里云智能语音（NLS）AppKey |
| `ALIYUN_OCR_ACCESS_KEY_ID` | 否† | — | 阿里云 OCR（图片导入）；缺省回退到 `ALIYUN_ACCESS_KEY_ID` |
| `ALIYUN_OCR_ACCESS_KEY_SECRET` | 否† | — | 阿里云 OCR Secret；缺省回退到 `ALIYUN_ACCESS_KEY_SECRET` |
| `ALIYUN_OCR_ENDPOINT` | 否 | `https://ocr-api.cn-hangzhou.aliyuncs.com/` | 阿里云 OCR 端点 |
| `OSS_BUCKET` | 否‡ | — | 阿里云 OSS Bucket（简历/JD 文件服务端代理上传） |
| `OSS_REGION` | 否‡ | — | OSS 地域，如 `oss-cn-hangzhou` |
| `OSS_ENDPOINT` | 否‡ | — | OSS Endpoint，如 `oss-cn-hangzhou.aliyuncs.com` |
| `OSS_ACCESS_KEY_ID` | 否‡ | — | OSS AccessKey ID |
| `OSS_ACCESS_KEY_SECRET` | 否‡ | — | OSS AccessKey Secret |

\* 无 `DEEPSEEK_API_KEY`：开始面试返回 `502`、报告不可用；增删改查/归属校验仍正常。
\*\* **必填**（语音是唯一作答方式）：缺阿里云语音变量时 `/api/speech/asr`、`/api/speech/tts` 返回 `502`，语音房间无法录音/播报，面试无法正常进行。
\† 缺 OCR Key：图片导入返回 `502`（提示改用文字粘贴）；文字导入正常。
\‡ 缺 OSS 配置：简历/JD 文件上传（`/api/uploads`、`/api/resumes`）返回 `502`，但直接填写 JD 文本、从 WPS 云文档导入不受影响。

**复制模板（推荐）**：

```bash
cp .env.example .env   # 然后编辑填写各项 Key
```

**PowerShell（Windows）手动设置**：

```powershell
$env:JWT_SECRET = "dev-change-me"
# Docker MySQL/Redis（与 .env 一致，通常无需重复设置）：
$env:MYSQL_DSN = "root:123456@tcp(127.0.0.1:3307)/interview?parseTime=true&charset=utf8mb4"
$env:REDIS_ADDR = "127.0.0.1:16379"
# WPS 登录（必填，推荐登录方式）：
# $env:WPS_CLIENT_ID = "AK..."
# $env:WPS_CLIENT_SECRET = "..."
# 完整面试流需要：
# $env:DEEPSEEK_API_KEY = "sk-..."
# 语音作答（必填，唯一作答方式）：
# $env:ALIYUN_ACCESS_KEY_ID = "LTAI..."
# $env:ALIYUN_ACCESS_KEY_SECRET = "..."
# $env:ALIYUN_NLS_APP_KEY = "..."
```

**bash / zsh**：

```bash
export JWT_SECRET=dev-change-me
# Docker MySQL/Redis（与 .env 一致，通常无需重复设置）：
export MYSQL_DSN='root:123456@tcp(127.0.0.1:3307)/interview?parseTime=true&charset=utf8mb4'
export REDIS_ADDR=127.0.0.1:16379
```

### 4. 运行后端 API

> **推荐用一键脚本**：`bash start-dev.sh` 会自动编译并后台启动后端（`backend/server_docker.exe`，日志 `backend/server_docker.log`）。

手动运行：

```bash
cd backend
# 方式一：直接运行
go run ./cmd/server
# 方式二：编译后运行（推荐，进程更可控）
go build -o server_docker.exe ./cmd/server && ./server_docker.exe
```

> **Windows 注意**：若 `C:\tmp` 被同名文件占用（非目录），Go 构建会报 `mkdir C:\tmp...: cannot find the path`。解决方案：
> 1. 删除该占位文件后重建目录（推荐，一劳永逸）；或
> 2. 构建时指定有效临时目录：`GOTMPDIR="$PWD/.gotmp" go build ./cmd/server`

验证：

```bash
curl http://127.0.0.1:18080/healthz
# {"ok":true}
```

> Windows PowerShell 下 `curl` 若被 `Invoke-WebRequest` 别名占用，请用 `curl.exe`。

**CORS**：REST 响应允许来源 `http://localhost:5173`、`http://127.0.0.1:5173`、`http://localhost:5174`、`http://127.0.0.1:5174`（带 `Authorization`/`Content-Type` 头）。WebSocket 通过 `?token=` 携带 JWT（无 CORS 预检）。

### 5. 运行前端

```bash
cd frontend
cp .env.example .env   # 或设置 VITE_API_BASE
npm install            # 首次需要
npm run dev            # 开发模式 http://localhost:5174
npm run preview        # 构建产物预览（同样 5174）
```

前端环境变量：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `VITE_API_BASE` | 跟随当前页面 hostname（默认 `:18080`） | 后端 REST 基址（WS 源由此推导） |

> `frontend/.env` 默认已设 `VITE_API_BASE=http://127.0.0.1:18080`，本地联调无需修改。

---

## MySQL / Redis 配置核对表

仓库内所有涉及 MySQL/Redis 的配置已统一（root 密码 `123456`、MySQL 宿主机 3307、Redis 宿主机 16379、库 `interview`）：

| 文件 | 位置 | 值 | 状态 |
|------|------|----|------|
| `docker-compose.yml` | `MYSQL_ROOT_PASSWORD` | `123456` | ✅ |
| `docker-compose.yml` | `MYSQL_DATABASE` | `interview` | ✅ |
| `docker-compose.yml` | `ports` | `3307:3306` / `16379:6379` | ✅ |
| `docker-compose.yml` | `command` / `TZ` | `--default-time-zone=+08:00` / `Asia/Shanghai` | ✅ |
| `.env`（生效） | `MYSQL_DSN` | `root:123456@tcp(127.0.0.1:3307)/interview?...` | ✅ |
| `.env`（生效） | `REDIS_ADDR` | `127.0.0.1:16379` | ✅ |
| `.env.example` | `MYSQL_DSN` / `REDIS_ADDR` | 同上 | ✅ |
| `backend/internal/config/config.go` | 默认 `MySQLDSN` / `RedisAddr` | `root:123456@...3307...` / `127.0.0.1:16379` | ✅ |
| `start-dev.sh` | 密码获取 | 自动从 `docker-compose.yml` 读取 | ✅ |
| `backend/migrations/*.sql` | 内嵌密码 | 无（仅建表/改表语句） | ✅ |
| `frontend/src/api/client.ts` | 后端地址 | `:18080` | ✅ |

> 修改密码时请同步改 4 处：`docker-compose.yml`、`.env`、`.env.example`、`config.go` 默认值。

---

## 常见问题排查

| 现象 | 原因 | 解决 |
|------|------|------|
| 后端启动报 `dial tcp 127.0.0.1:3307: connect: connection refused` | MySQL 容器未启动 | `docker compose up -d` 后等待就绪，或运行 `bash start-dev.sh` |
| `docker compose up -d` 后容器无宿主机端口映射（`docker ps` 只显示 `3306/tcp` 而无 `0.0.0.0:3307->3306/tcp`），后端连不上 MySQL | 端口被占用导致绑定失败 | 停止占用方后 `docker compose down` 再 `docker compose up -d`（重建以恢复映射） |
| 同一台机器上另一个项目（如 `candimate-*`）的容器占用 3307/16379/18080 | 多项目端口撞车：另一项目的 compose 也映射到相同端口且已在运行 | 先停掉另一项目容器再启动本项目；若需同时运行，为其中一方改 compose 端口映射 |
| 3307 端口被本机服务占用 | 本机装了旧 MySQL/Redis 服务 | 停止本机服务释放端口后重启容器；Windows 可 `netstat -ano | grep :3307` 找 PID 后结束，或 `sc stop MySQL` |
| Go 构建报 `mkdir C:\tmp...` | `C:\tmp` 被同名文件占用 | 删除占位文件重建目录，或设置 `GOTMPDIR` |
| 登录接口返回 503 | 未配置 WPS 凭证 | 在 `.env` 配置 `WPS_CLIENT_ID` / `WPS_CLIENT_SECRET` |
| 语音无法作答（502） | 缺阿里云语音 Key | 配置 `ALIYUN_ACCESS_KEY_ID/SECRET/NLS_APP_KEY` |
| 开始面试返回 502 | 缺 DeepSeek Key | 配置 `DEEPSEEK_API_KEY` |
| 图片导入 502 | 缺 OCR Key | 配置 OCR Key 或改用文字粘贴 |
| 文件上传 502 | 缺 OSS 配置 | 配置 OSS 或直接填写 JD 文本 / 从 WPS 云文档导入 |
| WPS 云文档/报告邮件功能报「WPS 账号未授权或登录已过期」 | 授权 scope 不含 drive/mail 权限 | 确认 `WPS_SCOPE` 含 `kso.drive.readwrite` / `kso.mail.readwrite` 后重新登录 |
| `docker compose up` 提示镜像拉取慢 | 网络原因 | 配置 Docker 镜像加速器后重试 |
| 面试记录时间差 8 小时（如本地 11:05 显示 03:05） | MySQL 容器时区（UTC）与后端 DSN `loc=Local`（东八区）不一致 | 确认 `docker-compose.yml` 的 `command`/`TZ` 为东八区；改时区后历史 `started_at/ended_at` 需 −8h 数据修正 |

---

## 功能总览

- **创建面试**：粘贴 JD 或从岗位信息库导入，可选简历（本地上传 / 简历库 / WPS 云文档），选类型（行为/技术/综合）、面试官人格（标准/严厉技术面/温和 HR/压力面）、难度、企业风格（通用/外企/大厂/国企/创业）。
- **简历库**：上传多份简历（含文本提取，支持 PDF/Word），可重命名/删除/预览；创建面试时从简历库挑选，刷新后数据保留（后端持久化）。
- **岗位信息库（JD 收藏）**：手动录入或图片 OCR 识别岗位信息存入岗位库；创建面试时从「已保存岗位」直接导入，刷新后数据保留。
- **简历-JD 匹配预检**：检测简历与 JD 的匹配度并列出差距，可针对性出题。
- **出题与追问**：LLM 依据 JD/简历/薄弱点/预检差距生成 5–8 题；逐题作答后由 LLM 决定追问、下一题或结束（受人格限定的追问上限）；**追问链**在面试间以树状结构可视化展示。
- **作答方式（语音）**：TTS 朗读题目，按住说话录音 → ASR 转写自动发送。语音是唯一作答方式。
- **数字人面试官**：面试间显示 3D 数字人头像（TalkingHead），朗读题目时音频驱动口型同步，可开关、可降级（见下节）。
- **评分报告**：四维评分（表达能力/逻辑结构/内容质量/岗位匹配）+ 总分 + 优点/问题/改进建议 + 表达分析（语速/口头禅/句长）；支持**一键发送到 WPS 邮箱**。
- **题库**：自建题目、导入（含图片 OCR）、按维度/标签分类、专项练习。
- **画像与成长分析**：基于历史面试的薄弱维度画像、成长趋势（成长看板）。
- **WPS 集成**：WPS OAuth 登录、从 WPS 云文档导入简历、报告邮件发送（见下节）。
- **摄像头表情/行为信号分析（可选）**：见下节。

---

## 页面路由

| 路由 | 页面 | 说明 |
|------|------|------|
| `/login` | 登录页 | 6 种表单形态（账号密码/验证码/注册两步/忘记密码两步，本地 mock）+「使用 WPS 账号登录」（真实 OAuth） |
| `/` | 欢迎页 | 首页，入口「开始模拟面试」 |
| `/history` | 历史记录 | 面试记录列表（卷宗卡风格） |
| `/manage` | 管理页 | 题库 / 简历 / 岗位信息 3 个 Tab（`/questions` 重定向至此） |
| `/interviews/new` | 新建面试 Hub | 卷宗卡入口，选择已有面试/发起新面试 |
| `/interviews/new/prep` | 创建面试（准备） | 填 JD、选简历（含 WPS 云文档导入）、类型/人格/难度/风格、预检 |
| `/interviews/:id` | 面试详情 | 查看/开始/结束面试 |
| `/interviews/:id/room` | 面试间 | WebSocket 逐题作答、数字人、语音、摄像头分析（可选） |
| `/interviews/:id/report` | 面试报告 | 四维评分、优缺点、表达分析、行为信号、发送邮件 |
| `/trends` | 成长趋势 | 画像与成长分析看板 |
| `*` | 404 | — |

除 `/login`、`/` 外均受 `ProtectedRoute` 保护，未登录跳转 `/login`。

---

## 数字人面试官

面试间默认展示 AI 数字人面试官（`@met4citizen/talkinghead` 3D 渲染），朗读题目时**音频驱动口型**同步。

### 工作原理

1. **渲染**：TalkingHead 在浏览器渲染 3D 人头像（模型与 worklet 从 `public/` 静态资源加载）。
2. **口型驱动（降级链，语音播放永不受阻）**：
   - Level 1：HeadAudio 音频驱动口型（默认）；
   - Level 2：TalkingHead 内置音量驱动口型（HeadAudio 初始化失败时）；
   - Level 3：整体失败 → 面板显示失败态，页面回落纯语音播放（voicePlayer）。
3. **性能**：`TalkingHead` / `HeadAudio` 在 `init` 时动态 `import`（vite 自动分包），不进入主 bundle；渲染循环仅在开启时运行，关闭即停渲染省 GPU。
4. **开关**：面试间可随时切换数字人显隐；加载/失败态以遮罩层呈现。

---

## 摄像头表情/行为信号分析

创建面试时勾选「开启摄像头分析（可选）」（默认关闭）后，面试期间在**浏览器本地**对摄像头画面做实时分析，作为报告中的**辅助反馈**——**不参与四维评分**。面试全程为语音作答，勾选后分析始终生效。

### 工作原理（隐私优先）

1. **采集**：`getUserMedia` 获取摄像头画面（仅在用户勾选开启并授权后）。
2. **人脸关键点**：`@tensorflow/tfjs` + `@tensorflow-models/face-landmarks-detection`（MediaPipe FaceMesh）在浏览器本地检测每帧 478 个面部关键点。
3. **信号提取（启发式几何规则）**：
   - 情绪标签：嘴部开合比（MAR）/ 眼睑开合比（EAR）/ 眉毛高度 → 微笑 / 中性 / 专注 / 惊讶 / 皱眉。
   - 点头：头部俯仰角（pitch）的「下压-回弹」周期事件计数。
   - 紧张度：眨眼频率 + 头部晃动幅度 + 表情切换频率加权 → 0–100。
4. **聚合与上报**：面试结束时把**聚合统计**（情绪分布、点头次数、紧张度均值/分段、有效帧数、时长）POST 到 `/api/interviews/:id/behavior`，存入 `interview_behavior` 表。
5. **报告展示**：报告页显示「行为信号（辅助参考）」卡片——情绪分布、点头次数、紧张度（含走势分段）、低置信度提示。

### 隐私与降级

- **画面绝不出浏览器**：FaceMesh 在本地推理，只有聚合统计 JSON 上报；不上传任何帧/视频。
- **默认关闭**：创建页复选框默认不勾选。
- **静默降级**：浏览器不支持 / 模型加载失败 / 用户拒绝权限 / 摄像头被遮 → 不启分析，面试正常进行，报告不显示该卡片。
- **提示**：启发式规则为近似估计，报告明确标注「本指标基于表情动作统计，仅供参考，不计入评分」。

---

## WPS 集成

基于 WPS 开放平台 OAuth 授权，登录后自动获得以下能力：

| 能力 | 接口 | 说明 |
|------|------|------|
| 登录 | `/api/auth/wps/*` | WPS OAuth 为后端唯一账号体系；授权成功跳转 `WPS_FRONTEND_REDIRECT` |
| 云文档列表/搜索 | `GET /api/wps/cloud-files` | 浏览各盘根目录文件，支持关键词搜索（简历/JD 候选） |
| 云文档导入 | `POST /api/wps/cloud-files/import` | 把 WPS 云文档（简历）导入为本地简历（有大小上限，与后端 `maxImportBytes` 一致） |
| 主邮箱查询 | `GET /api/wps/primary-email` | 获取当前用户 WPS 主邮箱地址 |
| 报告邮件 | `POST /api/interviews/:id/report/email` | 把报告摘要（含四维评分/建议）生成邮件发送到用户 WPS 邮箱（正文上限 1024 字符） |

> **权限要求**：云文档与邮箱功能需要 `WPS_SCOPE` 包含 `kso.drive.readwrite`、`kso.file.read`、`kso.mail.readwrite` 等权限（见 `.env`）。缺失时对应接口返回错误，登录/面试等核心流程不受影响。

---

## Demo 流程

1. **登录**：打开 `/login`，点击「使用 WPS 账号登录」完成 OAuth 授权（或使用演示账号 `demo@mianzhi.cn` / `demo123456`、验证码 `123456` 走本地 mock）。
2. **创建面试**：`/interviews/new` → 填写 JD（或从岗位库导入），选类型/人格/难度/企业风格，可选上传/选择简历、跑预检；**可选勾选「开启摄像头分析」**。
3. **开始**：从面试详情页开始（需服务端 `DEEPSEEK_API_KEY`）。
4. **面试间**：数字人面试官朗读题目（TTS），按住说话（语音）作答；追问链树状展示；断线自动重连并补发暂存回答。
5. **（可选）摄像头分析**：勾选后，面试间本地采集摄像头画面做表情/行为分析，实时显示紧张度指示灯。
6. **结束**：正常结束（WS `done`）或强制结束（HTTP）。
7. **报告**：查看四维评分、优缺点、建议；如勾选了摄像头分析，另有「行为信号（辅助参考）」卡片；可一键**发送报告到 WPS 邮箱**。

---

## 测试

后端集成测试需要可达的 MySQL（使用 `interview` 库并只清理自己的测试用户）。通过 `MYSQL_DSN` 指向实例（仓库 Docker 容器密码为 `123456`，宿主机端口 3307）：

```bash
# 先确保 Docker MySQL 已启动（bash start-dev.sh 或 docker compose up -d）
MYSQL_DSN='root:123456@tcp(127.0.0.1:3307)/interview?parseTime=true&charset=utf8mb4' go test ./... -p 1
```

数据库与其他进程/并行任务共享时建议加 `-p 1`，避免偶发的 MySQL `Error 1213` 死锁。

前端测试：

```bash
cd frontend
npm run test   # vitest
npm run lint   # oxlint
npx tsc -b     # 类型检查
```

---

## 已知限制

- **关闭浏览器/断线不标记 `failed`**：中途断开不把面试标为失败；用「结束面试」（HTTP 强制结束即使 WebSocket 断开也有效）。
- **无每用户并发上限**：一个用户可有多个 `in_progress` 会话；每会话仅通过 Redis 强制一个直播房间。
- **同步评分延迟 `done`**：WebSocket `done` 在同步后置评分后发送，慢的 LLM 调用会增加跳转报告的延迟。
- **并发 `BeginLive` 竞态**：同一会话两个同时 WebSocket 连接可能短暂重复第一题；正常重连幂等。
- **A3/A6 需要 `DEEPSEEK_API_KEY`**：完整端到端验收（开始面试 + 评分报告）需要有效 DeepSeek Key。
- **语音服务为硬依赖**：语音是唯一作答方式，阿里云语音（ASR/TTS）不可用时面试无法作答/播报。
- **表情分析为启发式**：非科学级情绪识别；光照差/侧脸/遮挡时关键点检测可能失败（报「未检测到清晰人脸」）。升级路径是本地小型 ONNX 情绪模型（仍不上传画面）。
- **数字人为视觉辅助**：数字人渲染失败时自动降级为纯语音播报，不影响面试流程。
- **登录页 mock 表单仅演示**：账号密码/验证码/注册/忘记密码走本地 mock，不写后端；真实数据请用 WPS OAuth。

---

## 项目结构

```
backend/                  Go API（Gin）、迁移、内部包
  cmd/server/             服务入口（集中注册全部路由）
  internal/
    analysis/             评分报告生成/重试、报告邮件发送（含空答硬性护栏）
    analytics/            成长趋势分析
    auth/                 JWT 签发与鉴权中间件
    behavior/             摄像头行为信号存取（幂等保存、归属校验）
    config/               配置加载（.env / 环境变量）
    db/                   数据库连接
    expression/           表达分析（语速/口头禅/句长）
    interview/            会话/轮次/题目
    jobinfo/              岗位信息库（JD 收藏）CRUD
    llm/                  DeepSeek 出题/评分/追问/预检提示词
    ocr/                  阿里云 OCR（图片导入）
    precheck/             简历-JD 匹配预检
    profile/              画像分析
    question/             题库
    resume/               简历库（OSS 存储 + 文本提取）
    sessionredis/         Redis 会话态存储
    speech/               阿里云语音 ASR/TTS
    upload/               OSS 服务端代理上传/读取（HMAC-SHA1 签名）
    user/                 用户资料
    wps/                  WPS 云文档列表/导入、主邮箱查询
    wpsoauth/             WPS OAuth 授权/回调/token 持久化
    ws/                   WebSocket 直播
  migrations/             001..019 数据库迁移（015 = WPS OAuth；016 = WPS token 持久化；017 = WPS OAuth 用户列补齐；018 = 题目 kind 字段；019 = 岗位信息库 job_info）
frontend/                 Vite + React SPA
  src/api/                后端 REST 封装（auth/analytics/behavior/expression/interviews/
                          jobinfo/ocr/precheck/profile/questions/resumes/speech/uploads/wps）
  src/auth/               AuthContext / ProtectedRoute（登录态与路由守卫）
  src/behavior/           摄像头分析：FaceLandmarkDetector / aggregator / cameraFeed /
                          signalExtractors / useBehaviorAnalysis
  src/components/         AppNav 导航、InterviewerAvatar 数字人、FollowUpTree 追问链、
                          CameraPreview、QuestionImportModal、ResumePreviewModal、UserModal、
                          TopBar、DesignSidebar、ConfirmModal、Dialog、ErrorBoundary
  src/lib/                avatar（TalkingHead 控制器）、voicePlayer、voiceRecorder、
                          resumeParse、followUpTree、detailSource、labels、listEntries、mockData
  src/pages/              欢迎/登录/历史/管理/新建 Hub/创建面试/详情/面试间/报告/成长趋势/404
  src/ws/                 WebSocket 面试直播客户端（interviewSocket）
docker-compose.yml        MySQL(宿主机 3307, 密码 123456) + Redis(宿主机 16379)，统一 Docker 运行
start-dev.sh              一键启动：Docker 引擎 → 容器 → 自动迁移 → 后端
.env.example              环境变量模板（与 .env 端口/scope 对齐）
```
