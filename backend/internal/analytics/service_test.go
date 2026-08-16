package analytics_test

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/interview-assistant/backend/internal/analytics"
	"github.com/interview-assistant/backend/internal/db"
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
			WHERE u.email LIKE 'test-trends-%@example.com'`)
		_, _ = sqlDB.Exec(`
			DELETE q FROM interview_questions q
			INNER JOIN interview_sessions s ON s.id = q.session_id
			INNER JOIN users u ON u.id = s.user_id
			WHERE u.email LIKE 'test-trends-%@example.com'`)
		_, _ = sqlDB.Exec(`
			DELETE s FROM interview_sessions s
			INNER JOIN users u ON u.id = s.user_id
			WHERE u.email LIKE 'test-trends-%@example.com'`)
		_, _ = sqlDB.Exec("DELETE FROM users WHERE email LIKE 'test-trends-%@example.com'")
		sqlDB.Close()
	})
	return sqlDB
}

func testRouter(t *testing.T, sqlDB *sql.DB) *gin.Engine {
	t.Helper()
	secret := os.Getenv("JWT_SECRET")
	if secret == "" {
		secret = "test-secret"
	}
	gin.SetMode(gin.TestMode)
	r := gin.New()
	user.RegisterRoutes(r, sqlDB, secret)
	return r
}

// registerUser creates a user through the user service HTTP routes and
// returns the real userID and the auth token.
func registerUser(t *testing.T, r *gin.Engine, email string) (int64, string) {
	t.Helper()
	body, _ := json.Marshal(map[string]string{
		"email":    email,
		"password": "password123",
	})
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/auth/register", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("register %s status = %d, body = %s", email, w.Code, w.Body.String())
	}
	var resp struct {
		Token string `json:"token"`
		User  struct {
			ID int64 `json:"id"`
		} `json:"user"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode register: %v", err)
	}
	if resp.User.ID == 0 {
		t.Fatalf("register %s returned zero user id", email)
	}
	return resp.User.ID, resp.Token
}

// fb is the feedback_json template used to seed completed sessions. It matches
// the production format written by analysis.Service, which nests the four
// dimension scores under "dimensions".
const fb = `{"total_score":%d,"dimensions":{"expression":%d,"logic":%d,"content":%d,"job_match":%d},"strengths":[],"weaknesses":[],"suggestions":[]}`

// insertCompletedSession inserts a completed, scored session with a distinct
// created_at (via daysAgo) so ordering is deterministic.
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

// insertVariantSession inserts a session with arbitrary status/score/feedback,
// used for draft / null-score / bad-feedback_json variants. A nil score is
// stored as NULL; a nil fbJSON is stored as NULL.
func insertVariantSession(t *testing.T, db *sql.DB, userID int64, jobJD, mode, status string, score *int, fbJSON any, daysAgo int) int64 {
	t.Helper()
	res, err := db.Exec(`
		INSERT INTO interview_sessions (user_id, job_jd, mode, input_mode, status, score, feedback_json, created_at)
		VALUES (?, ?, ?, 'text', ?, ?, ?, DATE_SUB(NOW(), INTERVAL ? DAY))`,
		userID, jobJD, mode, status, score, fbJSON, daysAgo)
	if err != nil {
		t.Fatalf("insert variant session: %v", err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		t.Fatalf("last insert id: %v", err)
	}
	return id
}

func TestTrendsComputesSummaryAndOrder(t *testing.T) {
	sqlDB := testDB(t)
	r := testRouter(t, sqlDB)
	userID, _ := registerUser(t, r, "test-trends-summary@example.com")

	s1 := insertCompletedSession(t, sqlDB, userID, "Backend Engineer JD", "technical", 72, fmt.Sprintf(fb, 72, 70, 75, 80, 85), 3)
	s2 := insertCompletedSession(t, sqlDB, userID, "Backend Engineer JD", "behavioral", 80, fmt.Sprintf(fb, 80, 80, 78, 82, 90), 2)
	s3 := insertCompletedSession(t, sqlDB, userID, "Backend Engineer JD", "mixed", 90, fmt.Sprintf(fb, 90, 88, 85, 90, 95), 1)

	tr, err := analytics.NewService(sqlDB).Trends(context.Background(), userID, "", "")
	if err != nil {
		t.Fatalf("trends: %v", err)
	}

	if tr.Summary.TotalSessions != 3 {
		t.Fatalf("total_sessions = %d, want 3", tr.Summary.TotalSessions)
	}
	if tr.Summary.AvgScore != 81 {
		t.Fatalf("avg_score = %d, want 81 (round((72+80+90)/3)=round(80.67))", tr.Summary.AvgScore)
	}
	if tr.Summary.MaxScore != 90 {
		t.Fatalf("max_score = %d, want 90", tr.Summary.MaxScore)
	}
	if tr.Summary.MinScore != 72 {
		t.Fatalf("min_score = %d, want 72", tr.Summary.MinScore)
	}
	if tr.Summary.FirstScore != 72 {
		t.Fatalf("first_score = %d, want 72", tr.Summary.FirstScore)
	}
	if tr.Summary.LatestScore != 90 {
		t.Fatalf("latest_score = %d, want 90", tr.Summary.LatestScore)
	}
	if tr.Summary.Delta != 18 {
		t.Fatalf("delta = %d, want 18", tr.Summary.Delta)
	}

	if len(tr.Points) != 3 {
		t.Fatalf("len(points) = %d, want 3", len(tr.Points))
	}
	want := []struct {
		id                             int64
		total                          int
		expression, logic, content, jm int
		mode                           string
	}{
		{id: s1, total: 72, expression: 70, logic: 75, content: 80, jm: 85, mode: "technical"},
		{id: s2, total: 80, expression: 80, logic: 78, content: 82, jm: 90, mode: "behavioral"},
		{id: s3, total: 90, expression: 88, logic: 85, content: 90, jm: 95, mode: "mixed"},
	}
	for i, w := range want {
		p := tr.Points[i]
		if p.SessionID != w.id {
			t.Fatalf("points[%d].session_id = %d, want %d", i, p.SessionID, w.id)
		}
		if p.Total != w.total {
			t.Fatalf("points[%d].total = %d, want %d", i, p.Total, w.total)
		}
		if p.Expression != w.expression || p.Logic != w.logic || p.Content != w.content || p.JobMatch != w.jm {
			t.Fatalf("points[%d] dims = %d/%d/%d/%d, want %d/%d/%d/%d",
				i, p.Expression, p.Logic, p.Content, p.JobMatch,
				w.expression, w.logic, w.content, w.jm)
		}
		if p.JobTag != "Backend Engineer JD" || p.Mode != w.mode {
			t.Fatalf("points[%d] tag/mode = %q/%q, want Backend Engineer JD/%s", i, p.JobTag, p.Mode, w.mode)
		}
		if p.Date == "" {
			t.Fatalf("points[%d].date is empty", i)
		}
	}

	if len(tr.JobTags) != 1 || tr.JobTags[0] != "Backend Engineer JD" {
		t.Fatalf("job_tags = %v, want [Backend Engineer JD]", tr.JobTags)
	}
}

func TestTrendsSkipsNonCompletedAndNullScore(t *testing.T) {
	sqlDB := testDB(t)
	r := testRouter(t, sqlDB)
	userID, _ := registerUser(t, r, "test-trends-skipstatus@example.com")

	valid := insertCompletedSession(t, sqlDB, userID, "Backend Engineer JD", "technical", 70, fmt.Sprintf(fb, 70, 70, 70, 70, 70), 3)

	score85 := 85
	insertVariantSession(t, sqlDB, userID, "Backend Engineer JD", "behavioral", "draft", &score85, fmt.Sprintf(fb, 85, 85, 85, 85, 85), 2)
	insertVariantSession(t, sqlDB, userID, "Backend Engineer JD", "mixed", "completed", nil, nil, 1)

	tr, err := analytics.NewService(sqlDB).Trends(context.Background(), userID, "", "")
	if err != nil {
		t.Fatalf("trends: %v", err)
	}

	if tr.Summary.TotalSessions != 1 {
		t.Fatalf("total_sessions = %d, want 1", tr.Summary.TotalSessions)
	}
	if len(tr.Points) != 1 {
		t.Fatalf("len(points) = %d, want 1", len(tr.Points))
	}
	if tr.Points[0].SessionID != valid {
		t.Fatalf("points[0].session_id = %d, want %d", tr.Points[0].SessionID, valid)
	}
	if tr.Summary.AvgScore != 70 || tr.Summary.MaxScore != 70 || tr.Summary.MinScore != 70 {
		t.Fatalf("summary = %+v, want single 70", tr.Summary)
	}
}

func TestTrendsSkipsBadFeedbackJSON(t *testing.T) {
	sqlDB := testDB(t)
	r := testRouter(t, sqlDB)
	userID, _ := registerUser(t, r, "test-trends-badjson@example.com")

	valid := insertCompletedSession(t, sqlDB, userID, "Backend Engineer JD", "technical", 70, fmt.Sprintf(fb, 70, 70, 70, 70, 70), 2)

	// The feedback_json column is MySQL JSON, which rejects a literal
	// 'not json' at insert time. Seed a valid JSON document that fails to
	// unmarshal into the service's dims struct (string where int expected)
	// so the service's skip-on-parse-error path is exercised.
	bad := insertCompletedSession(t, sqlDB, userID, "Backend Engineer JD", "mixed", 90,
		`{"total_score":90,"dimensions":{"expression":"not-a-number","logic":90,"content":90,"job_match":90}}`, 1)

	tr, err := analytics.NewService(sqlDB).Trends(context.Background(), userID, "", "")
	if err != nil {
		t.Fatalf("trends: %v", err)
	}

	if tr.Summary.TotalSessions != 1 {
		t.Fatalf("total_sessions = %d, want 1", tr.Summary.TotalSessions)
	}
	if len(tr.Points) != 1 {
		t.Fatalf("len(points) = %d, want 1", len(tr.Points))
	}
	if tr.Points[0].SessionID != valid {
		t.Fatalf("points[0].session_id = %d, want %d", tr.Points[0].SessionID, valid)
	}
	for _, p := range tr.Points {
		if p.SessionID == bad {
			t.Fatalf("bad-feedback session %d leaked into points", bad)
		}
	}
}

func TestTrendsFiltersByJobTagAndMode(t *testing.T) {
	sqlDB := testDB(t)
	r := testRouter(t, sqlDB)
	userID, _ := registerUser(t, r, "test-trends-filter@example.com")

	insertCompletedSession(t, sqlDB, userID, "Backend Engineer JD", "technical", 70, fmt.Sprintf(fb, 70, 70, 70, 70, 70), 3)
	insertCompletedSession(t, sqlDB, userID, "Backend Engineer JD", "behavioral", 80, fmt.Sprintf(fb, 80, 80, 80, 80, 80), 2)
	insertCompletedSession(t, sqlDB, userID, "Frontend Engineer JD", "technical", 90, fmt.Sprintf(fb, 90, 90, 90, 90, 90), 1)

	svc := analytics.NewService(sqlDB)
	ctx := context.Background()

	byTag, err := svc.Trends(ctx, userID, "Backend Engineer JD", "")
	if err != nil {
		t.Fatalf("trends by tag: %v", err)
	}
	if byTag.Summary.TotalSessions != 2 || len(byTag.Points) != 2 {
		t.Fatalf("by tag: total=%d points=%d, want 2/2", byTag.Summary.TotalSessions, len(byTag.Points))
	}
	if byTag.Points[0].Total != 70 || byTag.Points[1].Total != 80 {
		t.Fatalf("by tag totals = %d,%d, want 70,80", byTag.Points[0].Total, byTag.Points[1].Total)
	}
	if byTag.Summary.AvgScore != 75 || byTag.Summary.MaxScore != 80 || byTag.Summary.MinScore != 70 {
		t.Fatalf("by tag summary = %+v, want avg75 max80 min70", byTag.Summary)
	}

	byMode, err := svc.Trends(ctx, userID, "", "technical")
	if err != nil {
		t.Fatalf("trends by mode: %v", err)
	}
	if byMode.Summary.TotalSessions != 2 || len(byMode.Points) != 2 {
		t.Fatalf("by mode: total=%d points=%d, want 2/2", byMode.Summary.TotalSessions, len(byMode.Points))
	}
	if byMode.Points[0].Total != 70 || byMode.Points[1].Total != 90 {
		t.Fatalf("by mode totals = %d,%d, want 70,90", byMode.Points[0].Total, byMode.Points[1].Total)
	}

	both, err := svc.Trends(ctx, userID, "Frontend Engineer JD", "technical")
	if err != nil {
		t.Fatalf("trends by tag+mode: %v", err)
	}
	if both.Summary.TotalSessions != 1 || len(both.Points) != 1 {
		t.Fatalf("by tag+mode: total=%d points=%d, want 1/1", both.Summary.TotalSessions, len(both.Points))
	}
	if both.Points[0].Total != 90 {
		t.Fatalf("by tag+mode total = %d, want 90", both.Points[0].Total)
	}
}

func TestTrendsIsolation(t *testing.T) {
	sqlDB := testDB(t)
	r := testRouter(t, sqlDB)
	userA, _ := registerUser(t, r, "test-trends-iso-a@example.com")
	userB, _ := registerUser(t, r, "test-trends-iso-b@example.com")

	a1 := insertCompletedSession(t, sqlDB, userA, "Backend Engineer JD", "technical", 60, fmt.Sprintf(fb, 60, 60, 60, 60, 60), 2)
	a2 := insertCompletedSession(t, sqlDB, userA, "Backend Engineer JD", "mixed", 70, fmt.Sprintf(fb, 70, 70, 70, 70, 70), 1)
	b1 := insertCompletedSession(t, sqlDB, userB, "Frontend Engineer JD", "behavioral", 95, fmt.Sprintf(fb, 95, 95, 95, 95, 95), 1)

	tr, err := analytics.NewService(sqlDB).Trends(context.Background(), userA, "", "")
	if err != nil {
		t.Fatalf("trends: %v", err)
	}

	if tr.Summary.TotalSessions != 2 || len(tr.Points) != 2 {
		t.Fatalf("user A total=%d points=%d, want 2/2", tr.Summary.TotalSessions, len(tr.Points))
	}
	for _, p := range tr.Points {
		if p.SessionID == b1 {
			t.Fatalf("user B session %d leaked into user A trends", b1)
		}
	}
	got := map[int64]bool{}
	for _, p := range tr.Points {
		got[p.SessionID] = true
	}
	if !got[a1] || !got[a2] {
		t.Fatalf("user A sessions not all present: %v", got)
	}
	if tr.Summary.MaxScore != 70 {
		t.Fatalf("user A max = %d, want 70 (must not see B's 95)", tr.Summary.MaxScore)
	}
}

func TestTrendsEmpty(t *testing.T) {
	sqlDB := testDB(t)
	r := testRouter(t, sqlDB)
	userID, _ := registerUser(t, r, "test-trends-empty@example.com")

	tr, err := analytics.NewService(sqlDB).Trends(context.Background(), userID, "", "")
	if err != nil {
		t.Fatalf("trends: %v", err)
	}

	if tr.Summary.TotalSessions != 0 {
		t.Fatalf("total_sessions = %d, want 0", tr.Summary.TotalSessions)
	}
	if tr.Summary.AvgScore != 0 || tr.Summary.MaxScore != 0 || tr.Summary.MinScore != 0 {
		t.Fatalf("summary scores = %+v, want all 0", tr.Summary)
	}
	if tr.Summary.FirstScore != 0 || tr.Summary.LatestScore != 0 || tr.Summary.Delta != 0 {
		t.Fatalf("summary scores = %+v, want all 0", tr.Summary)
	}
	if len(tr.Points) != 0 {
		t.Fatalf("len(points) = %d, want 0", len(tr.Points))
	}
	if len(tr.JobTags) != 0 {
		t.Fatalf("job_tags = %v, want empty", tr.JobTags)
	}
}
