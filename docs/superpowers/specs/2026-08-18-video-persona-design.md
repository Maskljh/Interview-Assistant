# V14 数字人视频面试官 — 设计规格

**Date:** 2026-08-18
**Status:** Implemented
**Parent:** V13 静态人像之后的形象升级
**Approach:** voice 模式下，用 `wps.png` 照片经国内云数字人 API 生成「会开口读题的面试官视频」替代 V13 静态人像 + TTS 播报；双画面（面试官视频大屏 + 用户摄像头小窗，本地预览）；题目字幕同步显示；服务商抽象层隔离

---

## 1. Goal

把语音面试的「面试官侧」从静态人像升级为**会说话的数字人视频**：每道题（含追问）由云端数字人 API 用 `wps.png` 生成一段口播视频（约 20~60 秒渲染），等待时显示「正在生成问题…」，视频播完进入作答；同时开启用户摄像头小窗，形成视频通话般的双画面体验。渲染失败/未配置 Key 时自动降级到 V13 行为（TTS + 静态人像），面试不中断。

---

## 2. Locked decisions

| 决策点 | 选择 |
|--------|------|
| 形态 | **照片变数字人**：`wps.png`（现有资源）上传服务商生成口播视频；非录播素材、非实时数字人流 |
| 实时性 | **预生成片段**：每题渲染 20~60 秒，等待时提示「正在生成问题…」；非秒级实时流 |
| 服务商 | **国内数字人服务商**（目标：硅基智能 / 腾讯云智影 / 讯飞智作，以开通确认的 API 为准），按量付费，人民币直连；**排除阿里云 IMS**（其数字人集成为实时 RTC 场景、集成第三方并需工单计价，无「照片→口播视频」自助 API） |
| 口播内容 | **只口播当前问题**（含追问）；不合成整段对话历史；不做衔接话术 |
| 模式衔接 | **升级现有 voice 模式**（text / voice 二选一不变）；不新增 video 第三模式 |
| 用户侧 | **开摄像头**：voice 模式双画面（面试官视频大屏 + 自己小窗）；`getUserMedia({ video: true })`（仅视频轨，本地预览不上传）；录音仍走现有「按次申请麦克风」路径，音频作答链路零改动 |
| 字幕 | **要**：视频区域显示题目全文（前端 overlay，非服务商烧字） |
| 视频声音 | 用服务商视频自带 TTS 音色（中文，可配置），替代现有阿里云 TTS 播题 |
| 降级 | 数字人服务不可用/超时/未配置 → **回退 V13**（TTS 播报 + 静态人像 + 状态标签），不阻塞面试 |
| 架构 | 后端新增 `internal/digitalhuman` 抽象层（Provider 接口 + 国内实现 + REST）；**零 DB 改动**（视频不落库） |
| 分支 | `feat/v14-video-persona` from main HEAD |

---

## 3. Non-goals (V14)

- 实时数字人流 / 秒级对话式口播（明确为预生成片段）
- 数字人跟读用户回答、实时唇形互动（回答期间面试官为等待画面）
- 视频存档 / 回放（服务商 URL 用完即弃；不落库）
- 新增 `video` 第三输入模式
- 海外服务商（D-ID / HeyGen，需代理 + 外币 + 数据出境）
- 摄像头画面上传/录制（本地预览）
- 服务商「形象克隆」精修（直接用照片原样驱动）

---

## 4. Architecture

```text
Browser (voice 模式)
 ├─ 提问：WS question ──► 前端 POST /api/digital-human/videos ──► Go digitalhuman ──► 国内数字人云 API
 │         ◄── 轮询 GET /api/digital-human/videos/:taskId ◄── 返回 mp4 URL ──► 前端播放视频 + 字幕
 ├─ 作答：录音 ──► ASR ──► WS answer（现有链路，不变）
 └─ 摄像头：getUserMedia 本地预览小窗（不上传）

现有链路保留：DeepSeek 出题、阿里云 ASR/TTS、WS 文本协议
```

| 单元 | 职责 |
|------|------|
| `internal/digitalhuman` | `Provider` 接口、国内服务商实现、REST handlers；失败/未配置 → 调用方降级 |
| `interview` / `ws` | **不改**；不感知视频 |
| 前端房间页 | voice 模式：提问改走「生成视频 → 播放」；作答交互不变；摄像头小窗 |
| V13 组件 | 保留作降级路径（静态人像 + TTS） |

**供应商抽象**：换服务商只新增一个 `Provider` 实现文件 + 改 `.env` 配置，其余不动。

---

## 5. 后端：`internal/digitalhuman`

### 5.1 Provider 接口

```go
type Provider interface {
    // Submit 提交文本口播任务，返回任务 ID（音色 voice 来自 Config，不逐题传参）
    Submit(ctx context.Context, text string) (taskID string, err error)
    // Result 查询任务状态；完成时返回视频 URL
    Result(ctx context.Context, taskID string) (status Status, videoURL string, err error)
}
```

- `Status`: `pending | processing | completed | failed`（服务商字段映射）
- 形象：`wps.png` 由运维/配置阶段上传一次，形象 ID 存 `.env` 或内存（Provider 构造参数），不逐题上传
- `voice` 音色参数来自配置（中文女声/男声，服务商音色 ID）

### 5.2 REST

| Method | Path | 语义 |
|--------|------|------|
| `POST` | `/api/digital-human/videos` | body `{text}` → 返回 `{taskId}`；text 为当前问题全文 |
| `GET` | `/api/digital-human/videos/:taskId` | 返回 `{status, videoURL?}`；completed 带 mp4 URL |

- 无 DB：task 状态直接透传服务商查询（服务商侧保留任务）
- 错误语义：服务商调用失败 → 返回 `503` + 明确错误；前端据此降级
- 鉴权：沿用现有 JWT 中间件

### 5.3 配置（`.env` 新增）

```text
DIGITAL_HUMAN_PROVIDER=           # 服务商标识，空 = 禁用（前端走降级）
DIGITAL_HUMAN_API_KEY=
DIGITAL_HUMAN_SECRET=
DIGITAL_HUMAN_AVATAR_ID=          # wps.png 上传后的形象 ID（开通后配置）
DIGITAL_HUMAN_VOICE=              # 音色 ID
```

### 5.4 超时

- 前端轮询上限约 120 秒（覆盖 20~60 秒渲染 + 余量），超时 → 降级 V13

---

## 6. 前端：房间页（`InterviewRoomPage.tsx`）

### 6.1 提问流程（voice 模式，替代现有 playQuestion TTS）

1. WS 收到新问题 → `videoState = 'generating'`，显示「正在生成问题…」
2. `POST /api/digital-human/videos {text}` → 轮询 `GET`（间隔 ~3s）
3. completed → `videoState = 'playing'`，播放 `<video>`（服务商 mp4，播一遍）
4. 播完 → `videoState = 'ended'`，停在最后一帧且字幕保持显示题目；随后复用现有「开始作答」流程（录音 → ASR → 自动 WS answer）
5. 任何失败/超时 → 静默降级：`videoState` 回到 `'none'`，复用现有 `playQuestion` 启动 V13 TTS 播报（状态标签「正在朗读问题...」），不额外 toast 提示

### 6.2 摄像头小窗

- 进入 voice 模式时 `getUserMedia({ video: true })`（仅视频轨，本地预览不上传）；录音仍走现有「按次申请麦克风」路径，音频作答链路零改动
- 小窗 `<video muted playsInline>` 本地预览，右下角叠加；提供「关闭摄像头」按钮（仅停 video 轨）
- 拒绝/无摄像头/浏览器不支持 → 只显示面试官视频，作答链路不变（静默降级）

### 6.3 状态与组件

- 新增 `videoState` 状态机：`'none' | 'generating' | 'playing' | 'ended'`（`'none'` = 未启用视频，渲染 V13 静态人像；`'ended'` = 播完停在最后一帧，字幕保留）；`personaState` 保持 V13 三态 `'idle' | 'speaking' | 'listening'`，仅在 `videoState === 'none'` 时更新（视频活动期间由 VideoPersona 接管渲染）
- 新增 `VideoPersona` 组件：视频大屏 + 字幕 overlay + 等待态（复用 V13 CSS 动画风格）
- 渲染条件不变：仅 `effectiveInputMode === 'voice'` 显示
- 字幕：题目全文显示在视频下方（现有题目展示区复用），回答期间保持可见

---

## 7. CSS（`InterviewPages.css`）

- `.video-persona` 大屏容器（16:9 或 `object-fit: contain` 适配）
- `.video-persona-generating`：等待动画（复用 V13 `--listening` 关键帧）
- `.video-persona-cam`：右下角小窗（约 25% 宽，圆角 + 边框 + 拖拽可选，本期固定位置）
- 字幕区：沿用题目文字样式

---

## 8. 测试与验收

| ID | Expectation |
|----|-------------|
| V1 | voice 模式提问：显示「正在生成问题…」→ 视频生成后播放（口播当前问题，含字幕）→ 播完进入作答 |
| V2 | 数字人服务不可用/未配置 Key：自动降级 TTS + 静态人像，面试不中断（模拟 503/超时） |
| V3 | 摄像头：允许 → 小窗显示本地画面；拒绝/无摄像头 → 静默降级只显示面试官；音频作答链路不变 |
| V4 | 双画面布局正确；视频播一遍不循环；字幕全程显示题目 |
| V5 | text 模式不显示视频/摄像头；WS 提问/作答/追问协议无回归 |
| V6 | `go test ./... -count=1 -p 1` 全绿（新增 digitalhuman 单测用 mock Provider）+ `npm run build` 通过 |

---

## 9. Implementation notes

- 涉及文件：`backend/internal/digitalhuman/`（新）、`backend/cmd/server/main.go`（注册路由 + 配置）、`.env.example`、`frontend/src/pages/InterviewRoomPage.tsx`、`frontend/src/components/VideoPersona.tsx`（新）、`frontend/src/pages/InterviewPages.css`
- 服务商选型：**排除阿里云 IMS**（2026-08-18 调研：无「照片→口播视频」自助 API，数字人集成为实时 RTC 场景、对接相芯/灵境第三方、计费需工单）；候选为硅基智能 / 腾讯云智影 / 讯飞智作，以注册开通后的实际 API 文档为准；实现文件内标注待确认项（形象上传方式、任务查询、音色 ID）
- 无 DB 迁移、无新前端依赖
- `wps.png` 复用现有 `frontend/public/persona-default.png` 作降级形象；上传给服务商用同一张图
- Prefer branch `feat/v14-video-persona` from main HEAD

---

## Spec self-review

- [x] 无 TBD / 占位符（服务商细节在 Implementation notes 显式标注「以开通 API 为准」）
- [x] 与 locked decisions 一致（照片数字人、预生成 20~60s、国内按量付费、双画面、只口播当前问题、升级 voice 模式、字幕、降级、零 DB）
- [x] 范围聚焦单一实施计划；Non-goals 明确排除实时流/跟读/存档/video 模式/海外服务商/画面上传
- [x] 延迟预期、降级路径、摄像头权限失败处理、Provider 抽象、轮询上限显式
