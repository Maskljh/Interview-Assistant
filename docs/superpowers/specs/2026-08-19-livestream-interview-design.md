# V15 实时视频面试 — 设计规格

**Date:** 2026-08-19
**Status:** Draft
**Parent:** V14 数字人视频面试官（预生成片段）之后的实时化升级
**Approach:** voice 模式下引入**实时数字人视频流**：面试官持续在线，收到题目即开口、作答期间静默等待，形成接近真实视频面试的连续体验；服务商未配置/失败时自动回退 V14（预生成视频 / TTS 播报）

---

## 1. Goal

把语音面试的「面试官侧」从**逐题预生成片段**升级为**持续在线的实时数字人**：进入面试即建立实时会话，后端 WS 推送题目后驱动面试官实时口播，作答期间面试官静默等待。由于实时数字人服务商尚未开通，本次交付**完整架构 + 模拟实现（stub）**，前端用模拟流跑通实时面试闭环；服务商开通后仅需新增一个 Provider 实现并配置 `.env`，前端与其余后端零改动。

---

## 2. Locked decisions

| 决策点 | 选择 |
|--------|------|
| 形态 | **实时数字人视频流**（服务商实时会话，非预生成片段、非 2D 动画） |
| 实时性 | **持续在线会话**：进入面试建立会话，题目驱动开口；非逐题渲染 |
| 服务商 | **未开通**：本次交付 `livestream` 抽象层 + stub Provider（返回模拟流）；接入目标为国内实时数字人服务商（腾讯云数智人 / 讯飞智作等），以开通确认的 API 为准 |
| 口播内容 | 驱动面试官口播**当前题目**（含追问）；作答期间静默等待 |
| 模式衔接 | **升级现有 voice 模式**（text / voice 二选一不变）；不新增 video 第三模式 |
| 用户侧 | **摄像头仅本地预览**：`getUserMedia({ video: true })` 本地小窗，不上传服务商（与 V14 一致）；录音仍走现有「按次申请麦克风」路径 |
| 字幕 | **要**：实时视频区域显示题目全文（前端 overlay），与 V14 一致 |
| 视频声音 | 实时数字人自带 TTS 音色口播，替代现有阿里云 TTS 播题与 V14 预生成视频 |
| 降级 | 服务商未配置 / 建会话失败 / 会话中途断开 → **回退 V14**（预生成视频 / TTS 播报），不阻塞面试 |
| 架构 | 后端新增 `internal/livestream` 抽象层（Provider + Session 接口 + stub + REST）；**零 DB 改动**（会话不落库） |
| 分支 | `feat/v15-livestream` from main HEAD |

---

## 3. Non-goals (V15)

- 真实服务商接入（本次仅抽象层 + stub；服务商实现列为后续增量）
- 用户摄像头画面上传 / 表情感知 / 录制（本地预览，与 V14 一致）
- 实时对话式多轮唇形互动（面试官只口播题目，回答期间等待）
- 视频存档 / 回放（会话不落库，用完即弃）
- 新增 `video` 第三输入模式
- 海外服务商（D-ID / HeyGen）

---

## 4. Architecture

```text
Browser (voice 模式, 实时可用时)
 ├─ 进入：POST /api/livestream/sessions ──► Go livestream ──► 实时数字人服务商
 │         ◄── {sessionId, streamURL} ──► 前端 <video> 播放实时流 + 字幕
 ├─ 提问：WS question ──► 前端调 POST /api/livestream/sessions/:id/speak ──► 服务商口播当前题
 ├─ 作答：录音 ──► ASR ──► WS answer（现有链路，不变）
 └─ 摄像头：getUserMedia 本地预览小窗（不上传，现有 UserCamera 不变）

现有链路保留：DeepSeek 出题、阿里云 ASR、WS 文本协议、V14 预生成视频作降级
```

| 单元 | 职责 |
|------|------|
| `internal/livestream` | `Provider` / `Session` 接口、stub 实现、REST handlers；未配置/失败 → 调用方降级 |
| `interview` / `ws` | **不改**；不感知实时视频 |
| 前端房间页 | voice 模式：进入即建会话播放实时流；收到题目调 `speak` 并显示字幕；作答交互不变 |
| V14 组件 | 保留作降级路径（`VideoPersona` 预生成视频 + TTS） |

**服务商抽象**：换服务商只新增一个 `Provider` 实现文件 + 改 `.env` 配置，其余不动。

---

## 5. 后端：`internal/livestream`

### 5.1 Provider / Session 接口

```go
// ErrNotConfigured 表示未配置实时数字人服务商，调用方应降级到 V14。
var ErrNotConfigured = errors.New("livestream provider not configured")

type Session interface {
    StreamURL() string              // 实时视频流地址（前端 <video> 播放）
    Speak(ctx context.Context, text string) error // 驱动面试官口播
    Close() error
}

type Provider interface {
    StartSession(ctx context.Context, avatarID string) (Session, error)
}
```

- `Config`：`ProviderName`、`APIKey`、`Secret`、`AvatarID`（照片/形象 ID，stub 可忽略）、`StreamURL`（stub 用）
- `NewProvider(cfg Config) (Provider, error)`：`ProviderName` 为空 → `(nil, nil)`，handler 降级；`"stub"` → 返回 stub；其余 → 错误

### 5.2 stub Provider

- `StartSession` 返回 `stubSession`：`StreamURL()` 返回配置的模拟流地址（本地可播放的占位视频 / 静默流）；`Speak` 为 no-op（`nil`）；`Close` 为 no-op
- 目的：前端在无服务商时也能完整走通「建会话 → 播放 → 开口 → 作答 → 下一题」闭环

### 5.3 REST handlers

| 路由 | 行为 |
|------|------|
| `POST /api/livestream/sessions` | `StartSession`，返回 `{sessionId, streamURL}`；未配置 → `503` |
| `POST /api/livestream/sessions/:id/speak` | body `{text}`，调 `Session.Speak`；失败 → `502` |
| `POST /api/livestream/sessions/:id/close` | 调 `Session.Close`，返回 `{ok:true}` |

- 鉴权：沿用现有 `JWT` 中间件模式（同 `digitalhuman`）
- 会话存于内存 map（`sessionID → Session`），跟随面试生命周期；不落库
- `sessionID` 由 handler 生成（如随机 ID），非数据库自增

### 5.4 main.go 接线

参照 `digitalhuman` 先例：`NewProvider` 按 `.env` 构造，`livestream.RegisterRoutes(r, cfg.JWTSecret, provider)`。`.env` 新增（默认 stub / 空）：

```
LIVESTREAM_PROVIDER=
LIVESTREAM_STREAM_URL=
```

---

## 6. 前端

### 6.1 API client：`frontend/src/api/livestream.ts`

```ts
export interface LivestreamSession { sessionId: string; streamURL: string }
export async function createLivestreamSession(): Promise<LivestreamSession> // POST /sessions
export async function speakLivestream(sessionId: string, text: string): Promise<void> // POST /sessions/:id/speak
export async function closeLivestream(sessionId: string): Promise<void> // POST /sessions/:id/close
```

### 6.2 组件：`frontend/src/components/LivestreamPersona.tsx`

- props：`streamURL`、`question`（字幕全文）、`speaking`（bool，是否正在口播）、`onToggleMute`、`onReplay`、`onSkip`
- 渲染：16:9 实时视频 `<video autoplay playsInline muted={ttsMuted}>` + 字幕 overlay + 控制（静音 / 重播 / 跳过）
- 沿用 `.video-persona-*` 样式（V14 已具备），必要时补 `.livestream-*` 微调

### 6.3 房间页 `InterviewRoomPage.tsx`

- 新增状态：`livestream: { sessionId, streamURL } | null`、`liveAvailable: boolean`（建会话是否成功，本场生效）、`liveSpeaking: boolean`
- **口播时长估算**：实时流无单题结束事件，按文本长度估算口播时长（约 240 字/分钟），到时置 `liveSpeaking=false`；「跳过」按钮立即清除；stub 模式同样适用
- **进入面试**（voice 模式）：请求建会话；成功 → `liveAvailable=true`，播放实时流；`503`（未配置）→ `liveAvailable=false`，沿用 V14 逐题流程
- **收到 WS question / follow_up**：
  - `liveAvailable` → 调 `speakLivestream` 驱动开口，字幕显示题目全文，`liveSpeaking=true`（口播期间）；口播结束（按文本长度估算时长，到时自动置 `false`；「跳过」按钮可立即清除）→ `liveSpeaking=false`
  - 否则 → 现有 `playQuestionVideo` / `playQuestion`（V14 降级路径）
- **作答期间**：实时形象静默等待（`liveSpeaking=false`），不驱动开口
- **静音**：实时模式下静音即 `video.muted=true`（不调 speak），`liveSpeaking` 状态照常
- **结束 / 卸载**：`closeLivestream`；会话中途断开 → 重建一次，失败回退 V14
- 摄像头小窗、录音/ASR、文字备选、结束面试、报告跳转等现有交互**全部不变**

### 6.4 渲染分支

`effectiveInputMode === 'voice'` 且 `liveAvailable` 时，视频舞台区渲染 `LivestreamPersona`；否则渲染现有 `VideoPersona / VirtualPersona`。`UserCamera` 始终渲染（不变）。

---

## 7. 错误处理与降级

| 场景 | 行为 |
|------|------|
| 服务商未配置 / 建会话失败（503） | `liveAvailable=false`，回退 V14 逐题流程（预生成视频 / TTS） |
| 实时会话中途断开 | 重建一次会话；仍失败 → 回退 V14 当前题 |
| speak 失败（502） | 字幕仍显示；「重播」按钮可重试 speak |
| 摄像头拒绝 / 无摄像头 | 静默隐藏（现有行为） |
| 静音状态 | 实时视频 `muted`；不调 speak |

---

## 8. 测试

### 后端（`internal/livestream/handler_test.go`）

- stub Provider：`StartSession` 返回 `streamURL`；`Speak`/`Close` no-op
- handler：建会话返回 `{sessionId, streamURL}`；speak/close 路由；未配置（`NewProvider` 空）→ 建会话 `503`
- 鉴权：无 token 请求被拒

### 前端

- `npm run build` 通过
- stub 模式手工验证：进入语音面试 → 实时流播放 → 题目出现并触发口播状态 → 录音作答 → 下一题继续 → 结束面试关闭会话
- 模拟 503（清空 `LIVESTREAM_PROVIDER`）→ 回退 V14 流程，面试不中断
