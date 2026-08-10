package interview_test

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
			WHERE u.email LIKE 'test-interview-%@example.com'`)
		_, _ = sqlDB.Exec(`
			DELETE q FROM interview_questions q
			INNER JOIN interview_sessions s ON s.id = q.session_id
			INNER JOIN users u ON u.id = s.user_id
			WHERE u.email LIKE 'test-interview-%@example.com'`)
		_, _ = sqlDB.Exec(`
			DELETE s FROM interview_sessions s
			INNER JOIN users u ON u.id = s.user_id
			WHERE u.email LIKE 'test-interview-%@example.com'`)
		_, _ = sqlDB.Exec("DELETE FROM users WHERE email LIKE 'test-interview-%@example.com'")
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

func testRouter(t *testing.T, sqlDB *sql.DB, llmClient llm.Client) *gin.Engine {
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
	return r
}

type fakeLLM struct {
	fn func(system, user string, out any) error
}

func (f fakeLLM) ChatJSON(ctx context.Context, system, user string, out any) error {
	return f.fn(system, user, out)
}

func fakeQuestionsLLM(n int) llm.Client {
	return fakeLLM{fn: func(system, user string, out any) error {
		gen, ok := out.(*llm.GenQuestionsOut)
		if !ok {
			return fmt.Errorf("unexpected out type")
		}
		gen.Questions = make([]llm.GenQuestion, n)
		for i := 0; i < n; i++ {
			gen.Questions[i] = llm.GenQuestion{
				Seq:      i + 1,
				Question: fmt.Sprintf("Question %d?", i+1),
				Intent:   "assessment",
			}
		}
		return nil
	}}
}

func fakeAlwaysFollowUpLLM(n int) llm.Client {
	return fakeLLM{fn: func(system, user string, out any) error {
		if gen, ok := out.(*llm.GenQuestionsOut); ok {
			gen.Questions = make([]llm.GenQuestion, n)
			for i := 0; i < n; i++ {
				gen.Questions[i] = llm.GenQuestion{
					Seq:      i + 1,
					Question: fmt.Sprintf("Question %d?", i+1),
					Intent:   "assessment",
				}
			}
			return nil
		}
		if decide, ok := out.(*llm.DecideNextOut); ok {
			decide.Action = "follow_up"
			decide.FollowUpText = "Can you elaborate?"
			return nil
		}
		return fmt.Errorf("unexpected out type %T", out)
	}}
}

func lastOutboundType(msgs []interview.OutboundMessage) string {
	for i := len(msgs) - 1; i >= 0; i-- {
		if msgs[i].Type != "status" {
			return msgs[i].Type
		}
	}
	return ""
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

func TestGetForeignSessionReturnsNotFound(t *testing.T) {
	sqlDB := testDB(t)
	r := testRouter(t, sqlDB, nil)

	tokenA := registerUser(t, r, "test-interview-a@example.com")
	tokenB := registerUser(t, r, "test-interview-b@example.com")
	sessionID := createInterview(t, r, tokenA, "Backend engineer JD", "mixed")

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, fmt.Sprintf("/api/interviews/%d", sessionID), nil)
	req.Header.Set("Authorization", "Bearer "+tokenB)
	r.ServeHTTP(w, req)

	if w.Code != http.StatusNotFound {
		t.Fatalf("foreign get status = %d, want 404, body = %s", w.Code, w.Body.String())
	}
}

func TestCreateRequiresJDAndValidMode(t *testing.T) {
	sqlDB := testDB(t)
	r := testRouter(t, sqlDB, nil)
	token := registerUser(t, r, "test-interview-validate@example.com")

	body, _ := json.Marshal(map[string]string{
		"job_jd": "",
		"mode":   "mixed",
	})
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/interviews", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	r.ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("empty JD status = %d, want 400", w.Code)
	}

	body, _ = json.Marshal(map[string]string{
		"job_jd": "Some JD",
		"mode":   "foo",
	})
	w = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/api/interviews", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	r.ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("invalid mode status = %d, want 400", w.Code)
	}
}

func TestStartPersistsQuestions(t *testing.T) {
	sqlDB := testDB(t)
	r := testRouter(t, sqlDB, fakeQuestionsLLM(6))

	token := registerUser(t, r, "test-interview-start@example.com")
	sessionID := createInterview(t, r, token, "Backend engineer JD", "mixed")

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, fmt.Sprintf("/api/interviews/%d/start", sessionID), nil)
	req.Header.Set("Authorization", "Bearer "+token)
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("start status = %d, want 200, body = %s", w.Code, w.Body.String())
	}
	var resp struct {
		Status    string `json:"status"`
		Questions []struct {
			Seq      int    `json:"seq"`
			Question string `json:"question"`
			Asked    bool   `json:"asked"`
		} `json:"questions"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode start: %v", err)
	}
	if resp.Status != "ready" {
		t.Fatalf("status = %q, want ready", resp.Status)
	}
	if len(resp.Questions) != 6 {
		t.Fatalf("len(questions) = %d, want 6", len(resp.Questions))
	}
	for _, q := range resp.Questions {
		if q.Asked {
			t.Fatalf("question seq %d should not be asked", q.Seq)
		}
	}
}

func TestStartRejectsNonOwner(t *testing.T) {
	sqlDB := testDB(t)
	r := testRouter(t, sqlDB, fakeQuestionsLLM(6))

	tokenA := registerUser(t, r, "test-interview-start-a@example.com")
	tokenB := registerUser(t, r, "test-interview-start-b@example.com")
	sessionID := createInterview(t, r, tokenA, "Backend engineer JD", "mixed")

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, fmt.Sprintf("/api/interviews/%d/start", sessionID), nil)
	req.Header.Set("Authorization", "Bearer "+tokenB)
	r.ServeHTTP(w, req)

	if w.Code != http.StatusNotFound {
		t.Fatalf("foreign start status = %d, want 404, body = %s", w.Code, w.Body.String())
	}
}

func assertSessionDraft(t *testing.T, sqlDB *sql.DB, r *gin.Engine, token string, sessionID int64) {
	t.Helper()

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, fmt.Sprintf("/api/interviews/%d", sessionID), nil)
	req.Header.Set("Authorization", "Bearer "+token)
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("get status = %d, want 200, body = %s", w.Code, w.Body.String())
	}
	var resp struct {
		Status    string `json:"status"`
		Questions []any  `json:"questions"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode get: %v", err)
	}
	if resp.Status != "draft" {
		t.Fatalf("GET status = %q, want draft", resp.Status)
	}
	if len(resp.Questions) != 0 {
		t.Fatalf("GET questions = %d, want 0", len(resp.Questions))
	}

	var dbStatus string
	if err := sqlDB.QueryRow(`SELECT status FROM interview_sessions WHERE id = ?`, sessionID).Scan(&dbStatus); err != nil {
		t.Fatalf("query session status: %v", err)
	}
	if dbStatus != "draft" {
		t.Fatalf("DB status = %q, want draft", dbStatus)
	}
	var qCount int
	if err := sqlDB.QueryRow(`SELECT COUNT(*) FROM interview_questions WHERE session_id = ?`, sessionID).Scan(&qCount); err != nil {
		t.Fatalf("query question count: %v", err)
	}
	if qCount != 0 {
		t.Fatalf("DB question count = %d, want 0", qCount)
	}
}

func TestStartLLMFailureKeepsDraft(t *testing.T) {
	cases := []struct {
		name  string
		email string
		llm   llm.Client
	}{
		{
			name:  "llm error",
			email: "test-interview-llm-fail-error@example.com",
			llm: fakeLLM{fn: func(system, user string, out any) error {
				return fmt.Errorf("llm unavailable")
			}},
		},
		{
			name:  "invalid question count",
			email: "test-interview-llm-fail-badcount@example.com",
			llm:   fakeQuestionsLLM(4),
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			sqlDB := testDB(t)
			r := testRouter(t, sqlDB, tc.llm)

			token := registerUser(t, r, tc.email)
			sessionID := createInterview(t, r, token, "Backend engineer JD", "mixed")

			w := httptest.NewRecorder()
			req := httptest.NewRequest(http.MethodPost, fmt.Sprintf("/api/interviews/%d/start", sessionID), nil)
			req.Header.Set("Authorization", "Bearer "+token)
			r.ServeHTTP(w, req)

			if w.Code != http.StatusBadGateway {
				t.Fatalf("start status = %d, want 502, body = %s", w.Code, w.Body.String())
			}
			assertSessionDraft(t, sqlDB, r, token, sessionID)
		})
	}
}

func TestHandleAnswerForcesNextAfterFollowUpCap(t *testing.T) {
	sqlDB := testDB(t)
	store := testStore(t)
	ctx := context.Background()

	r := testRouter(t, sqlDB, fakeAlwaysFollowUpLLM(6))
	token := registerUser(t, r, "test-interview-followup-cap@example.com")
	sessionID := createInterview(t, r, token, "Backend engineer JD", "mixed")

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, fmt.Sprintf("/api/interviews/%d/start", sessionID), nil)
	req.Header.Set("Authorization", "Bearer "+token)
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("start status = %d, body = %s", w.Code, w.Body.String())
	}

	svc := interview.NewService(sqlDB, fakeAlwaysFollowUpLLM(6), store)

	var userID int64
	if err := sqlDB.QueryRow(`SELECT id FROM users WHERE email = ?`, "test-interview-followup-cap@example.com").Scan(&userID); err != nil {
		t.Fatalf("query user: %v", err)
	}

	if _, err := svc.BeginLive(ctx, userID, sessionID); err != nil {
		t.Fatalf("BeginLive: %v", err)
	}

	msgs, err := svc.HandleAnswer(ctx, userID, sessionID, "first answer")
	if err != nil {
		t.Fatalf("HandleAnswer 1: %v", err)
	}
	if lastOutboundType(msgs) != "follow_up" {
		t.Fatalf("answer 1 last type = %q, want follow_up", lastOutboundType(msgs))
	}

	msgs, err = svc.HandleAnswer(ctx, userID, sessionID, "second answer")
	if err != nil {
		t.Fatalf("HandleAnswer 2: %v", err)
	}
	if lastOutboundType(msgs) != "follow_up" {
		t.Fatalf("answer 2 last type = %q, want follow_up", lastOutboundType(msgs))
	}

	msgs, err = svc.HandleAnswer(ctx, userID, sessionID, "third answer")
	if err != nil {
		t.Fatalf("HandleAnswer 3: %v", err)
	}
	if got := lastOutboundType(msgs); got != "question" {
		t.Fatalf("answer 3 last type = %q, want question (forced next_question after follow-up cap)", got)
	}
}

func TestBeginLiveIdempotent(t *testing.T) {
	sqlDB := testDB(t)
	store := testStore(t)
	ctx := context.Background()

	r := testRouter(t, sqlDB, fakeQuestionsLLM(6))
	token := registerUser(t, r, "test-interview-begin-idempotent@example.com")
	sessionID := createInterview(t, r, token, "Backend engineer JD", "mixed")

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, fmt.Sprintf("/api/interviews/%d/start", sessionID), nil)
	req.Header.Set("Authorization", "Bearer "+token)
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("start status = %d, body = %s", w.Code, w.Body.String())
	}

	svc := interview.NewService(sqlDB, fakeQuestionsLLM(6), store)

	var userID int64
	if err := sqlDB.QueryRow(`SELECT id FROM users WHERE email = ?`, "test-interview-begin-idempotent@example.com").Scan(&userID); err != nil {
		t.Fatalf("query user: %v", err)
	}

	msgs1, err := svc.BeginLive(ctx, userID, sessionID)
	if err != nil {
		t.Fatalf("BeginLive 1: %v", err)
	}
	if lastOutboundType(msgs1) != "question" {
		t.Fatalf("BeginLive 1 last type = %q, want question", lastOutboundType(msgs1))
	}

	var turnCount int
	if err := sqlDB.QueryRow(`SELECT COUNT(*) FROM interview_turns WHERE session_id = ?`, sessionID).Scan(&turnCount); err != nil {
		t.Fatalf("count turns after first BeginLive: %v", err)
	}
	if turnCount != 1 {
		t.Fatalf("turn count after first BeginLive = %d, want 1", turnCount)
	}

	msgs2, err := svc.BeginLive(ctx, userID, sessionID)
	if err != nil {
		t.Fatalf("BeginLive 2: %v", err)
	}
	if lastOutboundType(msgs2) != "question" {
		t.Fatalf("BeginLive 2 last type = %q, want question (reconnect pending)", lastOutboundType(msgs2))
	}

	var turnCountAfter int
	if err := sqlDB.QueryRow(`SELECT COUNT(*) FROM interview_turns WHERE session_id = ?`, sessionID).Scan(&turnCountAfter); err != nil {
		t.Fatalf("count turns after second BeginLive: %v", err)
	}
	if turnCountAfter != 1 {
		t.Fatalf("turn count after second BeginLive = %d, want 1 (no duplicate Q0)", turnCountAfter)
	}
}
