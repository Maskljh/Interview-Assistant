package interview_test

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/interview-assistant/backend/internal/db"
	"github.com/interview-assistant/backend/internal/interview"
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

func testRouter(t *testing.T, sqlDB *sql.DB) *gin.Engine {
	t.Helper()
	secret := os.Getenv("JWT_SECRET")
	if secret == "" {
		secret = "test-secret"
	}
	gin.SetMode(gin.TestMode)
	r := gin.New()
	user.RegisterRoutes(r, sqlDB, secret)
	interview.RegisterRoutes(r, sqlDB, secret)
	return r
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
	r := testRouter(t, sqlDB)

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
	r := testRouter(t, sqlDB)
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
