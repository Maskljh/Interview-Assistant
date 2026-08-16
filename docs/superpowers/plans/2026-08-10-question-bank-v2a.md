# V2-A Question Bank Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship user-owned question bank: save main questions from a session, list/star/filter/delete, and multi-select practice sessions that enter the existing WS room without LLM generate.

**Architecture:** New `internal/question` Gin module + `002_question_bank.sql`. `POST /api/interviews/from-bank` on interview service creates `ready` sessions with ordered `interview_questions`. Frontend Chinese `/questions` page + save buttons on detail/report; JD create/start path unchanged.

**Tech Stack:** Go/Gin, MySQL, existing JWT middleware, React/Vite TS, existing `fetchJSON` client.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-10-question-bank-v2a-design.md`
- Ingest only via `from-session` (no manual create / OCR / AI-only bank gen)
- Dedup allowed; copy only main `interview_questions`, not follow-up turns
- Ownership: missing/foreign → 404; JD path `POST /api/interviews` + `/:id/start` unchanged
- Chinese UI; branch prefer `feat/v2a-question-bank` from `feat/mvp-v1`
- Worktree: `.worktrees/feat-v2a-question-bank` (or implement in existing mvp worktree on new branch)
- On this machine prefer `.git-safe-commit.ps1` if `git commit` wrapper injects unsupported `--trailer`

---

## File map

| Path | Responsibility |
|------|----------------|
| `backend/migrations/002_question_bank.sql` | `question_bank` table + indexes |
| `backend/internal/question/models.go` | Bank item types |
| `backend/internal/question/repo.go` | CRUD SQL |
| `backend/internal/question/service.go` | List/Import/Star/Delete + job_tag truncate |
| `backend/internal/question/handler.go` | HTTP routes under `/api/questions` |
| `backend/internal/question/service_test.go` | Integration tests (MySQL) |
| `backend/internal/interview/service.go` | `CreateFromBank` |
| `backend/internal/interview/handler.go` | `POST /from-bank` |
| `backend/internal/interview/repo.go` | Helper to insert ready session + questions if needed |
| `backend/cmd/server/main.go` | Wire `question.RegisterRoutes` |
| `frontend/src/api/questions.ts` | Bank API client |
| `frontend/src/api/interviews.ts` | `createInterviewFromBank` |
| `frontend/src/pages/QuestionBankPage.tsx` | List / filters / multi-select / practice |
| `frontend/src/App.tsx` | Route `/questions` |
| `frontend/src/pages/InterviewDetailPage.tsx` | 「存入题库」 |
| `frontend/src/pages/ReportPage.tsx` | 「存入题库」 |
| `frontend/src/pages/InterviewListPage.tsx` (+ other headers) | 「题库」 nav link |

---

### Task 1: Migration `question_bank`

**Files:**
- Create: `backend/migrations/002_question_bank.sql`
- Test: apply via mysql client against local `interview` DB

**Interfaces:**
- Produces: table `question_bank` as in spec §4.1

- [ ] **Step 1: Write migration**

```sql
CREATE TABLE IF NOT EXISTS question_bank (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  user_id BIGINT NOT NULL,
  question TEXT NOT NULL,
  answer TEXT NULL,
  source VARCHAR(32) NOT NULL,
  source_session_id BIGINT NULL,
  job_tag VARCHAR(64) NULL,
  starred TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_qb_user FOREIGN KEY (user_id) REFERENCES users(id),
  INDEX idx_qb_user_created (user_id, created_at),
  INDEX idx_qb_user_starred (user_id, starred),
  INDEX idx_qb_user_job_tag (user_id, job_tag)
);
```

- [ ] **Step 2: Apply migration**

```powershell
Get-Content backend/migrations/002_question_bank.sql -Raw |
  docker exec -i template-mall-mysql mysql -uroot -proot interview
```

Expected: `SHOW TABLES` includes `question_bank`.

- [ ] **Step 3: Commit**

```bash
git add backend/migrations/002_question_bank.sql
# use safe commit helper if needed
git commit -m "feat(v2a): add question_bank migration"
```

---

### Task 2: Question bank module (list / import / star / delete)

**Files:**
- Create: `backend/internal/question/models.go`, `repo.go`, `service.go`, `handler.go`, `service_test.go`
- Modify: `backend/cmd/server/main.go`

**Interfaces:**
- Consumes: `auth.Middleware`, `*sql.DB`, interview tables for import
- Produces:
  - `question.RegisterRoutes(r *gin.Engine, db *sql.DB, secret string)`
  - Routes: `GET /api/questions`, `POST /api/questions/from-session/:sessionId`, `PATCH /api/questions/:id`, `DELETE /api/questions/:id`
  - `Service.ImportFromSession(ctx, userID, sessionID int64) (imported int, error)`
  - `jobTagFromJD(jd string) string` — trim, rune truncate 40, append `…` if truncated

- [ ] **Step 1: Write failing tests** in `service_test.go` (mirror `interview/service_test.go`: register user, create session via interview service + fake LLM start, then bank APIs)

Cover:
1. `TestImportFromSessionCopiesMainQuestions` — after start with N questions, POST from-session → `{imported:N}`; GET list length ≥ N; items have `source=interview`, `starred=false`, non-empty `job_tag`
2. `TestImportEmptySessionReturns400` — draft session with 0 questions → 400
3. `TestImportForeignSessionReturns404`
4. `TestPatchStarAndFilter` — PATCH starred true; GET `?starred=1` includes; `?job_tag=` filters
5. `TestDeleteOwnQuestion` — DELETE then GET missing; foreign DELETE → 404
6. `TestListIsolation` — user B cannot see user A items (B6)

- [ ] **Step 2: Run tests — expect FAIL** (package missing)

```bash
cd backend && go test ./internal/question/ -count=1
```

- [ ] **Step 3: Implement models + repo + service + handler**

`models.go`:

```go
type Item struct {
	ID              int64     `json:"id"`
	UserID          int64     `json:"-"`
	Question        string    `json:"question"`
	Answer          *string   `json:"answer"`
	Source          string    `json:"source"`
	SourceSessionID *int64    `json:"source_session_id"`
	JobTag          *string   `json:"job_tag"`
	Starred         bool      `json:"starred"`
	CreatedAt       time.Time `json:"created_at"`
}
```

Handler list query: `starred=1`, `job_tag`, `q` (LIKE `%q%` on question, optional).

Import SQL sketch:
1. Load session by id; if not found or `user_id != caller` → ErrNotFound
2. `SELECT question FROM interview_questions WHERE session_id=? ORDER BY seq`
3. If len==0 → ErrInvalidInput
4. Insert each row with `source='interview'`, `source_session_id`, `job_tag`, `starred=0`

Register in `main.go` after interview routes:

```go
question.RegisterRoutes(r, sqlDB, cfg.JWTSecret)
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
cd backend && go test ./internal/question/ -count=1
```

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(v2a): question bank API list/import/star/delete"
```

---

### Task 3: `POST /api/interviews/from-bank`

**Files:**
- Modify: `backend/internal/interview/service.go`, `handler.go`, `repo.go`, `service_test.go`

**Interfaces:**
- Consumes: bank ownership check via SQL on `question_bank` (or inject thin reader); `ValidateMode`
- Produces: `Service.CreateFromBank(ctx, userID int64, questionIDs []int64, mode Mode) (*Session, []Question, error)`
- Route: `POST /api/interviews/from-bank` body `{ "question_ids": number[], "mode": "behavioral"|"technical"|"mixed" }`
- Response: same `sessionResponse` shape as Get/Start (status `ready`, questions ordered)

**Behavior (exact):**
1. `len(questionIDs)==0` → 400
2. Invalid mode → 400
3. For each id in order: load from `question_bank` where `id=? AND user_id=?`; any miss → 404
4. Insert session: `job_jd` = `题库练习（N题）` where N=len; `resume_text` NULL; `status=ready`; given mode
5. Insert `interview_questions` seq 1..N, `asked=false`, text from bank
6. Return session + questions (BeginLive-ready)

- [ ] **Step 1: Write failing tests**

1. `TestCreateFromBankOrdersQuestions` — import or insert 3 bank rows; from-bank with ids `[c,a,b]` → session ready, questions seq texts match c,a,b order
2. `TestCreateFromBankEmptyIDs400`
3. `TestCreateFromBankForeignID404`
4. `TestCreateFromBankBeginLiveWorks` — after from-bank, `svc.BeginLive` succeeds (no LLM)

- [ ] **Step 2: Run — FAIL**

```bash
cd backend && go test ./internal/interview/ -count=1 -run FromBank
```

- [ ] **Step 3: Implement CreateFromBank + handler route**

Register **before** `/:id` routes if Gin would otherwise capture `from-bank` as id — mount explicitly:

```go
g.POST("/from-bank", h.CreateFromBank)
```

before `g.GET("/:id", ...)`.

Repo helper example:

```go
func (r *Repo) CreateReadyWithQuestions(userID int64, jobJD string, mode Mode, texts []string) (*Session, []Question, error)
```

Transaction: insert session status ready; insert questions; return GetByID + ListQuestions.

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(v2a): create interview session from question bank"
```

---

### Task 4: Frontend API + QuestionBankPage + nav

**Files:**
- Create: `frontend/src/api/questions.ts`, `frontend/src/pages/QuestionBankPage.tsx`
- Modify: `frontend/src/api/interviews.ts`, `frontend/src/App.tsx`, `frontend/src/pages/InterviewListPage.tsx`, `InterviewDetailPage.tsx`, `ReportPage.tsx`, `CreateInterviewPage.tsx` (nav only), reuse `InterviewPages.css`

**Interfaces:**
- `listQuestions(params?: { starred?: boolean; job_tag?: string; q?: string })`
- `importQuestionsFromSession(sessionId: number): Promise<{ imported: number }>`
- `patchQuestion(id: number, body: { starred: boolean })`
- `deleteQuestion(id: number)`
- `createInterviewFromBank(input: { question_ids: number[]; mode: InterviewMode }): Promise<Interview>`

- [ ] **Step 1: Add API helpers**

- [ ] **Step 2: Add route `/questions` → `QuestionBankPage` in App.tsx**

- [ ] **Step 3: Implement QuestionBankPage (Chinese)**

UI must include:
- Header: brand, link 面试列表 `/`, 题库 (current), 退出
- Filters: job_tag text input, checkbox「仅收藏」, optional search `q`
- List rows: checkbox, question text, job_tag, star toggle, delete
- Footer/actions: 「已选 N 题」+ mode select + 「开始练习」 → `createInterviewFromBank` → `navigate(/interviews/${id}/room)`
- Empty state copy in Chinese

- [ ] **Step 4: Add「题库」link on list/detail/report/create headers**

- [ ] **Step 5: Manual smoke** — `npm run build` must pass

```bash
cd frontend && npm run build
```

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(v2a): question bank page and API client"
```

---

### Task 5: Save-to-bank on detail + report; acceptance polish

**Files:**
- Modify: `frontend/src/pages/InterviewDetailPage.tsx`, `ReportPage.tsx`
- Optional: `README.md` one-liner for bank routes

- [ ] **Step 1: Detail + Report「存入题库」button**

Only show when `interview.questions.length > 0` (or always and surface API error). On click:

```ts
const { imported } = await importQuestionsFromSession(interviewId);
// toast/inline: `已存入 ${imported} 题`
```

- [ ] **Step 2: Verify acceptance mapping**

| ID | How verified |
|----|----------------|
| B1 | Import + list tests + UI button |
| B2 | Patch/filter tests + UI filters |
| B3 | Delete test |
| B4 | from-bank + BeginLive test; UI navigate room |
| B5 | Existing interview tests still pass |
| B6 | ListIsolation test |

Run full backend suite:

```bash
cd backend && go test ./... -count=1
```

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(v2a): save session questions to bank from detail/report"
```

---

## Spec coverage self-review

| Spec section | Task |
|--------------|------|
| §4 question_bank table | T1 |
| §5.1 bank APIs | T2 |
| §5.2 from-bank | T3 |
| §6 frontend surfaces | T4–T5 |
| §7 B1–B6 | T2–T5 tests |
| Non-goals (no manual create/OCR/voice) | not implemented |

## Placeholder scan

No TBD steps; concrete SQL/routes/signatures included.
