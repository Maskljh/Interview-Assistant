package question_test

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
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
	question.RegisterRoutes(r, sqlDB, secret, llmClient)
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

type classifyingLLM struct {
	out llm.ClassifyOut
}

func (c *classifyingLLM) ChatJSON(ctx context.Context, system, user string, out any) error {
	dest, ok := out.(*llm.ClassifyOut)
	if !ok {
		return fmt.Errorf("unexpected out type")
	}
	*dest = c.out
	return nil
}

type failingLLM struct{}

func (failingLLM) ChatJSON(ctx context.Context, system, user string, out any) error {
	return fmt.Errorf("classification failed")
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

func startInterview(t *testing.T, sqlDB *sql.DB, r *gin.Engine, token string, sessionID int64) {
	t.Helper()
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, fmt.Sprintf("/api/interviews/%d/start", sessionID), nil)
	req.Header.Set("Authorization", "Bearer "+token)
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("start status = %d, want 200, body = %s", w.Code, w.Body.String())
	}
	// Mark all generated questions as asked so the import path (which only
	// imports asked=1 questions) sees them.
	if _, err := sqlDB.Exec(`UPDATE interview_questions SET asked = 1 WHERE session_id = ?`, sessionID); err != nil {
		t.Fatalf("mark questions asked: %v", err)
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
	Dimension       *string `json:"dimension"`
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

func userIDByEmail(t *testing.T, sqlDB *sql.DB, email string) int64 {
	t.Helper()
	var id int64
	if err := sqlDB.QueryRow(`SELECT id FROM users WHERE email = ?`, email).Scan(&id); err != nil {
		t.Fatalf("get user id: %v", err)
	}
	return id
}

// insertBankQuestion inserts a bank question directly. dimension "" maps to NULL.
func insertBankQuestion(t *testing.T, sqlDB *sql.DB, userID int64, question string, starred bool, dimension string) int64 {
	t.Helper()
	starVal := 0
	if starred {
		starVal = 1
	}
	var dim any
	if dimension != "" {
		dim = dimension
	}
	res, err := sqlDB.Exec(
		`INSERT INTO question_bank (user_id, question, source, source_session_id, job_tag, dimension, starred)
		 VALUES (?, ?, 'practice', NULL, NULL, ?, ?)`,
		userID, question, dim, starVal,
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

// seedTurn inserts a single interview turn, simulating a live transcript.
func seedTurn(t *testing.T, sqlDB *sql.DB, sessionID int64, seq int, role, kind, content string) {
	t.Helper()
	if _, err := sqlDB.Exec(
		`INSERT INTO interview_turns (session_id, seq, role, kind, content) VALUES (?, ?, ?, ?, ?)`,
		sessionID, seq, role, kind, content,
	); err != nil {
		t.Fatalf("seed turn: %v", err)
	}
}

func TestImportFromSessionCopiesMainQuestions(t *testing.T) {
	sqlDB := testDB(t)
	r := testRouter(t, sqlDB, nil)

	token := registerUser(t, r, "test-question-import@example.com")
	jobJD := "Backend engineer JD"
	sessionID := createInterview(t, r, token, jobJD, "mixed")
	seedTurn(t, sqlDB, sessionID, 1, "interviewer", "question", "Q1")
	seedTurn(t, sqlDB, sessionID, 2, "candidate", "answer", "A1")
	seedTurn(t, sqlDB, sessionID, 3, "interviewer", "question", "Q2")
	seedTurn(t, sqlDB, sessionID, 4, "candidate", "answer", "A2")
	seedTurn(t, sqlDB, sessionID, 5, "interviewer", "question", "Q3")
	seedTurn(t, sqlDB, sessionID, 6, "candidate", "answer", "A3")

	imported := importFromSession(t, r, token, sessionID)
	if imported != 3 {
		t.Fatalf("imported = %d, want 3", imported)
	}

	items := listQuestions(t, r, token, "")
	if len(items) < 3 {
		t.Fatalf("list len = %d, want >= 3", len(items))
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
	seedTurn(t, sqlDB, sessionID, 1, "interviewer", "question", "Q1")
	seedTurn(t, sqlDB, sessionID, 2, "candidate", "answer", "A1")

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
	seedTurn(t, sqlDB, sessionID, 1, "interviewer", "question", "Q1")
	seedTurn(t, sqlDB, sessionID, 2, "candidate", "answer", "A1")
	seedTurn(t, sqlDB, sessionID, 3, "interviewer", "question", "Q2")
	seedTurn(t, sqlDB, sessionID, 4, "candidate", "answer", "A2")
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
	seedTurn(t, sqlDB, sessionID, 1, "interviewer", "question", "Q1")
	seedTurn(t, sqlDB, sessionID, 2, "candidate", "answer", "A1")
	seedTurn(t, sqlDB, sessionID, 3, "interviewer", "question", "Q2")
	seedTurn(t, sqlDB, sessionID, 4, "candidate", "answer", "A2")
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
	seedTurn(t, sqlDB, sessionID, 1, "interviewer", "question", "Q1")
	seedTurn(t, sqlDB, sessionID, 2, "candidate", "answer", "A1")
	seedTurn(t, sqlDB, sessionID, 3, "interviewer", "question", "Q2")
	seedTurn(t, sqlDB, sessionID, 4, "candidate", "answer", "A2")
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

func TestImportClassifiesDimensions(t *testing.T) {
	sqlDB := testDB(t)
	classOut := llm.ClassifyOut{}
	classOut.Classifications = append(classOut.Classifications, struct {
		Question  string `json:"question"`
		Dimension string `json:"dimension"`
	}{Question: "Q1", Dimension: "logic"})
	r := testRouter(t, sqlDB, &classifyingLLM{out: classOut})

	const email = "test-question-classify@example.com"
	token := registerUser(t, r, email)
	sessionID := createInterview(t, r, token, "Backend engineer JD", "mixed")
	seedTurn(t, sqlDB, sessionID, 1, "interviewer", "question", "Q1")
	seedTurn(t, sqlDB, sessionID, 2, "candidate", "answer", "A1")
	seedTurn(t, sqlDB, sessionID, 3, "interviewer", "question", "Q2")
	seedTurn(t, sqlDB, sessionID, 4, "candidate", "answer", "A2")

	imported := importFromSession(t, r, token, sessionID)
	if imported != 2 {
		t.Fatalf("imported = %d, want 2", imported)
	}

	userID := userIDByEmail(t, sqlDB, email)
	var dim sql.NullString
	if err := sqlDB.QueryRow(`SELECT dimension FROM question_bank WHERE user_id = ? AND question = 'Q1'`, userID).Scan(&dim); err != nil {
		t.Fatalf("read Q1 dimension: %v", err)
	}
	if !dim.Valid || dim.String != "logic" {
		t.Fatalf("Q1 dimension = %v, want logic", dim)
	}
	if err := sqlDB.QueryRow(`SELECT dimension FROM question_bank WHERE user_id = ? AND question = 'Q2'`, userID).Scan(&dim); err != nil {
		t.Fatalf("read Q2 dimension: %v", err)
	}
	if dim.Valid {
		t.Fatalf("Q2 dimension = %q, want NULL", dim.String)
	}
}

func TestImportClassificationFailureKeepsQuestions(t *testing.T) {
	sqlDB := testDB(t)
	r := testRouter(t, sqlDB, failingLLM{})

	const email = "test-question-classify-fail@example.com"
	token := registerUser(t, r, email)
	sessionID := createInterview(t, r, token, "Backend engineer JD", "mixed")
	seedTurn(t, sqlDB, sessionID, 1, "interviewer", "question", "Q1")
	seedTurn(t, sqlDB, sessionID, 2, "candidate", "answer", "A1")
	seedTurn(t, sqlDB, sessionID, 3, "interviewer", "question", "Q2")
	seedTurn(t, sqlDB, sessionID, 4, "candidate", "answer", "A2")

	imported := importFromSession(t, r, token, sessionID)
	if imported != 2 {
		t.Fatalf("imported = %d, want 2", imported)
	}

	userID := userIDByEmail(t, sqlDB, email)
	rows, err := sqlDB.Query(`SELECT dimension FROM question_bank WHERE user_id = ?`, userID)
	if err != nil {
		t.Fatalf("query dimensions: %v", err)
	}
	defer rows.Close()
	count := 0
	for rows.Next() {
		var dim sql.NullString
		if err := rows.Scan(&dim); err != nil {
			t.Fatalf("scan dimension: %v", err)
		}
		if dim.Valid {
			t.Fatalf("expected NULL dimension, got %q", dim.String)
		}
		count++
	}
	if count != 2 {
		t.Fatalf("bank rows = %d, want 2", count)
	}
}

func TestListFiltersByDimension(t *testing.T) {
	sqlDB := testDB(t)
	r := testRouter(t, sqlDB, nil)

	const email = "test-question-listdim@example.com"
	token := registerUser(t, r, email)
	userID := userIDByEmail(t, sqlDB, email)
	insertBankQuestion(t, sqlDB, userID, "logic question", false, "logic")
	insertBankQuestion(t, sqlDB, userID, "content question", false, "content")

	items := listQuestions(t, r, token, "dimension=logic")
	if len(items) != 1 {
		t.Fatalf("len = %d, want 1", len(items))
	}
	if items[0].Question != "logic question" {
		t.Fatalf("got question %q, want logic question", items[0].Question)
	}
	if items[0].Dimension == nil || *items[0].Dimension != "logic" {
		t.Fatalf("dimension = %v, want logic", items[0].Dimension)
	}
}

func TestFocusedStarredFirstAndLimit(t *testing.T) {
	sqlDB := testDB(t)
	r := testRouter(t, sqlDB, nil)

	_ = registerUser(t, r, "test-question-focused@example.com")
	userID := userIDByEmail(t, sqlDB, "test-question-focused@example.com")
	id1 := insertBankQuestion(t, sqlDB, userID, "focused q1", true, "logic")
	id2 := insertBankQuestion(t, sqlDB, userID, "focused q2", true, "logic")
	insertBankQuestion(t, sqlDB, userID, "focused q3", false, "logic")

	svc := question.NewService(sqlDB, nil)
	items, err := svc.Focused(context.Background(), userID, []string{"logic"}, 2)
	if err != nil {
		t.Fatalf("focused: %v", err)
	}
	if len(items) != 2 {
		t.Fatalf("len = %d, want 2", len(items))
	}
	got := map[int64]bool{}
	for _, it := range items {
		if !it.Starred {
			t.Fatalf("expected starred item, got id=%d", it.ID)
		}
		got[it.ID] = true
	}
	if !got[id1] || !got[id2] {
		t.Fatalf("expected ids %d and %d, got %v", id1, id2, got)
	}
}

func TestFocusedEmptyDimensionsRejected(t *testing.T) {
	sqlDB := testDB(t)
	svc := question.NewService(sqlDB, nil)
	_, err := svc.Focused(context.Background(), 1, nil, 5)
	if !errors.Is(err, question.ErrInvalidInput) {
		t.Fatalf("err = %v, want ErrInvalidInput", err)
	}
}

func TestFocusedInvalidDimensionRejected(t *testing.T) {
	sqlDB := testDB(t)
	svc := question.NewService(sqlDB, nil)
	_, err := svc.Focused(context.Background(), 1, []string{"evil"}, 5)
	if !errors.Is(err, question.ErrInvalidInput) {
		t.Fatalf("err = %v, want ErrInvalidInput", err)
	}
}

// TestImportFromSessionIncludesFollowUps verifies that interviewer follow-up
// questions (stored in interview_turns) are imported into the bank together
// with the main questions.
func TestImportFromSessionIncludesFollowUps(t *testing.T) {
	sqlDB := testDB(t)
	r := testRouter(t, sqlDB, nil)

	const email = "test-question-followup@example.com"
	token := registerUser(t, r, email)
	sessionID := createInterview(t, r, token, "Backend engineer JD", "mixed")
	seedTurn(t, sqlDB, sessionID, 1, "interviewer", "question", "Q1")
	seedTurn(t, sqlDB, sessionID, 2, "candidate", "answer", "A1")
	seedTurn(t, sqlDB, sessionID, 3, "interviewer", "follow_up", "F1")
	seedTurn(t, sqlDB, sessionID, 4, "candidate", "answer", "A2")
	seedTurn(t, sqlDB, sessionID, 5, "interviewer", "question", "Q2")
	seedTurn(t, sqlDB, sessionID, 6, "candidate", "answer", "A3")

	imported := importFromSession(t, r, token, sessionID)
	if imported != 3 {
		t.Fatalf("imported = %d, want 3", imported)
	}

	items := listQuestions(t, r, token, "")
	got := map[string]bool{}
	for _, item := range items {
		got[item.Question] = true
	}
	for _, q := range []string{"Q1", "F1", "Q2"} {
		if !got[q] {
			t.Fatalf("question %q missing from bank", q)
		}
	}
}

// TestImportFromSessionDeduplicates verifies that importing the same session
// twice does not duplicate bank rows.
func TestImportFromSessionDeduplicates(t *testing.T) {
	sqlDB := testDB(t)
	r := testRouter(t, sqlDB, nil)

	const email = "test-question-dedupe@example.com"
	token := registerUser(t, r, email)
	sessionID := createInterview(t, r, token, "Backend engineer JD", "mixed")
	seedTurn(t, sqlDB, sessionID, 1, "interviewer", "question", "Q1")
	seedTurn(t, sqlDB, sessionID, 2, "candidate", "answer", "A1")
	seedTurn(t, sqlDB, sessionID, 3, "interviewer", "question", "Q2")
	seedTurn(t, sqlDB, sessionID, 4, "candidate", "answer", "A2")

	first := importFromSession(t, r, token, sessionID)
	if first != 2 {
		t.Fatalf("first import = %d, want 2", first)
	}
	second := importFromSession(t, r, token, sessionID)
	if second != 0 {
		t.Fatalf("second import = %d, want 0 (deduplicated)", second)
	}

	items := listQuestions(t, r, token, "")
	if len(items) != 2 {
		t.Fatalf("bank len = %d, want 2", len(items))
	}
}
