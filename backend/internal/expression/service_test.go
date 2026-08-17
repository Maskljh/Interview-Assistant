package expression_test

import (
	"context"
	"database/sql"
	"os"
	"testing"

	"github.com/interview-assistant/backend/internal/db"
	"github.com/interview-assistant/backend/internal/expression"
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
