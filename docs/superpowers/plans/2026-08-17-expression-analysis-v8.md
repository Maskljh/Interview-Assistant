# V8 语音表达分析 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 语音答案的录音时长随 WS 答案落库，报告页新增「表达分析」区（语速、口头禅、句长），纯规则计算无 LLM。

**Architecture:** 迁移 `007_voice_duration.sql` 给 `interview_turns` 加 `voice_duration_ms`；WS `ClientMsg` 加可选 `voice_duration_ms`，`HandleAnswer`→`AppendTurn` 落库；新增 `internal/expression` 模块（复用 `interview.Repo` 读 turns）挂 `GET /api/interviews/:id/expression`；前端录音开始记时间戳、语音提交带时长，ReportPage 加展示区。

**Tech Stack:** Go/Gin、MySQL（迁移 007）、WebSocket、React/Vite TS、既有 design tokens。

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-17-expression-analysis-design.md`
- 分支 `feat/v8-expression-analysis` from main HEAD
- 迁移 `backend/migrations/007_voice_duration.sql`：`ALTER TABLE interview_turns ADD COLUMN voice_duration_ms INT NULL;`
- **跑集成测试前先执行迁移**：`docker exec -i feat-v2b-voice-mysql-1 mysql -uroot -proot interview < backend/migrations/007_voice_duration.sql`（worktree 无 compose mysql；容器名 `feat-v2b-voice-mysql-1`）
- `voice_duration_ms` NULL = 文字答案或存量；文字答案不带时长
- 语速公式：`round(∑rune(答案) / (∑voice_duration_ms / 60000))`，仅统计 `voice_duration_ms` 非空答案轮次；无语音答案 → `speech_rate_cpm` 为 `null`（JSON null，Go 用 `*int`）
- 口头禅词表（`internal/expression` 单一来源）：`嗯、呃、那个、这个、然后、就是`；在**全部答案文本**（含文字）`strings.Count`，count>0 列出，按 count 降序
- 句长：按 `。！？.?!` 切分全部答案，平均 rune 数（四舍五入）；无句子 → 0
- `avg_answer_chars`：全部答案平均 rune 数（四舍五入）
- 归属校验：session 不存在或 `session.UserID != userID` → 404
- 空会话/无答案 → `available: true` + 零值（不报错）
- 评分口径（四维）不变；表达分析为附加展示
- 前端：语音提交带 `voice_duration_ms`，文字不带；ReportPage 展示失败静默；`npm run build` 通过

---

## File map

| Path | Responsibility |
|------|----------------|
| `backend/migrations/007_voice_duration.sql` | voice_duration_ms 列 |
| `backend/internal/ws/protocol.go` | `ClientMsg.VoiceDurationMs *int64` |
| `backend/internal/ws/handler.go` | 传时长给 HandleAnswer |
| `backend/internal/interview/models.go` | `Turn.VoiceDurationMs *int` |
| `backend/internal/interview/repo.go` | AppendTurn 加参数 + INSERT 列；ListTurns SELECT 列 + scan |
| `backend/internal/interview/service.go` | `HandleAnswer` 加 `voiceDurationMs *int64` 参数 + 内部 AppendTurn 调用 |
| `backend/internal/interview/handler.go` | `turnResponse.VoiceDurationMs` |
| `backend/internal/expression/service.go` | 计算逻辑 + `Analyze` |
| `backend/internal/expression/handler.go` | `RegisterRoutes` + `GET /:id/expression` |
| `backend/internal/expression/service_test.go` | 计算单测（语速/口头禅/句长/降级/隔离） |
| `backend/cmd/server/main.go` | `expression.RegisterRoutes(r, sqlDB, cfg.JWTSecret)` |
| `frontend/src/ws/interviewSocket.ts` | `sendAnswer(content, voiceDurationMs?)` |
| `frontend/src/pages/InterviewRoomPage.tsx` | 录音计时 + 语音提交带时长 |
| `frontend/src/api/expression.ts` | `ExpressionResult` + `fetchExpression` |
| `frontend/src/pages/ReportPage.tsx` | 表达分析展示区 |
| `docs/superpowers/specs/2026-08-17-expression-analysis-design.md` | Status → Implemented |

---

### Task 1: 迁移 + turns 时长列（repo/ws/interview 贯通）

**Files:**
- Create: `backend/migrations/007_voice_duration.sql`
- Modify: `backend/internal/ws/protocol.go`, `backend/internal/ws/handler.go`, `backend/internal/interview/models.go`, `repo.go`, `service.go`, `handler.go`

**Interfaces:**
- Consumes: 无
- Produces:
  - `ClientMsg.VoiceDurationMs *int64 \`json:"voice_duration_ms,omitempty"\``
  - `Turn.VoiceDurationMs *int`
  - `func (r *Repo) AppendTurn(sessionID int64, role, kind, content string, voiceDurationMs *int64) (int, error)`
  - `func (s *Service) HandleAnswer(ctx context.Context, userID, sessionID int64, content string, voiceDurationMs *int64) ([]OutboundMessage, error)`

- [ ] **Step 1: 写迁移文件**

```sql
-- backend/migrations/007_voice_duration.sql
ALTER TABLE interview_turns
  ADD COLUMN voice_duration_ms INT NULL;
```

- [ ] **Step 2: ws/protocol.go**

```go
type ClientMsg struct {
	Type            string `json:"type"`
	Content         string `json:"content"`
	VoiceDurationMs *int64 `json:"voice_duration_ms,omitempty"`
}
```

- [ ] **Step 3: ws/handler.go**

第 75 行调用改为：

```go
answerMsgs, err := h.svc.HandleAnswer(ctx, userID, sessionID, clientMsg.Content, clientMsg.VoiceDurationMs)
```

- [ ] **Step 4: interview/models.go**

```go
type Turn struct {
	...
	Content         string
	VoiceDurationMs *int
	CreatedAt       time.Time
}
```

- [ ] **Step 5: interview/repo.go**

`AppendTurn` 签名加 `voiceDurationMs *int64`，INSERT 加列：

```go
func (r *Repo) AppendTurn(sessionID int64, role, kind, content string, voiceDurationMs *int64) (int, error) {
	...
	_, err := r.db.Exec(
		`INSERT INTO interview_turns (session_id, seq, role, kind, content, voice_duration_ms) VALUES (?, ?, ?, ?, ?, ?)`,
		sessionID, seq, role, kind, content, voiceDurationMs,
	)
	return seq, err
}
```

（`*int64` 直接传参：Go 驱动对 nil 指针存 NULL。）

`ListTurns` SELECT 加 `voice_duration_ms` 列，scan 加：

```go
var voiceDurationMs sql.NullInt64
if err := rows.Scan(&t.ID, &t.SessionID, &t.Seq, &t.Role, &t.Kind, &t.Content, &voiceDurationMs, &t.CreatedAt); err != nil {
	return nil, err
}
if voiceDurationMs.Valid {
	v := int(voiceDurationMs.Int64)
	t.VoiceDurationMs = &v
}
```

- [ ] **Step 6: interview/service.go**

`HandleAnswer` 签名加 `voiceDurationMs *int64`；内部 `AppendTurn` 调用（约 332 行）改为：

```go
if _, err := s.repo.AppendTurn(sessionID, "candidate", "answer", content, voiceDurationMs); err != nil {
```

（其余 `AppendTurn` 调用点——question/follow_up 等 interviewer 轮次——传 `nil`，共约 3 处：272、344、373 行。）

- [ ] **Step 7: interview/handler.go**

`turnResponse` 加：

```go
VoiceDurationMs *int `json:"voice_duration_ms"`
```

`toSessionResponse` 的 turns 循环填 `VoiceDurationMs: t.VoiceDurationMs`。

- [ ] **Step 8: 跑迁移 + 测试**

```bash
docker exec -i feat-v2b-voice-mysql-1 mysql -uroot -proot interview < backend/migrations/007_voice_duration.sql
cd backend && go build ./... && go test ./internal/interview/ ./internal/ws/ -count=1
```

Expected: PASS（既有测试若因 AppendTurn 签名变化编译失败，给相关调用补 `nil`）。

- [ ] **Step 9: 提交**

```bash
git add backend/migrations/007_voice_duration.sql backend/internal/ws/ backend/internal/interview/
git commit -m "feat(v8): persist voice answer duration through WS to interview_turns"
```

---

### Task 2: expression 模块（service + handler + 路由 + 测试）

**Files:**
- Create: `backend/internal/expression/service.go`, `backend/internal/expression/handler.go`, `backend/internal/expression/service_test.go`
- Modify: `backend/cmd/server/main.go`

**Interfaces:**
- Consumes: `interview.Repo`（`GetByID`、`ListTurns`）、`auth.Middleware(secret)`
- Produces:
  - `type Fillers struct { Word string `json:"word"`; Count int `json:"count"` }`
  - `type Result struct { Available bool `json:"available"`; VoiceAnswers int `json:"voice_answers"`; TotalDurationMs int `json:"total_duration_ms"`; SpeechRateCPM *int `json:"speech_rate_cpm"`; Fillers []Fillers `json:"fillers"`; AvgAnswerChars int `json:"avg_answer_chars"`; AvgSentenceChars int `json:"avg_sentence_chars"` }`
  - `func NewService(repo *interview.Repo) *Service`
  - `func (s *Service) Analyze(ctx context.Context, userID, sessionID int64) (Result, error)`
  - `func RegisterRoutes(r *gin.Engine, db *sql.DB, secret string)` — `GET /api/interviews/:id/expression`

- [ ] **Step 1: 写 service.go**

```go
package expression

import (
	"context"
	"database/sql"
	"errors"
	"sort"
	"strings"

	"github.com/interview-assistant/backend/internal/interview"
)

var (
	ErrNotFound = errors.New("session not found")
)

// fillerWords are the preset filler phrases counted across candidate answers.
var fillerWords = []string{"嗯", "呃", "那个", "这个", "然后", "就是"}

type Fillers struct {
	Word  string `json:"word"`
	Count int    `json:"count"`
}

type Result struct {
	Available      bool     `json:"available"`
	VoiceAnswers   int      `json:"voice_answers"`
	TotalDurationMs int     `json:"total_duration_ms"`
	SpeechRateCPM  *int     `json:"speech_rate_cpm"`
	Fillers        []Fillers `json:"fillers"`
	AvgAnswerChars int      `json:"avg_answer_chars"`
	AvgSentenceChars int    `json:"avg_sentence_chars"`
}

type Service struct {
	repo *interview.Repo
}

func NewService(repo *interview.Repo) *Service {
	return &Service{repo: repo}
}

func (s *Service) Analyze(ctx context.Context, userID, sessionID int64) (Result, error) {
	session, err := s.repo.GetByID(sessionID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return Result{}, ErrNotFound
		}
		return Result{}, err
	}
	if session.UserID != userID {
		return Result{}, ErrNotFound
	}

	turns, err := s.repo.ListTurns(sessionID)
	if err != nil {
		return Result{}, err
	}

	var (
		answers        []string
		voiceChars     int
		totalDuration  int
		voiceAnswers   int
	)
	for _, t := range turns {
		if t.Role != "candidate" || t.Kind != "answer" {
			continue
		}
		answers = append(answers, t.Content)
		if t.VoiceDurationMs != nil {
			voiceAnswers++
			totalDuration += *t.VoiceDurationMs
			voiceChars += runeLen(t.Content)
		}
	}

	res := Result{
		Available:      true,
		VoiceAnswers:   voiceAnswers,
		TotalDurationMs: totalDuration,
		Fillers:        []Fillers{},
	}
	if voiceAnswers > 0 && totalDuration > 0 {
		rate := int(float64(voiceChars) / (float64(totalDuration) / 60000.0) + 0.5)
		res.SpeechRateCPM = &rate
	}

	fillerCounts := map[string]int{}
	for _, w := range fillerWords {
		for _, a := range answers {
			fillerCounts[w] += strings.Count(a, w)
		}
		if fillerCounts[w] > 0 {
			res.Fillers = append(res.Fillers, Fillers{Word: w, Count: fillerCounts[w]})
		}
	}
	sort.Slice(res.Fillers, func(i, j int) bool { return res.Fillers[i].Count > res.Fillers[j].Count })

	if len(answers) > 0 {
		totalChars := 0
		for _, a := range answers {
			totalChars += runeLen(a)
		}
		res.AvgAnswerChars = int(float64(totalChars)/float64(len(answers)) + 0.5)
		sentences := 0
		for _, a := range answers {
			sentences += countSentences(a)
		}
		if sentences > 0 {
			res.AvgSentenceChars = int(float64(totalChars)/float64(sentences) + 0.5)
		}
	}
	return res, nil
}

func runeLen(s string) int {
	return len([]rune(s))
}

func countSentences(s string) int {
	n := 0
	for _, r := range s {
		switch r {
		case '。', '！', '？', '.', '!', '?':
			n++
		}
	}
	return n
}
```

- [ ] **Step 2: 写 handler.go**

```go
package expression

import (
	"database/sql"
	"errors"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"github.com/interview-assistant/backend/internal/auth"
	"github.com/interview-assistant/backend/internal/interview"
)

type Handler struct {
	svc *Service
}

func NewHandler(repo *interview.Repo) *Handler {
	return &Handler{svc: NewService(repo)}
}

func RegisterRoutes(r *gin.Engine, db *sql.DB, secret string) {
	h := NewHandler(interview.NewRepo(db))
	protected := r.Group("/api/interviews")
	protected.Use(auth.Middleware(secret))
	protected.GET("/:id/expression", h.Get)
}

func (h *Handler) Get(c *gin.Context) {
	userID, ok := c.Get("userID")
	if !ok {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
		return
	}
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid id"})
		return
	}
	res, err := h.svc.Analyze(c.Request.Context(), userID.(int64), id)
	if errors.Is(err, ErrNotFound) {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not analyze expression"})
		return
	}
	c.JSON(http.StatusOK, res)
}
```

- [ ] **Step 3: main.go**

`expression.RegisterRoutes(r, sqlDB, cfg.JWTSecret)` 加在 `analysis.RegisterRoutes`（约 78 行）后；import `"github.com/interview-assistant/backend/internal/expression"`。

- [ ] **Step 4: 写测试**

`backend/internal/expression/service_test.go`（镜像 analytics 测试模式，email 前缀 `test-expression-%@example.com`）：

```go
package expression_test

import (
	"context"
	"database/sql"
	"os"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/interview-assistant/backend/internal/db"
	"github.com/interview-assistant/backend/internal/expression"
	"github.com/interview-assistant/backend/internal/interview"
	"github.com/interview-assistant/backend/internal/user"
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
			WHERE u.email LIKE 'test-expression-%@example.com'`)
		_, _ = sqlDB.Exec(`
			DELETE s FROM interview_sessions s
			INNER JOIN users u ON u.id = s.user_id
			WHERE u.email LIKE 'test-expression-%@example.com'`)
		_, _ = sqlDB.Exec("DELETE FROM users WHERE email LIKE 'test-expression-%@example.com'")
		sqlDB.Close()
	})
	return sqlDB
}

func registerUser(t *testing.T, sqlDB *sql.DB, email string) int64 {
	t.Helper()
	gin.SetMode(gin.TestMode)
	r := gin.New()
	user.RegisterRoutes(r, sqlDB, "test-secret")
	// ... 用 httptest POST /api/auth/register 取 user.id（镜像 analytics/service_test.go 的 registerUser）
	// 为简洁：直接 SQL 插入 users 并取 LastInsertId（users 表结构：email, password_hash, created_at）
	res, err := sqlDB.Exec(`INSERT INTO users (email, password_hash) VALUES (?, 'x')`, email)
	if err != nil {
		t.Fatalf("insert user: %v", err)
	}
	id, _ := res.LastInsertId()
	return id
}

func insertSession(t *testing.T, sqlDB *sql.DB, userID int64) int64 {
	t.Helper()
	res, err := sqlDB.Exec(`
		INSERT INTO interview_sessions (user_id, job_jd, mode, input_mode, persona, status)
		VALUES (?, 'JD', 'mixed', 'text', 'standard', 'completed')`, userID)
	if err != nil {
		t.Fatalf("insert session: %v", err)
	}
	id, _ := res.LastInsertId()
	return id
}

func insertAnswer(t *testing.T, sqlDB *sql.DB, sessionID int64, seq int, content string, durationMs *int64) {
	t.Helper()
	_, err := sqlDB.Exec(
		`INSERT INTO interview_turns (session_id, seq, role, kind, content, voice_duration_ms)
		 VALUES (?, ?, 'candidate', 'answer', ?, ?)`,
		sessionID, seq, content, durationMs,
	)
	if err != nil {
		t.Fatalf("insert answer: %v", err)
	}
}

func TestAnalyzeSpeechRate(t *testing.T) {
	sqlDB := testDB(t)
	uid := registerUser(t, sqlDB, "test-expression-rate@example.com")
	sid := insertSession(t, sqlDB, uid)
	d1, d2 := int64(30000), int64(30000)
	insertAnswer(t, sqlDB, sid, 1, "我叫小明，负责后端开发。然后我做过高并发项目。", &d1)
	insertAnswer(t, sqlDB, sid, 2, "那个我们用了 Redis 缓存。", &d2)

	res, err := expression.NewService(interview.NewRepo(sqlDB)).Analyze(context.Background(), uid, sid)
	if err != nil {
		t.Fatalf("analyze: %v", err)
	}
	// 答案1 rune 数：23，答案2 rune 数：16 → 39 chars / 1 min → 39
	if res.SpeechRateCPM == nil || *res.SpeechRateCPM != 39 {
		t.Fatalf("speech_rate_cpm = %v, want 39", res.SpeechRateCPM)
	}
	if res.VoiceAnswers != 2 || res.TotalDurationMs != 60000 {
		t.Fatalf("voice_answers/duration = %d/%d, want 2/60000", res.VoiceAnswers, res.TotalDurationMs)
	}
	if res.AvgAnswerChars != 20 { // (23+16)/2 = 19.5 → 20
		t.Fatalf("avg_answer_chars = %d, want 20", res.AvgAnswerChars)
	}
	// 答案1 句末标点：2 句；答案2：1 句 → 3 句，39/3 = 13
	if res.AvgSentenceChars != 13 {
		t.Fatalf("avg_sentence_chars = %d, want 13", res.AvgSentenceChars)
	}
}

func TestAnalyzeNoVoiceAnswers(t *testing.T) {
	sqlDB := testDB(t)
	uid := registerUser(t, sqlDB, "test-expression-text@example.com")
	sid := insertSession(t, sqlDB, uid)
	insertAnswer(t, sqlDB, sid, 1, "然后我做过缓存优化。", nil)

	res, err := expression.NewService(interview.NewRepo(sqlDB)).Analyze(context.Background(), uid, sid)
	if err != nil {
		t.Fatalf("analyze: %v", err)
	}
	if res.VoiceAnswers != 0 || res.TotalDurationMs != 0 {
		t.Fatalf("voice answers should be 0: %+v", res)
	}
	if res.SpeechRateCPM != nil {
		t.Fatalf("speech_rate_cpm should be null for text-only, got %d", *res.SpeechRateCPM)
	}
	if len(res.Fillers) != 1 || res.Fillers[0].Word != "然后" {
		t.Fatalf("fillers = %+v, want [然后]", res.Fillers)
	}
}

func TestAnalyzeFillersSortedAndEmpty(t *testing.T) {
	sqlDB := testDB(t)
	uid := registerUser(t, sqlDB, "test-expression-fillers@example.com")
	sid := insertSession(t, sqlDB, uid)
	insertAnswer(t, sqlDB, sid, 1, "然后那个然后然后", nil)

	res, _ := expression.NewService(interview.NewRepo(sqlDB)).Analyze(context.Background(), uid, sid)
	if len(res.Fillers) != 2 {
		t.Fatalf("fillers = %+v, want 2 entries", res.Fillers)
	}
	if res.Fillers[0].Word != "然后" || res.Fillers[0].Count != 3 {
		t.Fatalf("top filler = %+v, want 然后×3", res.Fillers[0])
	}
}

func TestAnalyzeIsolation(t *testing.T) {
	sqlDB := testDB(t)
	uidA := registerUser(t, sqlDB, "test-expression-iso-a@example.com")
	uidB := registerUser(t, sqlDB, "test-expression-iso-b@example.com")
	sid := insertSession(t, sqlDB, uidA)
	insertAnswer(t, sqlDB, sid, 1, "答案内容", nil)

	svc := expression.NewService(interview.NewRepo(sqlDB))
	ctx := context.Background()
	if _, err := svc.Analyze(ctx, uidB, sid); err != expression.ErrNotFound {
		t.Fatalf("user B analyze = %v, want ErrNotFound", err)
	}
}

func TestAnalyzeEmptySession(t *testing.T) {
	sqlDB := testDB(t)
	uid := registerUser(t, sqlDB, "test-expression-empty@example.com")
	sid := insertSession(t, sqlDB, uid)

	res, err := expression.NewService(interview.NewRepo(sqlDB)).Analyze(context.Background(), uid, sid)
	if err != nil {
		t.Fatalf("analyze: %v", err)
	}
	if !res.Available || res.AvgAnswerChars != 0 || res.AvgSentenceChars != 0 {
		t.Fatalf("empty session result = %+v", res)
	}
	if len(res.Fillers) != 0 || res.SpeechRateCPM != nil {
		t.Fatalf("empty session fillers/rate = %+v/%v", res.Fillers, res.SpeechRateCPM)
	}
}
```

注意：`registerUser` 直接 SQL 插入 users 需匹配 `users` 表结构（`email`、`password_hash`、可能 `created_at` 有默认值——先看 `001_init.sql` 的 users 表；若 schema 不同，改用 httptest 走 user 注册路由，镜像 analytics/service_test.go）。

- [ ] **Step 5: 跑测试**

Run: `cd backend && go test ./internal/expression/ -count=1`
Expected: 全部 PASS（需 MySQL）。

- [ ] **Step 6: 提交**

```bash
git add backend/internal/expression/ backend/cmd/server/main.go
git commit -m "feat(v8): expression analysis endpoint (speech rate, fillers, sentence length)"
```

---

### Task 3: 前端（时长上报 + 报告页展示）

**Files:**
- Create: `frontend/src/api/expression.ts`
- Modify: `frontend/src/ws/interviewSocket.ts`, `frontend/src/pages/InterviewRoomPage.tsx`, `frontend/src/pages/ReportPage.tsx`

**Interfaces:**
- Consumes: 后端 `voice_duration_ms` 字段（ws answer 请求体 + turns 响应）、`GET /api/interviews/:id/expression`
- Produces:
  - `interface ExpressionResult { available: boolean; voice_answers: number; total_duration_ms: number; speech_rate_cpm: number | null; fillers: { word: string; count: number }[]; avg_answer_chars: number; avg_sentence_chars: number }`
  - `fetchExpression(id: number): Promise<ExpressionResult>`
  - `sendAnswer(content: string, voiceDurationMs?: number): void`

- [ ] **Step 1: `api/expression.ts`**

```ts
import { fetchJSON } from './client';

export interface ExpressionResult {
  available: boolean;
  voice_answers: number;
  total_duration_ms: number;
  speech_rate_cpm: number | null;
  fillers: { word: string; count: number }[];
  avg_answer_chars: number;
  avg_sentence_chars: number;
}

export async function fetchExpression(id: number): Promise<ExpressionResult> {
  return fetchJSON<ExpressionResult>(`/api/interviews/${id}/expression`);
}
```

- [ ] **Step 2: `interviewSocket.ts`**

```ts
): { sendAnswer(content: string, voiceDurationMs?: number): void; close(): void } {
...
    sendAnswer(content: string, voiceDurationMs?: number) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify(
            voiceDurationMs
              ? { type: 'answer', content, voice_duration_ms: voiceDurationMs }
              : { type: 'answer', content },
          ),
        );
      }
    },
```

- [ ] **Step 3: `InterviewRoomPage.tsx` 录音计时**

- 新增 `const recordStartRef = useRef<number | null>(null);`
- `startRecordingSession`（按住说话开始时，约 258 行 `startRecordingSession()` 返回前）设 `recordStartRef.current = Date.now();`
- `handleVoiceSend`（约 270 行，`submitAnswer(trimmed)` 前）计算时长：

```ts
const durationMs = recordStartRef.current ? Date.now() - recordStartRef.current : undefined;
recordStartRef.current = null;
```

- `submitAnswer` 改为带时长：`socketRef.current?.sendAnswer(content, durationMs)`（仅语音路径传；文字 `handleSubmit` 走 `submitAnswer(trimmed)` 不传——需要 `submitAnswer` 加第二可选参数 `voiceDurationMs?: number` 并传给 `sendAnswer`；文字调用不传即可）

具体改法：

```ts
const submitAnswer = useCallback(
  (content: string, voiceDurationMs?: number) => {
    appendTurn('candidate', content);
    setAnswer('');
    socketRef.current?.sendAnswer(content, voiceDurationMs);
  },
  [appendTurn],
);
```

`handleVoiceSend` 里 `submitAnswer(trimmed, durationMs);`

- 录音取消（`cancelRecording` / 失败路径）：`recordStartRef.current = null`（若已有清理逻辑，确保重置）

- [ ] **Step 4: `ReportPage.tsx` 表达分析区**

- imports 加 `import { fetchExpression, type ExpressionResult } from '../api/expression';`
- state 加 `const [expression, setExpression] = useState<ExpressionResult | null>(null);`
- 现有 `useEffect`（39 行起，加载报告）里并行加：

```ts
fetchExpression(interviewId)
  .then((res) => setExpression(res))
  .catch(() => {
    /* silent: hide expression section on error */
  });
```

- feedback 展示区下方渲染：

```tsx
{expression && (
  <div className="profile-card">
    <h3 className="trends-section-title">表达分析</h3>
    {expression.speech_rate_cpm !== null ? (
      <p>语速 {expression.speech_rate_cpm} 字/分钟（一般 100–200 字/分钟）</p>
    ) : (
      <p>本场为文字作答，无语速指标</p>
    )}
    {expression.fillers.length > 0 ? (
      <p>
        高频口头禅：
        {expression.fillers
          .map((f) => `${f.word} ×${f.count}`)
          .join('、')}
      </p>
    ) : (
      <p>口头禅较少，继续保持</p>
    )}
    {expression.avg_answer_chars > 0 ? (
      <p>
        平均每答 {expression.avg_answer_chars} 字 / 平均句长{' '}
        {expression.avg_sentence_chars} 字
      </p>
    ) : (
      <p>暂无答案数据</p>
    )}
  </div>
)}
```

（复用 `.profile-card` 样式与 `trends-section-title`；若 `trends-section-title` 类不存在，用页面既有标题类或直接 `<strong>`。）

- [ ] **Step 5: 构建**

Run: `cd frontend && npm run build`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add frontend/src/api/expression.ts frontend/src/ws/interviewSocket.ts frontend/src/pages/InterviewRoomPage.tsx frontend/src/pages/ReportPage.tsx
git commit -m "feat(v8): report voice duration and expression analysis in frontend"
```

---

### Task 4: 验收

**Files:**
- Modify: `docs/superpowers/specs/2026-08-17-expression-analysis-design.md`

- [ ] **Step 1: 全量后端测试**

Run: `cd backend && go test ./... -count=1 -p 1`
Expected: 全部 PASS。

- [ ] **Step 2: 前端构建**

Run: `cd frontend && npm run build`
Expected: PASS。

- [ ] **Step 3: 手工冒烟（可选，需语音设备 + Aliyun 配置）**

语音面试作答 → 报告页显示语速/口头禅/句长；文字作答场次 → 无语速、有口头禅/句长。

- [ ] **Step 4: 更新 spec 状态**

`docs/superpowers/specs/2026-08-17-expression-analysis-design.md` 的 `**Status:** Draft for user review` 改为 `**Status:** Implemented on feat/v8-expression-analysis`。

- [ ] **Step 5: 提交并合并**

```bash
git add docs/superpowers/specs/2026-08-17-expression-analysis-design.md
git commit -m "docs(v8): mark spec implemented"
# 回到主仓库合并
git merge --no-ff feat/v8-expression-analysis -m "merge: V8 expression analysis"
```

---

## Spec coverage self-review

| Spec section | Task |
|--------------|------|
| §4 迁移 + Turn.VoiceDurationMs + 响应 | T1 |
| §5 WS 协议 + 前端计时 | T1, T3 |
| §6 expression 模块 + API + 计算规则 | T2 |
| §7 前端展示 | T3 |
| §8 S1–S7 | T1–T4 |

## Placeholder scan

所有步骤含具体代码/命令，无 TBD。执行时需确认的点：
- `users` 表结构（`registerUser` 直接 SQL 插入是否可行；不可行则改用 httptest 走 user 路由，镜像 analytics/service_test.go）
- 语速断言值依赖测试文本的 rune 计数——实现时按实际 rune 数校准测试期望（答案1 的 rune 数按实际字符串计算）
- `trends-section-title` CSS 类是否存在（不存在则用页面既有标题类）
- `AppendTurn` 其余 3 处调用点（question/follow_up）需补 `nil`
