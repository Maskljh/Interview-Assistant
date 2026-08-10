package user_test

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/interview-assistant/backend/internal/db"
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
		_, _ = sqlDB.Exec("DELETE FROM users WHERE email LIKE 'test-%@example.com'")
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
	return r
}

func TestRegisterAndLogin(t *testing.T) {
	sqlDB := testDB(t)
	_, err := sqlDB.Exec("DELETE FROM users WHERE email = ?", "test-auth@example.com")
	if err != nil {
		t.Fatalf("cleanup: %v", err)
	}

	r := testRouter(t, sqlDB)
	email := "test-auth@example.com"
	password := "password123"
	body, _ := json.Marshal(map[string]string{"email": email, "password": password})

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/auth/register", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("register status = %d, body = %s", w.Code, w.Body.String())
	}
	var regResp struct {
		Token string `json:"token"`
		User  struct {
			ID    int64  `json:"id"`
			Email string `json:"email"`
		} `json:"user"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &regResp); err != nil {
		t.Fatalf("decode register: %v", err)
	}
	if regResp.Token == "" {
		t.Fatal("expected non-empty token")
	}
	if regResp.User.ID == 0 || regResp.User.Email != email {
		t.Fatalf("unexpected user: %+v", regResp.User)
	}

	w = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/api/auth/login", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("login status = %d, body = %s", w.Code, w.Body.String())
	}

	w = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/api/auth/register", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("duplicate register status = %d, want 400", w.Code)
	}
}
