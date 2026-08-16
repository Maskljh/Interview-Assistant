# V3 针对性出题（用户画像）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Derive a user's weak dimensions from their past scored interviews and inject them into JD question generation so the LLM allocates more questions to weak areas, with a profile card on the create-interview page and automatic fallback when no history exists.

**Architecture:** New `internal/profile` module computing weak dimensions from the last ≤5 completed+scored sessions' `feedback_json` (nested `dimensions`), serving `GET /api/profile`. `interview.Service.Start` calls an injected `SessionProfileProvider` interface; `llm.GenerateQuestionsUser` gains a `weak []string` parameter that appends a targeted-focus directive to the prompt. Frontend `CreateInterviewPage` fetches the profile and shows a card (or fallback copy).

**Tech Stack:** Go/Gin, MySQL (no migration), existing JWT middleware + `auth.Middleware`, React/Vite TS, existing `fetchJSON` client.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-16-targeted-questions-v3-design.md`
- Profile window: last ≤5 sessions `status='completed'` with parseable `feedback_json`, ordered `created_at DESC`; `sessions` query param overrides (default 5, range 1–10)
- Weak dimension = dimension mean **below** the average of the four dimension means, sorted by gap desc, max 2
- No history → `{ "weak_dimensions": [], "based_on_sessions": 0 }` (HTTP 200)
- `interview` depends on profile only through an injected interface (`SessionProfileProvider`), never a direct package import
- `GenerateQuestionsUser(jobJD, resume, mode string, weak []string)`; empty `weak` → prompt byte-identical to current behavior
- Dimension Chinese labels live in the `llm` package (single source): `expression→表达能力`, `logic→逻辑结构`, `content→内容质量`, `job_match→岗位匹配`
- `from-bank` path unchanged (no LLM, no profile)
- Empty profile never blocks question generation
- Chinese UI; branch `feat/v3-profile` from main HEAD
- Tests use MySQL (docker) with email-prefix cleanup (`test-profile-%@example.com`)

---

## File map

| Path | Responsibility |
|------|----------------|
| `backend/internal/profile/service.go` | Weak-dimension computation |
| `backend/internal/profile/handler.go` | `RegisterRoutes` + GET `/api/profile` |
| `backend/internal/profile/service_test.go` | Computation + isolation + sessions-window tests |
| `backend/internal/llm/prompts.go` | `GenerateQuestionsUser` gains `weak []string` + Chinese label map |
| `backend/internal/llm/prompts_test.go` | Prompt content assertions (weak → directive; empty → unchanged) |
| `backend/internal/interview/service.go` | `SessionProfileProvider` interface + `Start` injection |
| `backend/internal/interview/service_test.go` | Start injects weak dims; empty profile → no directive |
| `backend/cmd/server/main.go` | Wire `profile.RegisterRoutes` + `svc.SetProfileProvider(profileSvc)` |
| `frontend/src/api/profile.ts` | `Profile` type + `fetchProfile` |
| `frontend/src/pages/CreateInterviewPage.tsx` | Profile card above JD input |
| `frontend/src/pages/InterviewPages.css` | `.profile-card` styles |
| `docs/superpowers/specs/2026-08-16-targeted-questions-v3-design.md` | Status → Implemented |

---

### Task 1: Profile module (service + handler + wiring)

**Files:**
- Create: `backend/internal/profile/service.go`, `backend/internal/profile/handler.go`
- Modify: `backend/cmd/server/main.go`

**Interfaces:**
- Consumes: `auth.Middleware(secret)`, `*sql.DB`
- Produces:
  - `type Profile struct { WeakDimensions []string `json:"weak_dimensions"`; BasedOnSessions int `json:"based_on_sessions"` }`
  - `func NewService(db *sql.DB) *Service`
  - `func (s *Service) Weaknesses(ctx context.Context, userID int64, maxSessions int) (Profile, error)`
  - `func RegisterRoutes(r *gin.Engine, db *sql.DB, secret string)` — mounts `GET /api/profile`
  - Handler reads `c.Get("userID")` (int64); optional `sessions` query param clamped to 1–10, default 5

- [ ] **Step 1: Write `service.go`**

```go
package profile

import (
	"context"
	"database/sql"
	"encoding/json"
	"sort"
	"time"
)

type dims struct {
	Dimensions struct {
		Expression int `json:"expression"`
		Logic      int `json:"logic"`
		Content    int `json:"content"`
		JobMatch   int `json:"job_match"`
	} `json:"dimensions"`
}

type Profile struct {
	WeakDimensions []string `json:"weak_dimensions"`
	BasedOnSessions int     `json:"based_on_sessions"`
}

type Service struct {
	db *sql.DB
}

func NewService(db *sql.DB) *Service {
	return &Service{db: db}
}

func (s *Service) Weaknesses(ctx context.Context, userID int64, maxSessions int) (Profile, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT feedback_json, created_at
		 FROM interview_sessions
		 WHERE user_id = ? AND status = 'completed' AND score IS NOT NULL
		 ORDER BY created_at DESC
		 LIMIT ?`,
		userID, maxSessions,
	)
	if err != nil {
		return Profile{}, err
	}
	defer rows.Close()

	var (
		sums    [4]int
		counts  [4]int
		parsed  int
		names   = [4]string{"expression", "logic", "content", "job_match"}
	)
	for rows.Next() {
		var raw sql.NullString
		var created time.Time
		if err := rows.Scan(&raw, &created); err != nil {
			return Profile{}, err
		}
		var d dims
		if err := json.Unmarshal([]byte(raw.String), &d); err != nil {
			continue // unparseable feedback: skip this session
		}
		parsed++
		sums[0] += d.Dimensions.Expression
		sums[1] += d.Dimensions.Logic
		sums[2] += d.Dimensions.Content
		sums[3] += d.Dimensions.JobMatch
		counts[0]++
		counts[1]++
		counts[2]++
		counts[3]++
	}
	if err := rows.Err(); err != nil {
		return Profile{}, err
	}
	if parsed == 0 {
		return Profile{WeakDimensions: []string{}, BasedOnSessions: 0}, nil
	}

	means := [4]float64{}
	var total float64
	for i := 0; i < 4; i++ {
		means[i] = float64(sums[i]) / float64(counts[i])
		total += means[i]
	}
	average := total / 4

	type gap struct {
		name string
		gap  float64
	}
	var gaps []gap
	for i := 0; i < 4; i++ {
		if means[i] < average {
			gaps = append(gaps, gap{name: names[i], gap: average - means[i]})
		}
	}
	sort.Slice(gaps, func(a, b int) bool { return gaps[a].gap > gaps[b].gap })
	if len(gaps) > 2 {
		gaps = gaps[:2]
	}

	weak := make([]string, 0, len(gaps))
	for _, g := range gaps {
		weak = append(weak, g.name)
	}
	return Profile{WeakDimensions: weak, BasedOnSessions: parsed}, nil
}
```

- [ ] **Step 2: Write `handler.go`**

```go
package profile

import (
	"database/sql"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"github.com/interview-assistant/backend/internal/auth"
)

type Handler struct {
	svc *Service
}

func NewHandler(svc *Service) *Handler {
	return &Handler{svc: svc}
}

func RegisterRoutes(r *gin.Engine, db *sql.DB, secret string) {
	svc := NewService(db)
	h := NewHandler(svc)
	protected := r.Group("/api/profile")
	protected.Use(auth.Middleware(secret))
	protected.GET("", h.Get)
}

func (h *Handler) Get(c *gin.Context) {
	userID, ok := c.Get("userID")
	if !ok {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
		return
	}
	maxSessions := 5
	if v := c.Query("sessions"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 1 && n <= 10 {
			maxSessions = n
		}
	}
	p, err := h.svc.Weaknesses(c.Request.Context(), userID.(int64), maxSessions)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not load profile"})
		return
	}
	c.JSON(http.StatusOK, p)
}
```

- [ ] **Step 3: Wire in `main.go`**

After `analytics.RegisterRoutes(r, sqlDB, cfg.JWTSecret)` (line ~73) add:

```go
profile.RegisterRoutes(r, sqlDB, cfg.JWTSecret)
```

Add import `"github.com/interview-assistant/backend/internal/profile"`.

- [ ] **Step 4: Verify compile**

Run: `cd backend && go build ./...`
Expected: success

- [ ] **Step 5: Commit**

```bash
git add backend/internal/profile/service.go backend/internal/profile/handler.go backend/cmd/server/main.go
git commit -m "feat(v3): user profile weak-dimension computation and route"
```

---

### Task 2: Profile integration tests

**Files:**
- Create: `backend/internal/profile/service_test.go`

**Interfaces:**
- Consumes: `profile.NewService`, raw `*sql.DB` for seeding; `user.RegisterRoutes` for creating test users (mirror `internal/analytics/service_test.go`)

- [ ] **Step 1: Write the failing tests**

Mirror `internal/analytics/service_test.go` setup: `testDB(t)` with cleanup deleting by `u.email LIKE 'test-profile-%@example.com'` (turns → questions → sessions → users); create users via the `user` service HTTP routes with `httptest` (or insert users directly via SQL and read `id`); seed sessions with the same helper shape used in analytics tests (`insertCompletedSession(t, db, userID, jobJD, mode, score, fbJSON, daysAgo)` with `created_at = DATE_SUB(NOW(), INTERVAL ? DAY)`).

Seed feedback template (nested production shape):

```go
const fb = `{"total_score":%d,"dimensions":{"expression":%d,"logic":%d,"content":%d,"job_match":%d},"strengths":[],"weaknesses":[],"suggestions":[]}`
```

Tests (all call `svc.Weaknesses(ctx, userID, maxSessions)` and assert on `Profile`):

1. `TestWeaknessesPicksBelowAverage` — 3 sessions with dims:
   - s1: 90,90,50,90 (content weak)
   - s2: 88,88,52,88
   - s3: 92,92,54,92
   Means: expression 90, logic 90, content 52, job_match 90. Average = 80.5. Only content < 80.5 → `WeakDimensions == ["content"]`, `BasedOnSessions == 3`.
2. `TestWeaknessesMaxTwoSortedByGap` — dims where two dims are below average: e.g. means expression 50, logic 60, content 90, job_match 90 → average 72.5, gaps: expression 22.5, logic 12.5 → `["expression","logic"]` (order by gap desc).
3. `TestWeaknessesEmptyHistory` — fresh user with no sessions → `WeakDimensions` empty slice, `BasedOnSessions == 0`.
4. `TestWeaknessesSkipsUnparseableFeedback` — one parseable + one with `feedback_json` = valid JSON that fails dims unmarshal (e.g. `{"dimensions":{"expression":"not-a-number"}}`); assert only the parseable session counts (`BasedOnSessions == 1`) and weak dims computed from it.
5. `TestWeaknessesIsolation` — user A with dims 50,50,90,90; user B with 90,90,50,50; A → `["expression","logic"]`, B → `["content","job_match"]`.
6. `TestWeaknessesSessionWindow` — seed 7 sessions with content weak; call with `maxSessions=5` → `BasedOnSessions == 5`; call with `maxSessions=10` → `BasedOnSessions == 7`.

- [ ] **Step 2: Run — expect PASS after Task 1**

Run: `cd backend && go test ./internal/profile/ -count=1`
Expected: all pass (service exists from Task 1). If an assertion fails, fix the test to match the spec's computation, not the service.

- [ ] **Step 3: Commit**

```bash
git add backend/internal/profile/service_test.go
git commit -m "test(v3): profile weak-dimension computation coverage"
```

---

### Task 3: Question generation injection

**Files:**
- Modify: `backend/internal/llm/prompts.go`, `backend/internal/llm/prompts_test.go`, `backend/internal/interview/service.go`, `backend/internal/interview/service_test.go`, `backend/cmd/server/main.go`

**Interfaces:**
- Consumes: nothing new (pure signature change + interface injection)
- Produces:
  - `func GenerateQuestionsUser(jobJD, resume, mode string, weak []string) string`
  - `var DimensionLabels = map[string]string{"expression":"表达能力","logic":"逻辑结构","content":"内容质量","job_match":"岗位匹配"}` (exported in `llm`)
  - `type SessionProfileProvider interface { Weaknesses(ctx context.Context, userID int64, maxSessions int) (profile.Profile, error) }` in package `interview`
  - `func (s *Service) SetProfileProvider(p SessionProfileProvider)` on `interview.Service`

- [ ] **Step 1: Update `llm/prompts.go`**

Change `GenerateQuestionsUser` signature and add the label map + directive:

```go
// DimensionLabels maps dimension keys to Chinese labels for prompt text.
var DimensionLabels = map[string]string{
	"expression": "表达能力",
	"logic":      "逻辑结构",
	"content":    "内容质量",
	"job_match":  "岗位匹配",
}

func GenerateQuestionsUser(jobJD, resume, mode string, weak []string) string {
	base := fmt.Sprintf(`Generate interview questions for this session.

Job description:
%s

Resume:
%s

Interview mode: %s`, jobJD, resume, mode)

	if len(weak) == 0 {
		return base
	}
	labels := make([]string, 0, len(weak))
	for _, w := range weak {
		if label, ok := DimensionLabels[w]; ok {
			labels = append(labels, label)
		}
	}
	if len(labels) == 0 {
		return base
	}
	return base + fmt.Sprintf(`

Targeted focus: this user's weak dimensions are %s. Generate at least half of the questions to assess these weak dimensions.`, strings.Join(labels, ", "))
}
```

(`strings` is already imported in `prompts.go`.)

Update the existing caller in `backend/internal/interview/service.go:169`:

```go
llm.GenerateQuestionsUser(session.JobJD, resume, string(session.Mode), nil)
```

(weak injected in Step 3.)

- [ ] **Step 2: Write `llm/prompts_test.go`**

```go
package llm

import (
	"strings"
	"testing"
)

func TestGenerateQuestionsUserEmptyWeakMatchesLegacy(t *testing.T) {
	got := GenerateQuestionsUser("jd", "resume", "technical", nil)
	if strings.Contains(got, "Targeted focus") {
		t.Fatalf("weak=nil should not inject directive, got: %s", got)
	}
	if !strings.Contains(got, "Job description:") || !strings.Contains(got, "Interview mode: technical") {
		t.Fatalf("base prompt missing sections: %s", got)
	}
}

func TestGenerateQuestionsUserInjectsWeakDirective(t *testing.T) {
	got := GenerateQuestionsUser("jd", "resume", "mixed", []string{"logic", "expression"})
	if !strings.Contains(got, "Targeted focus: this user's weak dimensions are 逻辑结构, 表达能力") {
		t.Fatalf("directive missing or labels wrong: %s", got)
	}
	if !strings.Contains(got, "at least half of the questions") {
		t.Fatalf("allocation rule missing: %s", got)
	}
}

func TestGenerateQuestionsUserIgnoresUnknownKeys(t *testing.T) {
	got := GenerateQuestionsUser("jd", "resume", "mixed", []string{"unknown"})
	if strings.Contains(got, "Targeted focus") {
		t.Fatalf("unknown key should not inject directive: %s", got)
	}
}
```

- [ ] **Step 3: Inject profile into `interview.Service.Start`**

In `backend/internal/interview/service.go`:

Add import `"github.com/interview-assistant/backend/internal/profile"`.

Add the interface + field + setter:

```go
// SessionProfileProvider supplies a user's weak dimensions for targeted
// question generation. Implemented by *profile.Service.
type SessionProfileProvider interface {
	Weaknesses(ctx context.Context, userID int64, maxSessions int) (profile.Profile, error)
}

// in Service struct:
	profileProvider SessionProfileProvider

// setter next to SetEvaluator:
func (s *Service) SetProfileProvider(p SessionProfileProvider) {
	s.profileProvider = p
}
```

In `Start`, before the `ChatJSON` call at line ~168, compute weak dims:

```go
	var weak []string
	if s.profileProvider != nil {
		if p, err := s.profileProvider.Weaknesses(ctx, session.UserID, 5); err == nil {
			weak = p.WeakDimensions
		} // on error, fall back to no injection (never block generation)
	}
```

Check `Session` has a `UserID` field (it does — `GetByID` scans it; verify the field name when implementing). Then change the call to:

```go
llm.GenerateQuestionsUser(session.JobJD, resume, string(session.Mode), weak)
```

- [ ] **Step 4: Wire the provider in `main.go`**

After `svc.SetEvaluator(analysisSvc)` (line ~65) add:

```go
svc.SetProfileProvider(profile.NewService(sqlDB))
```

- [ ] **Step 5: Update/add interview tests**

In `backend/internal/interview/service_test.go`, add a test that captures the user prompt through the fake LLM:

```go
type capturingLLM struct {
	userPrompts []string
}

func (c *capturingLLM) ChatJSON(ctx context.Context, system, user string, out any) error {
	c.userPrompts = append(c.userPrompts, user)
	gen, ok := out.(*llm.GenQuestionsOut)
	if !ok {
		return fmt.Errorf("unexpected out type")
	}
	gen.Questions = make([]llm.GenQuestion, 1)
	gen.Questions[0] = llm.GenQuestion{Seq: 1, Question: "Q?", Intent: "assessment"}
	return nil
}
```

Test 1 `TestStartInjectsWeakDimensions` — build a Service with `SetProfileProvider` returning a fixed `profile.Profile{WeakDimensions: []string{"logic"}, BasedOnSessions: 3}`, fake capturing LLM, and a ready session (create + Start with the fake LLM). Assert the captured user prompt contains `Targeted focus` and `逻辑结构`.

Test 2 `TestStartNoInjectionWithoutProvider` — same but NO `SetProfileProvider` call. Assert the captured prompt does NOT contain `Targeted focus`.

Follow the existing test's session-creation pattern in `service_test.go` (create user → create session → Start). Reuse its helpers.

- [ ] **Step 6: Run tests**

Run: `cd backend && go test ./internal/llm/ ./internal/interview/ -count=1`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add backend/internal/llm/prompts.go backend/internal/llm/prompts_test.go backend/internal/interview/service.go backend/internal/interview/service_test.go backend/cmd/server/main.go
git commit -m "feat(v3): inject weak dimensions into question generation"
```

---

### Task 4: Frontend profile card

**Files:**
- Create: `frontend/src/api/profile.ts`
- Modify: `frontend/src/pages/CreateInterviewPage.tsx`, `frontend/src/pages/InterviewPages.css`

**Interfaces:**
- Consumes: `fetchJSON` from `./client`
- Produces:
  - `interface Profile { weak_dimensions: string[]; based_on_sessions: number }`
  - `fetchProfile(): Promise<Profile>` — GET `/api/profile`

- [ ] **Step 1: Write `frontend/src/api/profile.ts`**

```ts
import { fetchJSON } from './client';

export interface Profile {
  weak_dimensions: string[];
  based_on_sessions: number;
}

export async function fetchProfile(): Promise<Profile> {
  return fetchJSON<Profile>('/api/profile');
}
```

- [ ] **Step 2: Add the profile card to `CreateInterviewPage.tsx`**

Read the current file first. Add:

```ts
import { useEffect } from 'react';
import { fetchProfile, type Profile } from '../api/profile';
```

State + effect (add inside the component):

```ts
const [profile, setProfile] = useState<Profile | null>(null);

useEffect(() => {
  let cancelled = false;
  fetchProfile()
    .then((p) => {
      if (!cancelled) setProfile(p);
    })
    .catch(() => {
      /* silent fallback: hide card on error */
    });
  return () => {
    cancelled = true;
  };
}, []);
```

Below the `<p className="interview-subtitle">` (and above the form), render:

```tsx
{profile && (
  <div className="profile-card">
    {profile.weak_dimensions.length > 0 ? (
      <p>
        针对性出题已开启：根据你最近 {profile.based_on_sessions} 场面试，薄弱点是
        {profile.weak_dimensions
          .map((d) => DIMENSION_LABELS[d] ?? d)
          .map((label) => `【${label}】`)
          .join('、')}
      </p>
    ) : (
      <p>暂无历史画像，将按通用方式出题</p>
    )}
  </div>
)}
```

Add the label map at module scope:

```ts
const DIMENSION_LABELS: Record<string, string> = {
  expression: '表达能力',
  logic: '逻辑结构',
  content: '内容质量',
  job_match: '岗位匹配',
};
```

- [ ] **Step 3: Add CSS to `InterviewPages.css`**

```css
.profile-card {
  margin: 0 0 var(--space-lg);
  padding: var(--space-sm) var(--space-md);
  font: var(--text-body-sm);
  color: var(--color-ink);
  background: var(--color-canvas-soft);
  border: 1px solid var(--color-hairline);
  border-radius: var(--rounded-sm);
}

.profile-card p {
  margin: 0;
}
```

- [ ] **Step 4: Build**

Run: `cd frontend && npm run build`
Expected: PASS. Fix any TS errors minimally.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api/profile.ts frontend/src/pages/CreateInterviewPage.tsx frontend/src/pages/InterviewPages.css
git commit -m "feat(v3): profile card on create interview page"
```

---

### Task 5: Acceptance verification

**Files:**
- Modify: `docs/superpowers/specs/2026-08-16-targeted-questions-v3-design.md` (status line)

- [ ] **Step 1: Map acceptance to verification**

| ID | How verified |
|----|----------------|
| P1 | `TestWeaknessesPicksBelowAverage`, `TestWeaknessesMaxTwoSortedByGap` |
| P2 | `TestWeaknessesEmptyHistory` + card fallback copy |
| P3 | `TestStartInjectsWeakDimensions`, `TestStartNoInjectionWithoutProvider` |
| P4 | `TestGenerateQuestionsUserInjectsWeakDirective` |
| P5 | `TestWeaknessesIsolation` |
| P6 | `TestWeaknessesSessionWindow` |
| P7 | `npm run build` + card render |

- [ ] **Step 2: Run full backend suite**

Run: `cd backend && go test ./... -count=1 -p 1`
Expected: all PASS (including pre-existing packages)

- [ ] **Step 3: Update spec status**

Change `**Status:** Draft for user review` to `**Status:** Implemented on feat/v3-profile` in `docs/superpowers/specs/2026-08-16-targeted-questions-v3-design.md`.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-08-16-targeted-questions-v3-design.md
git commit -m "docs(v3): mark spec implemented"
```

---

## Spec coverage self-review

| Spec section | Task |
|--------------|------|
| §5 computation rules | T1, T2 |
| §6 GET /api/profile + sessions param | T1, T2 (window test) |
| §7 Start injection + interface | T3 |
| §7 prompt directive + Chinese labels in llm | T3 |
| §8 frontend card + fallback | T4 |
| §9 P1–P7 | T2–T5 |
| §10 no migration, from-bank unchanged | T1 (no SQL change), T3 (only Start path) |

## Placeholder scan

All steps contain concrete code, signatures, or commands; no TBD markers. One noted check: `Session.UserID` field name must be confirmed during Task 3 Step 3 (the repo scans `user_id`; the field is `UserID` — verify when editing).
