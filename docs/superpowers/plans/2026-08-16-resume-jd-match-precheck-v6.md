# V6 简历 × JD 匹配度预检 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新建面试页可选「匹配度检测」，LLM 即时输出简历对 JD 的匹配分与差距项；差距项随创建持久化到会话，Start 出题时作为即时画像注入（与 V3 weak、V5 persona 并存）。

**Architecture:** 新增 `internal/precheck` 模块（复用 `llm.Client`，纯即时诊断，无 DB）挂 `POST /api/precheck`；`llm` 包新增 `PreCheckSystem`/`PreCheckUser` prompt 并给 `GenerateQuestionsUser` 加第 6 参数 `precheckGaps []string`；迁移 `005_precheck.sql` 给 `interview_sessions` 加 `precheck_gaps JSON` 列，Create/CreateFromBank 持久化，Start 出题注入；前端新建页加按钮与结果卡片，开始面试时随 create 提交 gaps。

**Tech Stack:** Go/Gin、MySQL（迁移 005）、React/Vite TS、既有 `fetchJSON` 客户端。

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-16-resume-jd-match-precheck-design.md`
- 分支 `feat/v6-precheck` from main HEAD（V4/V5 已合并，`GenerateQuestionsUser` 现有签名 `(jobJD, resume, mode string, weak []string, persona string)`）
- 迁移 `backend/migrations/005_precheck.sql`：`ALTER TABLE interview_sessions ADD COLUMN precheck_gaps JSON NULL AFTER persona;`
- **跑 interview 集成测试前先执行迁移**：`docker compose exec -T mysql mysql -uroot -proot interview < backend/migrations/005_precheck.sql`（worktree 无 compose mysql 服务时用 `docker exec <container> mysql -uroot -proot interview < ...`，容器名参照其他测试的既有实践）
- `precheckGaps` 为空/nil → 存 NULL；`GenerateQuestionsUser` 输出与现状**逐字节一致**
- precheck 注入段与 weak、persona 段**共存**（追加顺序：weak → persona → precheck），互不干扰
- 仅注入出题（`GenerateQuestionsUser`）；`DecideNextUser`、评估 prompt 不变
- `job_jd` 为空 → precheck 400；LLM 失败 → 502
- 前端：不检测 → 不带 `precheck_gaps`；检测后修改 JD/简历 → 视为过期，结果卡片提示「已修改，建议重新检测」，提交时以当前 gaps 为准（实现取最简单可行）
- 测试：llm 单测 + precheck handler 测试（fake LLM）+ interview 集成测试（MySQL）；前端 `npm run build`

---

## File map

| Path | Responsibility |
|------|----------------|
| `backend/migrations/005_precheck.sql` | precheck_gaps JSON 列 |
| `backend/internal/llm/prompts.go` | `PreCheckSystem` / `PreCheckUser` + `GenerateQuestionsUser` 第 6 参数 + precheck 注入 |
| `backend/internal/llm/prompts_test.go` | precheck prompt 用例 + 既有调用更新 + 三注入共存用例 |
| `backend/internal/precheck/service.go` | `Service.Check`（llm 调用 + 校验） |
| `backend/internal/precheck/handler.go` | `RegisterRoutes` + `POST /api/precheck` |
| `backend/internal/precheck/handler_test.go` | fake LLM + 200/400/502 用例 |
| `backend/cmd/server/main.go` | `precheck.RegisterRoutes(r, llmClient, cfg.JWTSecret)` |
| `backend/internal/interview/models.go` | `Session.PrecheckGaps []string` |
| `backend/internal/interview/repo.go` | INSERT/SELECT/scanSession 处理 precheck_gaps JSON 列 |
| `backend/internal/interview/service.go` | Create/CreateFromBank 签名 + Start 出题传 `session.PrecheckGaps` |
| `backend/internal/interview/handler.go` | 请求/响应加 `precheck_gaps` |
| `backend/internal/interview/service_test.go` | 持久化/注入用例 + 既有调用更新 |
| `frontend/src/api/precheck.ts` | `PreCheckOut` + `fetchPreCheck` |
| `frontend/src/api/interviews.ts` | `precheck_gaps?` 输入字段 |
| `frontend/src/pages/CreateInterviewPage.tsx` | 检测按钮 + 结果卡片 + 提交 gaps |
| `frontend/src/pages/InterviewPages.css` | `.precheck-card` 样式 |
| `docs/superpowers/specs/2026-08-16-resume-jd-match-precheck-design.md` | Status → Implemented |

---

### Task 1: 迁移 + llm precheck prompt 与出题注入

**Files:**
- Create: `backend/migrations/005_precheck.sql`
- Modify: `backend/internal/llm/prompts.go`, `backend/internal/llm/prompts_test.go`

**Interfaces:**
- Consumes: 现有 `GenerateQuestionsUser(jobJD, resume, mode string, weak []string, persona string)`、`personaInjection`
- Produces:
  - `func PreCheckSystem() string`
  - `func PreCheckUser(jobJD, resume string) string`
  - `func GenerateQuestionsUser(jobJD, resume, mode string, weak []string, persona string, precheckGaps []string) string`
  - `func precheckInjection(gaps []string) string`（空 → `""`）

- [ ] **Step 1: 写迁移文件**

```sql
-- backend/migrations/005_precheck.sql
ALTER TABLE interview_sessions
  ADD COLUMN precheck_gaps JSON NULL AFTER persona;
```

- [ ] **Step 2: 写 precheck prompt**

在 `backend/internal/llm/prompts.go` 末尾（`EvaluateSessionUser` 之后）新增：

```go
// PreCheckSystem instructs the model to score resume-vs-JD match and list gaps.
func PreCheckSystem() string {
	return `You are a hiring analyst. Score how well the candidate's resume matches the job description and list the concrete gaps.

Respond with valid JSON only, no markdown fences or extra text. Use this exact schema:
{"match_score":0,"gaps":["..."],"suggestions":["..."]}

Rules:
- match_score must be an integer from 0 to 100
- gaps must be a non-empty array of specific, concrete gaps between the resume and the job description (missing skills, insufficient experience, etc.)
- suggestions must be a non-empty array of actionable preparation advice`
}

// PreCheckUser builds the user prompt for a match precheck. An empty resume
// produces JD-focused gaps and practice advice instead.
func PreCheckUser(jobJD, resume string) string {
	if resume == "" {
		return fmt.Sprintf(`Assess this job description.

Job description:
%s

No resume was provided. Output the core competency points of this role as gaps, practice advice as suggestions, and a match_score reflecting the baseline difficulty of this role.`, jobJD)
	}
	return fmt.Sprintf(`Assess the match between the resume and the job description.

Job description:
%s

Resume:
%s`, jobJD, resume)
}
```

- [ ] **Step 3: `GenerateQuestionsUser` 加第 6 参数**

修改签名与函数体（在 persona 注入之后追加 precheck 注入）：

```go
func GenerateQuestionsUser(jobJD, resume, mode string, weak []string, persona string, precheckGaps []string) string {
	base := fmt.Sprintf(`Generate interview questions for this session.

Job description:
%s

Resume:
%s

Interview mode: %s`, jobJD, resume, mode)

	if len(weak) > 0 {
		labels := make([]string, 0, len(weak))
		for _, w := range weak {
			if label, ok := DimensionLabels[w]; ok {
				labels = append(labels, label)
			}
		}
		if len(labels) > 0 {
			base += fmt.Sprintf(`
	
Targeted focus: this user's weak dimensions are %s. Generate at least half of the questions to assess these weak dimensions.`, strings.Join(labels, ", "))
		}
	}

	if inj := personaInjection(persona); inj != "" {
		base += "\n\n" + inj
	}

	if inj := precheckInjection(precheckGaps); inj != "" {
		base += "\n\n" + inj
	}
	return base
}

// precheckInjection returns the pre-check gap directive, or "" when gaps are
// empty so prompts stay byte-identical to legacy.
func precheckInjection(gaps []string) string {
	if len(gaps) == 0 {
		return ""
	}
	return fmt.Sprintf("Targeted focus (pre-check): the candidate's JD-match gaps are %s. Include questions that probe these gaps.", strings.Join(gaps, ", "))
}
```

- [ ] **Step 4: 更新既有测试调用 + 写新用例**

`backend/internal/llm/prompts_test.go`：所有 `GenerateQuestionsUser(...)` 调用（既有 3 个 weak 用例 + 5 个 persona 用例）末尾追加 `, nil`。新增：

```go
func TestPreCheckSystemRequiresSchema(t *testing.T) {
	sys := PreCheckSystem()
	if !strings.Contains(sys, "match_score") || !strings.Contains(sys, `"gaps"`) || !strings.Contains(sys, `"suggestions"`) {
		t.Fatalf("schema fields missing: %s", sys)
	}
}

func TestPreCheckUserWithResume(t *testing.T) {
	got := PreCheckUser("Backend engineer JD", "Go, SQL experience")
	if !strings.Contains(got, "Resume:") || !strings.Contains(got, "Backend engineer JD") {
		t.Fatalf("resume branch wrong: %s", got)
	}
}

func TestPreCheckUserWithoutResume(t *testing.T) {
	got := PreCheckUser("Backend engineer JD", "")
	if !strings.Contains(got, "No resume was provided") {
		t.Fatalf("empty-resume branch missing: %s", got)
	}
}

func TestGenerateQuestionsUserInjectsPrecheckGaps(t *testing.T) {
	got := GenerateQuestionsUser("jd", "resume", "mixed", nil, StandardPersona, []string{"缺少 Kubernetes 经验", "无高并发项目"})
	if !strings.Contains(got, "Targeted focus (pre-check):") || !strings.Contains(got, "缺少 Kubernetes 经验") {
		t.Fatalf("precheck directive missing: %s", got)
	}
}

func TestGenerateQuestionsUserEmptyGapsMatchesLegacy(t *testing.T) {
	noGaps := GenerateQuestionsUser("jd", "resume", "mixed", []string{"logic"}, "strict_tech", nil)
	withEmpty := GenerateQuestionsUser("jd", "resume", "mixed", []string{"logic"}, "strict_tech", []string{})
	if noGaps != withEmpty {
		t.Fatalf("empty gaps must not alter prompt:\nnoGaps: %s\nwithEmpty: %s", noGaps, withEmpty)
	}
}

func TestGenerateQuestionsUserInjectionsCoexist(t *testing.T) {
	got := GenerateQuestionsUser("jd", "resume", "mixed", []string{"logic"}, "strict_tech", []string{"缺经验"})
	if !strings.Contains(got, "Targeted focus: this user's weak dimensions are") {
		t.Fatalf("weak directive missing: %s", got)
	}
	if !strings.Contains(got, "strict senior technical interviewer") {
		t.Fatalf("persona directive missing: %s", got)
	}
	if !strings.Contains(got, "Targeted focus (pre-check):") {
		t.Fatalf("precheck directive missing: %s", got)
	}
}
```

- [ ] **Step 5: 跑测试**

Run: `cd backend && go test ./internal/llm/ -count=1`
Expected: 全部 PASS。

- [ ] **Step 6: 提交**

```bash
git add backend/migrations/005_precheck.sql backend/internal/llm/prompts.go backend/internal/llm/prompts_test.go
git commit -m "feat(v6): precheck prompts and precheck-gap injection in question generation"
```

---

### Task 2: precheck 模块（service + handler + 路由）

**Files:**
- Create: `backend/internal/precheck/service.go`, `backend/internal/precheck/handler.go`, `backend/internal/precheck/handler_test.go`
- Modify: `backend/cmd/server/main.go`

**Interfaces:**
- Consumes: `llm.Client`（`ChatJSON(ctx, system, user string, out any) error`）、`auth.Middleware(secret)`
- Produces:
  - `type PreCheckOut struct { MatchScore int `json:"match_score"`; Gaps []string `json:"gaps"`; Suggestions []string `json:"suggestions"` }`
  - `func NewService(llmClient llm.Client) *Service`
  - `func (s *Service) Check(ctx context.Context, jobJD, resume string) (PreCheckOut, error)`
  - `func RegisterRoutes(r *gin.Engine, llmClient llm.Client, secret string)` — `POST /api/precheck`
  - `var ErrInvalidInput = errors.New("invalid input")`、`var ErrLLMFailure = errors.New("llm failure")`

- [ ] **Step 1: 写 `service.go`**

```go
package precheck

import (
	"context"
	"errors"
	"strings"

	"github.com/interview-assistant/backend/internal/llm"
)

var (
	ErrInvalidInput = errors.New("invalid input")
	ErrLLMFailure   = errors.New("llm failure")
)

type PreCheckOut struct {
	MatchScore  int      `json:"match_score"`
	Gaps        []string `json:"gaps"`
	Suggestions []string `json:"suggestions"`
}

type Service struct {
	llm llm.Client
}

func NewService(llmClient llm.Client) *Service {
	return &Service{llm: llmClient}
}

func (s *Service) Check(ctx context.Context, jobJD, resume string) (PreCheckOut, error) {
	if strings.TrimSpace(jobJD) == "" {
		return PreCheckOut{}, ErrInvalidInput
	}
	var out PreCheckOut
	if err := s.llm.ChatJSON(ctx, llm.PreCheckSystem(), llm.PreCheckUser(jobJD, resume), &out); err != nil {
		return PreCheckOut{}, ErrLLMFailure
	}
	return out, nil
}
```

- [ ] **Step 2: 写 `handler.go`**

```go
package precheck

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/interview-assistant/backend/internal/auth"
)

type Handler struct {
	svc *Service
}

type precheckRequest struct {
	JobJD      string `json:"job_jd"`
	ResumeText string `json:"resume_text"`
}

func NewHandler(svc *Service) *Handler {
	return &Handler{svc: svc}
}

func RegisterRoutes(r *gin.Engine, llmClient llm.Client, secret string) {
	svc := NewService(llmClient)
	h := NewHandler(svc)
	protected := r.Group("/api/precheck")
	protected.Use(auth.Middleware(secret))
	protected.POST("", h.Check)
}

func (h *Handler) Check(c *gin.Context) {
	var req precheckRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request"})
		return
	}
	out, err := h.svc.Check(c.Request.Context(), req.JobJD, req.ResumeText)
	if errors.Is(err, ErrInvalidInput) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "job_jd is required"})
		return
	}
	if errors.Is(err, ErrLLMFailure) {
		c.JSON(http.StatusBadGateway, gin.H{"error": "precheck failed"})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not run precheck"})
		return
	}
	c.JSON(http.StatusOK, out)
}
```

（`handler.go` 需要 import `"errors"` 与 `"github.com/interview-assistant/backend/internal/llm"`。）

- [ ] **Step 3: 挂路由**

`backend/cmd/server/main.go` 在 `profile.RegisterRoutes(r, sqlDB, cfg.JWTSecret)`（约 76 行）后加：

```go
precheck.RegisterRoutes(r, llmClient, cfg.JWTSecret)
```

加 import `"github.com/interview-assistant/backend/internal/precheck"`。

- [ ] **Step 4: 写 handler 测试**

```go
package precheck_test

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
	"github.com/interview-assistant/backend/internal/precheck"
)

type fakeLLM struct {
	out string
	err error
}

func (f *fakeLLM) ChatJSON(ctx context.Context, system, user string, out any) error {
	if f.err != nil {
		return f.err
	}
	return json.Unmarshal([]byte(f.out), out)
}

func testRouter(llmClient *fakeLLM) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	precheck.RegisterRoutes(r, llmClient, "test-secret")
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

func postPrecheck(t *testing.T, r *gin.Engine, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/precheck", bytes.NewReader([]byte(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", authHeader(t))
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func TestPrecheckReturnsMatch(t *testing.T) {
	r := testRouter(&fakeLLM{out: `{"match_score":72,"gaps":["缺少K8s经验"],"suggestions":["补K8s项目"]}`})
	w := postPrecheck(t, r, `{"job_jd":"Backend engineer","resume_text":"Go, SQL"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", w.Code, w.Body.String())
	}
	var out precheck.PreCheckOut
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if out.MatchScore != 72 || len(out.Gaps) != 1 || out.Gaps[0] != "缺少K8s经验" {
		t.Fatalf("out = %+v", out)
	}
}

func TestPrecheckMissingJDFails(t *testing.T) {
	r := testRouter(&fakeLLM{out: `{}`})
	w := postPrecheck(t, r, `{"job_jd":""}`)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", w.Code)
	}
}

func TestPrecheckLLMFailureReturns502(t *testing.T) {
	r := testRouter(&fakeLLM{err: errors.New("boom")})
	w := postPrecheck(t, r, `{"job_jd":"Backend engineer"}`)
	if w.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502", w.Code)
	}
}
```

- [ ] **Step 5: 跑测试**

Run: `cd backend && go test ./internal/precheck/ -count=1`
Expected: 全部 PASS（不依赖 MySQL）。

- [ ] **Step 6: 提交**

```bash
git add backend/internal/precheck/ backend/cmd/server/main.go
git commit -m "feat(v6): resume-JD match precheck API endpoint"
```

---

### Task 3: interview 持久化 precheck_gaps + Start 注入

**Files:**
- Modify: `backend/internal/interview/models.go`, `repo.go`, `service.go`, `handler.go`, `service_test.go`

**Interfaces:**
- Consumes: T1 的 `GenerateQuestionsUser` 第 6 参数
- Produces:
  - `Session.PrecheckGaps []string`
  - `func (s *Service) Create(ctx, userID, jobJD string, resume *string, mode Mode, inputMode InputMode, persona string, precheckGaps []string) (*Session, error)`
  - `func (s *Service) CreateFromBank(ctx, userID, questionIDs []int64, mode Mode, inputMode InputMode, persona string, precheckGaps []string) (*Session, []Question, error)`

- [ ] **Step 1: 先跑迁移**

```bash
docker compose exec -T mysql mysql -uroot -proot interview < backend/migrations/005_precheck.sql
```

（worktree 无 compose mysql 服务时：`docker exec <mysql-container> mysql -uroot -proot interview < backend/migrations/005_precheck.sql`，容器名用 `docker ps` 查既有 `-mysql-1` 容器。）

- [ ] **Step 2: models.go**

`Session` 结构体在 `Persona` 后加 `PrecheckGaps []string`。

- [ ] **Step 3: repo.go**

`Create`（当前签名 `Create(userID int64, jobJD string, resume *string, mode Mode, inputMode InputMode, persona string)`）与 `CreateReadyWithQuestions` 各追加 `precheckGaps []string` 参数；INSERT 加列与占位符：

```go
// Create
res, err := r.db.Exec(
	`INSERT INTO interview_sessions (user_id, job_jd, resume_text, mode, input_mode, persona, precheck_gaps, status)
	 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
	userID, jobJD, nullString(resume), string(mode), string(inputMode), persona, nullGapsJSON(precheckGaps), string(StatusDraft),
)
```

`CreateReadyWithQuestions` 的 INSERT 同理（`resume_text` 为 NULL 分支）。

`ListByUser` 与 `GetByID` 的 SELECT 在 `persona` 后加 `precheck_gaps`；`scanSession` 加：

```go
var gaps []byte
err := row.Scan(
	&s.ID, &s.UserID, &s.JobJD, &resume, &mode, &inputMode, &persona, &gaps, &status, &score, &feedback,
	&s.StartedAt, &s.EndedAt, &s.CreatedAt,
)
...
if len(gaps) > 0 {
	_ = json.Unmarshal(gaps, &s.PrecheckGaps) // NULL column → nil slice
}
```

文件末尾加辅助函数：

```go
// nullGapsJSON marshals precheck gaps for a JSON column; empty stays NULL.
func nullGapsJSON(gaps []string) any {
	if len(gaps) == 0 {
		return nil
	}
	b, err := json.Marshal(gaps)
	if err != nil {
		return nil
	}
	return string(b)
}
```

（`encoding/json` 已在 repo.go 导入。）

- [ ] **Step 4: service.go**

`Create`/`CreateFromBank` 签名末尾追加 `precheckGaps []string`，透传给 `s.repo.Create(...)` / `s.repo.CreateReadyWithQuestions(...)`。`Start` 出题调用（当前约 200 行）改为：

```go
llm.GenerateQuestionsUser(session.JobJD, resume, string(session.Mode), weak, session.Persona, session.PrecheckGaps)
```

- [ ] **Step 5: handler.go**

`createRequest` / `fromBankRequest` 加：

```go
PrecheckGaps []string `json:"precheck_gaps"`
```

`sessionResponse` 加 `PrecheckGaps []string \`json:"precheck_gaps"\``（用 `omitempty`，空则省略）；`toSessionResponse` 填 `PrecheckGaps: session.PrecheckGaps`；两处 handler 调用传 `req.PrecheckGaps`。

- [ ] **Step 6: 更新既有调用 + 写新测试**

`backend/internal/interview/service_test.go`：6 处 `svc.Create(ctx, ..., llm.StandardPersona)` 末尾追加 `, nil`（保留 V5 加的参数）。

追加：

```go
func TestCreatePersistsPrecheckGaps(t *testing.T) {
	sqlDB := testDB(t)
	store := testStore(t)
	ctx := context.Background()
	r := testRouter(t, sqlDB, nil)
	_ = registerUser(t, r, "test-interview-gaps-persist@example.com")
	userID := userIDByEmail(t, sqlDB, "test-interview-gaps-persist@example.com")

	svc := interview.NewService(sqlDB, &fakeLLM{}, store)
	session, err := svc.Create(ctx, userID, "Backend engineer JD", nil, interview.ModeMixed, interview.InputModeText, llm.StandardPersona, []string{"缺少K8s经验"})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	got, _, _, err := svc.Get(ctx, userID, session.ID)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if len(got.PrecheckGaps) != 1 || got.PrecheckGaps[0] != "缺少K8s经验" {
		t.Fatalf("precheck_gaps = %v, want [缺少K8s经验]", got.PrecheckGaps)
	}
}

func TestStartInjectsPrecheckGaps(t *testing.T) {
	sqlDB := testDB(t)
	store := testStore(t)
	ctx := context.Background()
	r := testRouter(t, sqlDB, nil)
	_ = registerUser(t, r, "test-interview-gaps-start@example.com")
	userID := userIDByEmail(t, sqlDB, "test-interview-gaps-start@example.com")

	capLLM := &capturingLLM{}
	svc := interview.NewService(sqlDB, capLLM, store)
	session, err := svc.Create(ctx, userID, "Backend engineer JD", nil, interview.ModeMixed, interview.InputModeText, llm.StandardPersona, []string{"缺少K8s经验"})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if _, _, err := svc.Start(ctx, userID, session.ID); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if len(capLLM.userPrompts) != 1 {
		t.Fatalf("captured %d prompts, want 1", len(capLLM.userPrompts))
	}
	if !strings.Contains(capLLM.userPrompts[0], "Targeted focus (pre-check):") || !strings.Contains(capLLM.userPrompts[0], "缺少K8s经验") {
		t.Fatalf("prompt missing precheck directive: %s", capLLM.userPrompts[0])
	}
}
```

（`capturingLLM` 与 `fakeLLM` 均已在文件内；`strings` 已导入。）

- [ ] **Step 7: 跑测试**

Run: `cd backend && go test ./internal/interview/ -count=1`
Expected: 全部 PASS。

- [ ] **Step 8: 提交**

```bash
git add backend/internal/interview/models.go backend/internal/interview/repo.go backend/internal/interview/service.go backend/internal/interview/handler.go backend/internal/interview/service_test.go
git commit -m "feat(v6): persist precheck gaps on session and inject into question generation"
```

---

### Task 4: 前端检测按钮与结果卡片

**Files:**
- Create: `frontend/src/api/precheck.ts`
- Modify: `frontend/src/api/interviews.ts`, `frontend/src/pages/CreateInterviewPage.tsx`, `frontend/src/pages/InterviewPages.css`

**Interfaces:**
- Consumes: `fetchJSON`、后端 `POST /api/precheck` 与 create 的 `precheck_gaps`
- Produces:
  - `interface PreCheckOut { match_score: number; gaps: string[]; suggestions: string[] }`
  - `fetchPreCheck(jobJd: string, resumeText: string): Promise<PreCheckOut>`

- [ ] **Step 1: `frontend/src/api/precheck.ts`**

```ts
import { fetchJSON } from './client';

export interface PreCheckOut {
  match_score: number;
  gaps: string[];
  suggestions: string[];
}

export async function fetchPreCheck(
  jobJd: string,
  resumeText: string,
): Promise<PreCheckOut> {
  return fetchJSON<PreCheckOut>('/api/precheck', {
    method: 'POST',
    body: JSON.stringify({ job_jd: jobJd, resume_text: resumeText }),
  });
}
```

- [ ] **Step 2: `frontend/src/api/interviews.ts`**

`CreateInterviewInput` 与 `CreateFromBankInput` 各加 `precheck_gaps?: string[];`。

- [ ] **Step 3: `CreateInterviewPage.tsx`**

新增 state 与 import：

```ts
import { fetchPreCheck, type PreCheckOut } from '../api/precheck';

const [precheck, setPrecheck] = useState<PreCheckOut | null>(null);
const [prechecking, setPrechecking] = useState(false);
const [precheckError, setPrecheckError] = useState('');
const [precheckStale, setPrecheckStale] = useState(false);
```

检测 handler（JD 必填校验后调用）：

```ts
async function handlePrecheck() {
  setPrecheckError('');
  const trimmedJd = jobJd.trim();
  if (!trimmedJd) {
    setPrecheckError('请先填写职位描述');
    return;
  }
  setPrechecking(true);
  try {
    const result = await fetchPreCheck(trimmedJd, resumeText.trim());
    setPrecheck(result);
    setPrecheckStale(false);
  } catch (err) {
    setPrecheckError(err instanceof ApiError ? err.message : '匹配度检测失败');
  } finally {
    setPrechecking(false);
  }
}
```

JD/简历输入 onChange 里加 `setPrecheckStale(true)`（修改即视为过期）。

`createInterview` payload 加：

```ts
...(precheck ? { precheck_gaps: precheck.gaps } : {}),
```

表单里（「作答方式」select 之后、「面试官风格」select 之前或之后均可）加按钮与结果卡片：

```tsx
<div className="interview-field">
  <label htmlFor="precheck">匹配度检测（可选）</label>
  <button
    type="button"
    className="interview-file-clear"
    onClick={handlePrecheck}
    disabled={prechecking || loading}
  >
    {prechecking ? '正在检测…' : '检测简历与职位匹配度'}
  </button>
  {precheckError && <p className="interview-error">{precheckError}</p>}
</div>

{precheck && (
  <div className="precheck-card">
    {precheckStale && (
      <p className="precheck-stale">JD/简历已修改，建议重新检测。</p>
    )}
    <p>
      匹配度 <strong>{precheck.match_score}</strong> / 100
    </p>
    {precheck.gaps.length > 0 && (
      <div>
        <p className="precheck-section-label">差距</p>
        <ul>
          {precheck.gaps.map((g, i) => (
            <li key={i}>{g}</li>
          ))}
        </ul>
      </div>
    )}
    {precheck.suggestions.length > 0 && (
      <div>
        <p className="precheck-section-label">建议</p>
        <ul>
          {precheck.suggestions.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ul>
      </div>
    )}
  </div>
)}
```

- [ ] **Step 4: CSS**

`frontend/src/pages/InterviewPages.css` 末尾追加：

```css
.precheck-card {
  margin: 0 0 var(--space-lg);
  padding: var(--space-sm) var(--space-md);
  font: var(--text-body-sm);
  color: var(--color-ink);
  background: var(--color-canvas-soft);
  border: 1px solid var(--color-hairline);
  border-radius: var(--rounded-sm);
}

.precheck-card p {
  margin: 0 0 var(--space-xs);
}

.precheck-card ul {
  margin: 0 0 var(--space-sm);
  padding-left: var(--space-md);
}

.precheck-stale {
  color: var(--color-warn);
}

.precheck-section-label {
  font: var(--text-caption);
  color: var(--color-mute);
}
```

（如 `--color-warn` token 不存在，用 `var(--color-error-deep)` 替代。）

- [ ] **Step 5: 构建**

Run: `cd frontend && npm run build`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add frontend/src/api/precheck.ts frontend/src/api/interviews.ts frontend/src/pages/CreateInterviewPage.tsx frontend/src/pages/InterviewPages.css
git commit -m "feat(v6): precheck button and result card on create page"
```

---

### Task 5: 验收

**Files:**
- Modify: `docs/superpowers/specs/2026-08-16-resume-jd-match-precheck-design.md`

- [ ] **Step 1: 全量后端测试**

Run: `cd backend && go test ./... -count=1 -p 1`
Expected: 全部 PASS（含既有包）。

- [ ] **Step 2: 前端构建**

Run: `cd frontend && npm run build`
Expected: PASS。

- [ ] **Step 3: 手工冒烟（可选，需 DEEPSEEK_API_KEY）**

新建面试 → 填 JD → 点「匹配度检测」→ 结果卡片显示 → 点开始面试 → 出题应覆盖 gaps 提到的点。

- [ ] **Step 4: 更新 spec 状态**

`docs/superpowers/specs/2026-08-16-resume-jd-match-precheck-design.md` 的 `**Status:** Draft for user review` 改为 `**Status:** Implemented on feat/v6-precheck`。

- [ ] **Step 5: 提交并合并**

```bash
git add docs/superpowers/specs/2026-08-16-resume-jd-match-precheck-design.md
git commit -m "docs(v6): mark spec implemented"
# 回到主仓库合并
git merge --no-ff feat/v6-precheck -m "merge: V6 resume-JD match precheck"
```

---

## Spec coverage self-review

| Spec section | Task |
|--------------|------|
| §5 LLM precheck prompt（含/不含简历） | T1 |
| §6 API + 400/502 | T2 |
| §4 迁移 + Session.PrecheckGaps + 响应字段 | T3 |
| §7.2 Create/CreateFromBank 持久化 | T3 |
| §7.3 出题注入 + 共存 + 空 gaps 一致 | T1 |
| §8 前端按钮/卡片/提交 | T4 |
| §9 Q1–Q7 | T1–T5 |

## Placeholder scan

所有步骤含具体代码/命令，无 TBD。执行时需确认的点：
- `docker compose exec` 在 worktree 不可用时用 `docker exec <mysql-container>`（容器名 `docker ps` 查）
- `--color-warn` token 可能不存在，CSS 里已给替代方案
- 服务测试 6 处 `svc.Create` 调用均需追加 `, nil`；handler 两处调用传 `req.PrecheckGaps`
