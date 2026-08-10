# Interview Assistant V1 MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a demoable closed loop: email/password auth → JD (+ optional resume) + mode → AI session questions → WebSocket adaptive text interview → structured report → history.

**Architecture:** Single Go (Gin) process with User / Interview / Analysis modules; MySQL for persistence; Redis for live session state; DeepSeek for three JSON-contract LLM calls; React SPA for UI. REST for lifecycle, WebSocket for Q&A.

**Tech Stack:** Go 1.22+, Gin, golang-jwt, bcrypt, go-redis, database/sql + MySQL driver, gorilla/websocket (or nhooyr), DeepSeek OpenAI-compatible HTTP API; React 18 + Vite + TypeScript; MySQL 8 + Redis 7 via Docker Compose.

**Spec:** `docs/superpowers/specs/2026-08-10-interview-assistant-mvp-design.md`

## Global Constraints

- Auth: email + password only; JWT on all protected routes and WS handshake
- Questions: session-scoped only; no global question bank
- Modes: `behavioral` | `technical` | `mixed`
- Session status: `draft` → `ready` → `in_progress` → `completed` | `failed`
- Hard limits: 5–8 main questions, ≤2 follow-ups per question, ~30 turns, 45 min, 1 concurrent interview per user
- LLM outputs must parse as JSON; 1 retry then rule fallback
- UI visual direction: repo root `DESIGN.md`
- No OCR, voice, OAuth, billing, microservices, OSS

## File structure (create as tasks progress)

```text
docker-compose.yml
.env.example
README.md
backend/
  go.mod
  cmd/server/main.go
  migrations/001_init.sql
  internal/config/config.go
  internal/db/db.go
  internal/auth/password.go
  internal/auth/jwt.go
  internal/auth/middleware.go
  internal/user/repo.go
  internal/user/handler.go
  internal/user/handler_test.go
  internal/llm/client.go
  internal/llm/client_test.go
  internal/llm/prompts.go
  internal/interview/models.go
  internal/interview/repo.go
  internal/interview/service.go
  internal/interview/service_test.go
  internal/interview/decide.go
  internal/interview/decide_test.go
  internal/interview/handler.go
  internal/interview/limits.go
  internal/analysis/service.go
  internal/analysis/service_test.go
  internal/analysis/handler.go
  internal/ws/hub.go
  internal/ws/handler.go
  internal/ws/protocol.go
  internal/sessionredis/store.go
frontend/
  package.json
  vite.config.ts
  index.html
  src/main.tsx
  src/App.tsx
  src/styles/tokens.css
  src/api/client.ts
  src/api/auth.ts
  src/api/interviews.ts
  src/auth/AuthContext.tsx
  src/pages/LoginPage.tsx
  src/pages/RegisterPage.tsx
  src/pages/InterviewListPage.tsx
  src/pages/CreateInterviewPage.tsx
  src/pages/InterviewRoomPage.tsx
  src/pages/ReportPage.tsx
  src/pages/InterviewDetailPage.tsx
  src/ws/interviewSocket.ts
```

---

### Task 1: Scaffold backend, Compose, and config

**Files:**
- Create: `docker-compose.yml`
- Create: `.env.example`
- Create: `backend/go.mod`
- Create: `backend/cmd/server/main.go`
- Create: `backend/internal/config/config.go`
- Create: `README.md` (minimal run instructions)

**Interfaces:**
- Produces: `config.Load() (*Config, error)` with fields `HTTPAddr`, `MySQLDSN`, `RedisAddr`, `JWTSecret`, `DeepSeekAPIKey`, `DeepSeekBaseURL`, `DeepSeekModel`
- Consumes: env vars from `.env` / process environment

- [ ] **Step 1: Create `docker-compose.yml`**

```yaml
services:
  mysql:
    image: mysql:8.4
    environment:
      MYSQL_ROOT_PASSWORD: root
      MYSQL_DATABASE: interview
    ports: ["3306:3306"]
    volumes: ["mysql_data:/var/lib/mysql"]
  redis:
    image: redis:7
    ports: ["6379:6379"]
volumes:
  mysql_data:
```

- [ ] **Step 2: Create `.env.example` and `backend/internal/config/config.go`**

```go
package config

import (
  "fmt"
  "os"
)

type Config struct {
  HTTPAddr        string
  MySQLDSN        string
  RedisAddr       string
  JWTSecret       string
  DeepSeekAPIKey  string
  DeepSeekBaseURL string
  DeepSeekModel   string
}

func Load() (*Config, error) {
  cfg := &Config{
    HTTPAddr:        getenv("HTTP_ADDR", ":8080"),
    MySQLDSN:        getenv("MYSQL_DSN", "root:root@tcp(127.0.0.1:3306)/interview?parseTime=true&charset=utf8mb4"),
    RedisAddr:       getenv("REDIS_ADDR", "127.0.0.1:6379"),
    JWTSecret:       os.Getenv("JWT_SECRET"),
    DeepSeekAPIKey:  os.Getenv("DEEPSEEK_API_KEY"),
    DeepSeekBaseURL: getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com"),
    DeepSeekModel:   getenv("DEEPSEEK_MODEL", "deepseek-chat"),
  }
  if cfg.JWTSecret == "" {
    return nil, fmt.Errorf("JWT_SECRET required")
  }
  return cfg, nil
}

func getenv(k, def string) string {
  if v := os.Getenv(k); v != "" {
    return v
  }
  return def
}
```

`.env.example`:

```text
HTTP_ADDR=:8080
MYSQL_DSN=root:root@tcp(127.0.0.1:3306)/interview?parseTime=true&charset=utf8mb4
REDIS_ADDR=127.0.0.1:6379
JWT_SECRET=dev-change-me
DEEPSEEK_API_KEY=
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-chat
```

- [ ] **Step 3: Init Go module and minimal main**

```bash
cd backend
go mod init github.com/interview-assistant/backend
go get github.com/gin-gonic/gin@v1.10.0
```

```go
package main

import (
  "log"
  "github.com/gin-gonic/gin"
  "github.com/interview-assistant/backend/internal/config"
)

func main() {
  cfg, err := config.Load()
  if err != nil {
    log.Fatal(err)
  }
  r := gin.Default()
  r.GET("/healthz", func(c *gin.Context) { c.JSON(200, gin.H{"ok": true}) })
  log.Fatal(r.Run(cfg.HTTPAddr))
}
```

- [ ] **Step 4: Boot dependencies and verify health**

```bash
docker compose up -d
cd backend && go run ./cmd/server
curl http://127.0.0.1:8080/healthz
```

Expected: `{"ok":true}`

- [ ] **Step 5: Commit**

```bash
git add docker-compose.yml .env.example README.md backend
git commit -m "chore: scaffold backend, compose, and config"
```

---

### Task 2: MySQL migrations and DB open helper

**Files:**
- Create: `backend/migrations/001_init.sql`
- Create: `backend/internal/db/db.go`
- Modify: `backend/cmd/server/main.go` (open DB on boot; fail fast)

**Interfaces:**
- Produces: `db.Open(dsn string) (*sql.DB, error)`; schema matching spec §4.1
- Consumes: `config.MySQLDSN`

- [ ] **Step 1: Write migration SQL**

```sql
CREATE TABLE IF NOT EXISTS users (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  email VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS interview_sessions (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  user_id BIGINT NOT NULL,
  job_jd TEXT NOT NULL,
  resume_text TEXT NULL,
  mode VARCHAR(32) NOT NULL,
  status VARCHAR(32) NOT NULL,
  score INT NULL,
  feedback_json JSON NULL,
  raw_feedback MEDIUMTEXT NULL,
  started_at TIMESTAMP NULL,
  ended_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users(id),
  INDEX idx_sessions_user (user_id)
);

CREATE TABLE IF NOT EXISTS interview_questions (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  session_id BIGINT NOT NULL,
  seq INT NOT NULL,
  question TEXT NOT NULL,
  intent VARCHAR(255) NULL,
  asked TINYINT(1) NOT NULL DEFAULT 0,
  CONSTRAINT fk_questions_session FOREIGN KEY (session_id) REFERENCES interview_sessions(id) ON DELETE CASCADE,
  UNIQUE KEY uq_session_seq (session_id, seq)
);

CREATE TABLE IF NOT EXISTS interview_turns (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  session_id BIGINT NOT NULL,
  seq INT NOT NULL,
  role VARCHAR(32) NOT NULL,
  kind VARCHAR(32) NOT NULL,
  content MEDIUMTEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_turns_session FOREIGN KEY (session_id) REFERENCES interview_sessions(id) ON DELETE CASCADE,
  UNIQUE KEY uq_turn_seq (session_id, seq)
);
```

- [ ] **Step 2: Apply migration and write `db.Open`**

```bash
docker compose exec -T mysql mysql -uroot -proot interview < backend/migrations/001_init.sql
```

```go
package db

import (
  "database/sql"
  "time"
  _ "github.com/go-sql-driver/mysql"
)

func Open(dsn string) (*sql.DB, error) {
  db, err := sql.Open("mysql", dsn)
  if err != nil {
    return nil, err
  }
  db.SetMaxOpenConns(20)
  db.SetConnMaxLifetime(30 * time.Minute)
  if err := db.Ping(); err != nil {
    return nil, err
  }
  return db, nil
}
```

```bash
cd backend && go get github.com/go-sql-driver/mysql@v1.8.1
```

- [ ] **Step 3: Wire DB into `main` — process must exit if Ping fails**

- [ ] **Step 4: Verify tables exist**

```bash
docker compose exec mysql mysql -uroot -proot -e "SHOW TABLES FROM interview;"
```

Expected: `users`, `interview_sessions`, `interview_questions`, `interview_turns`

- [ ] **Step 5: Commit**

```bash
git add backend/migrations backend/internal/db backend/cmd/server/main.go backend/go.mod backend/go.sum
git commit -m "feat: add MySQL schema and db helper"
```

---

### Task 3: Auth — register, login, JWT middleware

**Files:**
- Create: `backend/internal/auth/password.go`
- Create: `backend/internal/auth/jwt.go`
- Create: `backend/internal/auth/middleware.go`
- Create: `backend/internal/user/repo.go`
- Create: `backend/internal/user/handler.go`
- Create: `backend/internal/user/handler_test.go`
- Modify: `backend/cmd/server/main.go` (mount routes)

**Interfaces:**
- Produces:
  - `auth.HashPassword(pw string) (string, error)`
  - `auth.CheckPassword(hash, pw string) bool`
  - `auth.IssueToken(secret string, userID int64, email string, ttl time.Duration) (string, error)`
  - `auth.ParseToken(secret, token string) (userID int64, email string, err error)`
  - `auth.Middleware(secret string) gin.HandlerFunc` sets `userID` in context
  - `POST /api/auth/register` body `{email,password}` → `{token,user:{id,email}}`
  - `POST /api/auth/login` same
- Consumes: `*sql.DB`, `cfg.JWTSecret`

- [ ] **Step 1: Write failing handler tests (httptest + sqlmock or testcontainers optional — prefer in-memory sqlite ONLY if mysql types conflict; otherwise use real MySQL test DB `interview_test`)**

Prefer real MySQL for V1 simplicity. Test against compose MySQL with a cleanup.

```go
func TestRegisterAndLogin(t *testing.T) {
  // arrange: clean users table, mount gin with user handlers
  // act: POST /api/auth/register {"email":"a@b.com","password":"password123"}
  // assert: 200, token non-empty
  // act: POST /api/auth/login same creds
  // assert: 200
  // act: register same email again
  // assert: 400
}
```

- [ ] **Step 2: Run test — expect FAIL (routes missing)**

```bash
cd backend && go test ./internal/user/ -v
```

- [ ] **Step 3: Implement password, JWT, repo, handler**

Password:

```go
package auth

import "golang.org/x/crypto/bcrypt"

func HashPassword(pw string) (string, error) {
  b, err := bcrypt.GenerateFromPassword([]byte(pw), bcrypt.DefaultCost)
  return string(b), err
}

func CheckPassword(hash, pw string) bool {
  return bcrypt.CompareHashAndPassword([]byte(hash), []byte(pw)) == nil
}
```

JWT (HS256, claims: `sub`=userID, `email`, `exp`):

```go
func IssueToken(secret string, userID int64, email string, ttl time.Duration) (string, error)
func ParseToken(secret, token string) (userID int64, email string, err error)
```

Middleware: `Authorization: Bearer <token>` → `c.Set("userID", userID)`.

Handler validation: email non-empty contains `@`; password length ≥ 8.

- [ ] **Step 4: Run tests — expect PASS**

```bash
cd backend && go test ./internal/user/ -v
```

- [ ] **Step 5: Manual curl smoke**

```bash
curl -s -X POST localhost:8080/api/auth/register -H 'Content-Type: application/json' -d '{"email":"demo@example.com","password":"password123"}'
```

- [ ] **Step 6: Commit**

```bash
git add backend/internal/auth backend/internal/user backend/cmd/server
git commit -m "feat: add email/password auth and JWT middleware"
```

---

### Task 4: Interview REST — create, list, get (no LLM yet)

**Files:**
- Create: `backend/internal/interview/models.go`
- Create: `backend/internal/interview/repo.go`
- Create: `backend/internal/interview/service.go`
- Create: `backend/internal/interview/service_test.go`
- Create: `backend/internal/interview/handler.go`
- Modify: `backend/cmd/server/main.go`

**Interfaces:**
- Produces types:

```go
type Mode string // behavioral | technical | mixed
type Status string // draft | ready | in_progress | completed | failed

type Session struct {
  ID, UserID int64
  JobJD string
  ResumeText *string
  Mode Mode
  Status Status
  Score *int
  FeedbackJSON json.RawMessage
  StartedAt, EndedAt *time.Time
  CreatedAt time.Time
}
```

- Service methods:
  - `Create(ctx, userID, jobJD string, resume *string, mode Mode) (*Session, error)` → status `draft`
  - `List(ctx, userID int64) ([]Session, error)`
  - `Get(ctx, userID, id int64) (*Session, []Question, []Turn, error)` — returns `ErrNotFound` if missing or not owned
- Routes (JWT required):
  - `POST /api/interviews`
  - `GET /api/interviews`
  - `GET /api/interviews/:id`

- [ ] **Step 1: Write failing ownership tests**

```go
func TestGetForeignSessionReturnsNotFound(t *testing.T) {
  // user A creates session; user B Get → ErrNotFound / HTTP 404
}

func TestCreateRequiresJDAndValidMode(t *testing.T) {
  // empty JD → 400; mode "foo" → 400
}
```

- [ ] **Step 2: Run tests — FAIL**

```bash
cd backend && go test ./internal/interview/ -v -run TestGetForeign
```

- [ ] **Step 3: Implement repo + service + handler**

Create body:

```json
{ "job_jd": "...", "resume_text": "...", "mode": "mixed" }
```

List item response: `{id, mode, status, created_at, score}`  
Detail: session + `questions` + `turns` (may be empty).

- [ ] **Step 4: Run tests — PASS**

- [ ] **Step 5: Commit**

```bash
git add backend/internal/interview backend/cmd/server
git commit -m "feat: interview create/list/get with ownership checks"
```

---

### Task 5: LLM client + GenerateQuestions + Start

**Files:**
- Create: `backend/internal/llm/client.go`
- Create: `backend/internal/llm/prompts.go`
- Create: `backend/internal/llm/client_test.go`
- Modify: `backend/internal/interview/service.go` (`Start`)
- Modify: `backend/internal/interview/handler.go` (`POST /:id/start`)
- Modify: `backend/internal/interview/service_test.go`

**Interfaces:**
- Produces:

```go
type Client interface {
  ChatJSON(ctx context.Context, system, user string, out any) error
}

type GenQuestion struct {
  Seq int `json:"seq"`
  Question string `json:"question"`
  Intent string `json:"intent"`
}
type GenQuestionsOut struct {
  Questions []GenQuestion `json:"questions"`
}

func (s *Service) Start(ctx context.Context, userID, sessionID int64) (*Session, []Question, error)
```

- `Start` rules: session must be `draft` or `failed` retry from draft-equivalent; after success status=`ready`, insert 5–8 questions, `asked=false`
- On LLM failure: set status `failed` (or keep `draft` — **use keep `draft` and return 502** so retry `start` is clean)

- [ ] **Step 1: Write unit test with fake LLM**

```go
type fakeLLM struct{ fn func(system, user string, out any) error }

func (f fakeLLM) ChatJSON(ctx context.Context, system, user string, out any) error {
  return f.fn(system, user, out)
}

func TestStartPersistsQuestions(t *testing.T) {
  // fake returns 6 questions; Start → status ready; len(questions)==6
}

func TestStartRejectsNonOwner(t *testing.T) { /* 404 */ }
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement DeepSeek client (OpenAI-compatible)**

`POST {base}/v1/chat/completions` with `response_format: {type: json_object}` if supported; strip markdown fences if present; `json.Unmarshal` into `out`; on failure retry once inside `ChatJSON`.

Prompt (`prompts.go`): system instructs interviewer question generator; user payload includes JD, resume (or "none"), mode; require JSON `{questions:[{seq,question,intent}]}` with 5–8 items.

- [ ] **Step 4: Implement `Start` + route; tests PASS**

- [ ] **Step 5: Manual smoke with real key (optional if key present)**

```bash
# register, create interview, start
```

- [ ] **Step 6: Commit**

```bash
git add backend/internal/llm backend/internal/interview
git commit -m "feat: DeepSeek question generation and interview start"
```

---

### Task 6: DecideNext rules engine (pure logic first)

**Files:**
- Create: `backend/internal/interview/limits.go`
- Create: `backend/internal/interview/decide.go`
- Create: `backend/internal/interview/decide_test.go`

**Interfaces:**

```go
const (
  MaxFollowUpsPerQuestion = 2
  MaxTurnsApprox = 30
  MaxDuration = 45 * time.Minute
)

type DecideAction string // follow_up | next_question | finish

type DecideInput struct {
  MainQuestionCount int
  CurrentQuestionIndex int // 0-based
  FollowUpsOnCurrent int
  TurnCount int
  StartedAt time.Time
  Now time.Time
  ModelAction DecideAction // from LLM; empty if LLM failed
  ModelFollowUpText string
}

type DecideResult struct {
  Action DecideAction
  FollowUpText string
  Reason string
}

func ApplyDecideRules(in DecideInput) DecideResult
```

- [ ] **Step 1: Write failing table-driven tests**

```go
func TestApplyDecideRules(t *testing.T) {
  cases := []struct{
    name string
    in DecideInput
    want DecideAction
  }{
    {"force next when followups full", DecideInput{FollowUpsOnCurrent:2, ModelAction:"follow_up", CurrentQuestionIndex:0, MainQuestionCount:5}, "next_question"},
    {"force finish when last question done", DecideInput{CurrentQuestionIndex:4, MainQuestionCount:5, FollowUpsOnCurrent:0, ModelAction:"next_question"}, "finish"},
    {"force finish on turn cap", DecideInput{TurnCount:30, MainQuestionCount:5, ModelAction:"follow_up"}, "finish"},
    {"force finish on time", DecideInput{StartedAt: time.Now().Add(-46*time.Minute), Now: time.Now(), MainQuestionCount:5, ModelAction:"follow_up"}, "finish"},
    {"honor model follow_up", DecideInput{FollowUpsOnCurrent:0, MainQuestionCount:5, ModelAction:"follow_up", ModelFollowUpText:"why?"}, "follow_up"},
    {"llm fail with remaining questions", DecideInput{CurrentQuestionIndex:1, MainQuestionCount:5, ModelAction:""}, "next_question"},
    {"llm fail on last", DecideInput{CurrentQuestionIndex:4, MainQuestionCount:5, ModelAction:""}, "finish"},
  }
  // assert ApplyDecideRules(c.in).Action == c.want
}
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement `ApplyDecideRules` exactly to satisfy table**

Priority order: time/turn caps → follow-up cap → last-question next→finish → empty model fallback → honor model.

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git add backend/internal/interview/limits.go backend/internal/interview/decide.go backend/internal/interview/decide_test.go
git commit -m "feat: adaptive decide rules with hard-limit fallbacks"
```

---

### Task 7: Redis session store + WebSocket interview loop

**Files:**
- Create: `backend/internal/sessionredis/store.go`
- Create: `backend/internal/ws/protocol.go`
- Create: `backend/internal/ws/hub.go`
- Create: `backend/internal/ws/handler.go`
- Modify: `backend/internal/interview/service.go` (`BeginLive`, `HandleAnswer`, `ForceEnd`)
- Modify: `backend/internal/llm/prompts.go` (DecideNext prompt)
- Modify: `backend/cmd/server/main.go`
- Test: `backend/internal/interview/service_test.go` (answer flow with fake LLM + miniredis or real Redis)

**Interfaces:**

```go
type LiveState struct {
  SessionID int64 `json:"session_id"`
  QuestionIndex int `json:"question_index"`
  FollowUpsOnCurrent int `json:"follow_ups_on_current"`
  TurnCount int `json:"turn_count"`
  PendingKind string `json:"pending_kind"` // question | follow_up
  PendingText string `json:"pending_text"`
}

type Store interface {
  Get(ctx, sessionID) (*LiveState, error)
  Save(ctx, *LiveState, ttl) error
  Delete(ctx, sessionID) error
}
```

WS messages (`protocol.go`):

```go
type ClientMsg struct { Type string `json:"type"`; Content string `json:"content"` }
type ServerMsg struct {
  Type string `json:"type"` // session_started|question|follow_up|status|done
  Content string `json:"content,omitempty"`
  Progress *struct{ Current, Total int } `json:"progress,omitempty"`
}
```

Flow:
1. Client connects `/ws/interviews/:id?token=JWT` after `start` (`ready`)
2. Server verifies ownership; transitions `ready`→`in_progress`; sets `started_at`; marks first question asked; appends interviewer turn; `Save` live state; sends `session_started` + `question`
3. On `answer`: append candidate turn; send `status thinking`; call LLM DecideNext JSON; `ApplyDecideRules`; branch:
   - `follow_up`: append turn, bump followup, send `follow_up`
   - `next_question`: advance index, reset followups, send `question` or if none → finish path
   - `finish`: run analysis (Task 8 hook — for now call `Finish` stub that sets completed without report if Analysis not ready); send `done`
4. Reconnect: if `in_progress`, send `session_started` + pending question/follow_up only

Also: `POST /api/interviews/:id/end` → force finish path.

- [ ] **Step 1: Write service test for one answer → forced next when followups full (fake LLM always follow_up)**

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement Redis store + WS handler + HandleAnswer**

```bash
cd backend && go get github.com/redis/go-redis/v9 github.com/gorilla/websocket
```

CORS: allow frontend origin for REST; WS same token query param.

- [ ] **Step 4: Tests PASS; manual WS smoke with websocat or small script**

- [ ] **Step 5: Commit**

```bash
git add backend/internal/sessionredis backend/internal/ws backend/internal/interview backend/cmd/server
git commit -m "feat: WebSocket adaptive interview loop with Redis state"
```

---

### Task 8: Analysis — EvaluateSession + report APIs

**Files:**
- Create: `backend/internal/analysis/service.go`
- Create: `backend/internal/analysis/service_test.go`
- Create: `backend/internal/analysis/handler.go`
- Modify: `backend/internal/interview/service.go` (`Finish` calls Analysis)
- Modify: `backend/internal/llm/prompts.go`
- Modify: `backend/cmd/server/main.go`

**Interfaces:**

```go
type Feedback struct {
  TotalScore int `json:"total_score"`
  Dimensions struct {
    Expression int `json:"expression"`
    Logic int `json:"logic"`
    Content int `json:"content"`
    JobMatch int `json:"job_match"`
  } `json:"dimensions"`
  Strengths []string `json:"strengths"`
  Weaknesses []string `json:"weaknesses"`
  Suggestions []string `json:"suggestions"`
  ModelVersion string `json:"model_version"`
}

func (a *Service) Evaluate(ctx, sessionID int64) (*Feedback, error)
```

Routes:
- `GET /api/interviews/:id/report` — 404 if not owned; 409 if completed but feedback null (or 200 with `{available:false}`); 200 with feedback when present
- `POST /api/interviews/:id/report/retry` — re-run Evaluate when feedback missing or prior fail

Finish behavior:
- Persist all turns first
- Set `ended_at`
- Call Evaluate; on success set `score`, `feedback_json`, status `completed`
- On Evaluate failure: status still `completed`, `feedback_json` null, `raw_feedback` optional error text — client can retry

- [ ] **Step 1: Fake LLM test — Finish writes feedback_json**

- [ ] **Step 2: FAIL then implement Evaluate prompt + parse + routes**

- [ ] **Step 3: PASS + commit**

```bash
git add backend/internal/analysis backend/internal/interview backend/internal/llm backend/cmd/server
git commit -m "feat: post-interview evaluation and report retry"
```

---

### Task 9: Frontend scaffold, tokens, auth pages

**Files:**
- Create: `frontend/*` Vite React-TS app
- Create: `src/styles/tokens.css` mapped from `DESIGN.md` colors
- Create: `src/api/client.ts`, `auth.ts`
- Create: `src/auth/AuthContext.tsx`
- Create: `src/pages/LoginPage.tsx`, `RegisterPage.tsx`
- Create: `src/App.tsx` routes

**Interfaces:**
- `api.client`: `getToken()`, `setToken()`, `fetchJSON(path, opts)` attaches Bearer; on 401 clears token and redirects `/login`
- AuthContext: `{user, login, register, logout}`

- [ ] **Step 1: Scaffold**

```bash
npm create vite@latest frontend -- --template react-ts
cd frontend && npm install && npm install react-router-dom
```

- [ ] **Step 2: Implement tokens.css from DESIGN.md primary/ink/canvas/link/error**

- [ ] **Step 3: Login/Register forms call backend; store JWT in localStorage**

- [ ] **Step 4: Manual verify register→login→protected redirect**

- [ ] **Step 5: Commit**

```bash
git add frontend
git commit -m "feat: frontend scaffold with auth pages"
```

---

### Task 10: Frontend — list, create, detail

**Files:**
- Create: `src/api/interviews.ts`
- Create: `src/pages/InterviewListPage.tsx`
- Create: `src/pages/CreateInterviewPage.tsx`
- Create: `src/pages/InterviewDetailPage.tsx`
- Modify: `src/App.tsx`

**Interfaces:**
- `createInterview({job_jd, resume_text?, mode})`
- `listInterviews()`
- `getInterview(id)`
- `startInterview(id)`

Create page: textarea JD (required), textarea resume (optional), mode select three options; submit → create → start (show loading) → navigate to `/interviews/:id/room`.

List: status pills, link to detail/report/room if in progress.

Detail: read-only turns transcript.

- [ ] **Step 1: Implement API helpers + pages**

- [ ] **Step 2: Manual: create mixed interview with JD only → lands in room route (room may be stub)**

- [ ] **Step 3: Commit**

```bash
git add frontend/src
git commit -m "feat: interview list/create/detail pages"
```

---

### Task 11: Frontend — interview room WS + report page

**Files:**
- Create: `src/ws/interviewSocket.ts`
- Create: `src/pages/InterviewRoomPage.tsx`
- Create: `src/pages/ReportPage.tsx`
- Modify: routes

**Interfaces:**

```ts
function connectInterviewWS(id: number, token: string, handlers: {
  onMessage(msg: ServerMsg): void
  onClose(): void
}): { sendAnswer(content: string): void; close(): void }
```

Room UX:
- Show progress `current/total` from server messages
- Disable input while `status` thinking
- On disconnect show Reconnect button (new socket)
- Force end button → `POST /end`
- On `done` → navigate `/interviews/:id/report`

Report page: total score, four dimensions, lists; Retry report button if unavailable.

- [ ] **Step 1: Implement socket helper + room + report**

- [ ] **Step 2: Manual closed-loop demo (acceptance A1–A4, A6 reconnect)**

- [ ] **Step 3: Commit**

```bash
git add frontend/src
git commit -m "feat: live interview room and report UI"
```

---

### Task 12: Hardening — CORS, acceptance checklist, README

**Files:**
- Modify: `backend/cmd/server/main.go` (CORS for `http://localhost:5173`)
- Modify: `README.md` full runbook
- Create: `docs/superpowers/plans/acceptance-checklist.md` OR section in README

- [ ] **Step 1: Add gin CORS middleware allowing frontend origin and Authorization header**

- [ ] **Step 2: Run acceptance A1–A6 manually; fix blockers**

| ID | Check |
|----|-------|
| A1 | Register/login JWT works |
| A2 | Create+start with each mode; resume optional |
| A3 | Observe follow-up or rule skip; end normally |
| A4 | Report dimensions + history |
| A5 | Second user 404 on first user's id |
| A6 | Kill WS, reconnect keeps pending question; retry report after simulated fail |

- [ ] **Step 3: README: compose up, migrate, env, `go run`, `npm run dev`, demo account flow**

- [ ] **Step 4: Commit**

```bash
git add backend/cmd/server/main.go README.md
git commit -m "docs: runbook and CORS for local demo"
```

---

## Spec coverage self-review

| Spec area | Task(s) |
|-----------|---------|
| Email/password + JWT | 3 |
| Session tables + turns/questions | 2, 4 |
| REST create/start/list/get/end/report | 4, 5, 7, 8 |
| WS adaptive loop + reconnect | 7, 11 |
| Decide rules + hard limits | 6, 7 |
| GenerateQuestions / DecideNext / Evaluate JSON | 5, 7, 8 |
| Report retry | 8, 11 |
| Ownership isolation | 4, 7, A5 in 12 |
| Frontend pages | 9–11 |
| Non-goals respected | No bank/OCR/voice tasks |

**Placeholder scan:** none intentional.  
**Type consistency:** `Mode`/`Status`/`DecideAction`/`Feedback`/`LiveState`/`ServerMsg` names reused across tasks as defined above.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-10-interview-assistant-mvp.md`.

**Two execution options:**

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks  
2. **Inline Execution** — execute tasks in this session with executing-plans checkpoints  

Which approach?
