package question_test

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/gin-gonic/gin"
	"github.com/interview-assistant/backend/internal/db"
	"github.com/interview-assistant/backend/internal/interview"
	"github.com/interview-assistant/backend/internal/llm"
	"github.com/interview-assistant/backend/internal/ocr"
	"github.com/interview-assistant/backend/internal/question"
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
		for _, pattern := range []string{"test-question-%@example.com", "test-import-%@example.com"} {
			_, _ = sqlDB.Exec(`
				DELETE qb FROM question_bank qb
				INNER JOIN users u ON u.id = qb.user_id
				WHERE u.email LIKE ?`, pattern)
			_, _ = sqlDB.Exec(`
				DELETE t FROM interview_turns t
				INNER JOIN interview_sessions s ON s.id = t.session_id
				INNER JOIN users u ON u.id = s.user_id
				WHERE u.email LIKE ?`, pattern)
			_, _ = sqlDB.Exec(`
				DELETE q FROM interview_questions q
				INNER JOIN interview_sessions s ON s.id = q.session_id
				INNER JOIN users u ON u.id = s.user_id
				WHERE u.email LIKE ?`, pattern)
			_, _ = sqlDB.Exec(`
				DELETE s FROM interview_sessions s
				INNER JOIN users u ON u.id = s.user_id
				WHERE u.email LIKE ?`, pattern)
			_, _ = sqlDB.Exec("DELETE FROM users WHERE email LIKE ?", pattern)
		}
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
	question.RegisterRoutes(r, sqlDB, secret, llmClient, nil)
	return r
}

// testRouterWithOCR builds the same router as testRouter but registers the
// question routes with an OCR client so the multipart image import branch is
// exercised end-to-end.
func testRouterWithOCR(t *testing.T, sqlDB *sql.DB, llmClient llm.Client, ocrClient ocr.Client) *gin.Engine {
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
	question.RegisterRoutes(r, sqlDB, secret, llmClient, ocrClient)
	return r
}

// fakeOCR returns a fixed OCR text so the multipart image branch can be tested
// without a real Aliyun client.
type fakeOCR struct{}

func (fakeOCR) Recognize(ctx context.Context, image []byte) (string, error) {
	return "OCR fake text", nil
}

// newMultipartImageBody builds a multipart/form-data body containing a file
// part named "file" with the given filename and content.
func newMultipartImageBody(t *testing.T, filename string, content []byte) ([]byte, string) {
	t.Helper()
	var body bytes.Buffer
	w := multipart.NewWriter(&body)
	part, err := w.CreateFormFile("file", filename)
	if err != nil {
		t.Fatalf("create form file: %v", err)
	}
	if _, err := part.Write(content); err != nil {
		t.Fatalf("write form file: %v", err)
	}
	if err := w.Close(); err != nil {
		t.Fatalf("close multipart: %v", err)
	}
	return body.Bytes(), w.FormDataContentType()
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

	token := registerUser(t, sqlDB, "test-question-import@example.com")
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

	token := registerUser(t, sqlDB, "test-question-empty@example.com")
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

	tokenA := registerUser(t, sqlDB, "test-question-foreign-a@example.com")
	tokenB := registerUser(t, sqlDB, "test-question-foreign-b@example.com")
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

	token := registerUser(t, sqlDB, "test-question-patch@example.com")
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

	tokenA := registerUser(t, sqlDB, "test-question-delete-a@example.com")
	tokenB := registerUser(t, sqlDB, "test-question-delete-b@example.com")
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

	tokenA := registerUser(t, sqlDB, "test-question-isolate-a@example.com")
	tokenB := registerUser(t, sqlDB, "test-question-isolate-b@example.com")
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
	token := registerUser(t, sqlDB, email)
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
	token := registerUser(t, sqlDB, email)
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
	token := registerUser(t, sqlDB, email)
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

	_ = registerUser(t, sqlDB, "test-question-focused@example.com")
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
	token := registerUser(t, sqlDB, email)
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
	token := registerUser(t, sqlDB, email)
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

// TestImportBackfillsUserAnswer verifies that re-importing a session backfills
// the user_answer of an existing bank question that was previously empty.
// This covers the case where a user imports mid-interview (question not yet
// answered → user_answer NULL), then answers later and re-imports.
func TestImportBackfillsUserAnswer(t *testing.T) {
	sqlDB := testDB(t)
	r := testRouter(t, sqlDB, nil)

	const email = "test-question-backfill@example.com"
	token := registerUser(t, sqlDB, email)
	sessionID := createInterview(t, r, token, "Backend engineer JD", "mixed")
	seedTurn(t, sqlDB, sessionID, 1, "interviewer", "question", "Q1")
	seedTurn(t, sqlDB, sessionID, 2, "candidate", "answer", "A1")

	// 模拟旧数据：题库里已有 Q1，但 user_answer 为 NULL
	userID := userIDByEmail(t, sqlDB, email)
	insertBankQuestion(t, sqlDB, userID, "Q1", false, "")

	imported := importFromSession(t, r, token, sessionID)
	if imported != 0 {
		t.Fatalf("imported = %d, want 0 (Q1 already exists)", imported)
	}

	var ua sql.NullString
	if err := sqlDB.QueryRow(`SELECT user_answer FROM question_bank WHERE user_id = ? AND question = ?`, userID, "Q1").Scan(&ua); err != nil {
		t.Fatalf("query user_answer: %v", err)
	}
	if !ua.Valid || ua.String != "A1" {
		t.Fatalf("user_answer = %v, want A1", ua)
	}
}

// TestImportStoresUserAnswerForFollowUps verifies that follow-up questions are
// imported with their paired candidate answer (not null).
func TestImportStoresUserAnswerForFollowUps(t *testing.T) {
	sqlDB := testDB(t)
	r := testRouter(t, sqlDB, nil)

	const email = "test-question-followup-ua@example.com"
	token := registerUser(t, sqlDB, email)
	sessionID := createInterview(t, r, token, "Backend engineer JD", "mixed")
	seedTurn(t, sqlDB, sessionID, 1, "interviewer", "question", "Q1")
	seedTurn(t, sqlDB, sessionID, 2, "candidate", "answer", "A1")
	seedTurn(t, sqlDB, sessionID, 3, "interviewer", "follow_up", "F1")
	seedTurn(t, sqlDB, sessionID, 4, "candidate", "answer", "A2")

	importFromSession(t, r, token, sessionID)

	userID := userIDByEmail(t, sqlDB, email)
	var ua sql.NullString
	if err := sqlDB.QueryRow(`SELECT user_answer FROM question_bank WHERE user_id = ? AND question = ?`, userID, "F1").Scan(&ua); err != nil {
		t.Fatalf("query user_answer for F1: %v", err)
	}
	if !ua.Valid || ua.String != "A2" {
		t.Fatalf("F1 user_answer = %v, want A2", ua)
	}
}

// TestImportSkipsUnansweredQuestionBeforeFollowUp verifies that when the
// interviewer asks a question and immediately follows up without an answer,
// the unanswered question is not paired with the follow-up's answer.
func TestImportSkipsUnansweredQuestionBeforeFollowUp(t *testing.T) {
	sqlDB := testDB(t)
	r := testRouter(t, sqlDB, nil)

	const email = "test-question-skip-unanswered@example.com"
	token := registerUser(t, sqlDB, email)
	sessionID := createInterview(t, r, token, "Backend engineer JD", "mixed")
	seedTurn(t, sqlDB, sessionID, 1, "interviewer", "question", "Q1")
	seedTurn(t, sqlDB, sessionID, 2, "interviewer", "follow_up", "F1")
	seedTurn(t, sqlDB, sessionID, 3, "candidate", "answer", "A1")

	imported := importFromSession(t, r, token, sessionID)
	if imported != 1 {
		t.Fatalf("imported = %d, want 1 (only F1)", imported)
	}

	items := listQuestions(t, r, token, "")
	got := map[string]bool{}
	for _, item := range items {
		got[item.Question] = true
	}
	if got["Q1"] {
		t.Fatal("Q1 should not be imported (unanswered before follow-up)")
	}
	if !got["F1"] {
		t.Fatal("F1 should be imported")
	}
}

type parseLLM struct{ out llm.ParseImportOut }

func (p *parseLLM) ChatJSON(ctx context.Context, system, user string, out any) error {
	dest, ok := out.(*llm.ParseImportOut)
	if !ok {
		return fmt.Errorf("unexpected out type")
	}
	*dest = p.out
	return nil
}

func TestImportConfirmedStoresImportSource(t *testing.T) {
	sqlDB := testDB(t)

	const email = "test-import-confirm@example.com"
	_ = registerUser(t, sqlDB, email)
	userID := userIDByEmail(t, sqlDB, email)

	svc := question.NewService(sqlDB, nil)
	_, err := svc.ImportConfirmed(context.Background(), userID, []question.ParsedQuestion{
		{Question: "导入题A", Answer: "答A", Reference: "出处A"},
		{Question: "导入题B"},
	}, "后端开发")
	if err != nil {
		t.Fatalf("import confirmed: %v", err)
	}

	var source, ref sql.NullString
	var sessionID sql.NullInt64
	if err := sqlDB.QueryRow(`SELECT source, source_session_id, reference FROM question_bank WHERE user_id = ? AND question = ?`, userID, "导入题A").Scan(&source, &sessionID, &ref); err != nil {
		t.Fatalf("query imported row: %v", err)
	}
	if !source.Valid || source.String != "import" {
		t.Fatalf("source = %v, want import", source)
	}
	if sessionID.Valid {
		t.Fatalf("source_session_id should be NULL, got %d", sessionID.Int64)
	}
	if !ref.Valid || ref.String != "出处A" {
		t.Fatalf("reference = %v, want 出处A", ref)
	}
}

// TestImportConfirmedTruncatesLongJobTag verifies that a jobTag longer than 64
// runes is truncated (rune-aware) before INSERT so it cannot fail the whole
// batch: job_tag is VARCHAR(64) and an over-long value would roll back the
// transaction under strict SQL mode.
func TestImportConfirmedTruncatesLongJobTag(t *testing.T) {
	sqlDB := testDB(t)

	const email = "test-import-confirm-tag@example.com"
	_ = registerUser(t, sqlDB, email)
	userID := userIDByEmail(t, sqlDB, email)

	svc := question.NewService(sqlDB, nil)
	// 70 runes: includes multi-byte CJK chars so byte-length != rune-length.
	jobTag := strings.Repeat("超长岗位标签", 10) // 10 * 6 = 60 runes
	jobTag += "一二三四五六七八九十"                 // +10 runes = 70 total, 210 bytes
	if len([]rune(jobTag)) <= 64 {
		t.Fatalf("test setup: jobTag must exceed 64 runes, got %d", len([]rune(jobTag)))
	}
	res, err := svc.ImportConfirmed(context.Background(), userID, []question.ParsedQuestion{
		{Question: "长标签题", Answer: "答"},
	}, jobTag)
	if err != nil {
		t.Fatalf("import confirmed with long jobTag: %v", err)
	}
	if res.Imported != 1 {
		t.Fatalf("imported = %d, want 1", res.Imported)
	}

	var stored sql.NullString
	if err := sqlDB.QueryRow(`SELECT job_tag FROM question_bank WHERE user_id = ? AND question = ?`, userID, "长标签题").Scan(&stored); err != nil {
		t.Fatalf("read stored job_tag: %v", err)
	}
	if !stored.Valid {
		t.Fatal("job_tag should be stored (non-NULL)")
	}
	if got := len([]rune(stored.String)); got != 64 {
		t.Fatalf("stored job_tag rune len = %d, want 64", got)
	}
	if want := string([]rune(jobTag)[:64]); stored.String != want {
		t.Fatalf("stored job_tag = %q, want truncated %q", stored.String, want)
	}
}

func TestImportConfirmedDeduplicates(t *testing.T) {
	sqlDB := testDB(t)

	const email = "test-import-confirm-dedupe@example.com"
	_ = registerUser(t, sqlDB, email)
	userID := userIDByEmail(t, sqlDB, email)

	svc := question.NewService(sqlDB, nil)
	items := []question.ParsedQuestion{{Question: "重复题", Answer: "答", Reference: ""}}
	first, err := svc.ImportConfirmed(context.Background(), userID, items, "")
	if err != nil || first.Imported != 1 {
		t.Fatalf("first import = %+v, err = %v", first, err)
	}
	second, err := svc.ImportConfirmed(context.Background(), userID, items, "")
	if err != nil {
		t.Fatalf("second import: %v", err)
	}
	if second.Imported != 0 || second.Skipped != 1 {
		t.Fatalf("second import = %+v, want imported=0 skipped=1", second)
	}
}

func TestImportConfirmedEmptyRejected(t *testing.T) {
	sqlDB := testDB(t)
	svc := question.NewService(sqlDB, nil)
	_, err := svc.ImportConfirmed(context.Background(), 1, nil, "")
	if !errors.Is(err, question.ErrInvalidInput) {
		t.Fatalf("err = %v, want ErrInvalidInput", err)
	}
}

func TestImportConfirmedClassifiesDimensions(t *testing.T) {
	sqlDB := testDB(t)
	classOut := llm.ClassifyOut{}
	classOut.Classifications = append(classOut.Classifications, struct {
		Question  string `json:"question"`
		Dimension string `json:"dimension"`
	}{Question: "导入分类题", Dimension: "content"})

	const email = "test-import-confirm-classify@example.com"
	_ = registerUser(t, sqlDB, email)
	userID := userIDByEmail(t, sqlDB, email)

	svc := question.NewService(sqlDB, &classifyingLLM{out: classOut})
	if _, err := svc.ImportConfirmed(context.Background(), userID, []question.ParsedQuestion{{Question: "导入分类题"}}, ""); err != nil {
		t.Fatalf("import: %v", err)
	}

	var dim sql.NullString
	if err := sqlDB.QueryRow(`SELECT dimension FROM question_bank WHERE user_id = ? AND question = ?`, userID, "导入分类题").Scan(&dim); err != nil {
		t.Fatalf("read dimension: %v", err)
	}
	if !dim.Valid || dim.String != "content" {
		t.Fatalf("dimension = %v, want content", dim)
	}
}

func TestParseFromTextStructuredAndFallback(t *testing.T) {
	sqlDB := testDB(t)

	// 成功：LLM 返回结构化
	svcOut := parseLLM{out: llm.ParseImportOut{}}
	svcOut.out.Items = append(svcOut.out.Items, struct {
		Question string `json:"question"`
		Answer   string `json:"answer,omitempty"`
	}{Question: "Q1", Answer: "A1"})
	svc := question.NewService(sqlDB, &svcOut)
	res, err := svc.ParseFromText(context.Background(), "面经原文")
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(res.Items) != 1 || res.Items[0].Question != "Q1" {
		t.Fatalf("items = %+v, want one Q1", res.Items)
	}

	// 失败降级：LLM 报错 → 返回 raw
	svc = question.NewService(sqlDB, failingLLM{})
	res, err = svc.ParseFromText(context.Background(), "无法解析的原文")
	if err != nil {
		t.Fatalf("fallback parse should not error, got %v", err)
	}
	if len(res.Items) != 0 || res.Raw != "无法解析的原文" {
		t.Fatalf("fallback = %+v, want empty items + raw", res)
	}
}

func TestImportParseTextHandler(t *testing.T) {
	sqlDB := testDB(t)
	svcOut := parseLLM{out: llm.ParseImportOut{}}
	svcOut.out.Items = append(svcOut.out.Items, struct {
		Question string `json:"question"`
		Answer   string `json:"answer,omitempty"`
	}{Question: "解析题", Answer: "解析答案"})
	r := testRouter(t, sqlDB, &svcOut)

	token := registerUser(t, sqlDB, "test-import-parse@example.com")
	body, _ := json.Marshal(map[string]string{"text": "面经内容"})
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/questions/import/parse", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("parse status = %d, body = %s", w.Code, w.Body.String())
	}
	var resp struct {
		Items []struct {
			Question string `json:"question"`
			Answer   string `json:"answer"`
		} `json:"items"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode parse: %v", err)
	}
	if len(resp.Items) != 1 || resp.Items[0].Question != "解析题" {
		t.Fatalf("items = %+v", resp.Items)
	}
}

func TestImportConfirmHandler(t *testing.T) {
	sqlDB := testDB(t)
	r := testRouter(t, sqlDB, nil)

	token := registerUser(t, sqlDB, "test-import-confirm-h@example.com")
	body, _ := json.Marshal(map[string]any{
		"items": []map[string]any{
			{"question": "接口入库题", "answer": "答", "reference": "出处"},
		},
		"job_tag": "前端开发",
	})
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/questions/import/confirm", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("confirm status = %d, body = %s", w.Code, w.Body.String())
	}
	var resp struct {
		Imported int `json:"imported"`
		Skipped  int `json:"skipped"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode confirm: %v", err)
	}
	if resp.Imported != 1 || resp.Skipped != 0 {
		t.Fatalf("imported=%d skipped=%d, want 1/0", resp.Imported, resp.Skipped)
	}

	items := listQuestions(t, r, token, "")
	found := false
	for _, it := range items {
		if it.Question == "接口入库题" {
			found = true
			if it.Source != "import" {
				t.Fatalf("source = %q, want import", it.Source)
			}
		}
	}
	if !found {
		t.Fatal("imported question not in list")
	}
}

// A valid 1x1 PNG (detected by http.DetectContentType as image/png).
const validPNG = "\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\nIDATx\x9cc\x00\x01\x00\x00\x05\x00\x01\r\n\x2d\xb4\x00\x00\x00\x00IEND\xaeB`\x82"

func TestImportParseImageMultipart(t *testing.T) {
	sqlDB := testDB(t)
	svcOut := parseLLM{out: llm.ParseImportOut{}}
	svcOut.out.Items = append(svcOut.out.Items, struct {
		Question string `json:"question"`
		Answer   string `json:"answer,omitempty"`
	}{Question: "OCR题目", Answer: "OCR答案"})
	// With an OCR client configured, the fake OCR returns "OCR fake text",
	// which the fake LLM turns into a structured item.
	r := testRouterWithOCR(t, sqlDB, &svcOut, fakeOCR{})

	token := registerUser(t, sqlDB, "test-import-parse-img@example.com")
	body, contentType := newMultipartImageBody(t, "shot.png", []byte(validPNG))
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/questions/import/parse", bytes.NewReader(body))
	req.Header.Set("Content-Type", contentType)
	req.Header.Set("Authorization", "Bearer "+token)
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("parse image status = %d, want 200, body = %s", w.Code, w.Body.String())
	}
	var resp struct {
		Items []struct {
			Question string `json:"question"`
			Answer   string `json:"answer"`
		} `json:"items"`
		OcrText string `json:"ocr_text"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode parse image: %v", err)
	}
	if len(resp.Items) != 1 || resp.Items[0].Question != "OCR题目" {
		t.Fatalf("items = %+v, want one OCR题目", resp.Items)
	}
	if resp.OcrText != "OCR fake text" {
		t.Fatalf("ocr_text = %q, want %q", resp.OcrText, "OCR fake text")
	}
}

func TestImportParseImageTooLarge400(t *testing.T) {
	sqlDB := testDB(t)
	r := testRouterWithOCR(t, sqlDB, nil, fakeOCR{})

	token := registerUser(t, sqlDB, "test-import-parse-img-big@example.com")
	// Exceeds maxImportImageBytes (5MB): content is a JPEG header so it would
	// pass MIME validation if it ever got there; the size check must reject it.
	content := append([]byte("\xff\xd8\xff\xe0"), bytes.Repeat([]byte{0x00}, 5<<20+1)...)
	body, contentType := newMultipartImageBody(t, "big.jpg", content)
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/questions/import/parse", bytes.NewReader(body))
	req.Header.Set("Content-Type", contentType)
	req.Header.Set("Authorization", "Bearer "+token)
	r.ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("oversized image status = %d, want 400, body = %s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "image is too large") {
		t.Fatalf("body = %s, want image is too large", w.Body.String())
	}
}

// TestImportParseImageOversizedMultipartBody400 verifies the overall multipart
// body limit: a body larger than maxImportMultipartBodyBytes is rejected before
// the file is parsed (MaxBytesReader path → 400 "image is too large").
func TestImportParseImageOversizedMultipartBody400(t *testing.T) {
	sqlDB := testDB(t)
	r := testRouterWithOCR(t, sqlDB, nil, fakeOCR{})

	token := registerUser(t, sqlDB, "test-import-parse-img-body@example.com")
	// maxImportMultipartBodyBytes = 5MB + 1MB. A file of 6MB+1 plus multipart
	// overhead pushes the whole body over the reader limit.
	content := append([]byte("\xff\xd8\xff\xe0"), bytes.Repeat([]byte{0x00}, (5<<20)+(1<<20)+1)...)
	body, contentType := newMultipartImageBody(t, "huge.jpg", content)
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/questions/import/parse", bytes.NewReader(body))
	req.Header.Set("Content-Type", contentType)
	req.Header.Set("Authorization", "Bearer "+token)
	r.ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("oversized body status = %d, want 400, body = %s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "image is too large") {
		t.Fatalf("body = %s, want image is too large", w.Body.String())
	}
}

func TestImportParseImageUnsupportedType400(t *testing.T) {
	sqlDB := testDB(t)
	r := testRouterWithOCR(t, sqlDB, nil, fakeOCR{})

	token := registerUser(t, sqlDB, "test-import-parse-img-type@example.com")
	// Plain text bytes are not a supported image type.
	body, contentType := newMultipartImageBody(t, "notes.txt", []byte("not an image"))
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/questions/import/parse", bytes.NewReader(body))
	req.Header.Set("Content-Type", contentType)
	req.Header.Set("Authorization", "Bearer "+token)
	r.ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("non-image status = %d, want 400, body = %s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "unsupported image type") {
		t.Fatalf("body = %s, want unsupported image type", w.Body.String())
	}
}

func TestImportParseImageOCRUnavailable502(t *testing.T) {
	sqlDB := testDB(t)
	// No OCR client configured → ParseFromImage returns ErrOCRUnavailable.
	r := testRouter(t, sqlDB, nil)

	token := registerUser(t, sqlDB, "test-import-parse-img-502@example.com")
	body, contentType := newMultipartImageBody(t, "shot.png", []byte(validPNG))
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/questions/import/parse", bytes.NewReader(body))
	req.Header.Set("Content-Type", contentType)
	req.Header.Set("Authorization", "Bearer "+token)
	r.ServeHTTP(w, req)
	if w.Code != http.StatusBadGateway {
		t.Fatalf("no-ocr status = %d, want 502, body = %s", w.Code, w.Body.String())
	}
	var resp struct {
		Error string `json:"error"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp.Error != "image recognition unavailable, please use text input" {
		t.Fatalf("error = %q, want image recognition unavailable", resp.Error)
	}
}
