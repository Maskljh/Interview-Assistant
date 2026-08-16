# V2-C 成长分析 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a growth analytics page: aggregate the user's completed & scored interviews into summary stats, total-score trend, and four-dimension trend lines with job-tag/mode filters.

**Architecture:** New `internal/analytics` Gin module serving `GET /api/analytics/trends` (JWT, owner-scoped). SQL reads `interview_sessions` where `status='completed' AND score IS NOT NULL`, derives job tags with the exported `question.JobTagFromJD`, parses four-dimension scores from `feedback_json` (skip rows that fail to parse), computes summary over filtered results. Frontend `/trends` page renders recharts LineCharts with filters; top bars get a「成长分析」link.

**Tech Stack:** Go/Gin, MySQL (no migration), existing JWT middleware + `auth.Middleware`, React/Vite TS, recharts (new dep), existing `fetchJSON` client.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-16-interview-trends-v2c-design.md`
- Only current user's rows: all SQL is `WHERE user_id = ?`; handler reads `c.Get("userID")`
- Only `status='completed' AND score IS NOT NULL` rows are candidates
- Job tag = `question.JobTagFromJD(job_jd)` (trim, rune-truncate 40, append `…` when truncated)
- Summary is computed over the **filtered** rows; `job_tags` list is computed over unfiltered completed rows
- `avg_score` rounded to nearest int; `delta = latest_score - first_score`; points sorted by `created_at ASC`
- Empty data → 200 with zero summary, `points=[]`, `job_tags=[]`
- Chinese UI; branch `feat/v2c-trends` from main HEAD
- Tests use MySQL (docker) with email-prefix cleanup pattern, mirroring `internal/question/service_test.go`

---

## File map

| Path | Responsibility |
|------|----------------|
| `backend/internal/question/service.go` | Rename `jobTagFromJD` → exported `JobTagFromJD` |
| `backend/internal/question/jobtag_test.go` | Update test to call `JobTagFromJD` |
| `backend/internal/analytics/models.go` | `Summary`, `TrendPoint`, `Trends` response types |
| `backend/internal/analytics/repo.go` | `ListCompletedScored(userID)` SQL |
| `backend/internal/analytics/service.go` | `Trends(ctx, userID, jobTag, mode)` aggregation |
| `backend/internal/analytics/handler.go` | `RegisterRoutes` + GET `/api/analytics/trends` |
| `backend/internal/analytics/service_test.go` | Integration tests (MySQL) |
| `backend/cmd/server/main.go` | Wire `analytics.RegisterRoutes` |
| `frontend/src/api/analytics.ts` | `Trends` types + `fetchTrends` |
| `frontend/src/pages/TrendsPage.tsx` | Filters + summary cards + two recharts LineCharts |
| `frontend/src/App.tsx` | Route `/trends` |
| `frontend/src/pages/InterviewListPage.tsx` (+ other headers) | 「成长分析」nav link |
| `frontend/package.json` | `recharts` dependency |

---

### Task 1: Export `JobTagFromJD`

**Files:**
- Modify: `backend/internal/question/service.go:23` (and caller at `:52`)
- Modify: `backend/internal/question/jobtag_test.go:20`

**Interfaces:**
- Produces: `func JobTagFromJD(jd string) string` — public; same behavior as current `jobTagFromJD`

- [ ] **Step 1: Rename the function**

In `backend/internal/question/service.go`:

```go
// JobTagFromJD derives the job tag from a JD: trim, truncate to 40 runes, append "…".
func JobTagFromJD(jd string) string {
	jd = strings.TrimSpace(jd)
	runes := []rune(jd)
	if len(runes) <= 40 {
		return jd
	}
	return string(runes[:40]) + "…"
}
```

Update the internal caller (`service.go:52`) from `jobTag := jobTagFromJD(session.JobJD)` to `jobTag := JobTagFromJD(session.JobJD)`.

- [ ] **Step 2: Update the test**

In `backend/internal/question/jobtag_test.go:20`, change `got := jobTagFromJD(tc.in)` to `got := JobTagFromJD(tc.in)` and the `t.Fatalf` format string accordingly.

- [ ] **Step 3: Run question tests**

Run: `cd backend && go test ./internal/question/ -count=1`
Expected: PASS (needs local MySQL from docker compose; MySQL + Redis already run from earlier work)

- [ ] **Step 4: Commit**

```bash
git add backend/internal/question/service.go backend/internal/question/jobtag_test.go
git commit -m "refactor(question): export JobTagFromJD for analytics reuse"
```

---

### Task 2: Analytics models + repo

**Files:**
- Create: `backend/internal/analytics/models.go`, `backend/internal/analytics/repo.go`

**Interfaces:**
- Consumes: nothing yet (repo only)
- Produces:
  - `type Summary struct { TotalSessions, AvgScore, MaxScore, MinScore, FirstScore, LatestScore, Delta int }`
  - `type TrendPoint struct { Date string; SessionID int64; JobTag, Mode string; Total, Expression, Logic, Content, JobMatch int }`
  - `type Trends struct { Summary Summary; Points []TrendPoint; JobTags []string }`
  - `func NewRepo(db *sql.DB) *Repo`
  - `func (r *Repo) ListCompletedScored(ctx context.Context, userID int64) ([]CompletedRow, error)` with `type CompletedRow struct { ID int64; JobJD, Mode string; Score int; FeedbackJSON []byte; CreatedAt time.Time }`

- [ ] **Step 1: Write `models.go`**

```go
package analytics

type Summary struct {
	TotalSessions int `json:"total_sessions"`
	AvgScore      int `json:"avg_score"`
	MaxScore      int `json:"max_score"`
	MinScore      int `json:"min_score"`
	FirstScore    int `json:"first_score"`
	LatestScore   int `json:"latest_score"`
	Delta         int `json:"delta"`
}

type TrendPoint struct {
	Date       string `json:"date"`
	SessionID  int64  `json:"session_id"`
	JobTag     string `json:"job_tag"`
	Mode       string `json:"mode"`
	Total      int    `json:"total"`
	Expression int    `json:"expression"`
	Logic      int    `json:"logic"`
	Content    int    `json:"content"`
	JobMatch   int    `json:"job_match"`
}

type Trends struct {
	Summary Summary      `json:"summary"`
	Points  []TrendPoint `json:"points"`
	JobTags []string     `json:"job_tags"`
}
```

- [ ] **Step 2: Write `repo.go`**

```go
package analytics

import (
	"context"
	"database/sql"
	"time"
)

type CompletedRow struct {
	ID           int64
	JobJD        string
	Mode         string
	Score        int
	FeedbackJSON []byte
	CreatedAt    time.Time
}

type Repo struct {
	db *sql.DB
}

func NewRepo(db *sql.DB) *Repo {
	return &Repo{db: db}
}

func (r *Repo) ListCompletedScored(ctx context.Context, userID int64) ([]CompletedRow, error) {
	rows, err := r.db.QueryContext(ctx,
		`SELECT id, job_jd, mode, score, feedback_json, created_at
		 FROM interview_sessions
		 WHERE user_id = ? AND status = 'completed' AND score IS NOT NULL
		 ORDER BY created_at ASC`,
		userID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []CompletedRow
	for rows.Next() {
		var row CompletedRow
		if err := rows.Scan(&row.ID, &row.JobJD, &row.Mode, &row.Score, &row.FeedbackJSON, &row.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	return out, rows.Err()
}
```

- [ ] **Step 3: Verify compile**

Run: `cd backend && go build ./internal/analytics/`
Expected: success (no tests yet — compile only)

- [ ] **Step 4: Commit**

```bash
git add backend/internal/analytics/models.go backend/internal/analytics/repo.go
git commit -m "feat(v2c): analytics models and completed-scored query"
```

---

### Task 3: Analytics service + handler + wiring

**Files:**
- Create: `backend/internal/analytics/service.go`, `backend/internal/analytics/handler.go`
- Modify: `backend/cmd/server/main.go`

**Interfaces:**
- Consumes: `question.JobTagFromJD` (Task 1), `analytics.NewRepo` / `ListCompletedScored` (Task 2), `auth.Middleware`
- Produces:
  - `func NewService(db *sql.DB) *Service`
  - `func (s *Service) Trends(ctx context.Context, userID int64, jobTag, mode string) (*Trends, error)`
  - `func RegisterRoutes(r *gin.Engine, db *sql.DB, secret string)` — mounts `GET /api/analytics/trends` behind JWT
  - Handler reads `c.Get("userID")` (int64); `job_tag` and `mode` from query params

- [ ] **Step 1: Write `service.go`**

```go
package analytics

import (
	"context"
	"database/sql"
	"encoding/json"
	"math"
	"strings"

	"github.com/interview-assistant/backend/internal/question"
)

type dims struct {
	Expression int `json:"expression"`
	Logic      int `json:"logic"`
	Content    int `json:"content"`
	JobMatch   int `json:"job_match"`
}

type Service struct {
	repo *Repo
}

func NewService(db *sql.DB) *Service {
	return &Service{repo: NewRepo(db)}
}

func (s *Service) Trends(ctx context.Context, userID int64, jobTag, mode string) (*Trends, error) {
	rows, err := s.repo.ListCompletedScored(ctx, userID)
	if err != nil {
		return nil, err
	}

	type candidate struct {
		point TrendPoint
	}
	var cands []candidate
	seenTags := make(map[string]bool)
	var jobTags []string

	for _, row := range rows {
		tag := question.JobTagFromJD(row.JobJD)
		if !seenTags[tag] {
			seenTags[tag] = true
			jobTags = append(jobTags, tag)
		}
		if jobTag != "" && tag != jobTag {
			continue
		}
		if mode != "" && row.Mode != mode {
			continue
		}

		var d dims
		if err := json.Unmarshal(row.FeedbackJSON, &d); err != nil {
			continue // bad feedback_json: skip this session entirely
		}
		cands = append(cands, candidate{
			point: TrendPoint{
				Date:       row.CreatedAt.Format("2006-01-02"),
				SessionID:  row.ID,
				JobTag:     tag,
				Mode:       row.Mode,
				Total:      row.Score,
				Expression: d.Expression,
				Logic:      d.Logic,
				Content:    d.Content,
				JobMatch:   d.JobMatch,
			},
		})
	}

	t := &Trends{JobTags: jobTags}
	if len(cands) == 0 {
		return t, nil
	}

	points := make([]TrendPoint, len(cands))
	sum := 0
	minScore, maxScore := cands[0].point.Total, cands[0].point.Total
	for i, c := range cands {
		points[i] = c.point
		sum += c.point.Total
		if c.point.Total < minScore {
			minScore = c.point.Total
		}
		if c.point.Total > maxScore {
			maxScore = c.point.Total
		}
	}

	t.Points = points
	t.Summary = Summary{
		TotalSessions: len(points),
		AvgScore:      int(math.Round(float64(sum) / float64(len(points)))),
		MaxScore:      maxScore,
		MinScore:      minScore,
		FirstScore:    points[0].Total,
		LatestScore:   points[len(points)-1].Total,
		Delta:         points[len(points)-1].Total - points[0].Total,
	}
	return t, nil
}
```

Note: `strings` is not used above — omit it from imports if the compiler complains (the plan's code imports only what it uses; remove `"strings"` if unused).

- [ ] **Step 2: Write `handler.go`**

```go
package analytics

import (
	"database/sql"
	"net/http"

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
	protected := r.Group("/api/analytics")
	protected.Use(auth.Middleware(secret))
	protected.GET("/trends", h.Trends)
}

func (h *Handler) Trends(c *gin.Context) {
	userID, ok := c.Get("userID")
	if !ok {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
		return
	}

	trends, err := h.svc.Trends(c.Request.Context(), userID.(int64), c.Query("job_tag"), c.Query("mode"))
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not load trends"})
		return
	}
	c.JSON(http.StatusOK, trends)
}
```

- [ ] **Step 3: Wire in `main.go`**

In `backend/cmd/server/main.go`, after `question.RegisterRoutes(...)` (line ~71), add:

```go
analytics.RegisterRoutes(r, sqlDB, cfg.JWTSecret)
```

and add `"github.com/interview-assistant/backend/internal/analytics"` to imports.

- [ ] **Step 4: Verify compile**

Run: `cd backend && go build ./...`
Expected: success

- [ ] **Step 5: Commit**

```bash
git add backend/internal/analytics/service.go backend/internal/analytics/handler.go backend/cmd/server/main.go
git commit -m "feat(v2c): trends aggregation service and route"
```

---

### Task 4: Analytics integration tests

**Files:**
- Create: `backend/internal/analytics/service_test.go`

**Interfaces:**
- Consumes: `analytics.NewService`, `user.RegisterRoutes` (for creating test users), raw `*sql.DB` for seeding sessions

- [ ] **Step 1: Write the failing tests**

Mirror the `internal/question/service_test.go` setup: `testDB(t)` with cleanup deleting rows by `u.email LIKE 'test-trends-%@example.com'`; register a user through the user service HTTP routes with `httptest`; seed `interview_sessions` rows directly via SQL (status `completed`, distinct scores/feedback_json/job_jd/created_at).

Seed helper (insert sessions with distinct `created_at` so ordering is deterministic):

```go
func insertCompletedSession(t *testing.T, db *sql.DB, userID int64, jobJD, mode string, score int, fbJSON string, daysAgo int) int64 {
	t.Helper()
	res, err := db.Exec(`
		INSERT INTO interview_sessions (user_id, job_jd, mode, input_mode, status, score, feedback_json, created_at)
		VALUES (?, ?, ?, 'text', 'completed', ?, ?, DATE_SUB(NOW(), INTERVAL ? DAY))`,
		userID, jobJD, mode, score, fbJSON, daysAgo)
	if err != nil {
		t.Fatalf("insert session: %v", err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		t.Fatalf("last insert id: %v", err)
	}
	return id
}
```

Feedback JSON template:

```go
const fb = `{"total_score":%d,"dimensions":{"expression":%d,"logic":%d,"content":%d,"job_match":%d},"strengths":[],"weaknesses":[],"suggestions":[]}`
```

Tests (all call `svc.Trends(ctx, userID, jobTag, mode)` and assert on `*Trends`):

1. `TestTrendsComputesSummaryAndOrder` — 3 sessions (scores 72/80/90, dims varying), no filters. Expect: `TotalSessions=3`, `AvgScore=81` (round((72+80+90)/3)=round(80.67)=81), `MaxScore=90`, `MinScore=72`, `FirstScore=72`, `LatestScore=90`, `Delta=18`, `Points[0].Total=72` … `Points[2].Total=90`, each point's dims match its seeded `feedback_json`.
2. `TestTrendsSkipsNonCompletedAndNullScore` — add one `status='draft'` and one `status='completed'` with `score=NULL`; assert they are absent from `points` and don't affect `TotalSessions`.
3. `TestTrendsSkipsBadFeedbackJSON` — one session with `feedback_json='not json'`; assert its session is skipped entirely (not in points, not counted in summary).
4. `TestTrendsFiltersByJobTagAndMode` — sessions with different `job_jd` values (produce distinct tags) and different `mode`; filter by tag and by mode; assert summary reflects only filtered rows.
5. `TestTrendsIsolation` — create user A with 2 sessions, user B with 1 session; `Trends` for A returns 2 points and none of B's.
6. `TestTrendsEmpty` — fresh user with no sessions; expect `TotalSessions=0`, `AvgScore=0`, `MaxScore=0`, `MinScore=0`, `FirstScore=0`, `LatestScore=0`, `Delta=0`, `Points` empty, `JobTags` empty.

- [ ] **Step 2: Run — expect FAIL**

Run: `cd backend && go test ./internal/analytics/ -count=1`
Expected: compile error (package `analytics` has no tests dir yet — tests reference service not yet exported) — if it compiles but fails assertions, that's also fine as a red test.

- [ ] **Step 3: Run — expect PASS**

Tests should now pass against the Task 3 implementation. Fix any assertion mismatches against the spec (e.g., rounding) by correcting the test, not the service.

- [ ] **Step 4: Commit**

```bash
git add backend/internal/analytics/service_test.go
git commit -m "test(v2c): analytics aggregation coverage"
```

---

### Task 5: Frontend — API client + TrendsPage + route + nav

**Files:**
- Create: `frontend/src/api/analytics.ts`, `frontend/src/pages/TrendsPage.tsx`
- Modify: `frontend/src/App.tsx`, `frontend/package.json` (add `recharts`)
- Modify headers in: `InterviewListPage.tsx`, `QuestionBankPage.tsx`, `CreateInterviewPage.tsx`, `InterviewDetailPage.tsx`, `ReportPage.tsx`, `InterviewRoomPage.tsx` — add 「成长分析」link next to existing `interview-header-link` items

**Interfaces:**
- Consumes: `fetchJSON` from `./client`, `useAuth`, `InterviewMode` type from `../api/interviews`
- Produces:
  - `type TrendsPoint`, `type TrendsSummary`, `type TrendsData` in `frontend/src/api/analytics.ts`
  - `fetchTrends(params?: { job_tag?: string; mode?: InterviewMode }): Promise<TrendsData>`

- [ ] **Step 1: Install recharts**

Run: `cd frontend && npm install recharts`

- [ ] **Step 2: Write `frontend/src/api/analytics.ts`**

```ts
import { fetchJSON } from './client';
import type { InterviewMode } from './interviews';

export interface TrendsSummary {
  total_sessions: number;
  avg_score: number;
  max_score: number;
  min_score: number;
  first_score: number;
  latest_score: number;
  delta: number;
}

export interface TrendsPoint {
  date: string;
  session_id: number;
  job_tag: string;
  mode: InterviewMode;
  total: number;
  expression: number;
  logic: number;
  content: number;
  job_match: number;
}

export interface TrendsData {
  summary: TrendsSummary;
  points: TrendsPoint[];
  job_tags: string[];
}

export async function fetchTrends(params?: {
  job_tag?: string;
  mode?: InterviewMode;
}): Promise<TrendsData> {
  const search = new URLSearchParams();
  if (params?.job_tag) {
    search.set('job_tag', params.job_tag);
  }
  if (params?.mode) {
    search.set('mode', params.mode);
  }
  const qs = search.toString();
  return fetchJSON<TrendsData>(`/api/analytics/trends${qs ? `?${qs}` : ''}`);
}
```

- [ ] **Step 3: Write `frontend/src/pages/TrendsPage.tsx`**

Pattern: header matches QuestionBankPage (brand `模拟面试助手`, links 面试列表/题库/成长分析(current)/退出登录); fetch on filter change with `useCallback` + `useEffect`; loading/error states from existing pages; empty state when `points.length === 0`.

```tsx
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../api/client';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { fetchTrends, type TrendsData } from '../api/analytics';
import type { InterviewMode } from '../api/interviews';
import { useAuth } from '../auth/AuthContext';
import { APP_NAME } from '../lib/labels';
import './InterviewPages.css';

const MODE_OPTIONS: { value: InterviewMode; label: string }[] = [
  { value: 'behavioral', label: '行为面试' },
  { value: 'technical', label: '技术面试' },
  { value: 'mixed', label: '综合面试' },
];

const DIM_LINES: { key: 'expression' | 'logic' | 'content' | 'job_match'; label: string }[] = [
  { key: 'expression', label: '表达能力' },
  { key: 'logic', label: '逻辑结构' },
  { key: 'content', label: '内容质量' },
  { key: 'job_match', label: '岗位匹配' },
];

const DIM_COLORS: Record<string, string> = {
  expression: '#0070f3',
  logic: '#7928ca',
  content: '#f5a623',
  job_match: '#50e3c2',
};

export default function TrendsPage() {
  const { logout } = useAuth();
  const [data, setData] = useState<TrendsData | null>(null);
  const [jobTag, setJobTag] = useState('');
  const [mode, setMode] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await fetchTrends({
        ...(jobTag ? { job_tag: jobTag } : {}),
        ...(mode ? { mode: mode as InterviewMode } : {}),
      });
      setData(result);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '加载成长分析失败');
    } finally {
      setLoading(false);
    }
  }, [jobTag, mode]);

  useEffect(() => {
    void load();
  }, [load]);

  const s = data?.summary;

  return (
    <div className="interview-page">
      <header className="interview-header">
        <Link className="interview-brand" to="/">
          {APP_NAME}
        </Link>
        <div className="interview-header-actions">
          <Link className="interview-header-link" to="/">
            面试列表
          </Link>
          <Link className="interview-header-link" to="/questions">
            题库
          </Link>
          <Link className="interview-header-link" to="/trends">
            成长分析
          </Link>
          <button type="button" className="interview-header-link" onClick={logout}>
            退出登录
          </button>
        </div>
      </header>
      <main className="interview-main">
        <h1>成长分析</h1>
        <p className="interview-subtitle">查看历史面试的分数趋势与维度变化。</p>

        {error && <p className="interview-error">{error}</p>}

        <div className="interview-filter-row">
          <select value={jobTag} onChange={(e) => setJobTag(e.target.value)}>
            <option value="">全部岗位</option>
            {data?.job_tags.map((tag) => (
              <option key={tag} value={tag}>
                {tag}
              </option>
            ))}
          </select>
          <select value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="">全部模式</option>
            {MODE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        {loading ? (
          <p className="interview-loading">加载中…</p>
        ) : data && data.points.length === 0 ? (
          <p className="interview-empty">
            还没有已完成评分的面试，完成一场面试后再来看成长趋势吧。
          </p>
        ) : data ? (
          <>
            <div className="trends-summary-grid">
              <div className="trends-summary-card">
                <span className="trends-summary-label">面试场次</span>
                <span className="trends-summary-value">{s?.total_sessions}</span>
              </div>
              <div className="trends-summary-card">
                <span className="trends-summary-label">平均分</span>
                <span className="trends-summary-value">{s?.avg_score}</span>
              </div>
              <div className="trends-summary-card">
                <span className="trends-summary-label">最高分</span>
                <span className="trends-summary-value">{s?.max_score}</span>
              </div>
              <div className="trends-summary-card">
                <span className="trends-summary-label">最低分</span>
                <span className="trends-summary-value">{s?.min_score}</span>
              </div>
              <div className="trends-summary-card">
                <span className="trends-summary-label">最近 vs 最早</span>
                <span
                  className={`trends-summary-value${
                    (s?.delta ?? 0) >= 0 ? ' trends-delta-up' : ' trends-delta-down'
                  }`}
                >
                  {(s?.delta ?? 0) >= 0 ? `+${s?.delta}` : `${s?.delta}`}
                </span>
              </div>
            </div>

            <h2 className="interview-section-title">总分趋势</h2>
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={data.points}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="date" />
                <YAxis domain={[0, 100]} />
                <Tooltip />
                <Line type="monotone" dataKey="total" name="总分" stroke="#171717" strokeWidth={2} />
              </LineChart>
            </ResponsiveContainer>

            <h2 className="interview-section-title">维度趋势</h2>
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={data.points}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="date" />
                <YAxis domain={[0, 100]} />
                <Tooltip />
                <Legend />
                {DIM_LINES.map((dim) => (
                  <Line
                    key={dim.key}
                    type="monotone"
                    dataKey={dim.key}
                    name={dim.label}
                    stroke={DIM_COLORS[dim.key]}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </>
        ) : null}
      </main>
    </div>
  );
}
```

- [ ] **Step 4: Add route in `frontend/src/App.tsx`**

Import `TrendsPage from './pages/TrendsPage'` and add a protected route:

```tsx
<Route
  path="/trends"
  element={
    <ProtectedRoute>
      <TrendsPage />
    </ProtectedRoute>
  }
/>
```

- [ ] **Step 5: Add「成长分析」nav link to other page headers**

In each of `InterviewListPage.tsx`, `QuestionBankPage.tsx`, `CreateInterviewPage.tsx`, `InterviewDetailPage.tsx`, `ReportPage.tsx`, `InterviewRoomPage.tsx`, inside the `<div className="interview-header-actions">` block, add (next to existing links):

```tsx
<Link className="interview-header-link" to="/trends">
  成长分析
</Link>
```

- [ ] **Step 6: Add styles for summary cards + filter row**

In `frontend/src/pages/InterviewPages.css`, append:

```css
.interview-filter-row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-sm);
  margin: 0 0 var(--space-lg);
}

.interview-filter-row select {
  padding: var(--space-xs) var(--space-sm);
  font: var(--text-body-sm);
  color: var(--color-ink);
  background: var(--color-canvas);
  border: 1px solid var(--color-hairline);
  border-radius: var(--rounded-sm);
}

.trends-summary-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: var(--space-sm);
  margin: 0 0 var(--space-xl);
}

.trends-summary-card {
  padding: var(--space-md);
  background: var(--color-canvas-soft);
  border: 1px solid var(--color-hairline);
  border-radius: var(--rounded-md);
  display: flex;
  flex-direction: column;
  gap: var(--space-xxs);
}

.trends-summary-label {
  font: var(--text-caption);
  color: var(--color-mute);
}

.trends-summary-value {
  font: var(--text-display-sm);
  color: var(--color-ink);
}

.trends-delta-up {
  color: var(--color-success);
}

.trends-delta-down {
  color: var(--color-error-deep);
}
```

- [ ] **Step 7: Build**

Run: `cd frontend && npm run build`
Expected: PASS. If TypeScript errors appear (e.g., unused vars), fix them.

- [ ] **Step 8: Manual smoke**

With backend + MySQL/Redis running: log in, open `/trends` directly (or via header link). Expect: empty state text if no completed interviews; after completing an interview, summary cards and two charts render; filter by job tag and mode changes the chart.

- [ ] **Step 9: Commit**

```bash
git add frontend/src/api/analytics.ts frontend/src/pages/TrendsPage.tsx frontend/src/App.tsx frontend/src/pages/InterviewListPage.tsx frontend/src/pages/QuestionBankPage.tsx frontend/src/pages/CreateInterviewPage.tsx frontend/src/pages/InterviewDetailPage.tsx frontend/src/pages/ReportPage.tsx frontend/src/pages/InterviewRoomPage.tsx frontend/src/pages/InterviewPages.css frontend/package.json frontend/package-lock.json
git commit -m "feat(v2c): trends page with recharts and filters"
```

---

### Task 6: Acceptance verification

**Files:**
- Modify: `docs/superpowers/specs/2026-08-16-interview-trends-v2c-design.md` (status line)

- [ ] **Step 1: Map acceptance to verification**

| ID | How verified |
|----|----------------|
| C1 | `TestTrendsSkipsNonCompletedAndNullScore` |
| C2 | `TestTrendsSkipsBadFeedbackJSON` |
| C3 | `TestTrendsFiltersByJobTagAndMode` |
| C4 | `TestTrendsEmpty` + TrendsPage empty state |
| C5 | `TestTrendsIsolation` |
| C6 | `TestTrendsComputesSummaryAndOrder` (order + delta) |
| C7 | `npm run build` |

- [ ] **Step 2: Run full backend suite**

Run: `cd backend && go test ./... -count=1 -p 1`
Expected: all PASS (question package tests must still pass after the `JobTagFromJD` rename)

- [ ] **Step 3: Update spec status**

In `docs/superpowers/specs/2026-08-16-interview-trends-v2c-design.md`, change `**Status:** Draft for user review` to `**Status:** Implemented on feat/v2c-trends`.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-08-16-interview-trends-v2c-design.md
git commit -m "docs(v2c): mark spec implemented"
```

---

## Spec coverage self-review

| Spec section | Task |
|--------------|------|
| §5 API + filtering semantics | T2, T3, T4 |
| §5 job_tags unfiltered / summary filtered | T3 (service), T4 (test 4) |
| §6 /trends page + filters + charts | T5 |
| §6 header links | T5 Step 5 |
| §7 C1–C7 | T4, T5, T6 |
| §8 reuse JobTagFromJD / no migration | T1, T2 |

## Placeholder scan

All steps contain concrete code, signatures, or commands; no TBD markers. One note: `service.go` imports `strings` only if needed — the plan's code does not use it and the implementer should keep imports minimal.
