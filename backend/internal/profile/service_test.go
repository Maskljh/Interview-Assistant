package profile_test

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/interview-assistant/backend/internal/db"
	"github.com/interview-assistant/backend/internal/profile"
	"github.com/interview-assistant/backend/internal/auth"
)

func testDB(t *testing.T) *sql.DB {
	t.Helper()
	dsn := os.Getenv("MYSQL_DSN")
	if dsn == "" {
		dsn = "root:123456@tcp(127.0.0.1:3306)/interview?parseTime=true&charset=utf8mb4"
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
			WHERE u.email LIKE 'test-profile-%@example.com'`)
		_, _ = sqlDB.Exec(`
			DELETE q FROM interview_questions q
			INNER JOIN interview_sessions s ON s.id = q.session_id
			INNER JOIN users u ON u.id = s.user_id
			WHERE u.email LIKE 'test-profile-%@example.com'`)
		_, _ = sqlDB.Exec(`
			DELETE s FROM interview_sessions s
			INNER JOIN users u ON u.id = s.user_id
			WHERE u.email LIKE 'test-profile-%@example.com'`)
		_, _ = sqlDB.Exec("DELETE FROM users WHERE email LIKE 'test-profile-%@example.com'")
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
	return r
}

// registerUser creates a user through the user service HTTP routes and
// returns the real userID and the auth token.
// registerUser inserts a user directly and returns the real userID and an app
// JWT for that user (email/password auth was removed in favor of WPS OAuth).
func registerUser(t *testing.T, sqlDB *sql.DB, email string) (int64, string) {
	t.Helper()
	secret := os.Getenv("JWT_SECRET")
	if secret == "" {
		secret = "test-secret"
	}
	res, err := sqlDB.Exec(
		"INSERT INTO users (email, password_hash, username) VALUES (?, 'not-a-real-hash', ?)",
		email, "测试用户",
	)
	if err != nil {
		t.Fatalf("insert user %s: %v", email, err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		t.Fatalf("last insert id: %v", err)
	}
	token, err := auth.IssueToken(secret, id, email, time.Hour)
	if err != nil {
		t.Fatalf("issue token: %v", err)
	}
	return id, token
}

// fb is the feedback_json template used to seed completed sessions. It matches
// the production format written by analysis.Service, which nests the four
// dimension scores under "dimensions".
const fb = `{"total_score":%d,"dimensions":{"expression":%d,"logic":%d,"content":%d,"job_match":%d},"strengths":[],"weaknesses":[],"suggestions":[]}`

// insertCompletedSession inserts a completed, scored session with a distinct
// created_at (via daysAgo) so ordering is deterministic.
func insertCompletedSession(t *testing.T, sqlDB *sql.DB, userID int64, jobJD, mode string, score int, fbJSON string, daysAgo int) int64 {
	t.Helper()
	res, err := sqlDB.Exec(`
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

func assertWeak(t *testing.T, p profile.Profile, want []string, wantSessions int) {
	t.Helper()
	if len(p.WeakDimensions) != len(want) {
		t.Fatalf("weak_dimensions = %v, want %v", p.WeakDimensions, want)
	}
	for i := range want {
		if p.WeakDimensions[i] != want[i] {
			t.Fatalf("weak_dimensions = %v, want %v", p.WeakDimensions, want)
		}
	}
	if p.BasedOnSessions != wantSessions {
		t.Fatalf("based_on_sessions = %d, want %d", p.BasedOnSessions, wantSessions)
	}
}

func TestWeaknessesPicksBelowAverage(t *testing.T) {
	sqlDB := testDB(t)
	userID, _ := registerUser(t, sqlDB, "test-profile-belowavg@example.com")

	// content is consistently ~52 vs 90 for the other three dims.
	insertCompletedSession(t, sqlDB, userID, "Backend Engineer JD", "technical", 90, fmt.Sprintf(fb, 90, 90, 90, 50, 90), 3)
	insertCompletedSession(t, sqlDB, userID, "Backend Engineer JD", "technical", 88, fmt.Sprintf(fb, 88, 88, 88, 52, 88), 2)
	insertCompletedSession(t, sqlDB, userID, "Backend Engineer JD", "technical", 92, fmt.Sprintf(fb, 92, 92, 92, 54, 92), 1)

	// Means: expression 90, logic 90, content 52, job_match 90; average 80.5.
	p, err := profile.NewService(sqlDB).Weaknesses(context.Background(), userID, 5)
	if err != nil {
		t.Fatalf("weaknesses: %v", err)
	}
	assertWeak(t, p, []string{"content"}, 3)
}

func TestWeaknessesMaxTwoSortedByGap(t *testing.T) {
	sqlDB := testDB(t)
	userID, _ := registerUser(t, sqlDB, "test-profile-max2@example.com")

	// Means 50, 60, 90, 90 -> average 72.5; gaps: expression 22.5, logic 12.5.
	insertCompletedSession(t, sqlDB, userID, "Backend Engineer JD", "technical", 70, fmt.Sprintf(fb, 70, 50, 60, 90, 90), 1)

	p, err := profile.NewService(sqlDB).Weaknesses(context.Background(), userID, 5)
	if err != nil {
		t.Fatalf("weaknesses: %v", err)
	}
	assertWeak(t, p, []string{"expression", "logic"}, 1)
}

func TestWeaknessesEmptyHistory(t *testing.T) {
	sqlDB := testDB(t)
	userID, _ := registerUser(t, sqlDB, "test-profile-empty@example.com")

	p, err := profile.NewService(sqlDB).Weaknesses(context.Background(), userID, 5)
	if err != nil {
		t.Fatalf("weaknesses: %v", err)
	}
	assertWeak(t, p, []string{}, 0)
}

func TestWeaknessesSkipsUnparseableFeedback(t *testing.T) {
	sqlDB := testDB(t)
	userID, _ := registerUser(t, sqlDB, "test-profile-badjson@example.com")

	insertCompletedSession(t, sqlDB, userID, "Backend Engineer JD", "technical", 80, fmt.Sprintf(fb, 80, 50, 80, 90, 90), 2)

	// The feedback_json column is MySQL JSON, which rejects a literal 'not json'
	// at insert time. Seed a valid JSON document that fails to unmarshal into the
	// service's dims struct (string where int expected) so the skip-on-parse-error
	// path is exercised.
	insertCompletedSession(t, sqlDB, userID, "Backend Engineer JD", "mixed", 90,
		`{"total_score":90,"dimensions":{"expression":"not-a-number","logic":90,"content":90,"job_match":90}}`, 1)

	// Only the parseable session counts: means 50, 80, 90, 90 -> average 77.5,
	// expression is the only weak dim.
	p, err := profile.NewService(sqlDB).Weaknesses(context.Background(), userID, 5)
	if err != nil {
		t.Fatalf("weaknesses: %v", err)
	}
	assertWeak(t, p, []string{"expression"}, 1)
}

func TestWeaknessesIsolation(t *testing.T) {
	sqlDB := testDB(t)
	userA, _ := registerUser(t, sqlDB, "test-profile-iso-a@example.com")
	userB, _ := registerUser(t, sqlDB, "test-profile-iso-b@example.com")

	insertCompletedSession(t, sqlDB, userA, "Backend Engineer JD", "technical", 70, fmt.Sprintf(fb, 70, 50, 50, 90, 90), 1)
	insertCompletedSession(t, sqlDB, userB, "Backend Engineer JD", "technical", 70, fmt.Sprintf(fb, 70, 90, 90, 50, 50), 1)

	svc := profile.NewService(sqlDB)
	ctx := context.Background()

	pA, err := svc.Weaknesses(ctx, userA, 5)
	if err != nil {
		t.Fatalf("weaknesses A: %v", err)
	}
	assertWeak(t, pA, []string{"expression", "logic"}, 1)

	pB, err := svc.Weaknesses(ctx, userB, 5)
	if err != nil {
		t.Fatalf("weaknesses B: %v", err)
	}
	assertWeak(t, pB, []string{"content", "job_match"}, 1)
}

func TestWeaknessesSessionWindow(t *testing.T) {
	sqlDB := testDB(t)
	userID, _ := registerUser(t, sqlDB, "test-profile-window@example.com")

	// 7 sessions, all content-weak.
	for i := 0; i < 7; i++ {
		insertCompletedSession(t, sqlDB, userID, "Backend Engineer JD", "technical", 90, fmt.Sprintf(fb, 90, 90, 90, 50, 90), 7-i)
	}

	svc := profile.NewService(sqlDB)
	ctx := context.Background()

	p5, err := svc.Weaknesses(ctx, userID, 5)
	if err != nil {
		t.Fatalf("weaknesses max5: %v", err)
	}
	assertWeak(t, p5, []string{"content"}, 5)

	p10, err := svc.Weaknesses(ctx, userID, 10)
	if err != nil {
		t.Fatalf("weaknesses max10: %v", err)
	}
	assertWeak(t, p10, []string{"content"}, 7)
}
