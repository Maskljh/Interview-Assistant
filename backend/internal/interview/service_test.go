package interview_test

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/gin-gonic/gin"
	"github.com/interview-assistant/backend/internal/db"
	"github.com/interview-assistant/backend/internal/interview"
	"github.com/interview-assistant/backend/internal/llm"
	"github.com/interview-assistant/backend/internal/profile"
	"github.com/interview-assistant/backend/internal/sessionredis"
	"github.com/interview-assistant/backend/internal/auth"
	"github.com/redis/go-redis/v9"
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
		_, _ = sqlDB.Exec(`
			DELETE qb FROM question_bank qb
			INNER JOIN users u ON u.id = qb.user_id
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
		if title, ok := out.(*llm.JobTitleOut); ok {
			title.Title = "后端工程师"
			return nil
		}
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
		if title, ok := out.(*llm.JobTitleOut); ok {
			title.Title = "后端工程师"
			return nil
		}
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

// registerUser inserts a user directly and returns an app JWT for that user
// (email/password auth was removed in favor of WPS OAuth).
func registerUser(t *testing.T, sqlDB *sql.DB, email string) string {
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
	return token
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

	tokenA := registerUser(t, sqlDB, "test-interview-a@example.com")
	tokenB := registerUser(t, sqlDB, "test-interview-b@example.com")
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
	token := registerUser(t, sqlDB, "test-interview-validate@example.com")

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

	token := registerUser(t, sqlDB, "test-interview-start@example.com")
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

	tokenA := registerUser(t, sqlDB, "test-interview-start-a@example.com")
	tokenB := registerUser(t, sqlDB, "test-interview-start-b@example.com")
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

			token := registerUser(t, sqlDB, tc.email)
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
	token := registerUser(t, sqlDB, "test-interview-followup-cap@example.com")
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

	msgs, err := svc.HandleAnswer(ctx, userID, sessionID, "first answer", nil)
	if err != nil {
		t.Fatalf("HandleAnswer 1: %v", err)
	}
	if lastOutboundType(msgs) != "follow_up" {
		t.Fatalf("answer 1 last type = %q, want follow_up", lastOutboundType(msgs))
	}

	msgs, err = svc.HandleAnswer(ctx, userID, sessionID, "second answer", nil)
	if err != nil {
		t.Fatalf("HandleAnswer 2: %v", err)
	}
	if lastOutboundType(msgs) != "follow_up" {
		t.Fatalf("answer 2 last type = %q, want follow_up", lastOutboundType(msgs))
	}

	msgs, err = svc.HandleAnswer(ctx, userID, sessionID, "third answer", nil)
	if err != nil {
		t.Fatalf("HandleAnswer 3: %v", err)
	}
	if got := lastOutboundType(msgs); got != "question" {
		t.Fatalf("answer 3 last type = %q, want question (forced next_question after follow-up cap)", got)
	}
}

func TestSkipQuestionAdvancesAndEnds(t *testing.T) {
	sqlDB := testDB(t)
	store := testStore(t)
	ctx := context.Background()

	r := testRouter(t, sqlDB, fakeQuestionsLLM(6))
	token := registerUser(t, sqlDB, "test-interview-skip@example.com")
	sessionID := createInterview(t, r, token, "Backend engineer JD", "mixed")

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, fmt.Sprintf("/api/interviews/%d/start", sessionID), nil)
	req.Header.Set("Authorization", "Bearer "+token)
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("start status = %d, body = %s", w.Code, w.Body.String())
	}

	svc := interview.NewService(sqlDB, fakeQuestionsLLM(6), store)
	userID := userIDByEmail(t, sqlDB, "test-interview-skip@example.com")

	if _, err := svc.BeginLive(ctx, userID, sessionID); err != nil {
		t.Fatalf("BeginLive: %v", err)
	}

	// First skip moves from question 1 to question 2, no candidate answer recorded.
	msgs, err := svc.SkipQuestion(ctx, userID, sessionID)
	if err != nil {
		t.Fatalf("SkipQuestion 1: %v", err)
	}
	if lastOutboundType(msgs) != "question" {
		t.Fatalf("skip 1 last type = %q, want question", lastOutboundType(msgs))
	}
	if got := msgs[len(msgs)-1].Progress.Current; got != 2 {
		t.Fatalf("skip 1 progress current = %d, want 2", got)
	}

	// Second skip moves to question 3.
	msgs, err = svc.SkipQuestion(ctx, userID, sessionID)
	if err != nil {
		t.Fatalf("SkipQuestion 2: %v", err)
	}
	if lastOutboundType(msgs) != "question" {
		t.Fatalf("skip 2 last type = %q, want question", lastOutboundType(msgs))
	}
	if got := msgs[len(msgs)-1].Progress.Current; got != 3 {
		t.Fatalf("skip 2 progress current = %d, want 3", got)
	}

	// No candidate answers may have been recorded for the skipped questions.
	session, _, turns, err := svc.Get(ctx, userID, sessionID)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	_ = session
	var candidateTurns int
	for _, tr := range turns {
		if tr.Role == "candidate" {
			candidateTurns++
		}
	}
	if candidateTurns != 0 {
		t.Fatalf("candidate turns = %d, want 0 (skipped questions are not scored)", candidateTurns)
	}
}

func TestSkipQuestionEndsOnLastQuestion(t *testing.T) {
	sqlDB := testDB(t)
	store := testStore(t)
	ctx := context.Background()

	r := testRouter(t, sqlDB, fakeQuestionsLLM(6))
	token := registerUser(t, sqlDB, "test-interview-skip-end@example.com")
	sessionID := createInterview(t, r, token, "Backend engineer JD", "mixed")

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, fmt.Sprintf("/api/interviews/%d/start", sessionID), nil)
	req.Header.Set("Authorization", "Bearer "+token)
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("start status = %d, body = %s", w.Code, w.Body.String())
	}

	svc := interview.NewService(sqlDB, fakeQuestionsLLM(6), store)
	userID := userIDByEmail(t, sqlDB, "test-interview-skip-end@example.com")

	if _, err := svc.BeginLive(ctx, userID, sessionID); err != nil {
		t.Fatalf("BeginLive: %v", err)
	}

	// Skip through the remaining 5 questions; the 6th skip ends the session.
	for i := 0; i < 5; i++ {
		if _, err := svc.SkipQuestion(ctx, userID, sessionID); err != nil {
			t.Fatalf("SkipQuestion %d: %v", i+1, err)
		}
	}
	msgs, err := svc.SkipQuestion(ctx, userID, sessionID)
	if err != nil {
		t.Fatalf("SkipQuestion final: %v", err)
	}
	if lastOutboundType(msgs) != "done" {
		t.Fatalf("final skip last type = %q, want done", lastOutboundType(msgs))
	}

	session, _, _, err := svc.Get(ctx, userID, sessionID)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if session.Status != interview.StatusCompleted {
		t.Fatalf("session status = %q, want completed", session.Status)
	}
}

func insertBankQuestion(t *testing.T, sqlDB *sql.DB, userID int64, text string) int64 {
	t.Helper()
	res, err := sqlDB.Exec(
		`INSERT INTO question_bank (user_id, question, source, starred) VALUES (?, ?, 'manual', 0)`,
		userID, text,
	)
	if err != nil {
		t.Fatalf("insert bank question: %v", err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		t.Fatalf("last insert id: %v", err)
	}
	return id
}

func userIDByEmail(t *testing.T, sqlDB *sql.DB, email string) int64 {
	t.Helper()
	var id int64
	if err := sqlDB.QueryRow(`SELECT id FROM users WHERE email = ?`, email).Scan(&id); err != nil {
		t.Fatalf("query user id: %v", err)
	}
	return id
}

func createFromBank(t *testing.T, r *gin.Engine, token string, questionIDs []int64, mode string) map[string]any {
	t.Helper()
	body, _ := json.Marshal(map[string]any{
		"question_ids": questionIDs,
		"mode":         mode,
	})
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/interviews/from-bank", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	r.ServeHTTP(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("from-bank status = %d, want 201, body = %s", w.Code, w.Body.String())
	}
	var resp map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode from-bank: %v", err)
	}
	return resp
}

func TestCreateFromBankOrdersQuestions(t *testing.T) {
	sqlDB := testDB(t)
	r := testRouter(t, sqlDB, nil)

	token := registerUser(t, sqlDB, "test-interview-frombank-order@example.com")
	userID := userIDByEmail(t, sqlDB, "test-interview-frombank-order@example.com")

	idA := insertBankQuestion(t, sqlDB, userID, "text-a")
	idB := insertBankQuestion(t, sqlDB, userID, "text-b")
	idC := insertBankQuestion(t, sqlDB, userID, "text-c")

	resp := createFromBank(t, r, token, []int64{idC, idA, idB}, "mixed")

	if resp["status"] != "ready" {
		t.Fatalf("status = %v, want ready", resp["status"])
	}
	if resp["job_jd"] != "题库练习（3题）" {
		t.Fatalf("job_jd = %v, want 题库练习（3题）", resp["job_jd"])
	}
	questions, ok := resp["questions"].([]any)
	if !ok || len(questions) != 3 {
		t.Fatalf("questions = %v, want 3 items", resp["questions"])
	}
	wantTexts := []string{"text-c", "text-a", "text-b"}
	for i, q := range questions {
		qm, ok := q.(map[string]any)
		if !ok {
			t.Fatalf("question %d: unexpected type %T", i, q)
		}
		if int(qm["seq"].(float64)) != i+1 {
			t.Fatalf("question %d seq = %v, want %d", i, qm["seq"], i+1)
		}
		if qm["question"] != wantTexts[i] {
			t.Fatalf("question %d text = %v, want %q", i, qm["question"], wantTexts[i])
		}
		if qm["asked"].(bool) {
			t.Fatalf("question %d should not be asked", i)
		}
	}
}

// TestCreateFromBankCarriesJDAndResume 验证题库模式携带岗位信息与简历时，
// 这些定制字段会被真实写入会话（而非被静默丢弃）。
func TestCreateFromBankCarriesJDAndResume(t *testing.T) {
	sqlDB := testDB(t)
	r := testRouter(t, sqlDB, nil)

	token := registerUser(t, sqlDB, "test-interview-frombank-jd@example.com")
	userID := userIDByEmail(t, sqlDB, "test-interview-frombank-jd@example.com")

	idA := insertBankQuestion(t, sqlDB, userID, "text-a")
	idB := insertBankQuestion(t, sqlDB, userID, "text-b")

	jd := "资深后端工程师岗位描述"
	resume := "候选人简历文本"
	jdfile := "https://example.com/jd.pdf"
	resumefile := "https://example.com/resume.docx"

	body, _ := json.Marshal(map[string]any{
		"question_ids":    []int64{idA, idB},
		"mode":            "mixed",
		"job_jd":          jd,
		"resume_text":     resume,
		"jd_file_url":     jdfile,
		"resume_file_url": resumefile,
	})
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/interviews/from-bank", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	r.ServeHTTP(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("from-bank status = %d, want 201, body = %s", w.Code, w.Body.String())
	}
	var resp map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode from-bank: %v", err)
	}
	if resp["job_jd"] != jd {
		t.Fatalf("job_jd = %v, want %q", resp["job_jd"], jd)
	}
	if resp["resume_text"] != resume {
		t.Fatalf("resume_text = %v, want %q", resp["resume_text"], resume)
	}
	if resp["jd_file_url"] != jdfile {
		t.Fatalf("jd_file_url = %v, want %q", resp["jd_file_url"], jdfile)
	}
	if resp["resume_file_url"] != resumefile {
		t.Fatalf("resume_file_url = %v, want %q", resp["resume_file_url"], resumefile)
	}
}

func TestCreateFromBankEmptyIDs400(t *testing.T) {
	sqlDB := testDB(t)
	r := testRouter(t, sqlDB, nil)
	token := registerUser(t, sqlDB, "test-interview-frombank-empty@example.com")

	body, _ := json.Marshal(map[string]any{
		"question_ids": []int64{},
		"mode":         "mixed",
	})
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/interviews/from-bank", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	r.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("empty ids status = %d, want 400, body = %s", w.Code, w.Body.String())
	}
}

func TestCreateFromBankForeignID404(t *testing.T) {
	sqlDB := testDB(t)
	r := testRouter(t, sqlDB, nil)

	_ = registerUser(t, sqlDB, "test-interview-frombank-foreign-a@example.com")
	tokenB := registerUser(t, sqlDB, "test-interview-frombank-foreign-b@example.com")
	userIDA := userIDByEmail(t, sqlDB, "test-interview-frombank-foreign-a@example.com")
	bankID := insertBankQuestion(t, sqlDB, userIDA, "foreign question")

	body, _ := json.Marshal(map[string]any{
		"question_ids": []int64{bankID},
		"mode":         "mixed",
	})
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/interviews/from-bank", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+tokenB)
	r.ServeHTTP(w, req)

	if w.Code != http.StatusNotFound {
		t.Fatalf("foreign id status = %d, want 404, body = %s", w.Code, w.Body.String())
	}
}

func TestCreateFromBankBeginLiveWorks(t *testing.T) {
	sqlDB := testDB(t)
	store := testStore(t)
	ctx := context.Background()
	r := testRouter(t, sqlDB, nil)

	token := registerUser(t, sqlDB, "test-interview-frombank-begin@example.com")
	userID := userIDByEmail(t, sqlDB, "test-interview-frombank-begin@example.com")

	idA := insertBankQuestion(t, sqlDB, userID, "Q1?")
	idB := insertBankQuestion(t, sqlDB, userID, "Q2?")

	resp := createFromBank(t, r, token, []int64{idA, idB}, "behavioral")
	sessionID := int64(resp["id"].(float64))

	svc := interview.NewService(sqlDB, nil, store)
	msgs, err := svc.BeginLive(ctx, userID, sessionID)
	if err != nil {
		t.Fatalf("BeginLive: %v", err)
	}
	if lastOutboundType(msgs) != "question" {
		t.Fatalf("BeginLive last type = %q, want question", lastOutboundType(msgs))
	}
}

func TestCreateDefaultsInputModeVoice(t *testing.T) {
	sqlDB := testDB(t)
	r := testRouter(t, sqlDB, nil)
	token := registerUser(t, sqlDB, "test-interview-inputmode-default@example.com")

	body, _ := json.Marshal(map[string]string{
		"job_jd": "Backend engineer JD",
		"mode":   "mixed",
	})
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/interviews", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	r.ServeHTTP(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("create status = %d, want 201, body = %s", w.Code, w.Body.String())
	}
	var resp map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode create: %v", err)
	}
	if resp["input_mode"] != "voice" {
		t.Fatalf("input_mode = %v, want voice", resp["input_mode"])
	}
	sessionID := int64(resp["id"].(float64))
	var dbInputMode string
	if err := sqlDB.QueryRow(`SELECT input_mode FROM interview_sessions WHERE id = ?`, sessionID).Scan(&dbInputMode); err != nil {
		t.Fatalf("query input_mode: %v", err)
	}
	if dbInputMode != "voice" {
		t.Fatalf("DB input_mode = %q, want voice", dbInputMode)
	}
}

// TestCreateForcesVoiceWhenClientSendsText verifies that a client-supplied
// 'text' input_mode is overridden to 'voice' (voice-only product).
func TestCreateForcesVoiceWhenClientSendsText(t *testing.T) {
	sqlDB := testDB(t)
	r := testRouter(t, sqlDB, nil)
	token := registerUser(t, sqlDB, "test-interview-inputmode-forced@example.com")

	body, _ := json.Marshal(map[string]string{
		"job_jd":     "Backend engineer JD",
		"mode":       "mixed",
		"input_mode": "text",
	})
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/interviews", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	r.ServeHTTP(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("create status = %d, want 201, body = %s", w.Code, w.Body.String())
	}
	var resp map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode create: %v", err)
	}
	if resp["input_mode"] != "voice" {
		t.Fatalf("input_mode = %v, want voice", resp["input_mode"])
	}
	sessionID := int64(resp["id"].(float64))
	var dbInputMode string
	if err := sqlDB.QueryRow(`SELECT input_mode FROM interview_sessions WHERE id = ?`, sessionID).Scan(&dbInputMode); err != nil {
		t.Fatalf("query input_mode: %v", err)
	}
	if dbInputMode != "voice" {
		t.Fatalf("DB input_mode = %q, want voice", dbInputMode)
	}
}

func TestCreateVoiceInputMode(t *testing.T) {
	sqlDB := testDB(t)
	r := testRouter(t, sqlDB, nil)
	token := registerUser(t, sqlDB, "test-interview-inputmode-voice@example.com")

	body, _ := json.Marshal(map[string]string{
		"job_jd":     "Backend engineer JD",
		"mode":       "mixed",
		"input_mode": "voice",
	})
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/interviews", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	r.ServeHTTP(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("create status = %d, want 201, body = %s", w.Code, w.Body.String())
	}
	var resp map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode create: %v", err)
	}
	if resp["input_mode"] != "voice" {
		t.Fatalf("input_mode = %v, want voice", resp["input_mode"])
	}
	sessionID := int64(resp["id"].(float64))
	var dbInputMode string
	if err := sqlDB.QueryRow(`SELECT input_mode FROM interview_sessions WHERE id = ?`, sessionID).Scan(&dbInputMode); err != nil {
		t.Fatalf("query input_mode: %v", err)
	}
	if dbInputMode != "voice" {
		t.Fatalf("DB input_mode = %q, want voice", dbInputMode)
	}
}

func TestCreateInvalidInputMode400(t *testing.T) {
	sqlDB := testDB(t)
	r := testRouter(t, sqlDB, nil)
	token := registerUser(t, sqlDB, "test-interview-inputmode-invalid@example.com")

	body, _ := json.Marshal(map[string]string{
		"job_jd":     "Backend engineer JD",
		"mode":       "mixed",
		"input_mode": "foo",
	})
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/interviews", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	r.ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("invalid input_mode status = %d, want 400, body = %s", w.Code, w.Body.String())
	}
}

func TestCreateFromBankVoiceInputMode(t *testing.T) {
	sqlDB := testDB(t)
	r := testRouter(t, sqlDB, nil)
	token := registerUser(t, sqlDB, "test-interview-frombank-voice@example.com")
	userID := userIDByEmail(t, sqlDB, "test-interview-frombank-voice@example.com")
	bankID := insertBankQuestion(t, sqlDB, userID, "voice question?")

	body, _ := json.Marshal(map[string]any{
		"question_ids": []int64{bankID},
		"mode":         "mixed",
		"input_mode":   "voice",
	})
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/interviews/from-bank", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	r.ServeHTTP(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("from-bank status = %d, want 201, body = %s", w.Code, w.Body.String())
	}
	var resp map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode from-bank: %v", err)
	}
	if resp["input_mode"] != "voice" {
		t.Fatalf("input_mode = %v, want voice", resp["input_mode"])
	}
	sessionID := int64(resp["id"].(float64))
	var dbInputMode string
	if err := sqlDB.QueryRow(`SELECT input_mode FROM interview_sessions WHERE id = ?`, sessionID).Scan(&dbInputMode); err != nil {
		t.Fatalf("query input_mode: %v", err)
	}
	if dbInputMode != "voice" {
		t.Fatalf("DB input_mode = %q, want voice", dbInputMode)
	}
}

func TestBeginLiveIdempotent(t *testing.T) {
	sqlDB := testDB(t)
	store := testStore(t)
	ctx := context.Background()

	r := testRouter(t, sqlDB, fakeQuestionsLLM(6))
	token := registerUser(t, sqlDB, "test-interview-begin-idempotent@example.com")
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

type capturingLLM struct {
	userPrompts []string
}

func (c *capturingLLM) ChatJSON(ctx context.Context, system, user string, out any) error {
	if title, ok := out.(*llm.JobTitleOut); ok {
		title.Title = "后端工程师"
		return nil
	}
	c.userPrompts = append(c.userPrompts, user)
	gen, ok := out.(*llm.GenQuestionsOut)
	if !ok {
		return fmt.Errorf("unexpected out type")
	}
	gen.Questions = make([]llm.GenQuestion, 5)
	for i := range gen.Questions {
		gen.Questions[i] = llm.GenQuestion{Seq: i + 1, Question: "Q?", Intent: "assessment"}
	}
	return nil
}

type fixedProfileProvider struct {
	p profile.Profile
}

func (f fixedProfileProvider) Weaknesses(ctx context.Context, userID int64, maxSessions int) (profile.Profile, error) {
	return f.p, nil
}

func TestStartInjectsWeakDimensions(t *testing.T) {
	sqlDB := testDB(t)
	store := testStore(t)
	ctx := context.Background()

	_ = registerUser(t, sqlDB, "test-interview-weak-inject@example.com")
	userID := userIDByEmail(t, sqlDB, "test-interview-weak-inject@example.com")

	capLLM := &capturingLLM{}
	svc := interview.NewService(sqlDB, capLLM, store)
	svc.SetProfileProvider(fixedProfileProvider{p: profile.Profile{WeakDimensions: []string{"logic"}, BasedOnSessions: 3}})

	session, err := svc.Create(ctx, userID, "Backend engineer JD", nil, nil, nil, interview.ModeMixed, interview.InputModeVoice, llm.StandardPersona, llm.StandardDifficulty, llm.StandardCompanyStyle, nil, false)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if _, _, err := svc.Start(ctx, userID, session.ID); err != nil {
		t.Fatalf("Start: %v", err)
	}

	if len(capLLM.userPrompts) != 1 {
		t.Fatalf("captured %d user prompts, want 1", len(capLLM.userPrompts))
	}
	prompt := capLLM.userPrompts[0]
	if !strings.Contains(prompt, "Targeted focus") || !strings.Contains(prompt, "逻辑结构") {
		t.Fatalf("prompt missing targeted focus directive: %s", prompt)
	}
}

func TestStartNoInjectionWithoutProvider(t *testing.T) {
	sqlDB := testDB(t)
	store := testStore(t)
	ctx := context.Background()

	_ = registerUser(t, sqlDB, "test-interview-weak-none@example.com")
	userID := userIDByEmail(t, sqlDB, "test-interview-weak-none@example.com")

	capLLM := &capturingLLM{}
	svc := interview.NewService(sqlDB, capLLM, store)

	session, err := svc.Create(ctx, userID, "Backend engineer JD", nil, nil, nil, interview.ModeMixed, interview.InputModeVoice, llm.StandardPersona, llm.StandardDifficulty, llm.StandardCompanyStyle, nil, false)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if _, _, err := svc.Start(ctx, userID, session.ID); err != nil {
		t.Fatalf("Start: %v", err)
	}

	if len(capLLM.userPrompts) != 1 {
		t.Fatalf("captured %d user prompts, want 1", len(capLLM.userPrompts))
	}
	if strings.Contains(capLLM.userPrompts[0], "Targeted focus") {
		t.Fatalf("prompt should not contain targeted focus: %s", capLLM.userPrompts[0])
	}
}

func TestCreatePersistsPersona(t *testing.T) {
	sqlDB := testDB(t)
	store := testStore(t)
	ctx := context.Background()
	_ = registerUser(t, sqlDB, "test-interview-persona-persist@example.com")
	userID := userIDByEmail(t, sqlDB, "test-interview-persona-persist@example.com")

	svc := interview.NewService(sqlDB, fakeQuestionsLLM(5), store)
	session, err := svc.Create(ctx, userID, "Backend engineer JD", nil, nil, nil, interview.ModeMixed, interview.InputModeVoice, "strict_tech", llm.StandardDifficulty, llm.StandardCompanyStyle, nil, false)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	got, _, _, err := svc.Get(ctx, userID, session.ID)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got.Persona != "strict_tech" {
		t.Fatalf("persona = %q, want strict_tech", got.Persona)
	}
}

func TestCreateDefaultsStandardPersona(t *testing.T) {
	sqlDB := testDB(t)
	store := testStore(t)
	ctx := context.Background()
	_ = registerUser(t, sqlDB, "test-interview-persona-default@example.com")
	userID := userIDByEmail(t, sqlDB, "test-interview-persona-default@example.com")

	svc := interview.NewService(sqlDB, fakeQuestionsLLM(5), store)
	session, err := svc.Create(ctx, userID, "Backend engineer JD", nil, nil, nil, interview.ModeMixed, interview.InputModeVoice, "", llm.StandardDifficulty, llm.StandardCompanyStyle, nil, false)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if session.Persona != llm.StandardPersona {
		t.Fatalf("persona = %q, want %q", session.Persona, llm.StandardPersona)
	}
}

func TestCreateRejectsInvalidPersona(t *testing.T) {
	sqlDB := testDB(t)
	store := testStore(t)
	ctx := context.Background()
	_ = registerUser(t, sqlDB, "test-interview-persona-invalid@example.com")
	userID := userIDByEmail(t, sqlDB, "test-interview-persona-invalid@example.com")

	svc := interview.NewService(sqlDB, fakeQuestionsLLM(5), store)
	_, err := svc.Create(ctx, userID, "Backend engineer JD", nil, nil, nil, interview.ModeMixed, interview.InputModeVoice, "evil", llm.StandardDifficulty, llm.StandardCompanyStyle, nil, false)
	if !errors.Is(err, interview.ErrInvalidPersona) {
		t.Fatalf("err = %v, want ErrInvalidPersona", err)
	}
}

func TestStartUsesPersonaInPrompt(t *testing.T) {
	sqlDB := testDB(t)
	store := testStore(t)
	ctx := context.Background()
	_ = registerUser(t, sqlDB, "test-interview-persona-start@example.com")
	userID := userIDByEmail(t, sqlDB, "test-interview-persona-start@example.com")

	capLLM := &capturingLLM{}
	svc := interview.NewService(sqlDB, capLLM, store)
	session, err := svc.Create(ctx, userID, "Backend engineer JD", nil, nil, nil, interview.ModeMixed, interview.InputModeVoice, "warm_hr", llm.StandardDifficulty, llm.StandardCompanyStyle, nil, false)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if _, _, err := svc.Start(ctx, userID, session.ID); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if len(capLLM.userPrompts) != 1 {
		t.Fatalf("captured %d prompts, want 1", len(capLLM.userPrompts))
	}
	if !strings.Contains(capLLM.userPrompts[0], "warm and supportive HR interviewer") {
		t.Fatalf("prompt missing persona directive: %s", capLLM.userPrompts[0])
	}
}

func TestListReturnsPersona(t *testing.T) {
	sqlDB := testDB(t)
	r := testRouter(t, sqlDB, nil)
	token := registerUser(t, sqlDB, "test-interview-persona-list@example.com")

	body, _ := json.Marshal(map[string]string{
		"job_jd": "Backend engineer JD",
		"mode":   "mixed",
		"persona": "strict_tech",
	})
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/interviews", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	r.ServeHTTP(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("create status = %d, want 201, body = %s", w.Code, w.Body.String())
	}

	w = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/api/interviews", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("list status = %d, want 200, body = %s", w.Code, w.Body.String())
	}
	var items []struct {
		Persona string `json:"persona"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &items); err != nil {
		t.Fatalf("decode list: %v", err)
	}
	if len(items) != 1 {
		t.Fatalf("len(items) = %d, want 1", len(items))
	}
	if items[0].Persona != "strict_tech" {
		t.Fatalf("persona = %q, want strict_tech", items[0].Persona)
	}
}

func TestCreateRejectsInvalidPersonaHTTP(t *testing.T) {
	sqlDB := testDB(t)
	r := testRouter(t, sqlDB, nil)
	token := registerUser(t, sqlDB, "test-interview-persona-badhttp@example.com")

	body, _ := json.Marshal(map[string]string{
		"job_jd":  "Backend engineer JD",
		"mode":    "mixed",
		"persona": "evil",
	})
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/interviews", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	r.ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("invalid persona status = %d, want 400, body = %s", w.Code, w.Body.String())
	}
}

func TestCreatePersistsPrecheckGaps(t *testing.T) {
	sqlDB := testDB(t)
	store := testStore(t)
	ctx := context.Background()
	_ = registerUser(t, sqlDB, "test-interview-gaps-persist@example.com")
	userID := userIDByEmail(t, sqlDB, "test-interview-gaps-persist@example.com")

	svc := interview.NewService(sqlDB, fakeQuestionsLLM(5), store)
	session, err := svc.Create(ctx, userID, "Backend engineer JD", nil, nil, nil, interview.ModeMixed, interview.InputModeVoice, llm.StandardPersona, llm.StandardDifficulty, llm.StandardCompanyStyle, []string{"缺少K8s经验"}, false)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	got, _, _, err := svc.Get(ctx, userID, session.ID)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if len(got.PrecheckGaps) != 1 || got.PrecheckGaps[0] != "缺少K8s经验" {
		t.Fatalf("precheck_gaps = %v, want [缺少K8s经验]", got.PrecheckGaps)
	}
}

func TestStartInjectsPrecheckGaps(t *testing.T) {
	sqlDB := testDB(t)
	store := testStore(t)
	ctx := context.Background()
	_ = registerUser(t, sqlDB, "test-interview-gaps-start@example.com")
	userID := userIDByEmail(t, sqlDB, "test-interview-gaps-start@example.com")

	capLLM := &capturingLLM{}
	svc := interview.NewService(sqlDB, capLLM, store)
	session, err := svc.Create(ctx, userID, "Backend engineer JD", nil, nil, nil, interview.ModeMixed, interview.InputModeVoice, llm.StandardPersona, llm.StandardDifficulty, llm.StandardCompanyStyle, []string{"缺少K8s经验"}, false)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if _, _, err := svc.Start(ctx, userID, session.ID); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if len(capLLM.userPrompts) != 1 {
		t.Fatalf("captured %d prompts, want 1", len(capLLM.userPrompts))
	}
	if !strings.Contains(capLLM.userPrompts[0], "Targeted focus (pre-check):") || !strings.Contains(capLLM.userPrompts[0], "缺少K8s经验") {
		t.Fatalf("prompt missing precheck directive: %s", capLLM.userPrompts[0])
	}
}
