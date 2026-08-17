package analysis_test

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

	"github.com/alicebob/miniredis/v2"
	"github.com/gin-gonic/gin"
	"github.com/interview-assistant/backend/internal/analysis"
	"github.com/interview-assistant/backend/internal/db"
	"github.com/interview-assistant/backend/internal/interview"
	"github.com/interview-assistant/backend/internal/llm"
	"github.com/interview-assistant/backend/internal/sessionredis"
	"github.com/interview-assistant/backend/internal/user"
	"github.com/redis/go-redis/v9"
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
			WHERE u.email LIKE 'test-analysis-%@example.com'`)
		_, _ = sqlDB.Exec(`
			DELETE q FROM interview_questions q
			INNER JOIN interview_sessions s ON s.id = q.session_id
			INNER JOIN users u ON u.id = s.user_id
			WHERE u.email LIKE 'test-analysis-%@example.com'`)
		_, _ = sqlDB.Exec(`
			DELETE s FROM interview_sessions s
			INNER JOIN users u ON u.id = s.user_id
			WHERE u.email LIKE 'test-analysis-%@example.com'`)
		_, _ = sqlDB.Exec("DELETE FROM users WHERE email LIKE 'test-analysis-%@example.com'")
		sqlDB.Close()
	})
	return sqlDB
}

func testStore(t *testing.T) sessionredis.Store {
	t.Helper()
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("miniredis: %v", err)
	}
	t.Cleanup(mr.Close)
	return sessionredis.NewRedisStore(redis.NewClient(&redis.Options{Addr: mr.Addr()}))
}

type fakeLLM struct {
	fn func(system, user string, out any) error
}

func (f fakeLLM) ChatJSON(ctx context.Context, system, user string, out any) error {
	return f.fn(system, user, out)
}

func fakeEvaluateFeedback() *analysis.Feedback {
	return &analysis.Feedback{
		TotalScore: 82,
		Dimensions: struct {
			Expression int `json:"expression"`
			Logic      int `json:"logic"`
			Content    int `json:"content"`
			JobMatch   int `json:"job_match"`
		}{
			Expression: 80,
			Logic:      85,
			Content:    78,
			JobMatch:   83,
		},
		Strengths:    []string{"Clear structure in answers"},
		Weaknesses:   []string{"Limited depth on trade-offs"},
		Suggestions:  []string{"Practice STAR examples with metrics"},
		ModelVersion: "test-model",
	}
}

func fakeFullLLM(questionCount int, decideAction string) llm.Client {
	return fakeLLM{fn: func(system, user string, out any) error {
		if gen, ok := out.(*llm.GenQuestionsOut); ok {
			gen.Questions = make([]llm.GenQuestion, questionCount)
			for i := 0; i < questionCount; i++ {
				gen.Questions[i] = llm.GenQuestion{
					Seq:      i + 1,
					Question: fmt.Sprintf("Question %d?", i+1),
					Intent:   "assessment",
				}
			}
			return nil
		}
		if decide, ok := out.(*llm.DecideNextOut); ok {
			decide.Action = decideAction
			if decideAction == "follow_up" {
				decide.FollowUpText = "Can you elaborate?"
			}
			return nil
		}
		if eval, ok := out.(*llm.EvaluateOut); ok {
			fb := fakeEvaluateFeedback()
			eval.TotalScore = fb.TotalScore
			eval.Dimensions = fb.Dimensions
			eval.Strengths = fb.Strengths
			eval.Weaknesses = fb.Weaknesses
			eval.Suggestions = fb.Suggestions
			eval.ModelVersion = fb.ModelVersion
			return nil
		}
		return fmt.Errorf("unexpected out type %T", out)
	}}
}

func testRouter(t *testing.T, sqlDB *sql.DB, llmClient llm.Client) (*gin.Engine, *interview.Service) {
	t.Helper()
	store := testStore(t)
	secret := os.Getenv("JWT_SECRET")
	if secret == "" {
		secret = "test-secret"
	}
	gin.SetMode(gin.TestMode)
	r := gin.New()
	user.RegisterRoutes(r, sqlDB, secret)
	svc := interview.NewService(sqlDB, llmClient, store)
	interview.RegisterRoutes(r, secret, svc)
	analysis.RegisterRoutes(r, sqlDB, secret, llmClient, "test-model")
	return r, svc
}

func registerUser(t *testing.T, r *gin.Engine, email string) string {
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
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode register: %v", err)
	}
	return resp.Token
}

func createInterview(t *testing.T, r *gin.Engine, token, jobJD, mode string) int64 {
	t.Helper()
	body, _ := json.Marshal(map[string]string{
		"job_jd": jobJD,
		"mode":   mode,
	})
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/interviews", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	r.ServeHTTP(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("create interview status = %d, body = %s", w.Code, w.Body.String())
	}
	var resp struct {
		ID int64 `json:"id"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode create: %v", err)
	}
	return resp.ID
}

func TestFinishWritesFeedbackJSON(t *testing.T) {
	sqlDB := testDB(t)
	ctx := context.Background()
	llmClient := fakeFullLLM(5, "finish")

	r, svc := testRouter(t, sqlDB, llmClient)
	analysisSvc := analysis.NewService(sqlDB, llmClient, "test-model")
	svc.SetEvaluator(analysisSvc)

	token := registerUser(t, r, "test-analysis-finish@example.com")
	sessionID := createInterview(t, r, token, "Backend engineer JD", "mixed")

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, fmt.Sprintf("/api/interviews/%d/start", sessionID), nil)
	req.Header.Set("Authorization", "Bearer "+token)
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("start status = %d, body = %s", w.Code, w.Body.String())
	}

	var userID int64
	if err := sqlDB.QueryRow(`SELECT id FROM users WHERE email = ?`, "test-analysis-finish@example.com").Scan(&userID); err != nil {
		t.Fatalf("query user: %v", err)
	}

	if _, err := svc.BeginLive(ctx, userID, sessionID); err != nil {
		t.Fatalf("BeginLive: %v", err)
	}
	msgs, err := svc.HandleAnswer(ctx, userID, sessionID, "my answer", nil)
	if err != nil {
		t.Fatalf("HandleAnswer: %v", err)
	}
	for _, m := range msgs {
		if m.Type == "done" {
			break
		}
	}

	var feedbackJSON []byte
	var score sql.NullInt64
	var status string
	if err := sqlDB.QueryRow(
		`SELECT status, score, feedback_json FROM interview_sessions WHERE id = ?`,
		sessionID,
	).Scan(&status, &score, &feedbackJSON); err != nil {
		t.Fatalf("query session: %v", err)
	}
	if status != "completed" {
		t.Fatalf("status = %q, want completed", status)
	}
	if !score.Valid || score.Int64 != 82 {
		t.Fatalf("score = %v, want 82", score)
	}
	if len(feedbackJSON) == 0 {
		t.Fatalf("feedback_json is empty")
	}
	var fb analysis.Feedback
	if err := json.Unmarshal(feedbackJSON, &fb); err != nil {
		t.Fatalf("decode feedback: %v", err)
	}
	if fb.TotalScore != 82 {
		t.Fatalf("feedback total_score = %d, want 82", fb.TotalScore)
	}
}

type failingEvaluator struct{}

func (f failingEvaluator) Evaluate(ctx context.Context, sessionID int64) (int, []byte, error) {
	return 0, nil, fmt.Errorf("llm unavailable")
}

func TestFinishEvaluateFailureCompletedAvailableFalse(t *testing.T) {
	sqlDB := testDB(t)
	ctx := context.Background()
	llmClient := fakeFullLLM(5, "finish")

	r, svc := testRouter(t, sqlDB, llmClient)
	svc.SetEvaluator(failingEvaluator{})

	token := registerUser(t, r, "test-analysis-eval-fail@example.com")
	sessionID := createInterview(t, r, token, "Backend engineer JD", "mixed")

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, fmt.Sprintf("/api/interviews/%d/start", sessionID), nil)
	req.Header.Set("Authorization", "Bearer "+token)
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("start status = %d, body = %s", w.Code, w.Body.String())
	}

	var userID int64
	if err := sqlDB.QueryRow(`SELECT id FROM users WHERE email = ?`, "test-analysis-eval-fail@example.com").Scan(&userID); err != nil {
		t.Fatalf("query user: %v", err)
	}

	if _, err := svc.BeginLive(ctx, userID, sessionID); err != nil {
		t.Fatalf("BeginLive: %v", err)
	}
	if _, err := svc.HandleAnswer(ctx, userID, sessionID, "my answer", nil); err != nil {
		t.Fatalf("HandleAnswer: %v", err)
	}

	var status string
	var feedbackJSON []byte
	var rawFeedback sql.NullString
	if err := sqlDB.QueryRow(
		`SELECT status, feedback_json, raw_feedback FROM interview_sessions WHERE id = ?`,
		sessionID,
	).Scan(&status, &feedbackJSON, &rawFeedback); err != nil {
		t.Fatalf("query session: %v", err)
	}
	if status != "completed" {
		t.Fatalf("status = %q, want completed", status)
	}
	if len(feedbackJSON) > 0 {
		t.Fatalf("feedback_json should be empty on evaluate failure")
	}
	if !rawFeedback.Valid || rawFeedback.String == "" {
		t.Fatalf("raw_feedback should contain error text")
	}

	w = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, fmt.Sprintf("/api/interviews/%d/report", sessionID), nil)
	req.Header.Set("Authorization", "Bearer "+token)
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("get report status = %d, body = %s", w.Code, w.Body.String())
	}
	var resp struct {
		Available bool `json:"available"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode report: %v", err)
	}
	if resp.Available {
		t.Fatalf("available = true, want false after evaluate failure")
	}
}

func TestGetReportAvailableFalseWhenNoFeedback(t *testing.T) {
	sqlDB := testDB(t)
	llmClient := fakeFullLLM(5, "finish")
	r, _ := testRouter(t, sqlDB, llmClient)
	token := registerUser(t, r, "test-analysis-no-fb@example.com")
	sessionID := createInterview(t, r, token, "Backend engineer JD", "mixed")

	_, err := sqlDB.Exec(
		`UPDATE interview_sessions SET status = 'completed', ended_at = NOW() WHERE id = ?`,
		sessionID,
	)
	if err != nil {
		t.Fatalf("mark completed: %v", err)
	}

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, fmt.Sprintf("/api/interviews/%d/report", sessionID), nil)
	req.Header.Set("Authorization", "Bearer "+token)
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("get report status = %d, body = %s", w.Code, w.Body.String())
	}
	var resp struct {
		Available bool `json:"available"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode report: %v", err)
	}
	if resp.Available {
		t.Fatalf("available = true, want false")
	}
}

func TestGetReportReturnsFeedback(t *testing.T) {
	sqlDB := testDB(t)
	llmClient := fakeFullLLM(5, "finish")
	r, _ := testRouter(t, sqlDB, llmClient)
	token := registerUser(t, r, "test-analysis-get-fb@example.com")
	sessionID := createInterview(t, r, token, "Backend engineer JD", "mixed")

	fb := fakeEvaluateFeedback()
	fbJSON, _ := json.Marshal(fb)
	_, err := sqlDB.Exec(
		`UPDATE interview_sessions SET status = 'completed', ended_at = NOW(), score = ?, feedback_json = ? WHERE id = ?`,
		fb.TotalScore, fbJSON, sessionID,
	)
	if err != nil {
		t.Fatalf("seed feedback: %v", err)
	}

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, fmt.Sprintf("/api/interviews/%d/report", sessionID), nil)
	req.Header.Set("Authorization", "Bearer "+token)
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("get report status = %d, body = %s", w.Code, w.Body.String())
	}
	var got analysis.Feedback
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode report: %v", err)
	}
	if got.TotalScore != 82 {
		t.Fatalf("total_score = %d, want 82", got.TotalScore)
	}
}

func TestRetryReportGeneratesFeedback(t *testing.T) {
	sqlDB := testDB(t)
	llmClient := fakeFullLLM(5, "finish")
	r, _ := testRouter(t, sqlDB, llmClient)
	token := registerUser(t, r, "test-analysis-retry@example.com")
	sessionID := createInterview(t, r, token, "Backend engineer JD", "mixed")

	_, err := sqlDB.Exec(
		`UPDATE interview_sessions SET status = 'completed', ended_at = NOW() WHERE id = ?`,
		sessionID,
	)
	if err != nil {
		t.Fatalf("mark completed: %v", err)
	}

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, fmt.Sprintf("/api/interviews/%d/report/retry", sessionID), nil)
	req.Header.Set("Authorization", "Bearer "+token)
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("retry status = %d, body = %s", w.Code, w.Body.String())
	}
	var got analysis.Feedback
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode retry: %v", err)
	}
	if got.TotalScore != 82 {
		t.Fatalf("total_score = %d, want 82", got.TotalScore)
	}

	var feedbackJSON []byte
	if err := sqlDB.QueryRow(`SELECT feedback_json FROM interview_sessions WHERE id = ?`, sessionID).Scan(&feedbackJSON); err != nil {
		t.Fatalf("query feedback: %v", err)
	}
	if len(feedbackJSON) == 0 {
		t.Fatalf("feedback_json still empty after retry")
	}
}

func TestGetReportForeignSessionReturnsNotFound(t *testing.T) {
	sqlDB := testDB(t)
	llmClient := fakeFullLLM(5, "finish")
	r, _ := testRouter(t, sqlDB, llmClient)
	tokenA := registerUser(t, r, "test-analysis-foreign-a@example.com")
	tokenB := registerUser(t, r, "test-analysis-foreign-b@example.com")
	sessionID := createInterview(t, r, tokenA, "Backend engineer JD", "mixed")

	_, _ = sqlDB.Exec(`UPDATE interview_sessions SET status = 'completed', ended_at = NOW() WHERE id = ?`, sessionID)

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, fmt.Sprintf("/api/interviews/%d/report", sessionID), nil)
	req.Header.Set("Authorization", "Bearer "+tokenB)
	r.ServeHTTP(w, req)
	if w.Code != http.StatusNotFound {
		t.Fatalf("foreign report status = %d, want 404, body = %s", w.Code, w.Body.String())
	}
}
