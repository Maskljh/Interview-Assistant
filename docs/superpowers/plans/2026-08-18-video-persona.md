# V14 数字人视频面试官 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** voice 模式下，用 `wps.png` 生成的数字人视频口播当前问题（替代 V13 静态人像 + TTS 播报），面试官视频大屏 + 用户摄像头小窗双画面；数字人服务不可用时自动降级到 V13（TTS + 静态人像），面试不中断。

**Architecture:** 后端新增 `internal/digitalhuman`（`Provider` 接口 + stub 实现 + REST `POST/GET /api/digital-human/videos`）；前端房间页 voice 模式提问改为「提交视频任务 → 轮询 → 播放」，任何失败回退现有 TTS 路径。服务商（硅基智能/腾讯云智影/讯飞智作）账号开通后按各自 API 文档实现 `Provider`，接口已抽象好，换供应商只改一个文件。

**Tech Stack:** Go/Gin、React/Vite TS、既有 design tokens；无新依赖、无 DB 迁移、无 WS 协议改动。

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-18-video-persona-design.md`
- 分支 `feat/v14-video-persona` from main HEAD（实施时用 superpowers:using-git-worktrees 建 worktree）
- 数字人服务未配置/不可用时 REST 返回 **503**，前端降级 TTS——**不阻塞面试**
- `Provider` 接口签名（Task 1 锁定，后续任务沿用）：`Submit(ctx, text) (taskID string, err error)`；`Result(ctx, taskID) (Status, string, error)`；`Status ∈ pending | processing | completed | failed`
- 后端测试：`cd backend && go test ./... -count=1 -p 1`；前端验证：`cd frontend && npm run build`（项目无前端单测框架，前端用 build 做类型检查）
- 摄像头仅申请视频轨 `getUserMedia({ video: true })`，本地预览不上传；录音仍走现有「按次申请麦克风」，作答链路零改动
- 轮询 3s × 40 次 = 120s 上限（覆盖服务商 20~60s 渲染 + 余量）
- 视频只播一遍；字幕在视频下方显示题目全文
- 每个 Task 完成后独立 commit

---

### Task 1: 后端 `internal/digitalhuman` 模块（接口 + stub + REST + 单测）

**Files:**
- Create: `backend/internal/digitalhuman/client.go`
- Create: `backend/internal/digitalhuman/provider_stub.go`
- Create: `backend/internal/digitalhuman/handler.go`
- Test: `backend/internal/digitalhuman/handler_test.go`

**Interfaces:**
- Consumes: 无（新包；依赖 `github.com/gin-gonic/gin`、`internal/auth.Middleware`，均已有）
- Produces:
  - `type Status string`，常量 `StatusPending/StatusProcessing/StatusCompleted/StatusFailed`
  - `type Config struct { ProviderName, APIKey, Secret, AvatarID, Voice string }`
  - `type Provider interface { Submit(ctx context.Context, text string) (string, error); Result(ctx context.Context, taskID string) (Status, string, error) }`
  - `func NewProvider(cfg Config) (Provider, error)`（ProviderName 空 → `(nil, nil)`）
  - `func RegisterRoutes(r *gin.Engine, secret string, provider Provider)`
  - `const maxVideoTextRunes = 500`

- [ ] **Step 1: 写失败的测试**

`backend/internal/digitalhuman/handler_test.go`（完整内容）：

```go
package digitalhuman_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/interview-assistant/backend/internal/auth"
	"github.com/interview-assistant/backend/internal/digitalhuman"
)

type fakeProvider struct {
	submitTaskID string
	submitErr    error
	resultStatus digitalhuman.Status
	resultURL    string
	resultErr    error
}

func (f *fakeProvider) Submit(ctx context.Context, text string) (string, error) {
	return f.submitTaskID, f.submitErr
}

func (f *fakeProvider) Result(ctx context.Context, taskID string) (digitalhuman.Status, string, error) {
	return f.resultStatus, f.resultURL, f.resultErr
}

func testRouter(p digitalhuman.Provider) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	digitalhuman.RegisterRoutes(r, "test-secret", p)
	return r
}

func authHeader(t *testing.T) string {
	t.Helper()
	token, err := auth.IssueToken("test-secret", 1, "test@example.com", time.Hour)
	if err != nil {
		t.Fatalf("issue token: %v", err)
	}
	return "Bearer " + token
}

func postVideo(t *testing.T, r *gin.Engine, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/digital-human/videos", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", authHeader(t))
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	return rec
}

func getVideo(t *testing.T, r *gin.Engine, taskID string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/digital-human/videos/"+taskID, nil)
	req.Header.Set("Authorization", authHeader(t))
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	return rec
}

func TestSubmitUnavailableWhenProviderNil(t *testing.T) {
	rec := postVideo(t, testRouter(nil), `{"text":"请介绍一下你自己"}`)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
}

func TestSubmitReturnsTaskID(t *testing.T) {
	r := testRouter(&fakeProvider{submitTaskID: "task-1"})
	rec := postVideo(t, r, `{"text":"请介绍一下你自己"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var resp struct {
		TaskID string `json:"taskId"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp.TaskID != "task-1" {
		t.Fatalf("taskId = %q, want task-1", resp.TaskID)
	}
}

func TestSubmitRejectsEmptyText(t *testing.T) {
	rec := postVideo(t, testRouter(&fakeProvider{submitTaskID: "task-1"}), `{"text":""}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
}

func TestSubmitProviderError(t *testing.T) {
	r := testRouter(&fakeProvider{submitErr: errors.New("vendor down")})
	rec := postVideo(t, r, `{"text":"请介绍一下你自己"}`)
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
}

func TestResultCompleted(t *testing.T) {
	r := testRouter(&fakeProvider{resultStatus: digitalhuman.StatusCompleted, resultURL: "https://cdn.example.com/v.mp4"})
	rec := getVideo(t, r, "task-1")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var resp struct {
		Status   string `json:"status"`
		VideoURL string `json:"videoURL"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp.Status != "completed" || resp.VideoURL != "https://cdn.example.com/v.mp4" {
		t.Fatalf("got status=%q videoURL=%q", resp.Status, resp.VideoURL)
	}
}

func TestResultPending(t *testing.T) {
	r := testRouter(&fakeProvider{resultStatus: digitalhuman.StatusPending})
	rec := getVideo(t, r, "task-1")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if !bytes.Contains(rec.Body.Bytes(), []byte(`"status":"pending"`)) {
		t.Fatalf("body = %s, want status pending", rec.Body.String())
	}
	if bytes.Contains(rec.Body.Bytes(), []byte("videoURL")) {
		t.Fatalf("body = %s, pending 不应带 videoURL", rec.Body.String())
	}
}

func TestResultUnavailableWhenProviderNil(t *testing.T) {
	rec := getVideo(t, testRouter(nil), "task-1")
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
}

func TestUnauthorized(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/api/digital-human/videos", bytes.NewBufferString(`{"text":"x"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	testRouter(nil).ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
}
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd backend && go test ./internal/digitalhuman/... -count=1`
Expected: 编译失败，`package github.com/interview-assistant/backend/internal/digitalhuman is not in std`（包还不存在）

- [ ] **Step 3: 实现接口与 stub**

`backend/internal/digitalhuman/client.go`：

```go
package digitalhuman

import "context"

type Status string

const (
	StatusPending    Status = "pending"
	StatusProcessing Status = "processing"
	StatusCompleted  Status = "completed"
	StatusFailed     Status = "failed"
)

type Config struct {
	ProviderName string
	APIKey       string
	Secret       string
	AvatarID     string
	Voice        string
}

// Provider 提交文本口播任务并查询渲染结果。视频生成在服务商侧排队渲染，
// 渲染时长通常 20~60 秒，调用方需轮询 Result。
type Provider interface {
	Submit(ctx context.Context, text string) (taskID string, err error)
	Result(ctx context.Context, taskID string) (Status, string, error)
}
```

`backend/internal/digitalhuman/provider_stub.go`：

```go
package digitalhuman

import (
	"context"
	"errors"
	"fmt"
)

var ErrNotConfigured = errors.New("digital human provider not configured")

// NewProvider 按配置构造 Provider。ProviderName 为空时返回 (nil, nil)，
// 由调用方（handler/前端）降级到 TTS 播报。
//
// 服务商（硅基智能 / 腾讯云智影 / 讯飞智作）账号开通后，按各自 API 文档
// 新增一个 Provider 实现（例如 provider_silicon.go）并在本 switch 注册，
// 同时在 handler 的 503 语义下正常返回任务 ID 与视频 URL。当前只有 stub。
func NewProvider(cfg Config) (Provider, error) {
	if cfg.ProviderName == "" {
		return nil, nil
	}
	switch cfg.ProviderName {
	case "stub":
		return &stubProvider{}, nil
	default:
		return nil, fmt.Errorf("digital human provider %q not supported", cfg.ProviderName)
	}
}

type stubProvider struct{}

func (p *stubProvider) Submit(ctx context.Context, text string) (string, error) {
	return "", ErrNotConfigured
}

func (p *stubProvider) Result(ctx context.Context, taskID string) (Status, string, error) {
	return "", "", ErrNotConfigured
}
```

- [ ] **Step 4: 实现 REST handler**

`backend/internal/digitalhuman/handler.go`：

```go
package digitalhuman

import (
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	"github.com/interview-assistant/backend/internal/auth"
)

const maxVideoTextRunes = 500

func RegisterRoutes(r *gin.Engine, secret string, provider Provider) {
	h := &handler{provider: provider}
	protected := r.Group("/api/digital-human")
	protected.Use(auth.Middleware(secret))
	protected.POST("/videos", h.Submit)
	protected.GET("/videos/:taskId", h.Result)
}

type handler struct {
	provider Provider
}

type submitRequest struct {
	Text string `json:"text"`
}

func (h *handler) Submit(c *gin.Context) {
	if h.provider == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "digital human service unavailable"})
		return
	}
	var req submitRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request"})
		return
	}
	if strings.TrimSpace(req.Text) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "text is required"})
		return
	}
	if utf8.RuneCountInString(req.Text) > maxVideoTextRunes {
		c.JSON(http.StatusBadRequest, gin.H{"error": "text is too long"})
		return
	}
	taskID, err := h.provider.Submit(c.Request.Context(), req.Text)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": "digital human service unavailable"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"taskId": taskID})
}

func (h *handler) Result(c *gin.Context) {
	if h.provider == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "digital human service unavailable"})
		return
	}
	status, videoURL, err := h.provider.Result(c.Request.Context(), c.Param("taskId"))
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": "digital human service unavailable"})
		return
	}
	resp := gin.H{"status": status}
	if videoURL != "" {
		resp["videoURL"] = videoURL
	}
	c.JSON(http.StatusOK, resp)
}
```

- [ ] **Step 5: 运行测试，确认全绿**

Run: `cd backend && go test ./internal/digitalhuman/... -count=1`
Expected: 全部 PASS（10 个测试）

- [ ] **Step 6: Commit**

```bash
git add backend/internal/digitalhuman/
git commit -m "feat(digitalhuman): provider interface + stub + REST submit/result with tests"
```

---

### Task 2: 后端接线（config + main.go + .env.example）

**Files:**
- Modify: `backend/internal/config/config.go`
- Modify: `backend/cmd/server/main.go`
- Modify: `.env.example`

**Interfaces:**
- Consumes: Task 1 的 `digitalhuman.Config`、`digitalhuman.NewProvider`、`digitalhuman.RegisterRoutes`
- Produces: `config.Config` 新增字段 `DigitalHumanProvider/DigitalHumanAPIKey/DigitalHumanSecret/DigitalHumanAvatarID/DigitalHumanVoice`；main.go 按 speech 同款模式构造 provider

- [ ] **Step 1: config.go 增加字段**

`backend/internal/config/config.go` 的 `Config` struct 增加：

```go
	DigitalHumanProvider string
	DigitalHumanAPIKey   string
	DigitalHumanSecret   string
	DigitalHumanAvatarID string
	DigitalHumanVoice    string
```

`Load()` 内、`AliyunNLSAppKey` 之后增加：

```go
		DigitalHumanProvider: os.Getenv("DIGITAL_HUMAN_PROVIDER"),
		DigitalHumanAPIKey:   os.Getenv("DIGITAL_HUMAN_API_KEY"),
		DigitalHumanSecret:   os.Getenv("DIGITAL_HUMAN_SECRET"),
		DigitalHumanAvatarID: os.Getenv("DIGITAL_HUMAN_AVATAR_ID"),
		DigitalHumanVoice:    os.Getenv("DIGITAL_HUMAN_VOICE"),
```

- [ ] **Step 2: .env.example 增加配置项**

`.env.example`（仓库根）末尾追加：

```text
# 数字人视频生成（空 = 禁用，前端自动降级 TTS 播报）
DIGITAL_HUMAN_PROVIDER=
DIGITAL_HUMAN_API_KEY=
DIGITAL_HUMAN_SECRET=
DIGITAL_HUMAN_AVATAR_ID=
DIGITAL_HUMAN_VOICE=
```

- [ ] **Step 3: main.go 接线**

`backend/cmd/server/main.go` 在 speechClient 初始化块之后、`svc := interview.NewService(...)` 之前插入：

```go
	var dhProvider digitalhuman.Provider
	if cfg.DigitalHumanProvider != "" {
		dhProvider, err = digitalhuman.NewProvider(digitalhuman.Config{
			ProviderName: cfg.DigitalHumanProvider,
			APIKey:       cfg.DigitalHumanAPIKey,
			Secret:       cfg.DigitalHumanSecret,
			AvatarID:     cfg.DigitalHumanAvatarID,
			Voice:        cfg.DigitalHumanVoice,
		})
		if err != nil {
			log.Fatalf("digital human provider: %v", err)
		}
		log.Println("digital human provider enabled")
	} else {
		log.Println("warning: DIGITAL_HUMAN_PROVIDER not set; /api/digital-human/videos return 503")
	}
```

import 块加入 `"github.com/interview-assistant/backend/internal/digitalhuman"`（按字母序放在 `db` 之后、`expression` 之前）。

`ws.RegisterRoutes(r, svc, cfg.JWTSecret)` 之前注册路由：

```go
	digitalhuman.RegisterRoutes(r, cfg.JWTSecret, dhProvider)
```

- [ ] **Step 4: 编译验证**

Run: `cd backend && go build ./... && go vet ./cmd/... ./internal/digitalhuman/...`
Expected: 无输出（编译通过）

- [ ] **Step 5: Commit**

```bash
git add backend/internal/config/config.go backend/cmd/server/main.go .env.example
git commit -m "feat(digitalhuman): wire provider into server via env config"
```

---

### Task 3: 前端 API 客户端

**Files:**
- Create: `frontend/src/api/digitalHuman.ts`

**Interfaces:**
- Consumes: `frontend/src/api/client.ts` 的 `ApiError`、`getApiBase`、`getToken`
- Produces:
  - `interface VideoTaskResult { status: 'pending' | 'processing' | 'completed' | 'failed'; videoURL?: string }`
  - `submitVideo(text: string): Promise<{ taskId: string }>`
  - `getVideoTask(taskId: string): Promise<VideoTaskResult>`

- [ ] **Step 1: 实现 API 客户端**

`frontend/src/api/digitalHuman.ts`（完整内容，`readError` 与 `speech.ts` 同款私有 helper）：

```ts
import { ApiError, getApiBase, getToken } from './client';

async function readError(res: Response): Promise<ApiError> {
  let message = res.statusText || 'Request failed';
  try {
    const data = (await res.json()) as unknown;
    if (data && typeof data === 'object' && 'error' in data) {
      message = String((data as { error: unknown }).error);
    }
  } catch {
    // Keep the status text when the response is not JSON.
  }
  return new ApiError(res.status, message);
}

export interface VideoTaskResult {
  status: 'pending' | 'processing' | 'completed' | 'failed';
  videoURL?: string;
}

export async function submitVideo(text: string): Promise<{ taskId: string }> {
  const token = getToken();
  const res = await fetch(`${getApiBase()}/api/digital-human/videos`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    throw await readError(res);
  }
  return (await res.json()) as { taskId: string };
}

export async function getVideoTask(taskId: string): Promise<VideoTaskResult> {
  const token = getToken();
  const res = await fetch(
    `${getApiBase()}/api/digital-human/videos/${encodeURIComponent(taskId)}`,
    { headers: token ? { Authorization: `Bearer ${token}` } : undefined },
  );
  if (!res.ok) {
    throw await readError(res);
  }
  return (await res.json()) as VideoTaskResult;
}
```

- [ ] **Step 2: 构建验证**

Run: `cd frontend && npm run build`
Expected: `tsc -b` + `vite build` 通过

- [ ] **Step 3: Commit**

```bash
git add frontend/src/api/digitalHuman.ts
git commit -m "feat(frontend): digital human video API client"
```

---

### Task 4: VideoPersona / UserCamera 组件 + CSS + spec 摄像头修正

**Files:**
- Create: `frontend/src/components/VideoPersona.tsx`
- Create: `frontend/src/components/UserCamera.tsx`
- Modify: `frontend/src/pages/InterviewPages.css`（`@keyframes persona-listen` 之后、`.virtual-persona-avatar-btn` 附近追加视频样式块）
- Modify: `docs/superpowers/specs/2026-08-18-video-persona-design.md`（6.2 摄像头一行修正）

**Interfaces:**
- Consumes: 无外部依赖（纯组件 + CSS tokens）
- Produces:
  - `export type VideoPersonaState = 'generating' | 'playing' | 'ended'`
  - `VideoPersona` props：`{ state: VideoPersonaState; videoUrl?: string | null; question?: string; muted?: boolean; onVideoEnded?: () => void; onToggleMute?: () => void; onSkip?: () => void }`
  - `UserCamera`：无 props，返回 `<div className="video-persona-cam">` 或 `null`

**spec 修正说明：** 锁定决策原本写 `getUserMedia({ video: true, audio: true })` 并复用音频流给录音。实现采用**仅视频轨** `getUserMedia({ video: true })`：录音保持现有「按次申请麦克风」路径（`voiceRecorder.ts` 零改动、零回归风险），且用户不会被重复弹麦克风授权。音频作答链路完全不变，符合设计意图。

- [ ] **Step 1: 实现 VideoPersona 组件**

`frontend/src/components/VideoPersona.tsx`（完整内容）：

```tsx
import { useEffect, useRef } from 'react';

export type VideoPersonaState = 'generating' | 'playing' | 'ended';

interface VideoPersonaProps {
  state: VideoPersonaState;
  videoUrl?: string | null;
  /** 题目全文，显示在视频下方作为字幕 */
  question?: string;
  muted?: boolean;
  onVideoEnded?: () => void;
  onToggleMute?: () => void;
  onSkip?: () => void;
}

export default function VideoPersona({
  state,
  videoUrl,
  question,
  muted = false,
  onVideoEnded,
  onToggleMute,
  onSkip,
}: VideoPersonaProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // 静音切换只影响音量，不暂停视频（取消静音可继续听）
  useEffect(() => {
    const el = videoRef.current;
    if (el) el.muted = muted;
  }, [muted]);

  if (state === 'generating') {
    return (
      <div className="video-persona video-persona--generating" aria-label="面试官正在生成问题">
        <div className="video-persona-screen">
          <img className="video-persona-waiting" src="/persona-default.png" alt="" />
          <span className="video-persona-label">正在生成问题…</span>
        </div>
      </div>
    );
  }

  return (
    <div className={`video-persona video-persona--${state}`} aria-label="面试官视频">
      <div className="video-persona-screen">
        <video
          ref={videoRef}
          className="video-persona-video"
          src={videoUrl ?? undefined}
          autoPlay
          playsInline
          muted={muted}
          onEnded={onVideoEnded}
        />
        {state === 'playing' && (
          <div className="video-persona-controls">
            <button type="button" className="video-persona-btn" onClick={onToggleMute}>
              {muted ? '取消静音' : '静音'}
            </button>
            <button type="button" className="video-persona-btn" onClick={onSkip}>
              跳过
            </button>
          </div>
        )}
      </div>
      {question && <p className="video-persona-subtitle">{question}</p>}
    </div>
  );
}
```

- [ ] **Step 2: 实现 UserCamera 组件**

`frontend/src/components/UserCamera.tsx`（完整内容）：

```tsx
import { useEffect, useRef, useState } from 'react';

/** 本地摄像头小窗：仅视频轨、不上传；拒绝/无摄像头时静默隐藏。 */
export default function UserCamera() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    if (!navigator.mediaDevices?.getUserMedia) return;
    let cancelled = false;
    async function start() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) videoRef.current.srcObject = stream;
        setEnabled(true);
      } catch {
        // 拒绝授权 / 无摄像头 → 静默降级，不打扰面试
      }
    }
    void start();
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, []);

  if (!enabled) return null;

  return (
    <div className="video-persona-cam">
      <video ref={videoRef} autoPlay muted playsInline aria-label="你的摄像头画面" />
      <button
        type="button"
        className="video-persona-cam-off"
        onClick={() => {
          streamRef.current?.getTracks().forEach((t) => t.stop());
          streamRef.current = null;
          setEnabled(false);
        }}
      >
        关闭摄像头
      </button>
    </div>
  );
}
```

- [ ] **Step 3: CSS**

`frontend/src/pages/InterviewPages.css`，在 `@keyframes persona-listen { ... }` 之后追加（复用既有 tokens：`--space-*`、`--text-caption`、`--color-*`、`--rounded-lg`、`--color-hairline-strong`）：

```css
/* V14 数字人视频面试官 */
.video-persona-stage {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-xs);
  margin-bottom: var(--space-md);
}

.video-persona {
  width: min(640px, 100%);
  display: flex;
  flex-direction: column;
  gap: var(--space-xs);
}

.video-persona-screen {
  position: relative;
  aspect-ratio: 16 / 9;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #000;
  border-radius: var(--rounded-lg);
  overflow: hidden;
}

.video-persona-video {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.video-persona-waiting {
  width: 120px;
  height: 120px;
  border-radius: 50%;
  object-fit: contain;
  background: var(--color-canvas-soft);
  animation: persona-listen 3s ease-in-out infinite;
}

.video-persona-label {
  position: absolute;
  bottom: var(--space-sm);
  left: 0;
  right: 0;
  text-align: center;
  font: var(--text-caption);
  color: var(--color-mute);
  background: rgba(0, 0, 0, 0.45);
  padding: 2px 0;
}

.video-persona-subtitle {
  margin: 0;
  padding: 0 var(--space-sm);
  font: var(--text-body);
  color: var(--color-ink);
  text-align: center;
}

.video-persona-controls {
  position: absolute;
  right: 8px;
  bottom: 8px;
  display: flex;
  gap: 8px;
}

.video-persona-btn {
  font: var(--text-caption);
  color: #fff;
  background: rgba(0, 0, 0, 0.55);
  border: none;
  border-radius: var(--rounded-full);
  padding: 4px 10px;
  cursor: pointer;
}

.video-persona-cam {
  position: absolute;
  right: 12px;
  bottom: 12px;
  width: 25%;
  max-width: 200px;
  border: 2px solid var(--color-hairline-strong);
  border-radius: var(--rounded-lg);
  overflow: hidden;
  background: #000;
  z-index: 1;
}

.video-persona-cam video {
  width: 100%;
  display: block;
}

.video-persona-cam-off {
  position: absolute;
  top: 4px;
  right: 4px;
  font: var(--text-caption);
  color: #fff;
  background: rgba(0, 0, 0, 0.55);
  border: none;
  border-radius: var(--rounded-full);
  padding: 2px 8px;
  cursor: pointer;
}
```

- [ ] **Step 4: spec 摄像头行修正**

`docs/superpowers/specs/2026-08-18-video-persona-design.md` 第 6.2 节，将：

```text
- 进入 voice 模式时 `getUserMedia({ video: true, audio: true })`；音频流供现有录音使用
```

改为：

```text
- 进入 voice 模式时 `getUserMedia({ video: true })`（仅视频轨，本地预览不上传）；录音仍走现有「按次申请麦克风」路径，音频作答链路零改动
```

- [ ] **Step 5: 构建验证**

Run: `cd frontend && npm run build`
Expected: `tsc -b` + `vite build` 通过

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/VideoPersona.tsx frontend/src/components/UserCamera.tsx frontend/src/pages/InterviewPages.css docs/superpowers/specs/2026-08-18-video-persona-design.md
git commit -m "feat(frontend): video persona + local camera components with styles"
```

---

### Task 5: 房间页接入（视频提问流 + 降级 + 双画面渲染）

**Files:**
- Modify: `frontend/src/pages/InterviewRoomPage.tsx`

**Interfaces:**
- Consumes: Task 1 REST（经 Task 3 `submitVideo`/`getVideoTask`）、Task 4 `VideoPersona`/`UserCamera`、现有 `VirtualPersona`/`playQuestion`/`toggleMute`
- Produces: 房间页新状态与函数（仅本任务内使用）：
  - `videoState: 'none' | 'generating' | 'playing' | 'ended'`、`videoUrl: string | null`、`videoUnavailableRef`（本场数字人不可用 → 后续直接 TTS）
  - `playQuestionVideo(content)`、`pollVideoTask(taskId, version)`、`handleVideoEnded()`、`handleVideoSkip()`、`handleVideoToggleMute()`

- [ ] **Step 1: import 与状态/常量**

`frontend/src/pages/InterviewRoomPage.tsx`：

import 块（`VirtualPersona` 之后）加：

```ts
import VideoPersona from '../components/VideoPersona';
import UserCamera from '../components/UserCamera';
import { getVideoTask, submitVideo } from '../api/digitalHuman';
```

状态区（`avatarUrl` 之后）加：

```ts
  const [videoState, setVideoState] = useState<'none' | 'generating' | 'playing' | 'ended'>('none');
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
```

ref 区（`mountedRef` 附近）加：

```ts
  const videoUnavailableRef = useRef(false);
```

`RETRY_DELAYS` 定义附近加：

```ts
  const VIDEO_POLL_INTERVAL_MS = 3000;
  const VIDEO_MAX_POLL_ATTEMPTS = 40; // 3s × 40 = 120s 上限
```

- [ ] **Step 2: 轮询与视频播放函数**

`handleSkipPlayback` 定义之后加：

```ts
  async function pollVideoTask(taskId: string, version: number): Promise<string | null> {
    for (let i = 0; i < VIDEO_MAX_POLL_ATTEMPTS; i++) {
      await new Promise((r) => setTimeout(r, VIDEO_POLL_INTERVAL_MS));
      if (version !== speechVersionRef.current) return null;
      const res = await getVideoTask(taskId);
      if (version !== speechVersionRef.current) return null;
      if (res.status === 'completed' && res.videoURL) return res.videoURL;
      if (res.status === 'failed') return null;
    }
    return null; // 超时
  }

  const playQuestionVideo = useCallback(
    async (content: string) => {
      if (ttsMutedRef.current) return;
      const version = ++speechVersionRef.current;
      setVideoState('generating');
      setVideoUrl(null);
      setStatusLine('正在生成问题…');
      try {
        const { taskId } = await submitVideo(content);
        if (version !== speechVersionRef.current) return;
        const url = await pollVideoTask(taskId, version);
        if (version !== speechVersionRef.current) return;
        if (url) {
          setVideoUrl(url);
          setVideoState('playing');
          setStatusLine('');
          return;
        }
      } catch (err) {
        if (version !== speechVersionRef.current) return;
        if (err instanceof ApiError && err.status === 503) {
          videoUnavailableRef.current = true; // 本场数字人不可用，后续直接 TTS
        }
      }
      // 失败/超时 → 降级 TTS 播报（V13 行为）
      setVideoState('none');
      setVideoUrl(null);
      void playQuestion(content);
    },
    [playQuestion],
  );

  const handleVideoEnded = useCallback(() => {
    // 播完停在最后一帧（videoState='ended'），字幕保留
    setVideoState('ended');
    setStatusLine('');
  }, []);

  const handleVideoSkip = useCallback(() => {
    speechVersionRef.current += 1; // 取消进行中的轮询
    setVideoState('none');
    setVideoUrl(null);
    setStatusLine('');
  }, []);

  const handleVideoToggleMute = useCallback(() => {
    const next = !ttsMutedRef.current;
    ttsMutedRef.current = next;
    setTtsMuted(next);
    setStatusLine(next ? '已静音' : '');
  }, []);
```

- [ ] **Step 3: handleMessage 提问分支改走视频**

`handleMessage` 内 `case 'question': case 'follow_up':` 分支中，将：

```ts
            if (inputModeRef.current === 'voice') {
              void playQuestion(msg.content);
            }
```

改为：

```ts
            if (inputModeRef.current === 'voice') {
              if (videoUnavailableRef.current) {
                void playQuestion(msg.content);
              } else {
                void playQuestionVideo(msg.content);
              }
            }
```

（`handleMessage` 的依赖数组加 `playQuestionVideo`。）

- [ ] **Step 4: personaState 映射 effect 改为视频优先**

将现有：

```ts
  useEffect(() => {
    if (reading) setPersonaState('speaking');
    else if (thinking) setPersonaState('listening');
    else setPersonaState('idle');
  }, [reading, thinking]);
```

改为：

```ts
  useEffect(() => {
    if (videoState !== 'none') return; // 视频模式由 VideoPersona 接管渲染
    if (reading) setPersonaState('speaking');
    else if (thinking) setPersonaState('listening');
    else setPersonaState('idle');
  }, [videoState, reading, thinking]);
```

- [ ] **Step 5: 切文字模式时取消视频流**

在 `effectiveInputMode` effect（`useEffect(() => { inputModeRef.current = effectiveInputMode; }, [effectiveInputMode]);`）之后加：

```ts
  useEffect(() => {
    if (effectiveInputMode === 'text' && videoState !== 'none') {
      speechVersionRef.current += 1;
      setVideoState('none');
      setVideoUrl(null);
      setStatusLine('');
    }
  }, [effectiveInputMode, videoState]);
```

- [ ] **Step 6: 渲染双画面 + 视频期间隐藏 TTS 控件**

将现有 voice 模式渲染块：

```tsx
            {effectiveInputMode === 'voice' && (
              <div className="virtual-persona-area">
                <VirtualPersona state={personaState} avatarUrl={avatarUrl} />
                <label className="virtual-persona-avatar-btn">
                  换头像
                  <input type="file" accept="image/*" onChange={handleAvatarChange} hidden />
                </label>
              </div>
            )}
```

改为：

```tsx
            {effectiveInputMode === 'voice' && (
              <div className="video-persona-stage">
                {videoState !== 'none' ? (
                  <VideoPersona
                    state={videoState}
                    videoUrl={videoUrl}
                    question={currentQuestionRef.current ?? ''}
                    muted={ttsMuted}
                    onVideoEnded={handleVideoEnded}
                    onToggleMute={handleVideoToggleMute}
                    onSkip={handleVideoSkip}
                  />
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

视频播放期间隐藏 TTS 控件（静音/重播/跳过由视频浮层接管）：将 `voice-room-tts-controls` 所在 `<div>` 的渲染条件从 `effectiveInputMode === 'voice' ?` 分支内的无条件渲染，改为仅当 `videoState === 'none'` 时渲染：

```tsx
                      {videoState === 'none' && (
                        <div className="voice-room-tts-controls">
                          ...
                        </div>
                      )}
```

（仅把外层 `<div className="voice-room-tts-controls">…</div>` 包进 `{videoState === 'none' && (…)}`，内部三个按钮不动。）

- [ ] **Step 7: 录音按钮在视频生成/播放期间禁用**

录音按钮 `disabled` 属性（`thinking || disconnected || ending || …` 那串）末尾加：

```ts
                          videoState === 'generating' ||
                          videoState === 'playing'
```

即完整为：

```ts
                        disabled={
                          thinking ||
                          disconnected ||
                          ending ||
                          voicePhase === 'transcribing' ||
                          voicePhase === 'sending' ||
                          videoState === 'generating' ||
                          videoState === 'playing'
                        }
```

- [ ] **Step 8: 构建验证**

Run: `cd frontend && npm run build`
Expected: `tsc -b` + `vite build` 通过

- [ ] **Step 9: Commit**

```bash
git add frontend/src/pages/InterviewRoomPage.tsx
git commit -m "feat(room): video persona question flow with TTS fallback and camera window"
```

---

### Task 6: 回归验证 + spec 状态更新

**Files:**
- Modify: `docs/superpowers/specs/2026-08-18-video-persona-design.md`

**Interfaces:**
- Consumes: 全部前置任务

- [ ] **Step 1: 后端全量测试**

Run: `cd backend && go test ./... -count=1 -p 1`
Expected: 全绿（含新增 digitalhuman 10 个用例；speech/expression/ws 等无回归）

- [ ] **Step 2: 前端构建**

Run: `cd frontend && npm run build`
Expected: 通过

- [ ] **Step 3: 前端 lint**

Run: `cd frontend && npm run lint`
Expected: 通过（如原有告警则保持不新增）

- [ ] **Step 4: 冒烟清单（手动，记录结果到 commit message 或另行说明）**

- 后端未配 `DIGITAL_HUMAN_PROVIDER` 启动 → 日志出现 warning；房间 voice 模式提问显示「正在生成问题…」后约数秒内自动降级 TTS 播报（503 → `videoUnavailableRef` 置位 → 后续题目直接 TTS）
- 摄像头授权 → 右下角出现小窗；拒绝/无摄像头 → 无小窗且面试正常
- 视频（stub 下无法真实生成，验证降级路径即可；待服务商 Key 就绪后按 Task 1 注释实现 Provider 再验 `playing` 路径）
- text 模式不显示视频区与摄像头

- [ ] **Step 5: spec 状态更新并提交**

`docs/superpowers/specs/2026-08-18-video-persona-design.md` 顶部 `**Status:**` 改为 `Implemented`，并 commit：

```bash
git add docs/superpowers/specs/2026-08-18-video-persona-design.md
git commit -m "docs(v14): mark spec implemented"
```

---

## Self-review

- [x] **Spec coverage:** 决策表逐项有对应 Task——Provider 抽象（T1）、REST（T1）、config/main 接线（T2）、降级 503→TTS（T1 handler + T5 Step 3/2）、轮询 120s（T5 Step 2）、双画面（T4+T5 Step 6）、字幕（T4+T5 Step 6）、只口播当前问题（T5 Step 3）、升级 voice 模式（T5）、视频只播一遍/停在最后一帧（T4 ended + T5 handleVideoEnded）、无 DB 迁移（T1 无 DB）、spec 摄像头行修正（T4 Step 4）、回归（T6）
- [x] **Placeholder scan:** 无 TBD/TODO；stub provider 是明确的设计决策（未配置即降级），非占位符；服务商接入在 Task 1 注释中显式标注为账号开通后的后续实现
- [x] **Type consistency:** `Status` 常量、`Provider` 签名、`RegisterRoutes(r, secret, provider)`、`submitVideo`/`getVideoTask`/`VideoTaskResult`、`VideoPersonaState`、`videoState` 联合类型、`personaState` 保持三态不变——前后任务一致；`speechVersionRef` 作为轮询取消令牌的语义在 T5 Step 2/3/5/9 与卸载处一致
