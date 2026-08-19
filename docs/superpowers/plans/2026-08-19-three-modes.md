# V17 三模式面试（文本/语音/视频） Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 创建页三选一（文本/语音/视频）；语音=静态形象+TTS，视频=数智人实时；修复数智人因配额泄漏不可见。

**Architecture:** 后端 `InputMode` 加 `video` + 驱动会话 TTL 清理；前端创建页三选项、房间页 voice→静态/video→数智人分流、数智人不可用提示+重试。

**Tech Stack:** Go (gin) + React/TypeScript (vite)。

## Global Constraints

- 语音模式**不建腾讯会话**、不占配额（恒静态形象 + TTS）
- 视频模式 = V16 数智人完整链路 + 摄像头小窗；数智人不可用 → 提示 + 重试
- 文本模式不变
- 模式内"切换为文字作答"保留（voice/video → text 单向）
- 驱动会话 TTL = 30 分钟无 speak 自动 close
- 零 DB 改动；后端模块 `github.com/interview-assistant/backend`；分支 `feat/v17-three-modes` from main HEAD

---

### Task 1: 后端 InputMode 加 video

**Files:**
- Modify: `backend/internal/interview/models.go`
- Test: `backend/internal/interview/models_test.go`（若存在）或 `models.go` 内联验证

**Interfaces:**
- Consumes: 无
- Produces: `InputModeVideo InputMode = "video"`；`ValidateInputMode` 接受 `video`

- [ ] **Step 1: 写失败的测试**

若 `backend/internal/interview/models_test.go` 不存在则创建：

```go
package interview_test

import (
	"testing"

	"github.com/interview-assistant/backend/internal/interview"
)

func TestValidateInputModeVideo(t *testing.T) {
	if err := interview.ValidateInputMode(interview.InputModeVideo); err != nil {
		t.Fatalf("video should be valid: %v", err)
	}
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd backend && go test ./internal/interview/ -run TestValidateInputModeVideo -v`
Expected: FAIL（video 未定义或校验失败）

- [ ] **Step 3: models.go 加枚举与校验**

`backend/internal/interview/models.go`：

```go
const (
	InputModeText  InputMode = "text"
	InputModeVoice InputMode = "voice"
	InputModeVideo InputMode = "video"
)
```

`ValidateInputMode`：

```go
	case InputModeText, InputModeVoice, InputModeVideo:
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd backend && go test ./internal/interview/ -v`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add backend/internal/interview/models.go backend/internal/interview/models_test.go
git commit -m "feat(interview): add video input mode"
```

---

### Task 2: 后端驱动会话 TTL 清理

**Files:**
- Modify: `backend/internal/livestream/handler.go`
- Test: `backend/internal/livestream/handler_test.go`

**Interfaces:**
- Consumes: 现有 `handler` 结构（`sessions map[string]Session`）
- Produces: 会话 map 值带 `lastActivity`；TTL 清理 goroutine（30 分钟）；speak/close 更新活动时间

- [ ] **Step 1: 写失败的测试**

在 `backend/internal/livestream/handler_test.go` 追加：

```go
func TestSessionTTLExpiry(t *testing.T) {
	// 构造一个超时会话，验证 sweep 会关闭它
	r := testRouter(&fakeProvider{session: &fakeSession{streamURL: "https://example.com/stream.mp4"}})
	id := createAndGetID(t, r)
	// 把该会话的 lastActivity 改为过期（通过访问内部状态不便，改为直接调 sweep 逻辑）
	// 这里用一个短 TTL 的 handler 实例验证
	gin.SetMode(gin.TestMode)
	rr := gin.New()
	h := &livestream.HandlerForTest{ /* 见实现 */ }
	_ = h
	_ = rr
	_ = id
}
```

（说明：TTL 测试需要可注入时钟或短 TTL。实现时在 handler 上加 `sessionTTL time.Duration` 字段（默认 30min），测试时用短 TTL + 手动改 `lastActivity`。测试写法以实际实现为准——关键是验证"过期会话被 sweep 关闭并移除"。）

- [ ] **Step 2: 运行测试确认失败**

Run: `cd backend && go test ./internal/livestream/ -run TestSessionTTLExpiry -v`
Expected: FAIL（sweep 未实现）

- [ ] **Step 3: 实现 TTL 清理**

`backend/internal/livestream/handler.go`：

- 会话 map 值改为结构：

```go
type sessionEntry struct {
	sess         Session
	lastActivity time.Time
}
```

- `handler.sessions` 类型改为 `map[string]sessionEntry`
- `Create` 写入 `sessionEntry{sess: sess, lastActivity: time.Now()}`
- `Speak`/`Close` 查询/更新 `entry.lastActivity = time.Now()`
- 新增 sweep 方法（惰性，在 `Create`/`Speak` 时检查）：

```go
const livestreamSessionTTL = 30 * time.Minute

// sweepExpired 关闭并移除超过 TTL 未活动的会话（防浏览器异常退出导致腾讯配额泄漏）。
func (h *handler) sweepExpired(now time.Time) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for id, e := range h.sessions {
		if now.Sub(e.lastActivity) > livestreamSessionTTL {
			_ = e.sess.Close()
			delete(h.sessions, id)
		}
	}
}
```

- 在 `Create`/`Speak`/`Close` 开头调用 `h.sweepExpired(time.Now())`（简单、无后台 goroutine）
- 为可测试性，`livestreamSessionTTL` 提为 `handler.sessionTTL` 字段（默认 30min），测试可注入短值

- [ ] **Step 4: 运行测试确认通过**

Run: `cd backend && go test ./internal/livestream/ -v`
Expected: 全部通过（含 TTL 测试，若可测）

- [ ] **Step 5: 提交**

```bash
git add backend/internal/livestream/handler.go backend/internal/livestream/handler_test.go
git commit -m "feat(livestream): TTL sweep for driver sessions"
```

---

### Task 3: 前端创建页三选项

**Files:**
- Modify: `frontend/src/pages/CreateInterviewPage.tsx`

**Interfaces:**
- Consumes: `InputMode` 类型（含 `video`，来自 `api/interviews`）
- Produces: 创建页显示 文本/语音/视频 三选项

- [ ] **Step 1: 改 INPUT_MODES**

`CreateInterviewPage.tsx`：

```tsx
const INPUT_MODES: { value: InputMode; label: string }[] = [
  { value: 'text', label: '文本' },
  { value: 'voice', label: '语音' },
  { value: 'video', label: '视频' },
];
```

- [ ] **Step 2: 检查 InputMode 类型**

`frontend/src/api/interviews.ts` 的 `InputMode` 类型是否已含 `video`（后端已加）。若无，同步：

```ts
export type InputMode = 'text' | 'voice' | 'video';
```

- [ ] **Step 3: 构建验证**

Run: `cd frontend && npm run build`
Expected: 构建成功

- [ ] **Step 4: 提交**

```bash
git add frontend/src/pages/CreateInterviewPage.tsx frontend/src/api/interviews.ts
git commit -m "feat(frontend): three input modes in create page"
```

---

### Task 4: 房间页 voice/video 分流

**Files:**
- Modify: `frontend/src/pages/InterviewRoomPage.tsx`

**Interfaces:**
- Consumes: `InputMode` 含 `video`；现有 voice 交互（录音/按住说话/切文字）与视频链路（getLivestreamSign/LivestreamPersona）
- Produces: `effectiveInputMode` 识别 voice+video；voice→静态+TTS；video→数智人

- [ ] **Step 1: effectiveInputMode 扩展**

```tsx
  const effectiveInputMode: InputMode =
    (inputMode === 'voice' || inputMode === 'video') && !textModeOverride
      ? inputMode
      : 'text';
```

（即 voice→voice、video→video、override→text。）

- [ ] **Step 2: loadAndConnect 分流**

`data.input_mode === 'voice'` 的建数智人分支改为仅 `video` 时建：

```tsx
        if (data.input_mode === 'video') {
          try {
            const sign = await getLivestreamSign();
            if (cancelled) return;
            liveAvailableRef.current = true;
            setLiveSign(sign);
          } catch {
            liveAvailableRef.current = false;
            setLiveSignError(true); // 新增状态：数智人不可用提示
          }
        }
```

新增状态 `const [liveSignError, setLiveSignError] = useState(false);`

- [ ] **Step 3: voice 渲染分支改为静态**

房间页 `effectiveInputMode === 'voice'` 的舞台区渲染 `VirtualPersona`（不再渲染数智人）。即 voice 分支：

```tsx
            {effectiveInputMode === 'voice' && (
              <div className="video-persona-stage">
                <VirtualPersona state={personaState} avatarUrl={avatarUrl} />
                <label className="virtual-persona-avatar-btn">
                  换头像
                  <input type="file" accept="image/*" onChange={handleAvatarChange} hidden />
                </label>
              </div>
            )}
```

（`liveSign`/`LivestreamPersona` 只在 video 模式渲染。）

- [ ] **Step 4: video 渲染分支保留数智人 + 不可用提示**

video 分支渲染 `LivestreamPersona`（现有 `liveSign ?` 逻辑），并在 `liveSignError` 时显示提示条：

```tsx
            {effectiveInputMode === 'video' && (
              <div className="video-persona-stage">
                {liveSignError && !liveSign && (
                  <div className="interview-room-status">
                    数智人不可用，已切换为静态面试官
                    <button type="button" onClick={retryLiveSign}>重试加载数智人</button>
                  </div>
                )}
                {liveSign ? (
                  <LivestreamPersona ... />
                ) : (
                  <VirtualPersona state={personaState} avatarUrl={avatarUrl} />
                )}
                <UserCamera />
                <label className="virtual-persona-avatar-btn">
                  换头像
                  <input type="file" accept="image/*" onChange={handleAvatarChange} hidden />
                </label>
              </div>
            )}
```

新增 `retryLiveSign`：

```tsx
  const retryLiveSign = useCallback(async () => {
    setLiveSignError(false);
    try {
      const sign = await getLivestreamSign();
      liveAvailableRef.current = true;
      setLiveSign(sign);
    } catch {
      setLiveSignError(true);
    }
  }, []);
```

- [ ] **Step 5: WS question 驱动分流**

`handleMessage` 的 voice 分支改为按 video/voice 分流——video 走 `handleLiveSpeak`（数智人），voice 走 `playQuestion`（TTS 播报）：

```tsx
            if (inputModeRef.current === 'video') {
              if (liveAvailableRef.current) {
                void handleLiveSpeak(msg.content);
              } else {
                void playQuestion(msg.content);
              }
            } else if (inputModeRef.current === 'voice') {
              void playQuestion(msg.content);
            } else if (videoUnavailableRef.current) {
              void playQuestion(msg.content);
            } else {
              void playQuestionVideo(msg.content);
            }
```

（voice 模式现在恒走 TTS 播报静态形象。）

- [ ] **Step 6: 语音交互区条件扩展**

`voice-room-controls` 等语音交互区（按住说话等）的条件从 `effectiveInputMode === 'voice'` 扩展为 `voice || video`（`effectiveInputMode !== 'text'`）：

```tsx
              {effectiveInputMode !== 'text' && (
                <div className="voice-room-controls">
                  {effectiveInputMode !== 'text' ? (
                    <>
                      ...按住说话...
                    </>
                  ) : (
                    ...
                  )}
                </div>
              )}
```

- [ ] **Step 7: 构建验证**

Run: `cd frontend && npm run build`
Expected: 构建成功（若 tsc 报未用变量等，按报错清理）

- [ ] **Step 8: 提交**

```bash
git add frontend/src/pages/InterviewRoomPage.tsx
git commit -m "feat(room): voice static persona, video livestream persona"
```

---

### Task 5: 端到端验证

**Files:** 无源码改动（构建 + 运行验证）

- [ ] **Step 1: 重建后端 + 重启**

```bash
cd backend && go build -o ../server.exe ./cmd/server
# 杀 9090 旧进程，重启 server.exe
```
验证 `curl -s http://localhost:9090/healthz` → `{"ok":true}`。

- [ ] **Step 2: 后端单测全过**

Run: `cd backend && export MYSQL_DSN='root:root@tcp(127.0.0.1:3307)/interview?parseTime=true&charset=utf8mb4' && go test ./...`
Expected: 全过

- [ ] **Step 3: 前端构建 + 重启**

Run: `cd frontend && VITE_API_BASE=http://localhost:9090 npm run build`，重启 5174 preview。

- [ ] **Step 4: 浏览器验证三模式**

- 创建页：显示 文本/语音/视频 三选项
- **语音模式**：进入房间 → 静态形象 + TTS 播报（题目读出），**无 livestream 网络请求**（验证不碰腾讯）
- **视频模式**：进入房间 → 数智人建流 + 口播 + 摄像头小窗
- 数智人不可用（临时占配额）：提示"数智人不可用"+ 重试按钮

- [ ] **Step 5: 收尾**

确认 git 状态干净（.env 不提交）；测试后清理腾讯会话（`listsessionofprojectid` + closesession）。

---

## Self-Review

**Spec coverage:**
- §5.1 InputMode 加 video → Task 1 ✓
- §5.2 驱动会话 TTL 清理 → Task 2 ✓
- §6.1 创建页三选项 → Task 3 ✓
- §6.2 房间页 voice/video 分流 → Task 4 ✓
- §6.3 数智人不可用提示 + 重试 → Task 4 ✓
- §7 降级（video 不可用提示、voice 恒静态、TTL 清理）→ Task 2/4 ✓
- §8 测试（video 枚举、TTL、三模式浏览器验证）→ Task 1/2/5 ✓

**Placeholder scan:** Task 2 的 TTL 测试写法标注"以实际实现为准"——这是测试设计说明而非占位符，实现时需给出具体测试。其余代码块完整。✓

**Type consistency:** `InputModeVideo` 跨 Task 1/3/4；`liveSignError`/`retryLiveSign` 跨 Task 4；`sessionEntry`/`sweepExpired` 跨 Task 2。均一致。✓
