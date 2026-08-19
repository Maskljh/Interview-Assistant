# V17 三模式面试（文本/语音/视频）— 设计规格

**Date:** 2026-08-19
**Status:** Draft
**Parent:** V16 腾讯数智人接入后的模式重构
**Approach:** 创建面试页提供**文本/语音/视频**三模式选择：文本=纯文字；语音=录音作答+静态形象+TTS 播报（V13 行为，不依赖腾讯）；视频=录音作答+腾讯数智人实时视频+摄像头小窗（V16 能力整体迁入）。同时修复"数智人看不到"根因（驱动会话泄漏占配额 → 加 TTL 清理）。

---

## 1. Goal

把面试模式从"文本/语音"二选一升级为**三选一**，并明确各模式的能力边界：语音模式不再使用数智人（回到静态形象 + TTS），数智人专属视频模式。同时修复数智人因会话配额被占用而无法显示的问题（驱动会话加 TTL 自动清理 + 前端明确提示与重试）。

---

## 2. Locked decisions

| 决策点 | 选择 |
|--------|------|
| 模式集 | **文本 / 语音 / 视频** 三选一 |
| 文本模式 | 纯文字作答；面试官无形象（现状不变） |
| 语音模式 | 录音作答 + **静态形象 + TTS 播报**（V13 行为）；**不建腾讯会话**、不占配额 |
| 视频模式 | 录音作答 + **腾讯数智人实时视频**（V16 能力）+ 摄像头小窗（本地预览）；数智人不可用时提示 + 可重试 / 切静态 |
| 模式切换 | 语音/视频模式内保留"切换为文字作答"（现有能力）；不可从文字切回语音/视频（现有行为） |
| 后端枚举 | `InputMode` 加 `video`；`ValidateInputMode` 接受；DB 无改动（字符串存储） |
| 配额清理 | 后端驱动会话内存 map 加 **TTL**（30 分钟无 speak 自动 close）；前端正常 close 保留 |
| 数智人不可用 | 视频模式：明确提示"数智人不可用，已切换为静态面试官"+ **重试按钮**；不再静默降级 |
| 降级链 | 视频 → 数智人 →（不可用）→ 静态形象 + TTS（现有 V14 预生成视频路径保留为中间档） |
| 分支 | `feat/v17-three-modes` from main HEAD |

---

## 3. Non-goals (V17)

- 语音模式引入数智人/预生成视频（明确去掉）
- 摄像头画面在上传/录制（仅本地预览）
- 模式间自由切换（只能文字↔语音/视频单向切文字）
- 数智人会话跨设备共享 / 多路并发（仍单配额）
- 新增 DB 字段

---

## 4. Architecture

```text
创建页: 文本 / 语音 / 视频   (三选一)

房间页:
 ├─ text    → 文字作答（现状）
 ├─ voice   → VirtualPersona 静态形象 + playQuestion TTS + 录音作答（V13，无腾讯）
 └─ video   → getLivestreamSign → IVH SDK 建流 → 数智人 + speak 驱动 + 录音作答 + 摄像头
                └─ 数智人不可用 → 提示 + 重试按钮 / 切静态形象

后端:
 ├─ InputMode: text / voice / video
 └─ livestream handler: 驱动会话 map 加 TTL 清理（30min 无 speak 自动 close）
```

| 单元 | 职责 |
|------|------|
| `CreateInterviewPage` | 三模式选择 UI |
| `InterviewRoomPage` | `effectiveInputMode` 分流：voice→静态+TTS；video→数智人链路；text→现状 |
| `internal/livestream/handler` | 驱动会话 TTL 清理 |
| 现有 V13/V16 组件 | 复用：`VirtualPersona`（静态）、`LivestreamPersona`（数智人）、`UserCamera`（摄像头） |

---

## 5. 后端改动

### 5.1 InputMode 加 video

`backend/internal/interview/models.go`:

```go
const (
	InputModeText  InputMode = "text"
	InputModeVoice InputMode = "voice"
	InputModeVideo InputMode = "video"
)
```

`ValidateInputMode` switch 加 `case InputModeVideo:`。

### 5.2 驱动会话 TTL 清理

`backend/internal/livestream/handler.go`：

- 会话 map 值改为带 `lastActivity time.Time` 的结构（或存 `lastSpeakAt`）
- 新增后台 goroutine（或惰性清理）：遍历 map，`lastActivity` 超过 30 分钟（`livestreamSessionTTL = 30 * time.Minute`）的会话 `Close()` 并删除
- speak/close 时更新 `lastActivity`
- 作用：浏览器异常退出导致的残留驱动会话，30 分钟后自动释放腾讯配额，不再永久占住导致"数智人看不到"

---

## 6. 前端改动

### 6.1 创建页三选项

`CreateInterviewPage.tsx` 的 `INPUT_MODES`：

```tsx
const INPUT_MODES: { value: InputMode; label: string }[] = [
  { value: 'text', label: '文本' },
  { value: 'voice', label: '语音' },
  { value: 'video', label: '视频' },
];
```

### 6.2 房间页 voice/video 分流

`InterviewRoomPage.tsx`：

- `effectiveInputMode`：`inputMode === 'voice' || inputMode === 'video'` 且非 textModeOverride 时，走语音/视频交互（录音、按住说话、切文字等现有 voice 逻辑）
- **voice**：面试官区渲染 `VirtualPersona`（静态）+ TTS 播报；**不调用** `getLivestreamSign` / 不建腾讯会话
- **video**：渲染 `LivestreamPersona`（数智人）+ 摄像头 + speak 驱动（V16 链路）；数智人不可用时显示提示 + 重试
- 加载面试时按 `input_mode` 分流：`video` → 建数智人会话；`voice` → 跳过（不请求 sign）

### 6.3 数智人不可用提示 + 重试

- 视频模式建数智人失败（sign 503 / SDK 失败）：显示"数智人不可用，已切换为静态面试官"+ "重试加载数智人"按钮
- 重试：重新 `getLivestreamSign()` → 重建数智人

---

## 7. 错误处理与降级

| 场景 | 行为 |
|---|---|
| 视频模式，数智人不可用（配额占/凭证错） | 明确提示 + 重试按钮；可保持静态形象继续面试 |
| 语音模式 | 恒为静态形象 + TTS，不依赖腾讯 |
| 文本模式 | 不变 |
| 驱动会话泄漏 | 后端 30 分钟 TTL 自动清理，释放配额 |

---

## 8. 测试

### 后端

- `ValidateInputMode("video")` 通过；`"text"/"voice"` 仍通过
- livestream handler TTL：构造超时会话，验证被清理（用可注入时钟或短 TTL 测试）

### 前端

- 创建页显示三选项
- 语音模式：进入房间 → 静态形象 + TTS 播报，无 livestream 网络请求
- 视频模式：进入房间 → 数智人建流 + 口播 + 摄像头（浏览器实测）
- 数智人不可用（模拟 503）：提示 + 重试按钮出现
- `npm run build` 通过
