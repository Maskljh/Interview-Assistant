# Interview Assistant — 模拟面试助手

AI 驱动的模拟面试练习工具：粘贴职位描述（JD）创建面试、通过 WebSocket 逐题**语音**作答（TTS 朗读 + 按住说话录音转写）、结束生成多维评分报告。支持题库、简历-JD 匹配预检、画像与成长分析，以及**可选的摄像头表情/行为信号分析**（本地运行，画面不上传）。

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
- [Demo 流程](#demo-流程)
- [摄像头表情/行为信号分析](#摄像头表情行为信号分析v14)
- [测试](#测试)
- [已知限制](#已知限制)
- [项目结构](#项目结构)

---

## 技术栈

| 层 | 技术 | 说明 |
|----|------|------|
| 前端 | React 19 + Vite 8 + TypeScript | SPA，开发端口 5174 |
| 后端 | Go 1.22+ / Gin | REST + WebSocket，默认端口 18080 |
| 数据库 | MySQL 8.4（Docker） | 用户、会话、题目、轮次、行为信号 |
| 缓存 | Redis 7（Docker） | 面试直播态、暂存 |
| 语音 | 阿里云智能语音 NLS | ASR（录音转写）+ TTS（朗读题目），**唯一作答方式** |
| 大模型 | DeepSeek | 出题、追问、评分报告 |
| 登录 | WPS OAuth | **唯一登录方式**（账号密码接口已移除） |
| 可选 | 阿里云 OCR（图片导入）、OSS（文件上传）、摄像头行为分析（浏览器本地 TensorFlow.js） | 见各节说明 |

---

## 架构总览

```
┌─────────────┐   REST / WS    ┌──────────────┐    SQL      ┌─────────────┐
│  前端 (Vite) │ ─────────────> │ 后端 (Go/Gin) │ ─────────> │ MySQL 8.4   │
│  :5174      │                │  :18080      │             │ Docker :3306│
└─────────────┘                └──────────────┘    Redis    └─────────────┘
                                        │        ┌─────────> │ Redis 7     │
                                        └───────> │  缓存/直播态  │ Docker :6379│
                                        WPS OAuth │           └─────────────┘
                                        DeepSeek  └──> 外部 API
                                        阿里云语音
```

| 服务 | 默认地址 | 用途 |
|------|----------|------|
| API（Go/Gin） | `http://127.0.0.1:18080` | REST + WebSocket（前端默认同端口 18080） |
| 前端（Vite） | `http://localhost:5174` | React SPA（开发端口 5174，由 `vite.config.ts` 固定） |
| MySQL 8.4 | `127.0.0.1:3306`（Docker 映射） | 用户、会话、题目、轮次、行为信号 |
| Redis 7 | `127.0.0.1:6379`（Docker 映射） | 面试直播态、暂存 |

> **端口约定**：MySQL `3306`、Redis `6379` 由 Docker 映射到宿主机。请确保本机 3306/6379 未被其他本地服务占用（若装有旧 MySQL 服务请保持停止）。

---

## 环境要求

- **Docker Desktop**（推荐，MySQL/Redis 统一通过容器运行；本仓库不依赖本机自装数据库）
- **Go** 1.22+
- **Node.js** 18+ 和 npm
- **阿里云语音 Key（必填）**：语音是唯一的作答方式，缺省时 ASR/TTS 返回 `502`，无法正常作答
- 可选：DeepSeek API Key（出题/评分）、阿里云 OCR Key（图片导入）、OSS Key（文件上传）、WPS 开放平台应用（登录）

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

> **脚本启动的容器**：`start-dev.sh` 只操作**当前项目** `Interview Assistant` 下的 `docker-compose.yml`，生成并启动的容器固定为
> - `interviewassistant-mysql-1`（MySQL，3306）
> - `interviewassistant-redis-1`（Redis，6379）
>
> 运行后可用 `docker ps` 确认。**它不会启动机器上其他项目的容器**（如 `candimate-*`）——若 `docker ps` 里出现其他前缀（candimate、reservation 等）的容器且占用了相同端口，那是另外的项目自行拉起的，与本脚本无关，需先将其停止或改端口（见下方排查表）。

启动后访问：

- 前端：http://localhost:5174
- 后端健康检查：http://127.0.0.1:18080/healthz （应返回 `{"ok":true}`）

> **Windows 用户**：请先安装并启动 Docker Desktop（首次需等待引擎就绪），脚本会自动检测与拉起。
> 若本机装有旧 MySQL 服务，请保持其停止以免占用 3306 端口。

---

## 详细启动步骤

### 1. Docker 基础设施（MySQL + Redis）

仓库根目录 `docker-compose.yml` 定义了两个服务：

```yaml
services:
  mysql:
    image: mysql:8.4
    environment:
      MYSQL_ROOT_PASSWORD: 123456      # root 密码（与 .env 的 MYSQL_DSN 一致）
      MYSQL_DATABASE: interview        # 自动创建 interview 库
    ports: ["3306:3306"]
    volumes: ["mysql_data:/var/lib/mysql"]   # 数据持久化卷
  redis:
    image: redis:7
    ports: ["6379:6379"]
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

### 2. 数据库迁移

迁移脚本位于 `backend/migrations/`，按编号顺序执行（`001_init.sql` … `018_question_kind.sql`）。

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
| `MYSQL_DSN` | 否 | `root:123456@tcp(127.0.0.1:3306)/interview?parseTime=true&charset=utf8mb4&loc=Local` | MySQL 连接串（**与 Docker 容器密码 123456 对齐**） |
| `REDIS_ADDR` | 否 | `127.0.0.1:6379` | Redis 地址（Docker 映射端口） |
| `WPS_CLIENT_ID` | 是 | — | WPS 开放平台应用 ID（登录唯一方式，缺省时登录返回 503） |
| `WPS_CLIENT_SECRET` | 是 | — | WPS 开放平台应用密钥 |
| `WPS_REDIRECT_URI` | 否 | `http://127.0.0.1:18365/callback` | WPS 授权回调地址（须与开放平台登记一致） |
| `WPS_CALLBACK_ADDR` | 否 | `:18365` | WPS 回调专用监听端口 |
| `WPS_SCOPE` | 否 | `kso.user_base.read` | WPS 授权范围 |
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
\‡ 缺 OSS 配置：简历/JD 文件上传（`/api/uploads`、`/api/resumes`）返回 `502`，但直接填写 JD 文本不受影响。

**复制模板（推荐）**：

```bash
cp .env.example .env   # 然后编辑填写各项 Key
```

**PowerShell（Windows）手动设置**：

```powershell
$env:JWT_SECRET = "dev-change-me"
# Docker MySQL/Redis（与 .env 一致，通常无需重复设置）：
$env:MYSQL_DSN = "root:123456@tcp(127.0.0.1:3306)/interview?parseTime=true&charset=utf8mb4"
$env:REDIS_ADDR = "127.0.0.1:6379"
# WPS 登录（必填，唯一登录方式）：
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
export MYSQL_DSN='root:123456@tcp(127.0.0.1:3306)/interview?parseTime=true&charset=utf8mb4'
export REDIS_ADDR=127.0.0.1:6379
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
npm run dev            # 默认 http://localhost:5174
```

前端环境变量：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `VITE_API_BASE` | 跟随当前页面 hostname（默认 `:18080`） | 后端 REST 基址（WS 源由此推导） |

---

## MySQL / Redis 配置核对表

仓库内所有涉及 MySQL/Redis 的配置已统一（root 密码 `123456`、MySQL 3306、Redis 6379、库 `interview`）：

| 文件 | 位置 | 值 | 状态 |
|------|------|----|------|
| `docker-compose.yml` | `MYSQL_ROOT_PASSWORD` | `123456` | ✅ |
| `docker-compose.yml` | `MYSQL_DATABASE` | `interview` | ✅ |
| `docker-compose.yml` | `ports` | `3306:3306` / `6379:6379` | ✅ |
| `.env`（生效） | `MYSQL_DSN` | `root:123456@tcp(127.0.0.1:3306)/interview?...` | ✅ |
| `.env`（生效） | `REDIS_ADDR` | `127.0.0.1:6379` | ✅ |
| `.env.example` | `MYSQL_DSN` / `REDIS_ADDR` | 同上 | ✅ |
| `backend/internal/config/config.go` | 默认 `MySQLDSN` / `RedisAddr` | `root:123456@...` / `127.0.0.1:6379` | ✅ |
| `start-dev.sh` | 密码获取 | 自动从 `docker-compose.yml` 读取 | ✅ |
| `backend/migrations/*.sql` | 内嵌密码 | 无（仅建表/改表语句） | ✅ |
| `frontend/src/api/client.ts` | 后端地址 | `:18080` | ✅ |

> 修改密码时请同步改 4 处：`docker-compose.yml`、`.env`、`.env.example`、`config.go` 默认值。

---

## 常见问题排查

| 现象 | 原因 | 解决 |
|------|------|------|
| 后端启动报 `dial tcp 127.0.0.1:3306: connect: connection refused` | MySQL 容器未启动 | `docker compose up -d` 后等待就绪，或运行 `bash start-dev.sh` |
| `docker compose up -d` 后容器无宿主机端口映射（`docker ps` 只显示 `3306/tcp` 而无 `0.0.0.0:3306->3306/tcp`），后端连不上 MySQL | 端口被占用导致绑定失败 | 停止占用方后 `docker compose down` 再 `docker compose up -d`（重建以恢复映射） |
| 同一台机器上另一个项目（如 `candimate-*`）的容器占用 3306/6379/18080 | 多项目端口撞车：另一项目的 compose 也映射到相同端口且已在运行 | 先停掉另一项目容器（`docker stop candimate-backend candimate-mysql candimate-redis`）再启动本项目；若需同时运行，为其中一方改 compose 端口映射 |
| 3306/6379 端口被本机服务占用（如 `[::1]:3306` 被本机 MySQL 监听） | 本机装了旧 MySQL/Redis 服务，与 Docker 映射冲突 | 停止本机服务释放端口后重启容器；Windows 可 `netstat -ano | grep :3306` 找 PID 后结束，或 `sc stop MySQL` |
| Go 构建报 `mkdir C:\tmp...` | `C:\tmp` 被同名文件占用 | 删除占位文件重建目录，或设置 `GOTMPDIR` |
| 登录接口返回 503 | 未配置 WPS 凭证 | 在 `.env` 配置 `WPS_CLIENT_ID` / `WPS_CLIENT_SECRET` |
| 语音无法作答（502） | 缺阿里云语音 Key | 配置 `ALIYUN_ACCESS_KEY_ID/SECRET/NLS_APP_KEY` |
| 开始面试返回 502 | 缺 DeepSeek Key | 配置 `DEEPSEEK_API_KEY` |
| 图片导入 502 | 缺 OCR Key | 配置 OCR Key 或改用文字粘贴 |
| 文件上传 502 | 缺 OSS 配置 | 配置 OSS 或直接填写 JD 文本 |
| `docker compose up` 提示镜像拉取慢 | 网络原因 | 配置 Docker 镜像加速器后重试 |

---

## 功能总览

- **创建面试**：粘贴 JD、可选简历、选类型（行为/技术/综合）、面试官人格（标准/严厉技术面/温和 HR/压力面）、难度、企业风格（通用/外企/大厂/国企/创业）。
- **简历-JD 匹配预检**：检测简历与 JD 的匹配度并列出差距，可针对性出题。
- **出题与追问**：LLM 依据 JD/简历/薄弱点/预检差距生成 5–8 题；逐题作答后由 LLM 决定追问、下一题或结束（受人格限定的追问上限）。
- **作答方式（语音）**：TTS 朗读题目，按住说话录音 → ASR 转写自动发送。语音是唯一作答方式。
- **评分报告**：四维评分（表达能力/逻辑结构/内容质量/岗位匹配）+ 总分 + 优点/问题/改进建议 + 表达分析（语速/口头禅/句长）。
- **题库**：自建题目、导入（含图片 OCR）、按维度/标签分类、专项练习。
- **画像与成长分析**：基于历史面试的薄弱维度画像、成长趋势。
- **摄像头表情/行为信号分析（可选，V14）**：见下节。

---

## Demo 流程

1. **登录**：打开 `/login`，点击 WPS 授权入口完成 OAuth 登录。
2. **创建面试**：粘贴 JD，选类型/人格/难度/企业风格，可选上传简历、跑预检；**可选勾选「开启摄像头分析」**。
3. **开始**：从面试详情页开始（需服务端 `DEEPSEEK_API_KEY`）。
4. **面试间**：WebSocket 逐题送达，TTS 朗读题目；按住说话（语音）作答；断线自动重连并补发暂存回答。
5. **（可选）摄像头分析**：勾选后，面试间本地采集摄像头画面做表情/行为分析（见下节），实时显示紧张度指示灯。
6. **结束**：正常结束（WS `done`）或强制结束（HTTP）。
7. **报告**：查看四维评分、优缺点、建议；如勾选了摄像头分析，另有「行为信号（辅助参考）」卡片。

---

## 摄像头表情/行为信号分析（V14）

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

## 测试

后端集成测试需要可达的 MySQL（使用 `interview` 库并只清理自己的测试用户）。通过 `MYSQL_DSN` 指向实例（仓库 Docker 容器密码为 `123456`）：

```bash
# 先确保 Docker MySQL 已启动（bash start-dev.sh 或 docker compose up -d）
MYSQL_DSN='root:123456@tcp(127.0.0.1:3306)/interview?parseTime=true&charset=utf8mb4' go test ./... -p 1
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

---

## 项目结构

```
backend/                  Go API（Gin）、迁移、内部包
  cmd/server/             服务入口
  internal/
    behavior/             V14 表情/行为信号存取（幂等保存、归属校验）
    interview/            会话/轮次/题目
    llm/                  DeepSeek 出题/评分/追问提示词
    speech/               阿里云语音 ASR/TTS
    ocr/                  阿里云 OCR（图片导入）
    question/             题库
    analytics/            成长分析
    profile/              画像
    expression/           表达分析（语速/口头禅/句长）
    upload/               OSS 服务端代理上传/读取（HMAC-SHA1 签名）
    ws/                   WebSocket 直播
  migrations/             001..018 数据库迁移（015 = WPS OAuth；016 = WPS token 持久化；017 = WPS OAuth 用户列补齐；018 = 题目 kind 字段）
frontend/                 Vite + React SPA
  src/behavior/           V14 前端：signalExtractors / aggregator / cameraFeed /
                          FaceLandmarkDetector / useBehaviorAnalysis
  src/pages/              创建、面试间、报告、题库、成长等页面
docker-compose.yml        MySQL(3306, 密码 123456) + Redis(6379)，统一 Docker 运行
start-dev.sh              一键启动：Docker 引擎 → 容器 → 自动迁移 → 后端
.env.example              环境变量模板
```
