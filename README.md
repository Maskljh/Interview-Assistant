# Interview Assistant — 模拟面试助手

AI 驱动的模拟面试练习工具：粘贴职位描述（JD）创建面试、通过 WebSocket 逐题**语音**作答（TTS 朗读 + 按住说话录音转写）、结束生成多维评分报告。支持题库、简历-JD 匹配预检、画像与成长分析，以及**可选的摄像头表情/行为信号分析**（本地运行，画面不上传）。

## 目录

- [Prerequisites（环境要求）](#prerequisites环境要求)
- [Architecture（本地架构）](#architecture本地架构)
- [1. 启动 MySQL 与 Redis](#1-启动-mysql-与-redis)
- [2. 应用数据库迁移](#2-应用数据库迁移)
- [3. 环境变量](#3-环境变量)
- [4. 运行 API 服务](#4-运行-api-服务)
- [5. 运行前端](#5-运行前端)
- [功能总览](#功能总览)
- [Demo 流程](#demo-流程)
- [摄像头表情/行为信号分析（V14）](#摄像头表情行为信号分析v14)
- [Backend tests](#backend-tests)
- [已知限制](#已知限制)
- [项目结构](#项目结构)

## Prerequisites（环境要求）

- **Go** 1.22+
- **Node.js** 18+ 和 npm
- **MySQL 8**（本机 3306 或 Docker），**Redis 7**（本机 6379 或 Docker）
- **阿里云语音 Key（必填）**：语音是唯一的作答方式，缺省时 ASR/TTS 返回 `502`，无法正常作答。
- 可选：DeepSeek API Key（出题/评分）、阿里云 OCR Key（图片导入）

> **端口约定：本仓库默认使用 MySQL `3306`、Redis `6379`。** 请确保本机 MySQL 监听 `127.0.0.1:3306`（或通过 Docker 映射到 3306）。

## Architecture（本地架构）

| 服务 | 默认地址 | 用途 |
|------|----------|------|
| API（Go/Gin） | `http://127.0.0.1:18080` | REST + WebSocket（前端默认同端口 18080） |
| 前端（Vite） | `http://localhost:5174` | React SPA（开发端口 5174） |
| MySQL 8 | `127.0.0.1:3306` | 用户、会话、题目、轮次、行为信号 |
| Redis 7 | `127.0.0.1:6379` | 面试直播态、暂存 |

> **端口说明：** `vite.config.ts` 固定开发/预览端口为 **5174**（5173 常被占用）；后端监听端口由 `.env` 的 `HTTP_ADDR` 决定（默认 `:18080`）。`frontend/src/api/client.ts` 自动跟随当前页面 hostname（手机经局域网访问时自动用局域网 IP）。

## 1. 启动 MySQL 与 Redis

### 方案 A — Docker Compose（本仓库）

```bash
docker compose up -d
```

启动 MySQL（`root` / `root`，数据库 `interview`）与 Redis，均映射到默认端口（MySQL 3306、Redis 6379）。

### 方案 B — 已有本机 MySQL

如果你已在 `127.0.0.1:3306` 运行 MySQL，创建数据库并把 `MYSQL_DSN` 指向它（密码按你的实际环境，如本机为 `123456`）：

```sql
CREATE DATABASE IF NOT EXISTS interview CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

Redis 仍需在 `REDIS_ADDR` 可达（可用 compose 只启动 Redis，或你自己的实例）。

## 2. 应用数据库迁移

按编号顺序应用 `backend/migrations/` 下的**全部**迁移（`001_init.sql` … `015_wps_oauth.sql`）：

- **全新数据库**：每个文件执行一次。
- **已有数据库**：只应用当前 schema 之后新增的文件（例如 `013_resume_files.sql` 新增 `users.username` 列与 `resume_files` 表；`014_job_title.sql` 新增 `interview_sessions.job_title` 列与 `question_usage` 表）。

从仓库根目录（Docker MySQL）：

```bash
for f in backend/migrations/*.sql; do
  docker compose exec -T mysql mysql -uroot -proot interview < "$f"
done
```

外部 MySQL：

```bash
for f in backend/migrations/*.sql; do
  mysql -h 127.0.0.1 -u root -p interview < "$f"
done
```

> 本机 MySQL 密码示例：`root` / `123456`（见下节）。迁移是幂等的（`IF NOT EXISTS` / `ADD COLUMN` 在已应用时按文档说明处理），但建议按顺序只执行一次。

## 3. 环境变量

服务端**优先读进程环境变量**（`os.Getenv`）；启动时会自动加载仓库根目录的 `.env`（`internal/config/config.go` 用 `godotenv` 加载当前目录及上一级目录的 `.env`，进程环境变量优先）。`.env.example` 是变量模板，本地复制为 `.env` 后按需填写。运行前也可手动设置（PowerShell 用 `$env:VAR=...`，bash 用 `export VAR=...`），手动设置会覆盖 `.env` 中的值。

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `JWT_SECRET` | **是** | — | JWT 访问令牌签名密钥 |
| `WPS_CLIENT_ID` | 是 | — | WPS 开放平台应用 ID（登录唯一方式，缺省时 WPS 登录返回 503） |
| `WPS_CLIENT_SECRET` | 是 | — | WPS 开放平台应用密钥 |
| `WPS_REDIRECT_URI` | 否 | `http://127.0.0.1:18365/callback` | WPS 授权回调地址（须与开放平台登记一致） |
| `WPS_CALLBACK_ADDR` | 否 | `:18365` | WPS 回调专用监听端口 |
| `WPS_SCOPE` | 否 | `kso.user_base.read` | WPS 授权范围 |
| `WPS_FRONTEND_REDIRECT` | 否 | `http://localhost:5174` | 授权成功后前端跳转地址 |
| `HTTP_ADDR` | 否 | `:18080` | API 监听地址（默认 `:18080`） |
| `MYSQL_DSN` | 否 | `root:root@tcp(127.0.0.1:3306)/interview?parseTime=true&charset=utf8mb4` | MySQL 连接串（**端口 3306**；本机密码 `123456` 时改为 `root:123456@...`） |
| `REDIS_ADDR` | 否 | `127.0.0.1:6379` | Redis 地址 |
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

**登录方式**：本应用已切换为 **WPS OAuth 唯一登录**（`/api/auth/wps/authorize|called|exchange`），账号密码注册/登录接口已移除。前端登录页只显示 WPS 授权入口；未配置 `WPS_CLIENT_ID/SECRET` 时授权接口返回 `503`。首次 WPS 登录会按 openid 自动创建用户。

\*\* **必填**（语音是唯一作答方式）：缺阿里云语音变量时 `/api/speech/asr`、`/api/speech/tts` 返回 `502`，语音房间无法录音/播报，面试无法正常进行。

\† 缺 OCR Key：图片导入返回 `502`（提示改用文字粘贴）；文字导入正常。两者均回退到共享的 `ALIYUN_ACCESS_KEY_ID/SECRET`。

\‡ 缺 OSS 配置：简历/JD 文件上传（`/api/uploads`、`/api/resumes`）返回 `502`，但直接填写 JD 文本不受影响。

**PowerShell（Windows）：**

```powershell
$env:JWT_SECRET = "dev-change-me"
# 数据库在 3306；本机 MySQL 密码 123456：
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
# 图片导入 OCR 需要：
# $env:ALIYUN_OCR_ACCESS_KEY_ID = "LTAI..."   # 缺省回退 ALIYUN_ACCESS_KEY_ID
# $env:ALIYUN_OCR_ACCESS_KEY_SECRET = "..."
```

**bash / zsh：**

```bash
export JWT_SECRET=dev-change-me
export MYSQL_DSN='root:123456@tcp(127.0.0.1:3306)/interview?parseTime=true&charset=utf8mb4'
export REDIS_ADDR=127.0.0.1:6379
# WPS 登录（必填，唯一登录方式）：
# export WPS_CLIENT_ID=AK...
# export WPS_CLIENT_SECRET=...
# export DEEPSEEK_API_KEY=sk-...
# 语音作答（必填，唯一作答方式）：
# export ALIYUN_ACCESS_KEY_ID=LTAI...
# export ALIYUN_ACCESS_KEY_SECRET=...
# export ALIYUN_NLS_APP_KEY=...
# 图片导入 OCR：
# export ALIYUN_OCR_ACCESS_KEY_ID=LTAI...   # 缺省回退 ALIYUN_ACCESS_KEY_ID
# export ALIYUN_OCR_ACCESS_KEY_SECRET=...
```

## 4. 运行 API 服务

```bash
cd backend
go run ./cmd/server
```

验证：

```bash
curl http://127.0.0.1:18080/healthz
# {"ok":true}
```

Windows PowerShell 下 `curl` 若被 `Invoke-WebRequest` 别名占用，请用 `curl.exe`。

### CORS

REST 响应允许来源 `http://localhost:5173`、`http://127.0.0.1:5173`、`http://localhost:5174`、`http://127.0.0.1:5174`（带 `Authorization`/`Content-Type` 头）。WebSocket 通过 `?token=` 携带 JWT（无 CORS 预检）。手机经局域网 IP（端口 5174）访问时后端同样放行。

## 5. 运行前端

```bash
cd frontend
cp .env.example .env   # 或设置 VITE_API_BASE
npm install
npm run dev            # 默认 http://localhost:5174
```

前端环境变量：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `VITE_API_BASE` | 跟随当前页面 hostname（默认 `:18080`） | 后端 REST 基址（WS 源由此推导） |

## 功能总览

- **创建面试**：粘贴 JD、可选简历、选类型（行为/技术/综合）、面试官人格（标准/严厉技术面/温和 HR/压力面）、难度、企业风格（通用/外企/大厂/国企/创业）。
- **简历-JD 匹配预检**：检测简历与 JD 的匹配度并列出差距，可针对性出题。
- **出题与追问**：LLM 依据 JD/简历/薄弱点/预检差距生成 5–8 题；逐题作答后由 LLM 决定追问、下一题或结束（受人格限定的追问上限）。
- **作答方式（语音）**：TTS 朗读题目，按住说话录音 → ASR 转写自动发送。语音是唯一作答方式。
- **评分报告**：四维评分（表达能力/逻辑结构/内容质量/岗位匹配）+ 总分 + 优点/问题/改进建议 + 表达分析（语速/口头禅/句长）。
- **题库**：自建题目、导入（含图片 OCR）、按维度/标签分类、专项练习。
- **画像与成长分析**：基于历史面试的薄弱维度画像、成长趋势。
- **摄像头表情/行为信号分析（可选，V14）**：见下节。

## Demo 流程

1. **注册/登录**：`/register`（密码 ≥ 8 位）或 `/login`。
2. **创建面试**：粘贴 JD，选类型/人格/难度/企业风格，可选上传简历、跑预检；**可选勾选「开启摄像头分析」**。
3. **开始**：从面试详情页开始（需服务端 `DEEPSEEK_API_KEY`）。
4. **面试间**：WebSocket 逐题送达，TTS 朗读题目；按住说话（语音）作答；断线自动重连并补发暂存回答。
5. **（可选）摄像头分析**：勾选后，面试间本地采集摄像头画面做表情/行为分析（见下节），实时显示紧张度指示灯。
6. **结束**：正常结束（WS `done`）或强制结束（HTTP）。
7. **报告**：查看四维评分、优缺点、建议；如勾选了摄像头分析，另有「行为信号（辅助参考）」卡片。

## 摄像头表情/行为信号分析（V14）

创建面试时勾选「开启摄像头分析（可选）」（默认关闭）后，面试期间在**浏览器本地**对摄像头画面做实时分析，作为报告中的**辅助反馈**——**不参与四维评分**，不引入数字人形象。面试全程为语音作答，勾选后分析始终生效。

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

## Backend tests

多数后端集成测试需要可达的 MySQL（使用 `interview` 库并只清理自己的测试用户）。通过 `MYSQL_DSN` 指向实例（默认 `root:root@tcp(127.0.0.1:3306)/interview`；本机密码为 `123456` 时请相应修改）：

```bash
MYSQL_DSN='root:123456@tcp(127.0.0.1:3306)/interview?parseTime=true&charset=utf8mb4' go test ./... -p 1
```

数据库与其他进程/并行任务共享时建议加 `-p 1`，避免偶发的 MySQL `Error 1213` 死锁。`V14` 新增的 `internal/behavior` 测试（幂等保存、归属校验、校验边界、无记录返回 `available:false`）同样需要真实 MySQL。

前端测试（沙箱内需本地 preload，非沙箱环境直接）：

```bash
cd frontend
npm run test   # vitest
npm run lint   # oxlint
npx tsc -b     # 类型检查
```

## 已知限制

- **关闭浏览器/断线不标记 `failed`**：中途断开不把面试标为失败；用「结束面试」（HTTP 强制结束即使 WebSocket 断开也有效）。
- **无每用户并发上限**：一个用户可有多个 `in_progress` 会话；每会话仅通过 Redis 强制一个直播房间。
- **同步评分延迟 `done`**：WebSocket `done` 在同步后置评分后发送，慢的 LLM 调用会增加跳转报告的延迟。
- **并发 `BeginLive` 竞态**：同一会话两个同时 WebSocket 连接可能短暂重复第一题；正常重连幂等。
- **A3/A6 需要 `DEEPSEEK_API_KEY`**：完整端到端验收（开始面试 + 评分报告）需要有效 DeepSeek Key。
- **语音服务为硬依赖**：语音是唯一作答方式，阿里云语音（ASR/TTS）不可用时面试无法作答/播报。
- **表情分析为启发式**：非科学级情绪识别；光照差/侧脸/遮挡时关键点检测可能失败（报「未检测到清晰人脸」）。升级路径是本地小型 ONNX 情绪模型（仍不上传画面）。

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
  migrations/             001..015 数据库迁移（015 = WPS OAuth + username 补齐）
frontend/                 Vite + React SPA
  src/behavior/           V14 前端：signalExtractors / aggregator / cameraFeed /
                          FaceLandmarkDetector / useBehaviorAnalysis
  src/pages/              创建、面试间、报告、题库、成长等页面
docker-compose.yml        MySQL(3306) + Redis(6379)
.env.example              环境变量模板
```
