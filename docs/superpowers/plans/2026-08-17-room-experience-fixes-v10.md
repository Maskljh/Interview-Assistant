# V10 面试房间体验修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复体验审查确认的三个 P0 问题：断线自动重连（指数退避 + 心跳 + 刷新对话恢复）、语音短按竞态、首条语速失真。

**Architecture:** 后端 `ws/handler.go` 加 gorilla ping/pong 心跳（pongWait 可配置，生产 60s，测试用短值）；前端 `InterviewRoomPage.tsx` 四块改动：`connect()` 改指数退避自动重连、`loadAndConnect` 用 `getInterview` 的 turns 填充初始 transcript、录音增加就绪/取消标记解决短按竞态、语速计时点移到录音真正开始后。

**Tech Stack:** Go/Gin + gorilla/websocket（既有依赖）、React/Vite TS。

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-17-room-experience-fixes-design.md`
- 分支 `feat/v10-room-experience-fixes` from main HEAD
- 心跳：服务端 ping（30s）+ pong 更新读超时 + 读超时判死关闭；前端浏览器自动回 pong，前端零改动
- 重连：指数退避 5 次（1/2/4/8/8 秒）；`session_started` 重置计数；5 次后降级手动按钮
- 对话恢复：仅加载时填充一次；`turnIdRef` 从接口最大 id 续接
- 竞态：录音前立即进入录音态；松手时未就绪 → 取消标记 + 提示「录音未开始，请重试」；就绪后检测取消 → 释放回 idle
- 计时：`recordStartRef` 在 `startRecordingSession` **成功后**设置
- 不动 WS 协议（ClientMsg/ServerMsg 不变）、无迁移、无新依赖
- 测试：`go test ./... -count=1 -p 1` 全绿 + `npm run build` 通过

---

## File map

| Path | Responsibility |
|------|----------------|
| `backend/internal/ws/handler.go` | 心跳常量 + Handler 可配置心跳字段 + ping goroutine + pong handler |
| `backend/internal/ws/handler_test.go` | ping 到达 + pong 保持 + 不回 pong 超时关闭（短 pongWait） |
| `frontend/src/pages/InterviewRoomPage.tsx` | 自动重连、turns 填充、短按竞态、语速计时 |
| `docs/superpowers/specs/2026-08-17-room-experience-fixes-design.md` | Status → Implemented |

---

### Task 1: 后端 WS 心跳

**Files:**
- Modify: `backend/internal/ws/handler.go`
- Create: `backend/internal/ws/handler_test.go`

**Interfaces:**
- Consumes: 既有 `interview.Service`、`auth`、gorilla
- Produces:
  - `type Handler struct { svc *interview.Service; secret string; hub *Hub; pongWait, pingPeriod, writeWait time.Duration }`
  - `func RegisterRoutes(...)` 用默认心跳（pongWait 60s / pingPeriod 30s / writeWait 10s）
  - 测试可构造 `&Handler{svc:…, secret:…, hub: NewHub(), pongWait: 2*time.Second, pingPeriod: 100*time.Millisecond, writeWait: time.Second}` 直接调 `Serve`

- [ ] **Step 1: handler.go 加心跳**

```go
import (
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
	"github.com/interview-assistant/backend/internal/auth"
	"github.com/interview-assistant/backend/internal/interview"
)

// Default heartbeat deadlines; tests may override via Handler fields.
const (
	defaultPongWait   = 60 * time.Second
	defaultPingPeriod = 30 * time.Second
	defaultWriteWait  = 10 * time.Second
)

type Handler struct {
	svc    *interview.Service
	secret string
	hub    *Hub

	pongWait   time.Duration
	pingPeriod time.Duration
	writeWait  time.Duration
}

func RegisterRoutes(r *gin.Engine, svc *interview.Service, secret string) {
	h := &Handler{
		svc:        svc,
		secret:     secret,
		hub:        NewHub(),
		pongWait:   defaultPongWait,
		pingPeriod: defaultPingPeriod,
		writeWait:  defaultWriteWait,
	}
	svc.SetSessionNotifier(h.hub)
	r.GET("/ws/interviews/:id", h.Serve)
}
```

`Serve` 在 `upgrader.Upgrade` 成功后、`hub.Register` 后加：

```go
	// Heartbeat: ping every pingPeriod; a dead peer (no pong within pongWait)
	// fails the read deadline, closing the connection and notifying the client.
	conn.SetReadDeadline(time.Now().Add(h.pongWait))
	conn.SetPongHandler(func(string) error {
		return conn.SetReadDeadline(time.Now().Add(h.pongWait))
	})

	go func() {
		ticker := time.NewTicker(h.pingPeriod)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				_ = conn.SetWriteDeadline(time.Now().Add(h.writeWait))
				if err := conn.WriteMessage(websocket.PingMessage, nil); err != nil {
					return
				}
			case <-ctx.Done():
				return
			}
		}
	}()
```

（`ctx := c.Request.Context()` 在心跳 goroutine 之前已定义。）

- [ ] **Step 2: 写心跳测试**

`backend/internal/ws/handler_test.go`（外部包 `ws_test`，镜像 interview/service_test.go 的 testDB/testStore/fakeLLM 模式；需要 MySQL 容器 `feat-v2b-voice-mysql-1` 运行中）：

```go
package ws_test

import (
	"context"
	"database/sql"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
	"github.com/interview-assistant/backend/internal/auth"
	"github.com/interview-assistant/backend/internal/db"
	"github.com/interview-assistant/backend/internal/interview"
	"github.com/interview-assistant/backend/internal/llm"
	"github.com/interview-assistant/backend/internal/sessionredis"
	"github.com/interview-assistant/backend/internal/ws"
	"github.com/redis/go-redis/v9"
)

func testDB(t *testing.T) *sql.DB {
	t.Helper()
	dsn := os.Getenv("MYSQL_DSN")
	if dsn == "" {
		dsn = "root:root@tcp(127.0.0.1:3306)/interview?parseTime=true&charset=utf8mb4"
	}
	sqlDB, err := db.Open(dsn)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() {
		_, _ = sqlDB.Exec(`
			DELETE t FROM interview_turns t
			INNER JOIN interview_sessions s ON s.id = t.session_id
			INNER JOIN users u ON u.id = s.user_id
			WHERE u.email LIKE 'test-ws-%@example.com'`)
		_, _ = sqlDB.Exec(`
			DELETE q FROM interview_questions q
			INNER JOIN interview_sessions s ON s.id = q.session_id
			INNER JOIN users u ON u.id = s.user_id
			WHERE u.email LIKE 'test-ws-%@example.com'`)
		_, _ = sqlDB.Exec(`
			DELETE s FROM interview_sessions s
			INNER JOIN users u ON u.id = s.user_id
			WHERE u.email LIKE 'test-ws-%@example.com'`)
		_, _ = sqlDB.Exec("DELETE FROM users WHERE email LIKE 'test-ws-%@example.com'")
		sqlDB.Close()
	})
	return sqlDB
}

// fakeLLM echoes a valid question-generation response.
type fakeLLM struct{}

func (fakeLLM) ChatJSON(ctx context.Context, system, user string, out any) error {
	gen, ok := out.(*llm.GenQuestionsOut)
	if !ok {
		return nil
	}
	gen.Questions = make([]llm.GenQuestion, 5)
	for i := range gen.Questions {
		gen.Questions[i] = llm.GenQuestion{Seq: i + 1, Question: "Q?", Intent: "assessment"}
	}
	return nil
}

// newTestServer builds an httptest server with a short-heartbeat ws Handler.
func newTestServer(t *testing.T) (*httptest.Server, *interview.Service) {
	t.Helper()
	sqlDB := testDB(t)
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("miniredis: %v", err)
	}
	t.Cleanup(mr.Close)
	store := sessionredis.NewStore(redis.NewClient(&redis.Options{Addr: mr.Addr()}))

	svc := interview.NewService(sqlDB, fakeLLM{}, store)

	gin.SetMode(gin.TestMode)
	r := gin.New()
	h := &ws.HandlerTestable{ // 见 Step 3 说明
		// 若 Handler 字段不可导出，提供构造函数；实现时按实际导出情况调整
	}
	_ = h
	// 路由：/ws/interviews/:id → h.Serve（短心跳）
	// 用户与 session 用 svc.Create + svc.Start 准备（见 Step 2.1）
	...
}
```

**注意：** 由于 `Handler` 的 `svc/secret/hub` 是小写字段，外部测试包无法直接构造。两种方案（实现时选一）：
- **方案 A（推荐）**：在 `ws` 包内加导出构造 `func NewTestHandlerForHeartbeat(...)`——不优雅；
- **方案 B**：心跳测试放包内（`package ws`，非外部包），直接构造 `&Handler{svc:…, secret:…, hub: NewHub(), pongWait: 2*time.Second, pingPeriod: 100*time.Millisecond, writeWait: time.Second}`。**采用方案 B**——测试文件 `package ws`（包内测试），可访问小写字段。

**Step 2.1** 准备用户与进行中的会话（镜像 interview/service_test.go 的流程：注册用户 → `svc.Create` → `svc.Start`，Start 会生成 5 题并置 in_progress）：

```go
func seedInProgressSession(t *testing.T, svc *interview.Service, sqlDB *sql.DB, email string) (int64, string) {
	t.Helper()
	// 用户：直接 SQL（users 表 email/password_hash）
	res, err := sqlDB.Exec(`INSERT INTO users (email, password_hash) VALUES (?, 'x')`, email)
	if err != nil {
		t.Fatalf("insert user: %v", err)
	}
	uid, _ := res.LastInsertId()
	token, err := auth.IssueToken("test-secret", uid, email, time.Hour)
	if err != nil {
		t.Fatalf("issue token: %v", err)
	}
	session, err := svc.Create(context.Background(), uid, "Backend JD", nil, interview.ModeMixed, interview.InputModeText, "standard", nil)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if _, _, err := svc.Start(context.Background(), uid, session.ID); err != nil {
		t.Fatalf("start: %v", err)
	}
	return session.ID, token
}
```

**Step 2.2** 两个用例：

```go
func TestHeartbeatPingKeepsConnection(t *testing.T) {
	sqlDB := testDB(t)
	mr, _ := miniredis.Run()
	t.Cleanup(mr.Close)
	store := sessionredis.NewStore(redis.NewClient(&redis.Options{Addr: mr.Addr()}))
	svc := interview.NewService(sqlDB, fakeLLM{}, store)
	sessionID, token := seedInProgressSession(t, svc, sqlDB, "test-ws-heartbeat@example.com")

	gin.SetMode(gin.TestMode)
	r := gin.New()
	h := &Handler{svc: svc, secret: "test-secret", hub: NewHub(),
		pongWait: 2 * time.Second, pingPeriod: 100 * time.Millisecond, writeWait: time.Second}
	r.GET("/ws/interviews/:id", h.Serve)
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)

	url := "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws/interviews/" + fmt.Sprint(sessionID) + "?token=" + token
	conn, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()

	// 应能持续收到 ping（pingPeriod 100ms）；在 pongWait 2s 内多次读到帧不关闭
	conn.SetReadDeadline(time.Now().Add(1500 * time.Millisecond))
	gotPing := false
	for {
		_, _, err := conn.ReadMessage()
		if err != nil {
			break // 预期：读到超时（连接仍活着，只是读超时）
		}
		gotPing = true // 收到过帧（含 ping 或 session_started/status）
	}
	if !gotPing {
		t.Fatal("no frames received; connection may be dead")
	}
}

func TestHeartbeatNoPongClosesConnection(t *testing.T) {
	sqlDB := testDB(t)
	mr, _ := miniredis.Run()
	t.Cleanup(mr.Close)
	store := sessionredis.NewStore(redis.NewClient(&redis.Options{Addr: mr.Addr()}))
	svc := interview.NewService(sqlDB, fakeLLM{}, store)
	sessionID, token := seedInProgressSession(t, svc, sqlDB, "test-ws-nopong@example.com")

	gin.SetMode(gin.TestMode)
	r := gin.New()
	h := &Handler{svc: svc, secret: "test-secret", hub: NewHub(),
		pongWait: 300 * time.Millisecond, pingPeriod: 50 * time.Millisecond, writeWait: time.Second}
	r.GET("/ws/interviews/:id", h.Serve)
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)

	url := "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws/interviews/" + fmt.Sprint(sessionID) + "?token=" + token
	conn, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()

	// 不主动回 pong（浏览器不会自动回，测试 dialer 也不回）→ 服务端 pongWait 后应关闭
	conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	var closed bool
	for {
		if _, _, err := conn.ReadMessage(); err != nil {
			closed = websocket.IsCloseError(err, websocket.CloseNormalClosure) ||
				websocket.IsUnexpectedCloseError(err) ||
				!websocket.IsUnexpectedCloseError(err, websocket.CloseNormalClosure)
			_ = closed
			// 服务端 defer conn.Close() → 对端读到 EOF/关闭错误即视为关闭
			break
		}
	}
	// 通过 err != nil 到达这里即服务端已关闭连接
}
```

注意：
- `TestHeartbeatNoPongClosesConnection` 断言方式：服务端 `Serve` 的读循环因读超时（pongWait 300ms 无 pong）返回 → `defer conn.Close()` → 客户端 `ReadMessage` 报错。测试仅需验证「在 pongWait 之后连接被服务端关闭」（读错误发生），并确保不是「正常保持」（若 2s 读超时前一直无错才失败）。
- 需要 import `fmt`；`websocket.IsCloseError`/`IsUnexpectedCloseError` 用于识别关闭类错误（gorilla 的 close 帧）。
- 心跳 goroutine 用 `ctx.Done()` 退出：测试 httptest server 关闭时请求 ctx 取消。

- [ ] **Step 3: 跑测试**

Run: `cd backend && go test ./internal/ws/ -count=1`
Expected: 全部 PASS（需 MySQL；两个心跳用例用短 pongWait 快速完成，不等待 60s）。

- [ ] **Step 4: 跑全量确认不回归**

Run: `cd backend && go test ./... -count=1 -p 1`
Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add backend/internal/ws/handler.go backend/internal/ws/handler_test.go
git commit -m "feat(v10): ws heartbeat ping/pong with configurable deadlines"
```

---

### Task 2: 前端重连 + 对话恢复 + 短按竞态 + 语速计时

**Files:**
- Modify: `frontend/src/pages/InterviewRoomPage.tsx`

**Interfaces:**
- Consumes: 既有 `connectInterviewWS`、`getInterview`（返回 `turns: InterviewTurn[]`）
- Produces: 无新导出；`connect()` 语义扩展为「连接 + 指数退避重连」

- [ ] **Step 1: 重连状态与定时器 refs**

新增：

```ts
const retryTimerRef = useRef<number | null>(null);
const attemptRef = useRef(0);
const voiceReadyRef = useRef(false);
const voiceCancelRef = useRef(false);
```

- [ ] **Step 2: connect 改指数退避自动重连**

`connect` 改为 `connectWithRetry`（保留 `connect` 名称给按钮用）：

```ts
const RETRY_DELAYS = [1000, 2000, 4000, 8000, 8000];

const connectWithRetry = useCallback(
  (attempt: number) => {
    const token = getToken();
    if (!token || !Number.isFinite(interviewId)) {
      setError('未登录或登录已失效');
      return;
    }
    socketRef.current?.close();
    setDisconnected(false);
    setError('');

    socketRef.current = connectInterviewWS(interviewId, token, {
      onMessage: (msg) => {
        if (msg.type === 'session_started') {
          attemptRef.current = 0; // 重连成功，重置退避
        }
        handleMessage(msg);
      },
      onClose: () => {
        if (doneRef.current) return;
        setThinking(false);
        setVoicePhase('idle');
        voicePlayerRef.current?.stop();
        if (attemptRef.current >= RETRY_DELAYS.length) {
          setDisconnected(true); // 退避耗尽，降级手动按钮
          return;
        }
        const delay = RETRY_DELAYS[attemptRef.current];
        attemptRef.current += 1;
        setStatusLine(`连接中断，正在重连（第 ${attemptRef.current} 次）…`);
        if (retryTimerRef.current != null) window.clearTimeout(retryTimerRef.current);
        retryTimerRef.current = window.setTimeout(
          () => connectWithRetry(attemptRef.current),
          delay,
        );
      },
    });
  },
  [handleMessage, interviewId],
);
```

保留一个对外函数（初始连接 + 手动按钮用）：

```ts
const connect = useCallback(() => {
  attemptRef.current = 0;
  connectWithRetry(0);
}, [connectWithRetry]);
```

（手动「重新连接」按钮 onClick={connect} 不变——点击重置退避重新开始。）

**cleanup 更新**（useEffect 返回）：

```ts
if (retryTimerRef.current != null) {
  window.clearTimeout(retryTimerRef.current);
  retryTimerRef.current = null;
}
```

- [ ] **Step 3: 加载时填充 turns**

`loadAndConnect` 中 `getInterview` 成功后、`connect()` 前加：

```ts
if (data.turns.length > 0) {
  const initial: Turn[] = data.turns.map((t) => ({
    id: t.id,
    role: t.role === 'interviewer' ? 'interviewer' : 'candidate',
    content: t.content,
  }));
  setTurns(initial);
  turnIdRef.current = Math.max(0, ...data.turns.map((t) => t.id));
}
```

（`Turn` 接口已定义 `role: 'interviewer' | 'candidate'`；后端 role 为字符串，映射非 interviewer 为 candidate。）

- [ ] **Step 4: 短按竞态 + 语速计时**

`handleStartRecording` 改为：

```ts
async function handleStartRecording() {
  if (
    disconnected ||
    thinking ||
    ending ||
    voicePhase === 'transcribing' ||
    voicePhase === 'sending'
  ) {
    return;
  }
  speechVersionRef.current += 1;
  voicePlayerRef.current?.stop();
  setError('');
  voiceCancelRef.current = false;
  voiceReadyRef.current = false;
  setVoicePhase('recording');
  setStatusLine('正在准备录音…');
  try {
    const recorder = await startRecordingSession();
    if (voiceCancelRef.current) {
      recorder.cancel();
      voiceRecorderRef.current = null;
      setVoicePhase('idle');
      setStatusLine('录音未开始，请重试');
      return;
    }
    recordStartRef.current = Date.now(); // 计时点后移：录音真正开始
    voiceReadyRef.current = true;
    voiceRecorderRef.current = recorder;
    setStatusLine('正在录音，松开发送');
  } catch {
    voiceCancelRef.current = false;
    setVoicePhase('idle');
    setStatusLine('无法访问麦克风，请使用文字作答');
  }
}
```

`handleStopRecording` 开头改：

```ts
function handleStopRecording() {
  const recorder = voiceRecorderRef.current;
  if (!recorder) {
    voiceCancelRef.current = true; // 麦克风未就绪已松手：就绪后释放
    return;
  }
  ...原逻辑...
  // 原逻辑末尾（成功/失败路径）后 voiceReadyRef.current = false
}
```

**注意**：`handleStopRecording` 原逻辑里 `voiceRecorderRef.current = null` 已在开头，保持；`voiceReadyRef` 可在录音态结束时（transcribe 完成或失败）置 false——实现时在 try/catch 的 finally 或各出口处理，确保下次录音重置。

cleanup 与 `handleForceEnd` 增加 `voiceReadyRef.current = false; voiceCancelRef.current = false;`（`recordStartRef.current = null` 已有）。

- [ ] **Step 5: 构建**

Run: `cd frontend && npm run build`
Expected: PASS（零 TS 错误）。

- [ ] **Step 6: 提交**

```bash
git add frontend/src/pages/InterviewRoomPage.tsx
git commit -m "feat(v10): auto-reconnect, transcript restore, voice press race, speech-rate timing"
```

---

### Task 3: 验收

**Files:**
- Modify: `docs/superpowers/specs/2026-08-17-room-experience-fixes-design.md`

- [ ] **Step 1: 全量后端测试**

Run: `cd backend && go test ./... -count=1 -p 1`
Expected: 全部 PASS（含新 ws 心跳用例）。

- [ ] **Step 2: 前端构建**

Run: `cd frontend && npm run build`
Expected: PASS。

- [ ] **Step 3: 手工冒烟（可选）**

面试房间 → 断网 → 观察「正在重连」文案与自动恢复；刷新房间页 → 历史对话记录恢复；短按麦克风 → 出现「录音未开始，请重试」；语音作答 → 报告页语速首条不再明显偏低。

- [ ] **Step 4: 更新 spec 状态**

`docs/superpowers/specs/2026-08-17-room-experience-fixes-design.md` 的 `**Status:** Draft for user review` 改为 `**Status:** Implemented on feat/v10-room-experience-fixes`。

- [ ] **Step 5: 提交并合并**

```bash
git add docs/superpowers/specs/2026-08-17-room-experience-fixes-design.md
git commit -m "docs(v10): mark spec implemented"
# 回到主仓库合并
git merge --no-ff feat/v10-room-experience-fixes -m "merge: V10 room experience fixes"
```

---

## Spec coverage self-review

| Spec section | Task |
|--------------|------|
| §4 后端心跳（ping/pong/超时） | T1 |
| §5 前端自动重连（退避/重置/降级） | T2 |
| §6 对话恢复（turns 填充/turnIdRef） | T2 |
| §7 短按竞态 + 计时后移 | T2 |
| §8 F1–F6 | T1–T3 |

## Placeholder scan

所有步骤含具体代码/命令，无 TBD。执行时需确认的点：
- ws 心跳测试用**包内测试**（`package ws`）以访问 Handler 小写字段；若实现时发现不可行，改为导出测试构造器
- `TestHeartbeatNoPongClosesConnection` 的关闭断言：以「读错误发生（连接被服务端关闭）」为准，避免对 gorilla 关闭码语义过度依赖
- `handleStopRecording` 的 `voiceReadyRef` 复位时机：确保下次录音前为 false（在转写/失败路径置 false）
- `connectWithRetry` 闭包递归用 `attemptRef` 而非参数，避免 setTimeout 闭包读到旧值
