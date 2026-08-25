package behavior_test

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"testing"

	"github.com/interview-assistant/backend/internal/behavior"
	"github.com/interview-assistant/backend/internal/db"
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
	res, err := sqlDB.Exec(`INSERT INTO users (email, password_hash, username) VALUES (?, 'x', '测试用户')`, email)
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
	svc := behavior.NewService(sqlDB)
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
	svc := behavior.NewService(sqlDB)
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
	svc := behavior.NewService(sqlDB)
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
	svc := behavior.NewService(sqlDB)
	ctx := context.Background()
	if err := svc.Save(ctx, uidA, sid, samplePayload()); err != nil {
		t.Fatalf("save: %v", err)
	}
	if err := svc.Save(ctx, uidB, sid, samplePayload()); !errors.Is(err, behavior.ErrNotFound) {
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
	svc := behavior.NewService(sqlDB)
	res, err := svc.Get(context.Background(), uid, sid)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if res.Available {
		t.Fatalf("available should be false, got %+v", res)
	}
}
