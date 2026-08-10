package question_test

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"testing"

	"github.com/alicebob/miniredis/v2"
	"github.com/gin-gonic/gin"
	"github.com/interview-assistant/backend/internal/db"
	"github.com/interview-assistant/backend/internal/interview"
	"github.com/interview-assistant/backend/internal/llm"
	"github.com/interview-assistant/backend/internal/question"
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
			DELETE qb FROM question_bank qb
			INNER JOIN users u ON u.id = qb.user_id
			WHERE u.email LIKE 'test-question-%@example.com'`)
		_, _ = sqlDB.Exec(`
			DELETE t FROM interview_turns t
			INNER JOIN interview_sessions s ON s.id = t.session_id
			INNER JOIN users u ON u.id = s.user_id
			WHERE u.email LIKE 'test-question-%@example.com'`)
		_, _ = sqlDB.Exec(`
			DELETE q FROM interview_questions q
			INNER JOIN interview_sessions s ON s.id = q.session_id
			INNER JOIN users u ON u.id = s.user_id
			WHERE u.email LIKE 'test-question-%@example.com'`)
		_, _ = sqlDB.Exec(`
			DELETE s FROM interview_sessions s
			INNER JOIN users u ON u.id = s.user_id
			WHERE u.email LIKE 'test-question-%@example.com'`)
		_, _ = sqlDB.Exec("DELETE FROM users WHERE email LIKE 'test-question-%@example.com'")
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
	question.RegisterRoutes(r, sqlDB, secret)
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

func startInterview(t *testing.T, r *gin.Engine, token string, sessionID int64) {
	t.Helper()
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, fmt.Sprintf("/api/interviews/%d/start", sessionID), nil)
	req.Header.Set("Authorization", "Bearer "+token)
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("start status = %d, want 200, body = %s", w.Code, w.Body.String())
	}
}

func importFromSession(t *testing.T, r *gin.Engine, token string, sessionID int64) int {
	t.Helper()
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, fmt.Sprintf("/api/questions/from-session/%d", sessionID), nil)
	req.Header.Set("Authorization", "Bearer "+token)
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("import status = %d, want 200, body = %s", w.Code, w.Body.String())
	}
	var resp struct {
		Imported int `json:"imported"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode import: %v", err)
	}
	return resp.Imported
}

type bankItem struct {
	ID              int64   `json:"id"`
	Question        string  `json:"question"`
	Source          string  `json:"source"`
	SourceSessionID *int64  `json:"source_session_id"`
	JobTag          *string `json:"job_tag"`
	Starred         bool    `json:"starred"`
}

func listQuestions(t *testing.T, r *gin.Engine, token, query string) []bankItem {
	t.Helper()
	path := "/api/questions"
	if query != "" {
		path += "?" + query
	}
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("list status = %d, want 200, body = %s", w.Code, w.Body.String())
	}
	var items []bankItem
	if err := json.Unmarshal(w.Body.Bytes(), &items); err != nil {
		t.Fatalf("decode list: %v", err)
	}
	return items
}

func TestImportFromSessionCopiesMainQuestions(t *testing.T) {
	sqlDB := testDB(t)
	const n = 6
	r := testRouter(t, sqlDB, fakeQuestionsLLM(n))

	token := registerUser(t, r, "test-question-import@example.com")
	jobJD := "Backend engineer JD"
	sessionID := createInterview(t, r, token, jobJD, "mixed")
	startInterview(t, r, token, sessionID)

	imported := importFromSession(t, r, token, sessionID)
	if imported != n {
		t.Fatalf("imported = %d, want %d", imported, n)
	}

	items := listQuestions(t, r, token, "")
	if len(items) < n {
		t.Fatalf("list len = %d, want >= %d", len(items), n)
	}
	for _, item := range items {
		if item.Source != "interview" {
			t.Fatalf("source = %q, want interview", item.Source)
		}
		if item.Starred {
			t.Fatalf("expected starred=false")
		}
		if item.JobTag == nil || *item.JobTag == "" {
			t.Fatalf("expected non-empty job_tag")
		}
		if item.SourceSessionID == nil || *item.SourceSessionID != sessionID {
			t.Fatalf("source_session_id = %v, want %d", item.SourceSessionID, sessionID)
		}
	}
}

func TestImportEmptySessionReturns400(t *testing.T) {
	sqlDB := testDB(t)
	r := testRouter(t, sqlDB, nil)

	token := registerUser(t, r, "test-question-empty@example.com")
	sessionID := createInterview(t, r, token, "Backend engineer JD", "mixed")

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, fmt.Sprintf("/api/questions/from-session/%d", sessionID), nil)
	req.Header.Set("Authorization", "Bearer "+token)
	r.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("import empty status = %d, want 400, body = %s", w.Code, w.Body.String())
	}
}

func TestImportForeignSessionReturns404(t *testing.T) {
	sqlDB := testDB(t)
	r := testRouter(t, sqlDB, fakeQuestionsLLM(6))

	tokenA := registerUser(t, r, "test-question-foreign-a@example.com")
	tokenB := registerUser(t, r, "test-question-foreign-b@example.com")
	sessionID := createInterview(t, r, tokenA, "Backend engineer JD", "mixed")
	startInterview(t, r, tokenA, sessionID)

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, fmt.Sprintf("/api/questions/from-session/%d", sessionID), nil)
	req.Header.Set("Authorization", "Bearer "+tokenB)
	r.ServeHTTP(w, req)

	if w.Code != http.StatusNotFound {
		t.Fatalf("foreign import status = %d, want 404, body = %s", w.Code, w.Body.String())
	}
}

func TestPatchStarAndFilter(t *testing.T) {
	sqlDB := testDB(t)
	r := testRouter(t, sqlDB, fakeQuestionsLLM(6))

	token := registerUser(t, r, "test-question-patch@example.com")
	jobJD := "Backend engineer JD"
	sessionID := createInterview(t, r, token, jobJD, "mixed")
	startInterview(t, r, token, sessionID)
	importFromSession(t, r, token, sessionID)

	items := listQuestions(t, r, token, "")
	if len(items) == 0 {
		t.Fatal("expected at least one item")
	}
	targetID := items[0].ID

	body, _ := json.Marshal(map[string]bool{"starred": true})
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPatch, fmt.Sprintf("/api/questions/%d", targetID), bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("patch status = %d, want 200, body = %s", w.Code, w.Body.String())
	}

	starred := listQuestions(t, r, token, "starred=1")
	found := false
	for _, item := range starred {
		if item.ID == targetID {
			found = true
			if !item.Starred {
				t.Fatal("expected item to be starred")
			}
		}
	}
	if !found {
		t.Fatal("starred filter did not include patched item")
	}

	byTag := listQuestions(t, r, token, "job_tag="+url.QueryEscape(jobJD))
	if len(byTag) == 0 {
		t.Fatal("job_tag filter returned no items")
	}
}

func TestDeleteOwnQuestion(t *testing.T) {
	sqlDB := testDB(t)
	r := testRouter(t, sqlDB, fakeQuestionsLLM(6))

	tokenA := registerUser(t, r, "test-question-delete-a@example.com")
	tokenB := registerUser(t, r, "test-question-delete-b@example.com")
	sessionID := createInterview(t, r, tokenA, "Backend engineer JD", "mixed")
	startInterview(t, r, tokenA, sessionID)
	importFromSession(t, r, tokenA, sessionID)

	items := listQuestions(t, r, tokenA, "")
	if len(items) == 0 {
		t.Fatal("expected at least one item")
	}
	targetID := items[0].ID

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodDelete, fmt.Sprintf("/api/questions/%d", targetID), nil)
	req.Header.Set("Authorization", "Bearer "+tokenA)
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("delete status = %d, want 200, body = %s", w.Code, w.Body.String())
	}

	remaining := listQuestions(t, r, tokenA, "")
	for _, item := range remaining {
		if item.ID == targetID {
			t.Fatal("deleted item still in list")
		}
	}

	w = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodDelete, fmt.Sprintf("/api/questions/%d", targetID), nil)
	req.Header.Set("Authorization", "Bearer "+tokenB)
	r.ServeHTTP(w, req)
	if w.Code != http.StatusNotFound {
		t.Fatalf("foreign delete status = %d, want 404, body = %s", w.Code, w.Body.String())
	}
}

func TestListIsolation(t *testing.T) {
	sqlDB := testDB(t)
	r := testRouter(t, sqlDB, fakeQuestionsLLM(6))

	tokenA := registerUser(t, r, "test-question-isolate-a@example.com")
	tokenB := registerUser(t, r, "test-question-isolate-b@example.com")
	sessionID := createInterview(t, r, tokenA, "Backend engineer JD", "mixed")
	startInterview(t, r, tokenA, sessionID)
	importFromSession(t, r, tokenA, sessionID)

	itemsA := listQuestions(t, r, tokenA, "")
	if len(itemsA) == 0 {
		t.Fatal("user A should have items")
	}
	itemsB := listQuestions(t, r, tokenB, "")
	if len(itemsB) != 0 {
		t.Fatalf("user B list len = %d, want 0", len(itemsB))
	}
}
