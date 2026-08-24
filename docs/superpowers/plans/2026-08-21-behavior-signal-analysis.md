# V14 视频表情 / 行为信号分析 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add optional camera-based expression/behavior signal analysis (emotion distribution, nod count, stress level) to mock interviews — analyzed locally in the browser with TensorFlow.js, aggregated results saved to the backend on session end, and shown as an auxiliary "行为信号" card on the report page (never part of the 4-dimension scoring, no digital human).

**Architecture:** The frontend captures camera frames via `getUserMedia` (only when the user opted in at session creation), runs MediaPipe FaceMesh landmarks locally via TensorFlow.js, extracts signals with pure heuristic functions (mouth/eye aspect ratios, brow raise, head pitch), aggregates them into a small JSON payload at session end, and POSTs it to a new `internal/behavior` backend module backed by a new `interview_behavior` table. The report page reads it back via GET and renders an auxiliary card. Frames/video never leave the browser.

**Tech Stack:** Go 1.22 / Gin / MySQL 8 / Redis, React 19 / Vite 8 / Vitest 4, `@tensorflow/tfjs`, `@tensorflow-models/face-landmarks-detection`.

## Global Constraints

- Backend DB test convention: integration tests use real MySQL via `MYSQL_DSN` (default `root:root@tcp(127.0.0.1:3306)/interview?parseTime=true&charset=utf8mb4`); cleanup deletes users by email prefix. Follow the `expression/service_test.go` pattern exactly.
- Migration numbering: latest is `009_difficulty_style.sql` → new migration is `010_behavior.sql`. Migrations are applied manually (no auto-migrate), e.g. `mysql -h 127.0.0.1 -u root -proot interview < backend/migrations/010_behavior.sql`.
- All new user-facing copy must be Chinese (Simplified). Emotion labels: `smile / neutral / focus / surprise / frown` → 微笑 / 中性 / 专注 / 惊讶 / 皱眉.
- The video/frame NEVER leaves the browser. Only the aggregated payload (emotion frame counts, nod count, stress level, segment series, frame count, duration) is sent to the backend.
- Silent degradation: missing `getUserMedia`, model-load failure, or permission denial must never block or interrupt the interview; the report simply hides the behavior card.
- `camera_enabled` defaults to OFF (checkbox unchecked at creation).
- Backend Go naming/lint conventions: `RegisterRoutes(r *gin.Engine, db *sql.DB, secret string)`, `Service{repo *interview.Repo}`, ownership isolation returns `ErrNotFound`.
- Frontend test conventions: vitest + `@testing-library/react`; `vi.mock('@capacitor/core', ...)` for any module importing `@capacitor/core`.
- Run verification before claiming success:
  - Backend: `$env:GOCACHE="<worktree>\backend\.gotmp\gocache"; $env:GOPATH="<worktree>\backend\.gopath"; go build ./... && go vet ./...` MUST pass. `go test ./internal/<pkg>/...` may run if MySQL at `MYSQL_DSN` is reachable — in the current sandbox MySQL (3306 password unknown / 3307 down), Redis (6379) and the Docker named-pipe API are unavailable, so **DB-backed integration tests cannot run here**; the existing DB tests are environment-limited and their absence is NOT a regression. Compile correctness (`go build`/`go vet`) is the binding backend gate in this environment.
  - Frontend: `npm run test` runs vitest but REQUIRES the local sandbox preload `$env:NODE_OPTIONS="--require <worktree>/frontend/.vitest-pipefix.cjs"` (DSH sandbox blocks Node child-process pipe stdio with EPERM; this preload forces stdio to 'ignore'). `npx tsc -b` MUST pass (type check). `npm run build` (vite/rolldown) FAILS in this sandbox (`spawn EPERM` in `windowsSafeRealPathSync`) — the same failure occurs in the main repo, so it is a known environment limitation, NOT a regression; use `tsc -b` as the binding build gate.
- The `.vitest-pipefix.cjs` preload file is a local-only sandbox workaround (untracked, must NOT be committed). Copy it from the main repo working tree (`frontend/.vitest-pipefix.cjs`) into the worktree's `frontend/` if absent.

---

### Task 1: Migration 010 + `camera_enabled` plumbing

**Files:**
- Create: `backend/migrations/010_behavior.sql`
- Modify: `backend/internal/interview/models.go` (Session struct), `backend/internal/interview/repo.go` (INSERT ×2 + SELECT ×2 + scanSession), `backend/internal/interview/handler.go` (createRequest, fromBankRequest, sessionResponse, toSessionResponse), `backend/internal/interview/service.go` (Create, CreateFromBank signatures)

**Interfaces:**
- Produces: `Session.CameraEnabled bool`; `Create(userID, jobJD, resume, mode, inputMode, persona, difficulty, style, precheckGaps, cameraEnabled bool)`; `CreateFromBank(..., cameraEnabled bool)`; `sessionResponse.CameraEnabled bool` with `json:"camera_enabled"`.

- [ ] **Step 1: Write migration 010**

`backend/migrations/010_behavior.sql`:

```sql
ALTER TABLE interview_sessions
  ADD COLUMN camera_enabled TINYINT(1) NOT NULL DEFAULT 0 AFTER company_style;

CREATE TABLE IF NOT EXISTS interview_behavior (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  session_id BIGINT NOT NULL,
  user_id BIGINT NOT NULL,
  emotion_distribution JSON NOT NULL,
  nod_count INT NOT NULL DEFAULT 0,
  stress_level INT NOT NULL,
  stress_segments JSON NULL,
  face_detected_frames INT NOT NULL DEFAULT 0,
  duration_ms INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_behavior_session FOREIGN KEY (session_id) REFERENCES interview_sessions(id) ON DELETE CASCADE,
  UNIQUE KEY uq_behavior_session (session_id)
);
```

- [ ] **Step 2: Apply the migration and verify it is idempotent**

Run (adjust to your MySQL host):

```bash
mysql -h 127.0.0.1 -u root -proot interview < backend/migrations/010_behavior.sql
mysql -h 127.0.0.1 -u root -proot interview -e "SHOW COLUMNS FROM interview_sessions LIKE 'camera_enabled'; SHOW TABLES LIKE 'interview_behavior';"
```

Expected: `camera_enabled` column exists (default 0), `interview_behavior` table exists. Re-running the same file must not error (guarded by `ADD COLUMN` on fresh DB only — note: if the column already exists the ALTER fails, which is expected on a DB that already applied it; do NOT run twice against the same DB).

- [ ] **Step 3: Add `CameraEnabled` to Session struct**

In `backend/internal/interview/models.go`, add to `Session`:

```go
	CompanyStyle string
	CameraEnabled bool
	PrecheckGaps []string
```

- [ ] **Step 4: Update repo INSERT and SELECT queries**

In `backend/internal/interview/repo.go`:
- `Create` INSERT: add `camera_enabled` column and the `cameraEnabled` value (`0`/`1` via `boolInt(cameraEnabled)`).
- `CreateReadyWithQuestions` INSERT: same.
- `ListByUser` and `GetByID` SELECT: add `camera_enabled` to the column list (after `company_style`).
- `scanSession`: add `var cameraEnabled int` and scan it after style; set `s.CameraEnabled = cameraEnabled != 0`.

Add helper (place near `nullGapsJSON`):

```go
func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}
```

- [ ] **Step 5: Update handler request/response structs**

In `backend/internal/interview/handler.go`:
- `createRequest`: add `CameraEnabled bool \`json:"camera_enabled"\``
- `fromBankRequest`: add `CameraEnabled bool \`json:"camera_enabled"\``
- `sessionResponse`: add `CameraEnabled bool \`json:"camera_enabled"\``
- `toSessionResponse`: set `CameraEnabled: session.CameraEnabled`

- [ ] **Step 6: Update service signatures**

In `backend/internal/interview/service.go`, add a `cameraEnabled bool` parameter to `Create(...)` and `CreateFromBank(...)` and pass it to the repo calls. Update the two `handler.go` call sites (`h.svc.Create(...)`, `h.svc.CreateFromBank(...)`) to pass `req.CameraEnabled`.

- [ ] **Step 7: Update existing service tests that call Create/CreateFromBank**

Search `backend/internal/interview/service_test.go` for `svc.Create(` and `svc.CreateFromBank(` and append `, false` (or a boolean literal) to each call so compilation passes.

- [ ] **Step 8: Verify build + existing tests**

Run: `cd backend && go build ./... && go test ./internal/interview/... -count=1 -p 1`
Expected: build succeeds, interview package tests pass (some may require live MySQL — if MYSQL_DSN is unavailable, at minimum `go build ./...` must pass).

- [ ] **Step 9: Commit**

```bash
git add backend/migrations/010_behavior.sql backend/internal/interview/models.go backend/internal/interview/repo.go backend/internal/interview/handler.go backend/internal/interview/service.go backend/internal/interview/service_test.go
git commit -m "feat(interview): add camera_enabled session flag + behavior table migration"
```

---

### Task 2: Backend `internal/behavior` — models, repo, service (with tests)

**Files:**
- Create: `backend/internal/behavior/service.go`, `backend/internal/behavior/service_test.go`
- Create: `backend/internal/behavior/repo.go` (repo can live in service.go or a separate file; keep `models.go` + `repo.go` + `service.go` if preferred)

**Interfaces:**
- Consumes: `interview.NewRepo(db)` (returns `*interview.Repo`), `interview.Repo.GetByID(id)` returning `(*interview.Session, error)` with `Session.UserID`.
- Produces: `type Payload struct{...}` (JSON tags below); `type Result struct{...}`; `func NewService(repo *interview.Repo) *Service`; `func (s *Service) Save(ctx, userID, sessionID int64, p Payload) error`; `func (s *Service) Get(ctx, userID, sessionID int64) (Result, error)`; `var ErrNotFound = errors.New("session not found")`; `var ErrInvalidPayload = errors.New("invalid behavior payload")`.

- [ ] **Step 1: Write the failing tests**

`backend/internal/behavior/service_test.go` (follow `expression/service_test.go` conventions — `testDB`, `registerUser`, `insertSession` with `camera_enabled` default; use email prefix `test-behavior-%@example.com`):

```go
package behavior_test

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"testing"

	"github.com/interview-assistant/backend/internal/behavior"
	"github.com/interview-assistant/backend/internal/db"
	"github.com/interview-assistant/backend/internal/interview"
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
			DELETE b FROM interview_behavior b
			INNER JOIN interview_sessions s ON s.id = b.session_id
			INNER JOIN users u ON u.id = s.user_id
			WHERE u.email LIKE 'test-behavior-%@example.com'`)
		_, _ = sqlDB.Exec(`
			DELETE s FROM interview_sessions s
			INNER JOIN users u ON u.id = s.user_id
			WHERE u.email LIKE 'test-behavior-%@example.com'`)
		_, _ = sqlDB.Exec("DELETE FROM users WHERE email LIKE 'test-behavior-%@example.com'")
		sqlDB.Close()
	})
	return sqlDB
}

func registerUser(t *testing.T, sqlDB *sql.DB, email string) int64 {
	t.Helper()
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

func samplePayload() behavior.Payload {
	return behavior.Payload{
		EmotionDistribution: map[string]int{"smile": 12, "neutral": 38, "focus": 30, "surprise": 12, "frown": 8},
		NodCount:            14,
		StressLevel:         42,
		StressSegments:      []behavior.Segment{{TMs: 0, V: 35}, {TMs: 30000, V: 60}},
		FaceDetectedFrames:  920,
		DurationMs:          92000,
	}
}

func TestSaveAndGetRoundTrip(t *testing.T) {
	sqlDB := testDB(t)
	uid := registerUser(t, sqlDB, "test-behavior-rt@example.com")
	sid := insertSession(t, sqlDB, uid)
	svc := behavior.NewService(interview.NewRepo(sqlDB))
	ctx := context.Background()
	if err := svc.Save(ctx, uid, sid, samplePayload()); err != nil {
		t.Fatalf("save: %v", err)
	}
	res, err := svc.Get(ctx, uid, sid)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if !res.Available || res.NodCount != 14 || res.StressLevel != 42 || res.FaceDetectedFrames != 920 || res.DurationMs != 92000 {
		t.Fatalf("round trip = %+v", res)
	}
	if res.EmotionDistribution["smile"] != 12 || res.EmotionDistribution["frown"] != 8 {
		t.Fatalf("emotion dist = %+v", res.EmotionDistribution)
	}
	if len(res.StressSegments) != 2 || res.StressSegments[1].V != 60 {
		t.Fatalf("segments = %+v", res.StressSegments)
	}
}

func TestSaveIdempotent(t *testing.T) {
	sqlDB := testDB(t)
	uid := registerUser(t, sqlDB, "test-behavior-idem@example.com")
	sid := insertSession(t, sqlDB, uid)
	svc := behavior.NewService(interview.NewRepo(sqlDB))
	ctx := context.Background()
	first := samplePayload()
	first.NodCount = 10
	if err := svc.Save(ctx, uid, sid, first); err != nil {
		t.Fatalf("save 1: %v", err)
	}
	second := samplePayload()
	second.NodCount = 99
	if err := svc.Save(ctx, uid, sid, second); err != nil {
		t.Fatalf("save 2: %v", err)
	}
	res, err := svc.Get(ctx, uid, sid)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if res.NodCount != 10 {
		t.Fatalf("idempotency violated: nod_count = %d, want 10 (first write wins)", res.NodCount)
	}
}

func TestSaveValidation(t *testing.T) {
	sqlDB := testDB(t)
	uid := registerUser(t, sqlDB, "test-behavior-val@example.com")
	sid := insertSession(t, sqlDB, uid)
	svc := behavior.NewService(interview.NewRepo(sqlDB))
	ctx := context.Background()
	bad := samplePayload()
	bad.StressLevel = 150
	if err := svc.Save(ctx, uid, sid, bad); !errors.Is(err, behavior.ErrInvalidPayload) {
		t.Fatalf("stress out of range err = %v, want ErrInvalidPayload", err)
	}
	neg := samplePayload()
	neg.NodCount = -1
	if err := svc.Save(ctx, uid, sid, neg); !errors.Is(err, behavior.ErrInvalidPayload) {
		t.Fatalf("negative nod err = %v, want ErrInvalidPayload", err)
	}
}

func TestIsolation(t *testing.T) {
	sqlDB := testDB(t)
	uidA := registerUser(t, sqlDB, "test-behavior-iso-a@example.com")
	uidB := registerUser(t, sqlDB, "test-behavior-iso-b@example.com")
	sid := insertSession(t, sqlDB, uidA)
	svc := behavior.NewService(interview.NewRepo(sqlDB))
	ctx := context.Background()
	if err := svc.Save(ctx, uidA, sid, samplePayload()); err != nil {
		t.Fatalf("save: %v", err)
	}
	if _, err := svc.Save(ctx, uidB, sid, samplePayload()); !errors.Is(err, behavior.ErrNotFound) {
		t.Fatalf("user B save = %v, want ErrNotFound", err)
	}
	if _, err := svc.Get(ctx, uidB, sid); !errors.Is(err, behavior.ErrNotFound) {
		t.Fatalf("user B get = %v, want ErrNotFound", err)
	}
}

func TestGetNoRecord(t *testing.T) {
	sqlDB := testDB(t)
	uid := registerUser(t, sqlDB, "test-behavior-norec@example.com")
	sid := insertSession(t, sqlDB, uid)
	svc := behavior.NewService(interview.NewRepo(sqlDB))
	res, err := svc.Get(context.Background(), uid, sid)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if res.Available {
		t.Fatalf("available should be false, got %+v", res)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && go test ./internal/behavior/... -count=1 -p 1`
Expected: FAIL — `no required module provides package .../behavior` or "undefined: behavior".

- [ ] **Step 3: Implement `models.go`, `repo.go`, `service.go`**

`backend/internal/behavior/models.go`:

```go
package behavior

// Payload is the client-submitted aggregate of behavior signals.
type Payload struct {
	EmotionDistribution map[string]int `json:"emotion_distribution"`
	NodCount            int            `json:"nod_count"`
	StressLevel         int            `json:"stress_level"`
	StressSegments      []Segment      `json:"stress_segments"`
	FaceDetectedFrames  int            `json:"face_detected_frames"`
	DurationMs          int            `json:"duration_ms"`
}

type Segment struct {
	TMs int `json:"t_ms"`
	V   int `json:"v"`
}

// Result is the read model; Available=false when no record exists.
type Result struct {
	Available           bool           `json:"available"`
	EmotionDistribution map[string]int `json:"emotion_distribution,omitempty"`
	NodCount            int            `json:"nod_count,omitempty"`
	StressLevel         int            `json:"stress_level,omitempty"`
	StressSegments      []Segment      `json:"stress_segments,omitempty"`
	FaceDetectedFrames  int            `json:"face_detected_frames,omitempty"`
	DurationMs          int            `json:"duration_ms,omitempty"`
}
```

`backend/internal/behavior/repo.go` (only the SQL + scan; validation lives in service):

```go
package behavior

import (
	"database/sql"
	"encoding/json"
	"errors"

	"github.com/go-sql-driver/mysql"
)

var errDuplicate = &mysql.MySQLError{Number: 1062}

type repo struct {
	db *sql.DB
}

func (r *repo) insert(sessionID, userID int64, p Payload) error {
	distJSON, err := json.Marshal(p.EmotionDistribution)
	if err != nil {
		return err
	}
	var segJSON any
	if len(p.StressSegments) > 0 {
		b, err := json.Marshal(p.StressSegments)
		if err != nil {
			return err
		}
		segJSON = string(b)
	}
	_, err = r.db.Exec(
		`INSERT INTO interview_behavior
		   (session_id, user_id, emotion_distribution, nod_count, stress_level, stress_segments, face_detected_frames, duration_ms)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		sessionID, userID, string(distJSON), p.NodCount, p.StressLevel, segJSON, p.FaceDetectedFrames, p.DurationMs,
	)
	if err != nil && isDuplicate(err) {
		return nil // idempotent: first write wins
	}
	return err
}

func (r *repo) get(sessionID int64) (*Result, error) {
	row := r.db.QueryRow(
		`SELECT emotion_distribution, nod_count, stress_level, stress_segments, face_detected_frames, duration_ms
		 FROM interview_behavior WHERE session_id = ?`, sessionID,
	)
	var distJSON, segJSON []byte
	var nod, stress, frames, dur int
	err := row.Scan(&distJSON, &nod, &stress, &segJSON, &frames, &dur)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	res := &Result{
		Available:          true,
		NodCount:           nod,
		StressLevel:        stress,
		FaceDetectedFrames: frames,
		DurationMs:         dur,
	}
	_ = json.Unmarshal(distJSON, &res.EmotionDistribution)
	if len(segJSON) > 0 {
		_ = json.Unmarshal(segJSON, &res.StressSegments)
	}
	return res, nil
}

func isDuplicate(err error) bool {
	var me *mysql.MySQLError
	return errors.As(err, &me) && me.Number == 1062
}
```

`backend/internal/behavior/service.go` (the Service owns a `*sql.DB` directly; ownership is checked via `interview.NewRepo(db).GetByID`, matching the V8 expression precedent):

```go
package behavior

import (
	"context"
	"database/sql"
	"errors"

	"github.com/interview-assistant/backend/internal/interview"
)

var (
	ErrNotFound       = errors.New("session not found")
	ErrInvalidPayload = errors.New("invalid behavior payload")
)

type Service struct {
	db   *sql.DB
	repo *interview.Repo
}

func NewService(db *sql.DB) *Service {
	return &Service{db: db, repo: interview.NewRepo(db)}
}

func (s *Service) Save(ctx context.Context, userID, sessionID int64, p Payload) error {
	if err := validate(p); err != nil {
		return err
	}
	session, err := s.repo.GetByID(sessionID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		return err
	}
	if session.UserID != userID {
		return ErrNotFound
	}
	return (&repo{db: s.db}).insert(sessionID, userID, p)
}

func (s *Service) Get(ctx context.Context, userID, sessionID int64) (Result, error) {
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
	res, err := (&repo{db: s.db}).get(sessionID)
	if err != nil {
		return Result{}, err
	}
	if res == nil {
		return Result{Available: false}, nil
	}
	return *res, nil
}

func validate(p Payload) error {
	if p.StressLevel < 0 || p.StressLevel > 100 {
		return ErrInvalidPayload
	}
	if p.NodCount < 0 || p.FaceDetectedFrames < 0 || p.DurationMs < 0 {
		return ErrInvalidPayload
	}
	if len(p.EmotionDistribution) == 0 {
		return ErrInvalidPayload
	}
	for _, seg := range p.StressSegments {
		if seg.V < 0 || seg.V > 100 || seg.TMs < 0 {
			return ErrInvalidPayload
		}
	}
	return nil
}
```

Update the test file's `behavior.NewService` call to `behavior.NewService(sqlDB)`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && go test ./internal/behavior/... -count=1 -p 1`
Expected: all behavior tests PASS (requires live MySQL per the package convention; if MySQL is unavailable this is a known environment limitation — the DB tests follow the existing repo convention).

- [ ] **Step 5: Commit**

```bash
git add backend/internal/behavior/
git commit -m "feat(behavior): behavior signal persistence service with idempotent save"
```

---

### Task 3: Backend `internal/behavior` — HTTP handler + route registration

**Files:**
- Create: `backend/internal/behavior/handler.go`
- Modify: `backend/cmd/server/main.go` (import + `RegisterRoutes` call)

**Interfaces:**
- Consumes: `behavior.NewService(db *sql.DB) *Service`; `(*Service).Save/Get` from Task 2; `auth.Middleware(secret)` from `internal/auth`.
- Produces: `func RegisterRoutes(r *gin.Engine, db *sql.DB, secret string)` registering `GET /api/interviews/:id/behavior` and `POST /api/interviews/:id/behavior` under JWT auth.

- [ ] **Step 1: Write `handler.go`**

`backend/internal/behavior/handler.go`:

```go
package behavior

import (
	"database/sql"
	"errors"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"github.com/interview-assistant/backend/internal/auth"
)

type Handler struct {
	svc *Service
}

func NewHandler(db *sql.DB) *Handler {
	return &Handler{svc: NewService(db)}
}

func RegisterRoutes(r *gin.Engine, db *sql.DB, secret string) {
	h := NewHandler(db)
	protected := r.Group("/api/interviews")
	protected.Use(auth.Middleware(secret))
	protected.GET("/:id/behavior", h.Get)
	protected.POST("/:id/behavior", h.Save)
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
	res, err := h.svc.Get(c.Request.Context(), userID.(int64), id)
	if errors.Is(err, ErrNotFound) {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not get behavior"})
		return
	}
	c.JSON(http.StatusOK, res)
}

func (h *Handler) Save(c *gin.Context) {
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
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 64<<10) // 64KB
	var p Payload
	if err := c.ShouldBindJSON(&p); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request"})
		return
	}
	if err := h.svc.Save(c.Request.Context(), userID.(int64), id, p); err != nil {
		if errors.Is(err, ErrNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
			return
		}
		if errors.Is(err, ErrInvalidPayload) {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid payload"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not save behavior"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"status": "saved"})
}
```

- [ ] **Step 2: Register routes in main.go**

In `backend/cmd/server/main.go`, add import `"github.com/interview-assistant/backend/internal/behavior"` and register near the expression routes (after `expression.RegisterRoutes(...)`):

```go
	behavior.RegisterRoutes(r, sqlDB, cfg.JWTSecret)
```

- [ ] **Step 3: Verify build**

Run: `cd backend && go build ./...`
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add backend/internal/behavior/handler.go backend/cmd/server/main.go
git commit -m "feat(behavior): behavior HTTP routes for save and get"
```

---

### Task 4: Frontend deps + behavior API module

**Files:**
- Modify: `frontend/package.json`
- Create: `frontend/src/api/behavior.ts`

**Interfaces:**
- Consumes: `fetchJSON` from `src/api/client.ts` (auto-attaches JWT).
- Produces: `type Emotion`, `interface StressSegment`, `interface BehaviorPayload`, `type BehaviorResult`, `saveBehavior(id, payload)`, `fetchBehavior(id)`. Also re-export `Emotion` for other modules.

- [ ] **Step 1: Install TensorFlow.js deps**

Run (in `frontend/`):

```bash
npm install @tensorflow/tfjs @tensorflow-models/face-landmarks-detection
```

Expected: `package.json` gains both deps (tfjs brings `@tensorflow/tfjs-core`, `@tensorflow/tfjs-backend-webgl`, etc.).

- [ ] **Step 2: Write `api/behavior.ts`**

`frontend/src/api/behavior.ts`:

```ts
import { fetchJSON } from './client';

export type Emotion = 'smile' | 'neutral' | 'focus' | 'surprise' | 'frown';

export interface StressSegment {
  t_ms: number;
  v: number;
}

export interface BehaviorPayload {
  emotion_distribution: Partial<Record<Emotion, number>>;
  nod_count: number;
  stress_level: number;
  stress_segments: StressSegment[];
  face_detected_frames: number;
  duration_ms: number;
}

export type BehaviorResult =
  | (BehaviorPayload & { available: true })
  | { available: false };

export async function saveBehavior(
  id: number,
  payload: BehaviorPayload,
): Promise<void> {
  await fetchJSON<{ status: string }>(`/api/interviews/${id}/behavior`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function fetchBehavior(id: number): Promise<BehaviorResult> {
  const data = await fetchJSON<BehaviorPayload | { available: false }>(
    `/api/interviews/${id}/behavior`,
  );
  if ('available' in data && data.available === false) {
    return { available: false };
  }
  return { ...data, available: true };
}
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd frontend && npx tsc -b`
Expected: compiles (new file has no references yet).

- [ ] **Step 4: Commit**

```bash
git add frontend/package.json frontend/package-lock.json frontend/src/api/behavior.ts
git commit -m "feat(behavior): frontend API module + tfjs dependencies"
```

---

### Task 5: Frontend pure signal extractors (TDD)

**Files:**
- Create: `frontend/src/behavior/signalExtractors.ts`
- Test: `frontend/src/behavior/signalExtractors.test.ts`

**Interfaces:**
- Produces (used by Tasks 6–8): `interface Point {x,y,z}`, `const LANDMARKS` (FaceMesh index constants), `distance(a,b)`, `mouthAspectRatio(pts)`, `eyeAspectRatio(pts)`, `browRaiseRatio(pts)`, `pitchFromLandmarks(pts)` (returns `number`), `type Emotion`, `classifyEmotion(mar, ear, browRaise)`, `class NodDetector` (`update({t,pitch})` → count), `interface StressFactors`, `computeStressLevel(factors)`, `clamp01(n)`, helper `point(x,y,z)` for tests (export `makePoint`).

- [ ] **Step 1: Write the failing tests**

`frontend/src/behavior/signalExtractors.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  NodDetector,
  browRaiseRatio,
  classifyEmotion,
  computeStressLevel,
  distance,
  eyeAspectRatio,
  LANDMARKS,
  makePoint,
  mouthAspectRatio,
  pitchFromLandmarks,
  type Point,
} from './signalExtractors';

function face(overrides: Partial<Record<keyof typeof LANDMARKS, Point>> = {}): Point[] {
  const pts: Point[] = new Array(478).fill(null).map(() => makePoint(0.5, 0.5, 0));
  // neutral default: eye width 0.2, eye height 0.06, mouth width 0.4, mouth height 0.06
  pts[LANDMARKS.leftEyeOuter] = makePoint(0.4, 0.4, 0);
  pts[LANDMARKS.leftEyeInner] = makePoint(0.48, 0.4, 0);
  pts[LANDMARKS.leftEyeTop] = makePoint(0.44, 0.385, 0);
  pts[LANDMARKS.leftEyeBottom] = makePoint(0.44, 0.445, 0);
  pts[LANDMARKS.rightEyeOuter] = makePoint(0.6, 0.4, 0);
  pts[LANDMARKS.rightEyeInner] = makePoint(0.52, 0.4, 0);
  pts[LANDMARKS.rightEyeTop] = makePoint(0.56, 0.385, 0);
  pts[LANDMARKS.rightEyeBottom] = makePoint(0.56, 0.445, 0);
  pts[LANDMARKS.mouthLeft] = makePoint(0.4, 0.62, 0);
  pts[LANDMARKS.mouthRight] = makePoint(0.6, 0.62, 0);
  pts[LANDMARKS.mouthTop] = makePoint(0.5, 0.59, 0);
  pts[LANDMARKS.mouthBottom] = makePoint(0.5, 0.65, 0);
  pts[LANDMARKS.leftBrowInner] = makePoint(0.46, 0.33, 0);
  pts[LANDMARKS.rightBrowInner] = makePoint(0.54, 0.33, 0);
  pts[LANDMARKS.noseTip] = makePoint(0.5, 0.52, 0);
  for (const [k, v] of Object.entries(overrides) as [keyof typeof LANDMARKS, Point][]) {
    pts[LANDMARKS[k]] = v;
  }
  return pts;
}

describe('geometry helpers', () => {
  it('computes mouth aspect ratio (height/width)', () => {
    const neutral = face();
    // width 0.2, height 0.06 → 0.3
    expect(mouthAspectRatio(neutral)).toBeCloseTo(0.3, 2);
    const smile = face();
    smile[LANDMARKS.mouthBottom] = makePoint(0.5, 0.67, 0); // height 0.08
    expect(mouthAspectRatio(smile)).toBeCloseTo(0.4, 2);
  });

  it('computes eye aspect ratio (avg height/width)', () => {
    const neutral = face();
    // each eye: height 0.06, width 0.08 → 0.75
    expect(eyeAspectRatio(neutral)).toBeCloseTo(0.75, 2);
  });

  it('brow raise is positive when brow sits above eye top', () => {
    const raised = face();
    raised[LANDMARKS.leftBrowInner] = makePoint(0.46, 0.30, 0);
    raised[LANDMARKS.rightBrowInner] = makePoint(0.54, 0.30, 0);
    expect(browRaiseRatio(raised)).toBeGreaterThan(0);
  });

  it('pitch is near zero in neutral, increases when nose drops', () => {
    const neutral = face();
    expect(pitchFromLandmarks(neutral)).toBeCloseTo(0, 3);
    const dropped = face();
    dropped[LANDMARKS.noseTip] = makePoint(0.5, 0.62, 0);
    expect(pitchFromLandmarks(dropped)).toBeGreaterThan(0);
  });
});

describe('classifyEmotion', () => {
  it('classifies smile from open mouth', () => {
    expect(classifyEmotion(0.25, 0.3, 0)).toBe('smile');
  });
  it('classifies surprise from wide mouth', () => {
    expect(classifyEmotion(0.4, 0.3, 0)).toBe('surprise');
  });
  it('classifies surprise from raised brows', () => {
    expect(classifyEmotion(0.1, 0.3, 0.03)).toBe('surprise');
  });
  it('classifies frown from furrowed brows', () => {
    expect(classifyEmotion(0.1, 0.3, -0.03)).toBe('frown');
  });
  it('classifies focus from narrow eyes', () => {
    expect(classifyEmotion(0.1, 0.15, 0)).toBe('focus');
  });
  it('classifies neutral otherwise', () => {
    expect(classifyEmotion(0.1, 0.3, 0)).toBe('neutral');
  });
});

describe('NodDetector', () => {
  it('counts a single nod when pitch crosses threshold', () => {
    const d = new NodDetector(0.04, 500);
    expect(d.update({ t: 0, pitch: 0.01 })).toBe(0);
    expect(d.update({ t: 100, pitch: 0.05 })).toBe(1);
    expect(d.update({ t: 200, pitch: 0.08 })).toBe(1); // still held
    expect(d.update({ t: 300, pitch: 0.02 })).toBe(1); // released
  });

  it('does not double count within cooldown', () => {
    const d = new NodDetector(0.04, 500);
    d.update({ t: 0, pitch: 0.01 });
    d.update({ t: 100, pitch: 0.05 }); // 1
    d.update({ t: 150, pitch: 0.02 }); // release
    d.update({ t: 200, pitch: 0.06 }); // within cooldown → still 1
    expect(d.update({ t: 700, pitch: 0.01 })).toBe(1);
  });

  it('counts a second nod after cooldown expires', () => {
    const d = new NodDetector(0.04, 500);
    d.update({ t: 0, pitch: 0.01 });
    d.update({ t: 100, pitch: 0.05 }); // 1
    d.update({ t: 150, pitch: 0.01 }); // release
    d.update({ t: 900, pitch: 0.05 }); // 2 (past cooldown)
    expect(d.update({ t: 1000, pitch: 0.02 })).toBe(2);
  });
});

describe('computeStressLevel', () => {
  it('maps to 0 when all factors are calm', () => {
    expect(computeStressLevel({ blinkRatePerMin: 0, headMoveStd: 0, emotionSwitchRatePerMin: 0 })).toBe(0);
  });
  it('maps to 100 at maximum factors', () => {
    expect(computeStressLevel({ blinkRatePerMin: 40, headMoveStd: 0.05, emotionSwitchRatePerMin: 30 })).toBe(100);
  });
  it('clamps intermediate values into 0..100', () => {
    const v = computeStressLevel({ blinkRatePerMin: 80, headMoveStd: 0.1, emotionSwitchRatePerMin: 60 });
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(100);
  });
});

it('distance is euclidean', () => {
  expect(distance(makePoint(0, 0, 0), makePoint(3, 4, 0))).toBe(5);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/behavior/signalExtractors.test.ts`
Expected: FAIL — module `./signalExtractors` not found.

- [ ] **Step 3: Implement `signalExtractors.ts`**

`frontend/src/behavior/signalExtractors.ts`:

```ts
export interface Point {
  x: number;
  y: number;
  z: number;
}

export function makePoint(x: number, y: number, z = 0): Point {
  return { x, y, z };
}

export const LANDMARKS = {
  leftEyeOuter: 33,
  leftEyeInner: 133,
  leftEyeTop: 159,
  leftEyeBottom: 145,
  rightEyeOuter: 362,
  rightEyeInner: 263,
  rightEyeTop: 386,
  rightEyeBottom: 374,
  mouthLeft: 61,
  mouthRight: 291,
  mouthTop: 13,
  mouthBottom: 14,
  noseTip: 1,
  leftBrowInner: 105,
  rightBrowInner: 334,
} as const;

export function distance(a: Point, b: Point): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export function mouthAspectRatio(pts: Point[]): number {
  const w = distance(pts[LANDMARKS.mouthLeft], pts[LANDMARKS.mouthRight]);
  const h = distance(pts[LANDMARKS.mouthTop], pts[LANDMARKS.mouthBottom]);
  return w === 0 ? 0 : h / w;
}

export function eyeAspectRatio(pts: Point[]): number {
  const lh = distance(pts[LANDMARKS.leftEyeTop], pts[LANDMARKS.leftEyeBottom]);
  const lw = distance(pts[LANDMARKS.leftEyeOuter], pts[LANDMARKS.leftEyeInner]);
  const rh = distance(pts[LANDMARKS.rightEyeTop], pts[LANDMARKS.rightEyeBottom]);
  const rw = distance(pts[LANDMARKS.rightEyeOuter], pts[LANDMARKS.rightEyeInner]);
  const l = lw === 0 ? 0 : lh / lw;
  const r = rw === 0 ? 0 : rh / rw;
  return (l + r) / 2;
}

export function browRaiseRatio(pts: Point[]): number {
  const leftBrow = pts[LANDMARKS.leftBrowInner];
  const rightBrow = pts[LANDMARKS.rightBrowInner];
  const leftEyeTop = pts[LANDMARKS.leftEyeTop];
  const rightEyeTop = pts[LANDMARKS.rightEyeTop];
  return (leftEyeTop.y - leftBrow.y + (rightEyeTop.y - rightBrow.y)) / 2;
}

export function pitchFromLandmarks(pts: Point[]): number {
  const leftEye = pts[LANDMARKS.leftEyeOuter];
  const rightEye = pts[LANDMARKS.rightEyeOuter];
  const eyeMidY = (leftEye.y + rightEye.y) / 2;
  const eyeWidth = distance(leftEye, rightEye);
  const nose = pts[LANDMARKS.noseTip];
  if (eyeWidth === 0) return 0;
  return (nose.y - eyeMidY) / eyeWidth;
}

export type Emotion = 'smile' | 'neutral' | 'focus' | 'surprise' | 'frown';

export function classifyEmotion(
  mar: number,
  ear: number,
  browRaise: number,
): Emotion {
  if (mar > 0.35) return 'surprise';
  if (mar > 0.22) return 'smile';
  if (browRaise > 0.015) return 'surprise';
  if (browRaise < -0.01) return 'frown';
  if (ear < 0.18) return 'focus';
  return 'neutral';
}

export interface TimedPitch {
  t: number;
  pitch: number;
}

export class NodDetector {
  count = 0;
  private nodding = false;
  private cooldownUntil = -Infinity;

  constructor(
    private readonly threshold = 0.04,
    private readonly cooldownMs = 500,
  ) {}

  update(sample: TimedPitch): number {
    if (sample.t < this.cooldownUntil) {
      if (sample.pitch < this.threshold * 0.5) this.nodding = false;
      return this.count;
    }
    if (!this.nodding && sample.pitch >= this.threshold) {
      this.nodding = true;
      this.count += 1;
      this.cooldownUntil = sample.t + this.cooldownMs;
    } else if (this.nodding && sample.pitch < this.threshold * 0.5) {
      this.nodding = false;
    }
    return this.count;
  }
}

export interface StressFactors {
  blinkRatePerMin: number;
  headMoveStd: number;
  emotionSwitchRatePerMin: number;
}

export function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

export function computeStressLevel(f: StressFactors): number {
  const blink = clamp01(f.blinkRatePerMin / 40);
  const move = clamp01(f.headMoveStd / 0.05);
  const switchRate = clamp01(f.emotionSwitchRatePerMin / 30);
  const raw = 0.45 * blink + 0.35 * move + 0.2 * switchRate;
  return Math.round(clamp01(raw) * 100);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/behavior/signalExtractors.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/behavior/signalExtractors.ts frontend/src/behavior/signalExtractors.test.ts
git commit -m "feat(behavior): pure signal extractors for emotion/nod/stress"
```

---

### Task 6: Frontend aggregator (TDD)

**Files:**
- Create: `frontend/src/behavior/aggregator.ts`
- Test: `frontend/src/behavior/aggregator.test.ts`

**Interfaces:**
- Consumes: from Task 5 — `Emotion`, `NodDetector`, `computeStressLevel`, `clamp01`, `StressFactors`.
- Produces: `interface FrameSignal { t, emotion, ear, pitch, browRaise }`; `interface AggregateOptions { segmentIntervalMs? }` (default 15000); `class BehaviorAggregator` with `push(frame: FrameSignal): void`, `build(): BehaviorPayload` (side-effect-free; returns a fresh snapshot each call, so it may be called repeatedly during live updates and once at stop), `get durationMs(): number`.

- [ ] **Step 1: Write the failing tests**

`frontend/src/behavior/aggregator.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { BehaviorAggregator, type FrameSignal } from './aggregator';
import type { Emotion } from './signalExtractors';

function frame(t: number, emotion: Emotion, pitch = 0.01): FrameSignal {
  return { t, emotion, ear: 0.3, pitch, browRaise: 0 };
}

describe('BehaviorAggregator', () => {
  it('counts emotion frames into a distribution', () => {
    const agg = new BehaviorAggregator();
    agg.push(frame(0, 'smile'));
    agg.push(frame(100, 'smile'));
    agg.push(frame(200, 'neutral'));
    const out = agg.build();
    expect(out.emotion_distribution).toEqual({ smile: 2, neutral: 1 });
  });

  it('counts nods from pitch crossings', () => {
    const agg = new BehaviorAggregator({ segmentIntervalMs: 1000 });
    const seq: [number, number][] = [
      [0, 0.01], [100, 0.01], [300, 0.05], [400, 0.01],
      [900, 0.05], [1000, 0.01],
    ];
    for (const [t, pitch] of seq) agg.push(frame(t, 'neutral', pitch));
    const out = agg.build();
    expect(out.nod_count).toBe(2);
  });

  it('produces stress segments at the configured interval', () => {
    const agg = new BehaviorAggregator({ segmentIntervalMs: 1000 });
    for (let t = 0; t <= 2500; t += 100) {
      agg.push(frame(t, 'neutral', 0.01));
    }
    const out = agg.build();
    // segments at t = 0, 1000, 2000 → 3 segments
    expect(out.stress_segments.length).toBe(3);
    expect(out.stress_segments[0].t_ms).toBe(0);
    expect(out.stress_segments[1].t_ms).toBe(1000);
  });

  it('computes duration and frame count', () => {
    const agg = new BehaviorAggregator();
    agg.push(frame(100, 'neutral'));
    agg.push(frame(200, 'neutral'));
    agg.push(frame(300, 'neutral'));
    const out = agg.build();
    expect(out.duration_ms).toBe(200);
    expect(out.face_detected_frames).toBe(3);
  });

  it('build is safe to call after empty input', () => {
    const out = new BehaviorAggregator().build();
    expect(out.emotion_distribution).toEqual({});
    expect(out.nod_count).toBe(0);
    expect(out.stress_segments).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/behavior/aggregator.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `aggregator.ts`**

`frontend/src/behavior/aggregator.ts`:

```ts
import {
  NodDetector,
  computeStressLevel,
  type Emotion,
  type StressFactors,
} from './signalExtractors';
import type { BehaviorPayload } from '../api/behavior';

export interface FrameSignal {
  t: number;
  emotion: Emotion;
  ear: number;
  pitch: number;
  browRaise: number;
}

export interface AggregateOptions {
  segmentIntervalMs?: number;
}

const DEFAULT_SEGMENT_INTERVAL_MS = 15000;

export class BehaviorAggregator {
  private frames: FrameSignal[] = [];
  private readonly nodDetector = new NodDetector(0.04, 500);
  private readonly segmentIntervalMs: number;
  private segmentStart = 0;
  private segmentFrames: FrameSignal[] = [];
  private segments: { t_ms: number; v: number }[] = [];

  constructor(opts: AggregateOptions = {}) {
    this.segmentIntervalMs = opts.segmentIntervalMs ?? DEFAULT_SEGMENT_INTERVAL_MS;
  }

  push(frame: FrameSignal): void {
    if (this.frames.length === 0) {
      this.segmentStart = frame.t;
    }
    this.frames.push(frame);
    this.segmentFrames.push(frame);
    this.nodDetector.update({ t: frame.t, pitch: frame.pitch });
    if (frame.t - this.segmentStart >= this.segmentIntervalMs) {
      this.segments.push({ t_ms: this.segmentStart, v: stressOf(this.segmentFrames) });
      this.segmentFrames = [];
      this.segmentStart = frame.t;
    }
  }

  // build() is side-effect-free: it never mutates segment state, so it can be
  // called repeatedly (e.g. for live stress updates in useBehaviorAnalysis).
  build(): BehaviorPayload {
    const distribution: Partial<Record<Emotion, number>> = {};
    for (const f of this.frames) {
      distribution[f.emotion] = (distribution[f.emotion] ?? 0) + 1;
    }
    const segments = [...this.segments];
    if (this.segmentFrames.length > 0) {
      segments.push({ t_ms: this.segmentStart, v: stressOf(this.segmentFrames) });
    }
    return {
      emotion_distribution: distribution,
      nod_count: this.nodDetector.count,
      stress_level: stressOf(this.frames),
      stress_segments: segments,
      face_detected_frames: this.frames.length,
      duration_ms: this.durationMs,
    };
  }

  get durationMs(): number {
    if (this.frames.length === 0) return 0;
    return this.frames[this.frames.length - 1].t - this.frames[0].t;
  }
}

function stressOf(frames: FrameSignal[]): number {
  if (frames.length < 2) return 0;
  let blinks = 0;
  let prevEar = frames[0].ear;
  for (let i = 1; i < frames.length; i++) {
    // a blink: EAR collapses below threshold then recovers
    if (prevEar >= 0.18 && frames[i].ear < 0.12) blinks++;
    prevEar = frames[i].ear;
  }
  const elapsedMin = (frames[frames.length - 1].t - frames[0].t) / 60000 || 1;
  const blinkRatePerMin = blinks / elapsedMin;

  const pitches = frames.map((f) => f.pitch);
  const mean = pitches.reduce((a, b) => a + b, 0) / pitches.length;
  const variance =
    pitches.reduce((a, b) => a + (b - mean) * (b - mean), 0) / pitches.length;
  const headMoveStd = Math.sqrt(variance);

  let switches = 0;
  for (let i = 1; i < frames.length; i++) {
    if (frames[i].emotion !== frames[i - 1].emotion) switches++;
  }
  const emotionSwitchRatePerMin = switches / elapsedMin;

  const factors: StressFactors = { blinkRatePerMin, headMoveStd, emotionSwitchRatePerMin };
  return computeStressLevel(factors);
}
```

> Note: `stressOf` needs `ear` to vary for blink detection, but tests use constant `ear: 0.3` (0 blinks) — that's fine because the tests only assert segment count/timestamps and distribution, not exact stress values. `build()` is side-effect-free, so the hook's repeated live-stress calls are safe.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/behavior/aggregator.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/behavior/aggregator.ts frontend/src/behavior/aggregator.test.ts
git commit -m "feat(behavior): frame aggregator producing behavior payload"
```

---

### Task 7: Frontend camera feed + face landmark detector

**Files:**
- Create: `frontend/src/behavior/cameraFeed.ts`
- Create: `frontend/src/behavior/FaceLandmarkDetector.ts`

**Interfaces:**
- Consumes: `Point` from `signalExtractors.ts`.
- Produces: `interface CameraFeed { video, stream, stop() }`; `startCameraFeed(constraints?): Promise<CameraFeed>`; `interface LandmarkDetector { load(): Promise<void>; detect(video): Promise<Point[] | null>; dispose(): void }`; `loadFaceLandmarkDetector(): Promise<LandmarkDetector>`.

- [ ] **Step 1: Write `cameraFeed.ts`**

`frontend/src/behavior/cameraFeed.ts`:

```ts
export interface CameraFeed {
  video: HTMLVideoElement;
  stream: MediaStream;
  stop(): void;
}

export async function startCameraFeed(
  constraints: MediaStreamConstraints = {
    video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
    audio: false,
  },
): Promise<CameraFeed> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('getUserMedia unsupported');
  }
  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  const video = document.createElement('video');
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  await video.play();
  return {
    video,
    stream,
    stop() {
      for (const track of stream.getTracks()) track.stop();
    },
  };
}
```

- [ ] **Step 2: Write `FaceLandmarkDetector.ts`**

`frontend/src/behavior/FaceLandmarkDetector.ts`:

```ts
import type { Point } from './signalExtractors';

export interface LandmarkDetector {
  load(): Promise<void>;
  detect(video: HTMLVideoElement): Promise<Point[] | null>;
  dispose(): void;
}

interface FaceLandmarksResult {
  keypoints: { x: number; y: number; z: number }[];
}

interface DetectorLike {
  estimateFaces(input: { source: HTMLVideoElement }): Promise<FaceLandmarksResult[]>;
}

let cached: LandmarkDetector | null = null;

export async function loadFaceLandmarkDetector(): Promise<LandmarkDetector> {
  if (cached) return cached;
  const [
    { createDetector, SupportedModels },
  ] = await Promise.all([
    import('@tensorflow-models/face-landmarks-detection'),
    import('@tensorflow/tfjs'),
  ]);
  const raw = (await createDetector(
    SupportedModels.MediaPipeFaceMesh,
    { runtime: 'tfjs', maxFaces: 1 },
  )) as DetectorLike;

  const detector: LandmarkDetector = {
    async load() {
      // createDetector already loads weights; kept for interface symmetry.
    },
    async detect(video) {
      const faces = await raw.estimateFaces({ source: video });
      if (!faces || faces.length === 0 || faces[0].keypoints.length === 0) {
        return null;
      }
      const w = video.videoWidth || 1;
      const h = video.videoHeight || 1;
      const pts: Point[] = new Array(478);
      for (let i = 0; i < 478 && i < faces[0].keypoints.length; i++) {
        const k = faces[0].keypoints[i];
        pts[i] = { x: k.x / w, y: k.y / h, z: k.z / Math.max(w, h) };
      }
      return pts;
    },
    dispose() {
      cached = null;
    },
  };
  cached = detector;
  return detector;
}
```

> Note: `estimateFaces` keypoints from `@tensorflow-models/face-landmarks-detection` are pixel-space; normalization by video dimensions keeps downstream extractors scale-independent. If a future model version returns normalized coordinates, this normalize step is still harmless (values stay 0–1).

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd frontend && npx tsc -b`
Expected: compiles.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/behavior/cameraFeed.ts frontend/src/behavior/FaceLandmarkDetector.ts
git commit -m "feat(behavior): camera feed and face landmark detector"
```

---

### Task 8: Frontend `useBehaviorAnalysis` hook (TDD with mocks)

**Files:**
- Create: `frontend/src/behavior/useBehaviorAnalysis.ts`
- Test: `frontend/src/behavior/useBehaviorAnalysis.test.ts`

**Interfaces:**
- Consumes: `startCameraFeed`, `CameraFeed`; `LandmarkDetector`, `loadFaceLandmarkDetector`; `signalExtractors` helpers (`mouthAspectRatio`, `eyeAspectRatio`, `browRaiseRatio`, `pitchFromLandmarks`, `classifyEmotion`); `BehaviorAggregator`; `saveBehavior`, `BehaviorPayload` from `api/behavior`.
- Produces: `type BehaviorStatus = 'idle' | 'loading-model' | 'running' | 'failed'`; `interface UseBehaviorOptions { enabled: boolean; sessionId: number; cameraFeed?: () => Promise<CameraFeed>; detectorLoader?: () => Promise<LandmarkDetector>; raf?: (cb) => number; cancelRaf?: (id) => void; now?: () => number }`; `interface BehaviorAnalysis { status, liveStress: number | null, start(), stop(): Promise<void> }`. `stop()` stops the loop + camera, builds the aggregate, and if it has ≥ 2 frames, calls `saveBehavior(sessionId, payload)` (errors swallowed). Start returns silently if `enabled` is false or already running.

- [ ] **Step 1: Write the failing tests**

`frontend/src/behavior/useBehaviorAnalysis.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { BehaviorAggregator } from './aggregator';
import { makePoint, type Point } from './signalExtractors';

// Keep a stable fake point array for detect() results.
function fakeLandmarks(): Point[] {
  const pts: Point[] = new Array(478).fill(null).map(() => makePoint(0.5, 0.5, 0));
  // neutral face (see signalExtractors.test.ts for the same layout)
  pts[33] = makePoint(0.4, 0.4, 0);
  pts[133] = makePoint(0.48, 0.4, 0);
  pts[159] = makePoint(0.44, 0.385, 0);
  pts[145] = makePoint(0.44, 0.445, 0);
  pts[362] = makePoint(0.6, 0.4, 0);
  pts[263] = makePoint(0.52, 0.4, 0);
  pts[386] = makePoint(0.56, 0.385, 0);
  pts[374] = makePoint(0.56, 0.445, 0);
  pts[61] = makePoint(0.4, 0.62, 0);
  pts[291] = makePoint(0.6, 0.62, 0);
  pts[13] = makePoint(0.5, 0.59, 0);
  pts[14] = makePoint(0.5, 0.65, 0);
  pts[105] = makePoint(0.46, 0.33, 0);
  pts[334] = makePoint(0.54, 0.33, 0);
  pts[1] = makePoint(0.5, 0.52, 0);
  return pts;
}

vi.mock('../api/behavior', () => ({
  saveBehavior: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./cameraFeed', () => ({
  startCameraFeed: vi.fn(),
}));

vi.mock('./FaceLandmarkDetector', () => ({
  loadFaceLandmarkDetector: vi.fn(),
}));

import { saveBehavior } from '../api/behavior';
import { startCameraFeed } from './cameraFeed';
import { loadFaceLandmarkDetector } from './FaceLandmarkDetector';
import { useBehaviorAnalysis } from './useBehaviorAnalysis';

describe('useBehaviorAnalysis', () => {
  let frames: number;
  let time: number;

  beforeEach(() => {
    frames = 0;
    time = 0;
    vi.clearAllMocks();
    const video = { videoWidth: 640, videoHeight: 480 } as HTMLVideoElement;
    const stream = { getTracks: () => [{ stop: vi.fn() }] } as unknown as MediaStream;
    vi.mocked(startCameraFeed).mockResolvedValue({ video, stream, stop: vi.fn() } as never);
    const detector = {
      load: vi.fn().mockResolvedValue(undefined),
      detect: vi.fn().mockResolvedValue(fakeLandmarks()),
      dispose: vi.fn(),
    };
    vi.mocked(loadFaceLandmarkDetector).mockResolvedValue(detector as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does nothing when disabled', async () => {
    const { result } = renderHook(() =>
      useBehaviorAnalysis({ enabled: false, sessionId: 1 }),
    );
    await act(async () => {
      await result.current.start();
    });
    expect(startCameraFeed).not.toHaveBeenCalled();
    expect(result.current.status).toBe('idle');
  });

  it('starts running and saves aggregate on stop', async () => {
    const { result } = renderHook(() =>
      useBehaviorAnalysis({
        enabled: true,
        sessionId: 7,
        // fire the rAF loop 3 times to accumulate >= 2 frames (save guard)
        raf: (cb) => {
          if (frames < 3) {
            frames += 1;
            cb(0);
          }
          return frames;
        },
        cancelRaf: vi.fn(),
        now: () => {
          time += 100;
          return time;
        },
      }),
    );
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.status).toBe('running');
    await act(async () => {
      await result.current.stop();
    });
    expect(saveBehavior).toHaveBeenCalledTimes(1);
    const payload = vi.mocked(saveBehavior).mock.calls[0][1];
    expect(payload.face_detected_frames).toBeGreaterThanOrEqual(2);
  });

  it('swallows save errors without throwing', async () => {
    vi.mocked(saveBehavior).mockRejectedValueOnce(new Error('network'));
    const { result } = renderHook(() =>
      useBehaviorAnalysis({
        enabled: true,
        sessionId: 1,
        raf: (cb) => {
          if (frames < 3) {
            frames += 1;
            cb(0);
          }
          return frames;
        },
        cancelRaf: vi.fn(),
        now: () => {
          time += 100;
          return time;
        },
      }),
    );
    await act(async () => {
      await result.current.start();
    });
    await act(async () => {
      await result.current.stop();
    });
    expect(result.current.status).toBe('idle');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/behavior/useBehaviorAnalysis.test.ts`
Expected: FAIL — module `./useBehaviorAnalysis` not found.

- [ ] **Step 3: Implement `useBehaviorAnalysis.ts`**

`frontend/src/behavior/useBehaviorAnalysis.ts`:

```ts
import { useCallback, useRef, useState } from 'react';
import { saveBehavior, type BehaviorPayload } from '../api/behavior';
import { BehaviorAggregator, type FrameSignal } from './aggregator';
import {
  browRaiseRatio,
  classifyEmotion,
  eyeAspectRatio,
  mouthAspectRatio,
  pitchFromLandmarks,
} from './signalExtractors';
import type { CameraFeed } from './cameraFeed';
import { startCameraFeed } from './cameraFeed';
import type { LandmarkDetector } from './FaceLandmarkDetector';
import { loadFaceLandmarkDetector } from './FaceLandmarkDetector';

export type BehaviorStatus = 'idle' | 'loading-model' | 'running' | 'failed';

export interface UseBehaviorOptions {
  enabled: boolean;
  sessionId: number;
  cameraFeed?: () => Promise<CameraFeed>;
  detectorLoader?: () => Promise<LandmarkDetector>;
  raf?: (cb: FrameRequestCallback) => number;
  cancelRaf?: (id: number) => void;
  now?: () => number;
}

export interface BehaviorAnalysis {
  status: BehaviorStatus;
  liveStress: number | null;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function useBehaviorAnalysis(opts: UseBehaviorOptions): BehaviorAnalysis {
  const [status, setStatus] = useState<BehaviorStatus>('idle');
  const [liveStress, setLiveStress] = useState<number | null>(null);
  const runningRef = useRef(false);
  const cameraRef = useRef<CameraFeed | null>(null);
  const detectorRef = useRef<LandmarkDetector | null>(null);
  const aggRef = useRef<BehaviorAggregator | null>(null);
  const rafIdRef = useRef<number | null>(null);
  const lastLiveRef = useRef(0);

  const getRaf = () => opts.raf ?? ((cb) => requestAnimationFrame(cb));
  const getCancelRaf = () => opts.cancelRaf ?? ((id) => cancelAnimationFrame(id));
  const getNow = () => opts.now ?? (() => Date.now());

  const cleanup = useCallback(() => {
    const cancel = getCancelRaf();
    if (rafIdRef.current != null) {
      cancel(rafIdRef.current);
      rafIdRef.current = null;
    }
    cameraRef.current?.stop();
    cameraRef.current = null;
    detectorRef.current?.dispose();
    detectorRef.current = null;
    aggRef.current = null;
    runningRef.current = false;
  }, [getCancelRaf]);

  const stop = useCallback(async () => {
    if (!runningRef.current) {
      setStatus('idle');
      return;
    }
    const agg = aggRef.current;
    cleanup();
    setStatus('idle');
    setLiveStress(null);
    if (!agg) return;
    const payload: BehaviorPayload = agg.build();
    if (payload.face_detected_frames < 2) return; // not enough data
    try {
      await saveBehavior(opts.sessionId, payload);
    } catch {
      // silent: never block navigation/report
    }
  }, [cleanup, opts.sessionId]);

  const start = useCallback(async () => {
    if (!opts.enabled || runningRef.current) return;
    runningRef.current = true;
    setStatus('loading-model');
    aggRef.current = new BehaviorAggregator();
    const now = getNow();
    try {
      const camera =
        opts.cameraFeed != null
          ? await opts.cameraFeed()
          : await startCameraFeed();
      cameraRef.current = camera;
      const detector =
        opts.detectorLoader != null
          ? await opts.detectorLoader()
          : await loadFaceLandmarkDetector();
      detectorRef.current = detector;
      await detector.load();
      setStatus('running');

      const loop = () => {
        if (!runningRef.current) return;
        const t = now();
        void detector.detect(camera.video).then((pts) => {
          if (!runningRef.current || !pts || !aggRef.current) {
            return;
          }
          const mar = mouthAspectRatio(pts);
          const ear = eyeAspectRatio(pts);
          const browRaise = browRaiseRatio(pts);
          const pitch = pitchFromLandmarks(pts);
          const frame: FrameSignal = {
            t,
            emotion: classifyEmotion(mar, ear, browRaise),
            ear,
            pitch,
            browRaise,
          };
          aggRef.current.push(frame);
          if (t - lastLiveRef.current >= 1000) {
            lastLiveRef.current = t;
            setLiveStress(aggRef.current.build().stress_level);
          }
        });
        rafIdRef.current = getRaf()(loop);
      };
      loop();
    } catch {
      cleanup();
      setStatus('failed');
    }
  }, [opts.enabled, opts.cameraFeed, opts.detectorLoader, getRaf, getNow, cleanup]);

  return { status, liveStress, start, stop };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/behavior/useBehaviorAnalysis.test.ts`
Expected: PASS (mocked feed/detector; save called once on stop; errors swallowed).

- [ ] **Step 5: Verify full frontend test suite + type check**

Run: `cd frontend && npx tsc -b && npm run test` (with the `NODE_OPTIONS` pipefix preload from Global Constraints; do NOT run `npm run build` — see Global Constraints)
Expected: all tests pass and `tsc -b` succeeds.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/behavior/useBehaviorAnalysis.ts frontend/src/behavior/useBehaviorAnalysis.test.ts
git commit -m "feat(behavior): useBehaviorAnalysis hook wiring camera to aggregation"
```

---

### Task 9: Create page toggle + interview API `camera_enabled`

**Files:**
- Modify: `frontend/src/api/interviews.ts` (CreateInterviewInput, CreateFromBankInput, Interview type)
- Modify: `frontend/src/pages/CreateInterviewPage.tsx`

**Interfaces:**
- Consumes: backend `camera_enabled` in session JSON (Task 1).
- Produces: `CreateInterviewInput.camera_enabled?: boolean`; `CreateFromBankInput.camera_enabled?: boolean`; `Interview.camera_enabled: boolean`.

- [ ] **Step 1: Update API types**

In `frontend/src/api/interviews.ts`:
- `CreateInterviewInput`: add `camera_enabled?: boolean;`
- `CreateFromBankInput`: add `camera_enabled?: boolean;`
- `Interview`: add `camera_enabled: boolean;`

- [ ] **Step 2: Add the toggle state**

In `frontend/src/pages/CreateInterviewPage.tsx`:
- Add state: `const [cameraEnabled, setCameraEnabled] = useState(false);`
- Pass to both create calls:

```ts
      const created = await createInterview({
        job_jd: trimmedJd,
        mode,
        input_mode: inputMode,
        persona,
        difficulty,
        company_style: companyStyle,
        camera_enabled: cameraEnabled,
        ...(trimmedResume ? { resume_text: trimmedResume } : {}),
        ...(precheck && !precheckStale ? { precheck_gaps: precheck.gaps } : {}),
      });
```

and in `handleFocusedPractice`:

```ts
      const created = await createInterviewFromBank({
        question_ids: items.map((q) => q.id),
        mode,
        input_mode: inputMode,
        persona,
        difficulty,
        company_style: companyStyle,
        camera_enabled: cameraEnabled,
      });
```

- [ ] **Step 3: Add the checkbox UI**

In the form JSX (after the 「企业风格」 field, before the submit button):

```tsx
          <div className="interview-field">
            <label className="interview-check-row" htmlFor="camera-enabled">
              <input
                id="camera-enabled"
                type="checkbox"
                checked={cameraEnabled}
                onChange={(e) => setCameraEnabled(e.target.checked)}
              />
              开启摄像头分析（可选）
            </label>
            <p className="interview-field-hint">
              面试中采集表情/行为信号（情绪、紧张度、点头），仅在本地分析，不上传画面。
            </p>
          </div>
```

- [ ] **Step 4: Verify type check + existing tests**

Run: `cd frontend && npx tsc -b && npm run test` (with the `NODE_OPTIONS` pipefix preload from Global Constraints; do NOT run `npm run build` — see Global Constraints)
Expected: type check passes, tests pass.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api/interviews.ts frontend/src/pages/CreateInterviewPage.tsx
git commit -m "feat(behavior): camera toggle on create interview page"
```

---

### Task 10: Interview room integration (light indicator + end upload)

**Files:**
- Modify: `frontend/src/pages/InterviewRoomPage.tsx`
- Modify (optional): `frontend/src/pages/InterviewPages.css` (indicator styles)

**Interfaces:**
- Consumes: `useBehaviorAnalysis` (Task 8); `Interview.camera_enabled` (Task 9); existing `handleForceEnd` and WS `done` navigation.

- [ ] **Step 1: Hook the analysis into the room**

In `frontend/src/pages/InterviewRoomPage.tsx`:
- Import `useBehaviorAnalysis` and `useEffect` (already imported).
- Add state for the session's camera flag: `const [cameraEnabled, setCameraEnabled] = useState(false);`
- In `loadAndConnect`, after `setCompanyStyle(data.company_style);` add `setCameraEnabled(data.camera_enabled);`
- Wire the hook (must be called unconditionally, before any early returns):

```ts
  const behavior = useBehaviorAnalysis({
    enabled: cameraEnabled,
    sessionId: interviewId,
  });
```

- Start analysis once camera is enabled and the room is connected (after `connect()` in `loadAndConnect`):

```ts
        connect();
        if (data.camera_enabled) {
          void behavior.start();
        }
```

> Note: `behavior` is a fresh object each render; to avoid stale closures use a ref mirroring `start`/`stop`:

```ts
  const behaviorStartRef = useRef<() => Promise<void>>(async () => {});
  const behaviorStopRef = useRef<() => Promise<void>>(async () => {});
  behaviorStartRef.current = behavior.start;
  behaviorStopRef.current = behavior.stop;
```

Then use `behaviorStartRef.current()` / `behaviorStopRef.current()` everywhere (including in the effect and handlers). This avoids the effect's stale-closure problem.

- [ ] **Step 2: Add the light indicator**

In the room JSX, near the status line (after `{statusLine && ...}`), add:

```tsx
            {behavior.status === 'loading-model' && (
              <p className="interview-room-status">正在加载摄像头分析…</p>
            )}
            {behavior.status === 'running' && (
              <p className="interview-room-status">
                <span
                  className={`behavior-light behavior-light--${
                    behavior.liveStress == null
                      ? 'ok'
                      : behavior.liveStress < 40
                        ? 'ok'
                        : behavior.liveStress < 70
                          ? 'mid'
                          : 'high'
                  }`}
                />
                摄像头分析中…
              </p>
            )}
```

- [ ] **Step 3: Stop + upload on force-end and on WS done**

In `handleForceEnd`, before `navigate(...)`, add `await behaviorStopRef.current();` (inside the existing try, before the navigate). Since `behavior.stop()` itself awaits `saveBehavior` (with a 20s fetch timeout cap), this can delay navigation; acceptable per spec ("正在生成报告，请稍候…" is already shown). Wrap with a safety so navigation is not blocked longer than ~3s:

```ts
    try {
      await endInterview(interviewId);
      await Promise.race([
        behaviorStopRef.current(),
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ]);
      if (!doneRef.current) {
        doneRef.current = true;
        navigate(`/interviews/${interviewId}/report`, { replace: true });
      }
    }
```

In the WS `done` handler (`handleMessage`, `case 'done':`), replace the immediate navigate with:

```ts
        case 'done':
          doneRef.current = true;
          setThinking(false);
          setVoicePhase('idle');
          voicePlayerRef.current?.stop();
          await Promise.race([
            behaviorStopRef.current(),
            new Promise((resolve) => setTimeout(resolve, 3000)),
          ]);
          navigate(`/interviews/${interviewId}/report`, { replace: true });
          break;
```

(`handleMessage` is already `useCallback` — add `async`.)

- [ ] **Step 4: Add minimal CSS**

In `frontend/src/pages/InterviewPages.css` (append):

```css
.behavior-light {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-right: 6px;
  vertical-align: middle;
}
.behavior-light--ok { background: #2ecc71; }
.behavior-light--mid { background: #f5a623; }
.behavior-light--high { background: #ee0000; }
.behavior-light--off { background: #aaa; }
```

- [ ] **Step 5: Verify type check + tests**

Run: `cd frontend && npx tsc -b && npm run test` (with the `NODE_OPTIONS` pipefix preload from Global Constraints; do NOT run `npm run build` — see Global Constraints)
Expected: type check + tests pass.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/InterviewRoomPage.tsx frontend/src/pages/InterviewPages.css
git commit -m "feat(behavior): room integration with light indicator and end upload"
```

---

### Task 11: Report page behavior card

**Files:**
- Modify: `frontend/src/pages/ReportPage.tsx`
- Modify (optional): `frontend/src/pages/InterviewPages.css`

**Interfaces:**
- Consumes: `fetchBehavior`, `BehaviorResult`, `Emotion` from `api/behavior.ts` (Task 4); existing `profile-card` styling and `interview-section-title`.

- [ ] **Step 1: Fetch behavior on load**

In `frontend/src/pages/ReportPage.tsx`:
- Import `fetchBehavior, type BehaviorResult, type Emotion } from '../api/behavior';`
- Add state: `const [behavior, setBehavior] = useState<BehaviorResult | null>(null);`
- In the existing `useEffect` (same one that calls `fetchExpression`), add:

```ts
    fetchBehavior(interviewId)
      .then((res) => {
        if (!cancelled) setBehavior(res);
      })
      .catch(() => {
        /* silent: hide behavior section on error */
      });
```

- [ ] **Step 2: Render the auxiliary card**

Add `EMOTION_LABELS` near `DIMENSION_LABELS`:

```ts
const EMOTION_LABELS: Record<Emotion, string> = {
  smile: '微笑',
  neutral: '中性',
  focus: '专注',
  surprise: '惊讶',
  frown: '皱眉',
};
```

In the JSX, after the `{expression && (...)}` block (before the `report-model-version` line), add:

```tsx
            {behavior && behavior.available && (
              <div className="profile-card">
                <h3 className="interview-section-title">行为信号（辅助参考）</h3>
                <p className="behavior-note">
                  本指标基于表情动作统计，仅供参考，不计入评分。
                </p>
                {behavior.face_detected_frames > 0 && behavior.duration_ms > 0
                  ? (() => {
                      const total = Object.values(
                        behavior.emotion_distribution,
                      ).reduce((a, b) => a + b, 0);
                      const pct = (v: number) =>
                        total > 0 ? Math.round((v / total) * 100) : 0;
                      return (
                        <>
                          <p>
                            情绪分布：
                            {(
                              Object.entries(
                                behavior.emotion_distribution,
                              ) as [Emotion, number][]
                            )
                              .map(
                                ([k, v]) =>
                                  `${EMOTION_LABELS[k] ?? k} ${pct(v)}%`,
                              )
                              .join(' / ')}
                          </p>
                          <p>点头：{behavior.nod_count} 次</p>
                          <p>
                            紧张度：{behavior.stress_level} / 100
                            {behavior.stress_level < 40
                              ? '（较放松）'
                              : behavior.stress_level < 70
                                ? '（中等）'
                                : '（偏高）'}
                          </p>
                          {behavior.stress_segments.length > 0 && (
                            <p>
                              紧张度走势：分段
                              {behavior.stress_segments.length} 段（{behavior.duration_ms / 1000}s
                              有效分析）
                            </p>
                          )}
                        </>
                      );
                    })()
                  : (
                    <p>未检测到清晰人脸，数据可能不准确</p>
                  )}
              </div>
            )}
```

- [ ] **Step 3: Add CSS for the note**

In `frontend/src/pages/InterviewPages.css` (append):

```css
.behavior-note {
  color: #888;
  font-size: 12px;
  margin: 0 0 8px;
}
```

- [ ] **Step 4: Verify type check + tests**

Run: `cd frontend && npx tsc -b && npm run test` (with the `NODE_OPTIONS` pipefix preload from Global Constraints; do NOT run `npm run build` — see Global Constraints)
Expected: type check + tests pass.

- [ ] **Step 5: Manual E2E (needs running stack)**

Start backend (`go run ./cmd/server`) + frontend (`npm run dev`), create an interview with the camera toggle checked, grant camera permission, let the interview run, end it, open the report. Expected: 「行为信号（辅助参考）」card shows emotion distribution, nod count, stress level; no video is uploaded (verify network tab has no image/video POST).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/ReportPage.tsx frontend/src/pages/InterviewPages.css
git commit -m "feat(behavior): behavior signal card on report page"
```

---

### Task 12: Full regression + acceptance sweep

**Files:** none (verification only).

- [ ] **Step 1: Backend tests**

Run: `cd backend && go test ./... -count=1 -p 1`
Expected: all packages pass (MySQL-backed integration tests need a live DB; if unavailable, report which packages were skipped as environment-limited and confirm `go build ./...` + `go vet ./...` pass).

- [ ] **Step 2: Frontend tests + type check + lint**

Run: `cd frontend && npx tsc -b && npm run test && npm run lint` (with the `NODE_OPTIONS` pipefix preload from Global Constraints; do NOT run `npm run build` — see Global Constraints)
Expected: all green.

- [ ] **Step 3: Acceptance checklist (manual)**

Walk B1–B9 from the spec:
- B1: toggle present + default off + persisted → `camera_enabled` in `GET /api/interviews/:id`.
- B2: toggled session starts camera + light indicator.
- B3: network tab shows no frame/video upload (only the final `POST .../behavior`).
- B4: POST once at end; repeat POST is ignored (first wins).
- B5: GET returns the aggregate; no record → `available:false`.
- B6: report card renders, marked 辅助参考.
- B7: untoggled / no getUserMedia / denied permission / model-load failure → silent degradation, interview works, no card.
- B8: other user's session → 404 on both routes.
- B9: regression suite green.

- [ ] **Step 4: Final commit if any fixes were made**

```bash
git add -A
git commit -m "fix(behavior): address acceptance findings"
```

---

## Execution Handoff

Plan complete and saved. Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints.

**Important note for execution:** the working tree on `main` currently has unrelated in-progress changes (digitalhuman/livestream removal, WPS speech, OCR plan) that touch several files this feature also modifies (`InterviewRoomPage.tsx`, `CreateInterviewPage.tsx`, `api/interviews.ts`, `interview/models.go`, `repo.go`, `service.go`, `handler.go`). Before implementation we must decide how to handle this — either commit/stash those in-progress changes first, or implement on top of the current dirty tree.
