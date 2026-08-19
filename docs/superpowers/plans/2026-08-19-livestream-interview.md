# V15 实时视频面试 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 voice 模式中引入实时数字人视频流：进入面试即建立实时会话，收到题目驱动面试官开口，服务商未配置时自动回退 V14 预生成视频/TTS。

**Architecture:** 后端新增 `internal/livestream` 抽象层（Provider/Session 接口 + stub + REST），前端新增 `LivestreamPersona` 组件并在房间页接入。stub Provider 返回模拟流地址，前端跑通完整实时闭环；服务商接入时只填 Provider 实现 + `.env`。

**Tech Stack:** Go (gin) + React/TypeScript (vite)。前端沿用 V14 的 `.video-persona-*` 样式。

## Global Constraints

- 零 DB 改动（会话不落库，内存 map 持有，跟随面试生命周期）
- 不新增 `video` 第三输入模式；只升级现有 voice 模式
- 摄像头保持本地预览（`UserCamera` 不变），不上传
- 服务商未配置/失败 → 回退 V14（`playQuestionVideo` → `playQuestion`），面试不中断
- `.env` 新增：`LIVESTREAM_PROVIDER`（默认 `stub`）、`LIVESTREAM_STREAM_URL`（stub 模拟流地址）
- 后端模块名 `github.com/interview-assistant/backend`；鉴权用 `auth.Middleware(secret)` / `auth.IssueToken`
- 前端 API base 用 `getApiBase()`（`client.ts`），请求头带 `Authorization: Bearer <token>`
- 分支 `feat/v15-livestream`（从 main HEAD 创建；当前工作区有未提交改动，任务提交时只 add 相关文件）

---

### Task 1: 后端 livestream 包 —— Provider/Session 接口 + Config + stub

**Files:**
- Create: `backend/internal/livestream/provider.go`
- Create: `backend/internal/livestream/provider_stub.go`
- Test: `backend/internal/livestream/provider_test.go`

**Interfaces:**
- Consumes: 无（新建包）
- Produces:
  - `type Config struct { ProviderName string; APIKey string; Secret string; AvatarID string; StreamURL string }`
  - `type Session interface { StreamURL() string; Speak(ctx context.Context, text string) error; Close() error }`
  - `type Provider interface { StartSession(ctx context.Context, avatarID string) (Session, error) }`
  - `func NewProvider(cfg Config) (Provider, error)` —— 空 ProviderName 返回 `(nil, nil)`；`"stub"` 返回 stub；其余返回错误
  - `var ErrNotConfigured = errors.New("livestream provider not configured")`

- [ ] **Step 1: 写失败的测试**

`backend/internal/livestream/provider_test.go`:

```go
package livestream_test

import (
	"context"
	"errors"
	"testing"

	"github.com/interview-assistant/backend/internal/livestream"
)

func TestNewProviderEmptyIsNil(t *testing.T) {
	p, err := livestream.NewProvider(livestream.Config{ProviderName: ""})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if p != nil {
		t.Fatalf("provider = %v, want nil", p)
	}
}

func TestNewProviderStub(t *testing.T) {
	p, err := livestream.NewProvider(livestream.Config{
		ProviderName: "stub",
		StreamURL:    "https://example.com/stream.mp4",
	})
	if err != nil {
		t.Fatalf("new provider: %v", err)
	}
	sess, err := p.StartSession(context.Background(), "")
	if err != nil {
		t.Fatalf("start session: %v", err)
	}
	if sess.StreamURL() != "https://example.com/stream.mp4" {
		t.Fatalf("streamURL = %q", sess.StreamURL())
	}
	if err := sess.Speak(context.Background(), "请介绍一下你自己"); err != nil {
		t.Fatalf("speak: %v", err)
	}
	if err := sess.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
}

func TestStubStartWithoutStreamURLErrors(t *testing.T) {
	p, err := livestream.NewProvider(livestream.Config{ProviderName: "stub"})
	if err != nil {
		t.Fatalf("new provider: %v", err)
	}
	_, err = p.StartSession(context.Background(), "")
	if !errors.Is(err, livestream.ErrNotConfigured) {
		t.Fatalf("err = %v, want ErrNotConfigured", err)
	}
}

func TestNewProviderUnsupported(t *testing.T) {
	_, err := livestream.NewProvider(livestream.Config{ProviderName: "vendor"})
	if err == nil {
		t.Fatal("expected error for unsupported provider")
	}
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd backend && go test ./internal/livestream/ -v`
Expected: FAIL（`livestream` 包不存在）

- [ ] **Step 3: 实现 provider.go**

`backend/internal/livestream/provider.go`:

```go
package livestream

import (
	"context"
	"errors"
	"fmt"
)

// ErrNotConfigured 表示实时数字人服务商未配置（或 stub 未设流地址），
// 调用方（handler/前端）应降级到 V14 预生成视频/TTS。
var ErrNotConfigured = errors.New("livestream provider not configured")

type Config struct {
	ProviderName string
	APIKey       string
	Secret       string
	AvatarID     string
	StreamURL    string
}

// Session 代表一场实时数字人会话。StreamURL 供前端 <video> 播放，
// Speak 驱动面试官口播文本。
type Session interface {
	StreamURL() string
	Speak(ctx context.Context, text string) error
	Close() error
}

// Provider 创建实时数字人会话。
type Provider interface {
	StartSession(ctx context.Context, avatarID string) (Session, error)
}

// NewProvider 按配置构造 Provider。ProviderName 为空时返回 (nil, nil)，
// 由调用方降级。服务商（腾讯云数智人 / 讯飞智作等）开通后，新增一个
// Provider 实现（例如 provider_vendor.go）并在本 switch 注册。
func NewProvider(cfg Config) (Provider, error) {
	if cfg.ProviderName == "" {
		return nil, nil
	}
	switch cfg.ProviderName {
	case "stub":
		return &stubProvider{streamURL: cfg.StreamURL}, nil
	default:
		return nil, fmt.Errorf("livestream provider %q not supported", cfg.ProviderName)
	}
}
```

- [ ] **Step 4: 实现 provider_stub.go**

`backend/internal/livestream/provider_stub.go`:

```go
package livestream

import "context"

// stubProvider 返回配置的模拟流地址，Speak/Close 为 no-op。
// 无 LIVESTREAM_STREAM_URL 时 StartSession 返回 ErrNotConfigured，
// 便于前端验证降级路径。
type stubProvider struct {
	streamURL string
}

func (p *stubProvider) StartSession(ctx context.Context, avatarID string) (Session, error) {
	if p.streamURL == "" {
		return nil, ErrNotConfigured
	}
	return &stubSession{streamURL: p.streamURL}, nil
}

type stubSession struct {
	streamURL string
}

func (s *stubSession) StreamURL() string { return s.streamURL }

func (s *stubSession) Speak(ctx context.Context, text string) error { return nil }

func (s *stubSession) Close() error { return nil }
```

- [ ] **Step 5: 运行测试确认通过**

Run: `cd backend && go test ./internal/livestream/ -v`
Expected: PASS（4 个测试全过）

- [ ] **Step 6: 提交**

```bash
git add backend/internal/livestream/provider.go backend/internal/livestream/provider_stub.go backend/internal/livestream/provider_test.go
git commit -m "feat(livestream): provider/session interfaces + stub"
```

---

### Task 2: 后端 livestream REST handlers + 测试

**Files:**
- Create: `backend/internal/livestream/handler.go`
- Test: `backend/internal/livestream/handler_test.go`

**Interfaces:**
- Consumes: Task 1 的 `livestream.Provider`、`livestream.Session`、`livestream.ErrNotConfigured`
- Produces:
  - `func RegisterRoutes(r *gin.Engine, secret string, provider Provider)` —— 挂载 `POST /api/livestream/sessions`、`POST /api/livestream/sessions/:id/speak`、`POST /api/livestream/sessions/:id/close`（均带 JWT）
  - 建会话成功返回 `{"sessionId":"...","streamURL":"..."}`；未配置/失败 → 503；speak 失败 → 502；未知会话 → 404

- [ ] **Step 1: 写失败的测试**

`backend/internal/livestream/handler_test.go`:

```go
package livestream_test

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
	"github.com/interview-assistant/backend/internal/livestream"
)

type fakeSession struct {
	streamURL string
	speakErr  error
	closed    bool
}

func (f *fakeSession) StreamURL() string { return f.streamURL }
func (f *fakeSession) Speak(ctx context.Context, text string) error { return f.speakErr }
func (f *fakeSession) Close() error { f.closed = true; return nil }

type fakeProvider struct {
	session  livestream.Session
	startErr error
}

func (f *fakeProvider) StartSession(ctx context.Context, avatarID string) (livestream.Session, error) {
	return f.session, f.startErr
}

func testRouter(p livestream.Provider) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	livestream.RegisterRoutes(r, "test-secret", p)
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

func postSession(t *testing.T, r *gin.Engine) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/livestream/sessions", bytes.NewBufferString(`{}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", authHeader(t))
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	return rec
}

func createAndGetID(t *testing.T, r *gin.Engine) string {
	t.Helper()
	rec := postSession(t, r)
	if rec.Code != http.StatusOK {
		t.Fatalf("create status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var resp struct {
		SessionID string `json:"sessionId"`
		StreamURL string `json:"streamURL"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.SessionID == "" || resp.StreamURL == "" {
		t.Fatalf("sessionId=%q streamURL=%q, both must be non-empty", resp.SessionID, resp.StreamURL)
	}
	return resp.SessionID
}

func postSpeak(t *testing.T, r *gin.Engine, id, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/livestream/sessions/"+id+"/speak", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", authHeader(t))
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	return rec
}

func postClose(t *testing.T, r *gin.Engine, id string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/livestream/sessions/"+id+"/close", nil)
	req.Header.Set("Authorization", authHeader(t))
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	return rec
}

func TestCreateUnavailableWhenProviderNil(t *testing.T) {
	rec := postSession(t, testRouter(nil))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
}

func TestCreateProviderError(t *testing.T) {
	r := testRouter(&fakeProvider{startErr: errors.New("vendor down")})
	rec := postSession(t, r)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
}

func TestCreateReturnsSession(t *testing.T) {
	r := testRouter(&fakeProvider{session: &fakeSession{streamURL: "https://example.com/stream.mp4"}})
	createAndGetID(t, r) // 内含 200 + 非空校验
}

func TestSpeakOK(t *testing.T) {
	r := testRouter(&fakeProvider{session: &fakeSession{streamURL: "https://example.com/stream.mp4"}})
	id := createAndGetID(t, r)
	rec := postSpeak(t, r, id, `{"text":"请介绍一下你自己"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
}

func TestSpeakEmptyText(t *testing.T) {
	r := testRouter(&fakeProvider{session: &fakeSession{streamURL: "https://example.com/stream.mp4"}})
	id := createAndGetID(t, r)
	rec := postSpeak(t, r, id, `{"text":"  "}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
}

func TestSpeakUnknownSession(t *testing.T) {
	r := testRouter(&fakeProvider{session: &fakeSession{streamURL: "https://example.com/stream.mp4"}})
	rec := postSpeak(t, r, "does-not-exist", `{"text":"hi"}`)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
}

func TestSpeakProviderError(t *testing.T) {
	r := testRouter(&fakeProvider{session: &fakeSession{streamURL: "https://example.com/stream.mp4", speakErr: errors.New("speak down")}})
	id := createAndGetID(t, r)
	rec := postSpeak(t, r, id, `{"text":"hi"}`)
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
}

func TestCloseRemovesSession(t *testing.T) {
	r := testRouter(&fakeProvider{session: &fakeSession{streamURL: "https://example.com/stream.mp4"}})
	id := createAndGetID(t, r)
	if rec := postClose(t, r, id); rec.Code != http.StatusOK {
		t.Fatalf("close status = %d, body = %s", rec.Code, rec.Body.String())
	}
	rec := postSpeak(t, r, id, `{"text":"hi"}`)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("speak after close = %d, want 404", rec.Code)
	}
}

func TestUnauthorized(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/api/livestream/sessions", bytes.NewBufferString(`{}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	testRouter(nil).ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd backend && go test ./internal/livestream/ -v`
Expected: FAIL（`handler` 未定义 `RegisterRoutes`）

- [ ] **Step 3: 实现 handler.go**

`backend/internal/livestream/handler.go`:

```go
package livestream

import (
	"crypto/rand"
	"encoding/hex"
	"net/http"
	"strings"
	"sync"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	"github.com/interview-assistant/backend/internal/auth"
)

const maxSpeakTextRunes = 1000

func RegisterRoutes(r *gin.Engine, secret string, provider Provider) {
	h := &handler{provider: provider, sessions: make(map[string]Session)}
	protected := r.Group("/api/livestream")
	protected.Use(auth.Middleware(secret))
	protected.POST("/sessions", h.Create)
	protected.POST("/sessions/:id/speak", h.Speak)
	protected.POST("/sessions/:id/close", h.Close)
}

type handler struct {
	provider Provider
	mu       sync.Mutex
	sessions map[string]Session
}

type createResponse struct {
	SessionID string `json:"sessionId"`
	StreamURL string `json:"streamURL"`
}

func (h *handler) Create(c *gin.Context) {
	if h.provider == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "livestream service unavailable"})
		return
	}
	sess, err := h.provider.StartSession(c.Request.Context(), "")
	if err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "livestream service unavailable"})
		return
	}
	sessionID := randomID()
	h.mu.Lock()
	h.sessions[sessionID] = sess
	h.mu.Unlock()
	c.JSON(http.StatusOK, createResponse{SessionID: sessionID, StreamURL: sess.StreamURL()})
}

type speakRequest struct {
	Text string `json:"text"`
}

func (h *handler) Speak(c *gin.Context) {
	id := c.Param("id")
	if id == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "id is required"})
		return
	}
	sess, ok := h.lookup(id)
	if !ok {
		c.JSON(http.StatusNotFound, gin.H{"error": "session not found"})
		return
	}
	var req speakRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request"})
		return
	}
	if strings.TrimSpace(req.Text) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "text is required"})
		return
	}
	if utf8.RuneCountInString(req.Text) > maxSpeakTextRunes {
		c.JSON(http.StatusBadRequest, gin.H{"error": "text is too long"})
		return
	}
	if err := sess.Speak(c.Request.Context(), req.Text); err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": "livestream speak failed"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (h *handler) Close(c *gin.Context) {
	id := c.Param("id")
	if id == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "id is required"})
		return
	}
	h.mu.Lock()
	sess, ok := h.sessions[id]
	if ok {
		delete(h.sessions, id)
	}
	h.mu.Unlock()
	if !ok {
		c.JSON(http.StatusNotFound, gin.H{"error": "session not found"})
		return
	}
	_ = sess.Close()
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (h *handler) lookup(id string) (Session, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	s, ok := h.sessions[id]
	return s, ok
}

func randomID() string {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		return "session"
	}
	return hex.EncodeToString(b)
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd backend && go test ./internal/livestream/ -v`
Expected: PASS（provider 4 个 + handler 9 个）

- [ ] **Step 5: 提交**

```bash
git add backend/internal/livestream/handler.go backend/internal/livestream/handler_test.go
git commit -m "feat(livestream): REST handlers for sessions/speak/close"
```

---

### Task 3: 后端接线 —— config + main.go + .env

**Files:**
- Modify: `backend/internal/config/config.go:21-25`（Config 字段）、`:44-48`（加载）
- Modify: `backend/cmd/server/main.go`（import + provider 构造 + RegisterRoutes）
- Modify: `.env`（新增两行）

**Interfaces:**
- Consumes: Task 1 的 `livestream.NewProvider` / `livestream.Config`；Task 2 的 `livestream.RegisterRoutes`
- Produces: `config.Config` 新增 `LivestreamProvider string`、`LivestreamStreamURL string`

- [ ] **Step 1: config.go 加字段**

`backend/internal/config/config.go` 的 `Config` struct 追加（`DigitalHumanVoice` 之后）：

```go
	LivestreamProvider    string
	LivestreamStreamURL   string
```

`Load()` 的 cfg 赋值追加：

```go
		LivestreamProvider:    os.Getenv("LIVESTREAM_PROVIDER"),
		LivestreamStreamURL:   os.Getenv("LIVESTREAM_STREAM_URL"),
```

- [ ] **Step 2: main.go 接线**

`backend/cmd/server/main.go`：

- import 增加：`"github.com/interview-assistant/backend/internal/livestream"`
- `digitalhuman` 块之后（约第 83 行后）插入：

```go
	var lsProvider livestream.Provider
	if cfg.LivestreamProvider != "" {
		lsProvider, err = livestream.NewProvider(livestream.Config{
			ProviderName: cfg.LivestreamProvider,
			StreamURL:    cfg.LivestreamStreamURL,
		})
		if err != nil {
			log.Fatalf("livestream provider: %v", err)
		}
		log.Println("livestream provider enabled")
	} else {
		log.Println("warning: LIVESTREAM_PROVIDER not set; /api/livestream/sessions return 503")
	}
```

- 路由注册处（`digitalhuman.RegisterRoutes(...)` 之后）插入：

```go
	livestream.RegisterRoutes(r, cfg.JWTSecret, lsProvider)
```

- [ ] **Step 3: .env 加配置**

`.env` 末尾追加（stub 用 MDN 公开示例视频，可随时替换为真实服务商流地址）：

```
LIVESTREAM_PROVIDER=stub
LIVESTREAM_STREAM_URL=https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4
```

- [ ] **Step 4: 构建 + 全量测试**

Run: `cd backend && go build ./... && go test ./...`
Expected: 构建成功，全部测试 PASS（`go vet` 无报错）

- [ ] **Step 5: 提交**

```bash
git add backend/internal/config/config.go backend/cmd/server/main.go .env
git commit -m "feat(livestream): wire provider into server via env config"
```

---

### Task 4: 前端 API client

**Files:**
- Create: `frontend/src/api/livestream.ts`

**Interfaces:**
- Consumes: `getApiBase()` / `getToken()`（`../api/client`）
- Produces:
  - `interface LivestreamSession { sessionId: string; streamURL: string }`
  - `createLivestreamSession(): Promise<LivestreamSession>`
  - `speakLivestream(sessionId: string, text: string): Promise<void>`
  - `closeLivestream(sessionId: string): Promise<void>`

- [ ] **Step 1: 实现 client（仿 digitalHuman.ts 风格）**

`frontend/src/api/livestream.ts`:

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

export interface LivestreamSession {
  sessionId: string;
  streamURL: string;
}

export async function createLivestreamSession(): Promise<LivestreamSession> {
  const token = getToken();
  const res = await fetch(`${getApiBase()}/api/livestream/sessions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: '{}',
  });
  if (!res.ok) throw await readError(res);
  return (await res.json()) as LivestreamSession;
}

export async function speakLivestream(sessionId: string, text: string): Promise<void> {
  const token = getToken();
  const res = await fetch(
    `${getApiBase()}/api/livestream/sessions/${encodeURIComponent(sessionId)}/speak`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ text }),
    },
  );
  if (!res.ok) throw await readError(res);
}

export async function closeLivestream(sessionId: string): Promise<void> {
  const token = getToken();
  const res = await fetch(
    `${getApiBase()}/api/livestream/sessions/${encodeURIComponent(sessionId)}/close`,
    {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    },
  );
  if (!res.ok) throw await readError(res);
}
```

- [ ] **Step 2: 构建验证**

Run: `cd frontend && npm run build`
Expected: 构建成功（当前 dist 生效；仅验证类型/打包）

- [ ] **Step 3: 提交**

```bash
git add frontend/src/api/livestream.ts
git commit -m "feat(frontend): livestream API client"
```

---

### Task 5: 前端 LivestreamPersona 组件

**Files:**
- Create: `frontend/src/components/LivestreamPersona.tsx`

**Interfaces:**
- Consumes: 无（纯展示组件）
- Produces:
  - `interface LivestreamPersonaProps { streamURL: string; question?: string; speaking?: boolean; muted?: boolean; onToggleMute?: () => void; onReplay?: () => void; onSkip?: () => void }`
  - `export default function LivestreamPersona(props: LivestreamPersonaProps)`

- [ ] **Step 1: 实现组件（复用 .video-persona-* 样式）**

`frontend/src/components/LivestreamPersona.tsx`:

```tsx
import { useEffect, useRef } from 'react';

interface LivestreamPersonaProps {
  streamURL: string;
  /** 题目全文，显示在视频下方作为字幕 */
  question?: string;
  /** 是否正在口播（显示「正在提问…」标签） */
  speaking?: boolean;
  muted?: boolean;
  onToggleMute?: () => void;
  onReplay?: () => void;
  onSkip?: () => void;
}

export default function LivestreamPersona({
  streamURL,
  question,
  speaking = false,
  muted = false,
  onToggleMute,
  onReplay,
  onSkip,
}: LivestreamPersonaProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // 静音切换只影响音量，不暂停视频
  useEffect(() => {
    const el = videoRef.current;
    if (el) el.muted = muted;
  }, [muted]);

  return (
    <div className="video-persona video-persona--live" aria-label="实时面试官">
      <div className="video-persona-screen">
        <video
          ref={videoRef}
          className="video-persona-video"
          src={streamURL}
          autoPlay
          playsInline
          muted={muted}
          loop
        />
        {speaking && <span className="video-persona-label">正在提问…</span>}
        <div className="video-persona-controls">
          <button type="button" className="video-persona-btn" onClick={onToggleMute}>
            {muted ? '取消静音' : '静音'}
          </button>
          <button type="button" className="video-persona-btn" onClick={onReplay} disabled={!question}>
            重播
          </button>
          <button type="button" className="video-persona-btn" onClick={onSkip} disabled={!speaking}>
            跳过
          </button>
        </div>
      </div>
      {question && <p className="video-persona-subtitle">{question}</p>}
    </div>
  );
}
```

- [ ] **Step 2: 构建验证**

Run: `cd frontend && npm run build`
Expected: 构建成功

- [ ] **Step 3: 提交**

```bash
git add frontend/src/components/LivestreamPersona.tsx
git commit -m "feat(frontend): livestream persona component"
```

---

### Task 6: 房间页接入实时流程

**Files:**
- Modify: `frontend/src/pages/InterviewRoomPage.tsx`

**Interfaces:**
- Consumes: Task 4 的 `createLivestreamSession` / `speakLivestream` / `closeLivestream` / `LivestreamSession`；Task 5 的 `LivestreamPersona`
- Produces: 无（修改现有页面行为）

- [ ] **Step 1: import 与新增状态/refs**

`InterviewRoomPage.tsx`：

- import 追加：

```tsx
import LivestreamPersona from '../components/LivestreamPersona';
import {
  closeLivestream,
  createLivestreamSession,
  speakLivestream,
  type LivestreamSession,
} from '../api/livestream';
```

- state（`videoUrl` 声明之后）追加：

```tsx
  const [liveSession, setLiveSession] = useState<LivestreamSession | null>(null);
  const [liveSpeaking, setLiveSpeaking] = useState(false);
```

- refs（`videoUnavailableRef` 之后）追加：

```tsx
  const liveAvailableRef = useRef(false);
  const liveSessionRef = useRef<LivestreamSession | null>(null);
  const liveSpeakTimerRef = useRef<number | null>(null);
```

- [ ] **Step 2: 实时辅助函数**

在 `handleSkipPlayback` 定义之后追加：

```tsx
  const clearLiveSpeakTimer = useCallback(() => {
    if (liveSpeakTimerRef.current != null) {
      window.clearTimeout(liveSpeakTimerRef.current);
      liveSpeakTimerRef.current = null;
    }
  }, []);

  // 实时流无单题结束事件：按文本长度估算口播时长（约 4 字/秒），到时清除口播状态
  const estimateSpeakMs = (text: string) =>
    Math.min(30000, Math.max(3000, Math.ceil(text.length / 4) * 1000));

  const handleLiveSpeak = useCallback(
    (content: string) => {
      const session = liveSessionRef.current;
      if (!session) return;
      clearLiveSpeakTimer();
      setLiveSpeaking(true);
      void speakLivestream(session.sessionId, content).catch(() => {
        // 失败不阻塞：字幕仍在，可点「重播」重试
      });
      liveSpeakTimerRef.current = window.setTimeout(() => {
        setLiveSpeaking(false);
      }, estimateSpeakMs(content));
    },
    [clearLiveSpeakTimer],
  );

  const handleLiveReplay = useCallback(() => {
    const content = currentQuestionRef.current;
    if (content) void handleLiveSpeak(content);
  }, [handleLiveSpeak]);

  const handleLiveSkip = useCallback(() => {
    clearLiveSpeakTimer();
    setLiveSpeaking(false);
  }, [clearLiveSpeakTimer]);
```

- [ ] **Step 3: 进入面试建立会话**

在 `loadAndConnect` 内 `lastInterviewerMsgRef.current = lastInterviewerContent;` 之后、`connect();` 之前插入：

```tsx
        // 实时视频面试：进入即建会话；失败(503) → liveAvailable=false，回退 V14 流程
        if (data.input_mode === 'voice') {
          try {
            const session = await createLivestreamSession();
            if (cancelled) {
              void closeLivestream(session.sessionId).catch(() => {});
              return;
            }
            liveSessionRef.current = session;
            liveAvailableRef.current = true;
            setLiveSession(session);
          } catch {
            liveAvailableRef.current = false;
          }
        }
```

- [ ] **Step 4: WS question 走实时驱动**

`handleMessage` 的 `case 'question': case 'follow_up':` 内，将：

```tsx
            if (inputModeRef.current === 'voice') {
              if (videoUnavailableRef.current) {
                void playQuestion(msg.content);
              } else {
                void playQuestionVideo(msg.content);
              }
            }
```

替换为：

```tsx
            if (inputModeRef.current === 'voice') {
              if (liveAvailableRef.current) {
                void handleLiveSpeak(msg.content);
              } else if (videoUnavailableRef.current) {
                void playQuestion(msg.content);
              } else {
                void playQuestionVideo(msg.content);
              }
            }
```

并将 `handleMessage` 的依赖数组 `[appendTurn, interviewId, navigate, playQuestion, playQuestionVideo]` 改为 `[appendTurn, interviewId, navigate, playQuestion, playQuestionVideo, handleLiveSpeak]`。

- [ ] **Step 5: 文字切换与卸载清理**

将现有文字切换 effect（`effectiveInputMode === 'text' && videoState !== 'none'` 那个）替换为：

```tsx
  useEffect(() => {
    if (effectiveInputMode === 'text') {
      clearLiveSpeakTimer();
      setLiveSpeaking(false);
      if (videoState !== 'none') {
        speechVersionRef.current += 1;
        setVideoState('none');
        setVideoUrl(null);
        setStatusLine('');
      }
    }
  }, [effectiveInputMode, videoState, clearLiveSpeakTimer]);
```

组件卸载清理（`useEffect` 的 cleanup）中，`voicePlayerRef.current?.stop();` 之前插入：

```tsx
      clearLiveSpeakTimer();
      const session = liveSessionRef.current;
      liveSessionRef.current = null;
      liveAvailableRef.current = false;
      if (session) void closeLivestream(session.sessionId).catch(() => {});
```

`handleForceEnd` 中 `speechVersionRef.current += 1;` 之后插入：

```tsx
    clearLiveSpeakTimer();
    const session = liveSessionRef.current;
    liveSessionRef.current = null;
    liveAvailableRef.current = false;
    if (session) void closeLivestream(session.sessionId).catch(() => {});
```

- [ ] **Step 6: 舞台渲染分支**

将舞台渲染块（`effectiveInputMode === 'voice' &&` 那个 div 内的三态）替换为：

```tsx
                {liveSession ? (
                  <LivestreamPersona
                    streamURL={liveSession.streamURL}
                    question={currentQuestionRef.current ?? ''}
                    speaking={liveSpeaking}
                    muted={ttsMuted}
                    onToggleMute={handleVideoToggleMute}
                    onReplay={handleLiveReplay}
                    onSkip={handleLiveSkip}
                  />
                ) : videoState !== 'none' ? (
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
```

（`handleLiveSkip` 已存在，`VideoPersona` 分支不变；`onToggleMute` 复用具相同语义的 `handleVideoToggleMute`。）

- [ ] **Step 7: 构建验证**

Run: `cd frontend && npm run build`
Expected: 构建成功（若 tsc 报未使用变量等，按报错清理）

- [ ] **Step 8: 提交**

```bash
git add frontend/src/pages/InterviewRoomPage.tsx
git commit -m "feat(room): live video persona flow with V14 fallback"
```

---

### Task 7: 重建并端到端验证

**Files:** 无源码改动（构建 + 运行验证）

- [ ] **Step 1: 重建后端并重启**

Run（backend 目录）:
```bash
cd backend && go build -o ../server.exe ./cmd/server
```

重启 server.exe（沿用 9090 端口；`.env` 已含 `LIVESTREAM_PROVIDER=stub`）：
- 杀掉当前监听 9090 的进程（`netstat -ano | grep ':9090'` 找 PID，`taskkill //PID <pid> //F`）
- 从项目根目录后台启动：`nohup ./server.exe > backend.log 2>&1 &`（需 export `.env` 环境变量，或直接运行 `start_backend.ps1`）

验证：`curl -s http://localhost:9090/healthz` 返回 `{"ok":true}`。

- [ ] **Step 2: 用真实登录 token 验证 livestream API**

```bash
TOKEN=$(curl -s -X POST http://localhost:9090/api/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"smoke-test-9090@example.com","password":"password123"}' | python -c 'import sys,json;print(json.load(sys.stdin)["token"])')
curl -s -X POST http://localhost:9090/api/livestream/sessions -H "Authorization: Bearer $TOKEN"
```
Expected: `{"sessionId":"...","streamURL":"https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4"}`

再验证 speak 与 close：
```bash
SID=$(curl -s -X POST http://localhost:9090/api/livestream/sessions -H "Authorization: Bearer $TOKEN" | python -c 'import sys,json;print(json.load(sys.stdin)["sessionId"])')
curl -s -X POST http://localhost:9090/api/livestream/sessions/$SID/speak -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"text":"请介绍一下你自己"}'
curl -s -X POST http://localhost:9090/api/livestream/sessions/$SID/close -H "Authorization: Bearer $TOKEN"
```
Expected: 前两个 `{"ok":true}`，close 后对同一 session speak 返回 404。

- [ ] **Step 3: 重启前端并手工验证**

- `cd frontend && npm run build`
- 杀掉 5174 进程并重启：`nohup npm run preview > preview.log 2>&1 &`，`curl -s -o /dev/null -w "%{http_code}" http://localhost:5174/` 返回 200
- 浏览器打开 `http://localhost:5174`，登录后新建语音面试：
  1. 进入面试间 → 面试官区域播放实时流（flower.mp4 循环），出现字幕
  2. 收到题目 → 「正在提问…」标签出现，字幕显示题目全文，约题目字数/4 秒后标签消失
  3. 按住说话作答 → 流程与 V14 一致
  4. 「跳过」立即清除口播状态；「重播」重新驱动；「静音」只静音不打断
  5. 结束面试 → 正常进入报告页

- [ ] **Step 4: 验证降级路径**

临时把 `.env` 的 `LIVESTREAM_PROVIDER` 置空并重启后端，重复 Step 3 的 1-2：
Expected: 建会话 503 → 前端回退 V14（预生成视频生成中 → 播报/TTS），面试不中断。
验证后恢复 `LIVESTREAM_PROVIDER=stub` 并重启后端。

- [ ] **Step 5: 提交收尾**

确认所有代码已提交（`git status` 干净，仅保留此前未提交的工作区改动：`frontend/src/api/client.ts`、`UserCamera.tsx`、`InterviewPages.css`、`start.ps1`、`backend.log` 等不属于本特性的文件不提交）。

---

## Self-Review

**Spec coverage:**
- §5.1 Provider/Session 接口 + Config → Task 1 ✓
- §5.2 stub Provider（无流地址返回 ErrNotConfigured）→ Task 1 ✓
- §5.3 REST handlers（建会话/speak/close、503/502/404、JWT）→ Task 2 ✓
- §5.4 main.go 接线 + .env → Task 3 ✓
- §6.1 前端 API client → Task 4 ✓
- §6.2 LivestreamPersona 组件 → Task 5 ✓
- §6.3 房间页（建会话/驱动开口/口播估算/静音/关闭清理/渲染分支）→ Task 6 ✓
- §6.4 渲染分支（liveAvailable 时 LivestreamPersona，否则 V14）→ Task 6 ✓
- §7 降级表（未配置 503、会话中断、speak 失败、静音）→ Task 6 + Task 7 Step 4 ✓
- §8 测试（handler 单测、前端构建、stub 手工闭环、503 降级）→ Task 2/7 ✓

**Placeholder scan:** 全部代码块为完整可粘贴实现，无 TBD/TODO。✓

**Type consistency:** `Session`/`Provider`/`Config`/`ErrNotConfigured`、`RegisterRoutes`、`createLivestreamSession`/`speakLivestream`/`closeLivestream`/`LivestreamSession`、`LivestreamPersonaProps` 在各任务间签名一致。✓
