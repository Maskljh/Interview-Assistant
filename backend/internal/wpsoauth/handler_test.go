package wpsoauth

import (
	"net/http"
	"net/http/httptest"
	"os"
	"sync/atomic"
	"testing"
	"time"

	"github.com/interview-assistant/backend/internal/db"
)

func TestTokenForUserRefreshesOnceForConcurrentRequests(t *testing.T) {
	dsn := os.Getenv("MYSQL_DSN")
	if dsn == "" {
		dsn = "root:123456@tcp(127.0.0.1:3306)/interview?parseTime=true&charset=utf8mb4"
	}
	sqlDB, err := db.Open(dsn)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}

	const email = "test-wps-refresh-user@example.com"
	t.Cleanup(func() {
		_, _ = sqlDB.Exec("DELETE FROM users WHERE email = ?", email)
	})
	_, _ = sqlDB.Exec("DELETE FROM users WHERE email = ?", email)
	result, err := sqlDB.Exec(`
		INSERT INTO users
			(email, password_hash, username, wps_access_token, wps_refresh_token, wps_token_expires_at, wps_token_scope)
		VALUES (?, ?, ?, ?, ?, ?, ?)`,
		email, "$2a$10$not-a-real-password", "用户", "old-access", "old-refresh", time.Now().Add(-time.Hour), "test-scope",
	)
	if err != nil {
		t.Fatalf("insert user: %v", err)
	}
	userID, err := result.LastInsertId()
	if err != nil {
		t.Fatalf("get user id: %v", err)
	}

	var refreshCalls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		refreshCalls.Add(1)
		time.Sleep(150 * time.Millisecond)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"access_token":"new-access","expires_in":3600}`))
	}))
	defer server.Close()

	handler := &Handler{
		client: NewClient(Config{TokenEndpoint: server.URL}),
		repo:   NewRepo(sqlDB),
	}
	start := make(chan struct{})
	errors := make(chan error, 2)
	for i := 0; i < 2; i++ {
		go func() {
			<-start
			if _, err := handler.TokenForUser(t.Context(), userID); err != nil {
				errors <- err
				return
			}
			errors <- nil
		}()
	}
	close(start)
	for i := 0; i < 2; i++ {
		if err := <-errors; err != nil {
			t.Fatalf("TokenForUser() error = %v", err)
		}
	}

	if refreshCalls.Load() != 1 {
		t.Fatalf("refresh calls = %d, want 1", refreshCalls.Load())
	}
	var accessToken, refreshToken string
	if err := sqlDB.QueryRow(
		"SELECT wps_access_token, wps_refresh_token FROM users WHERE id = ?",
		userID,
	).Scan(&accessToken, &refreshToken); err != nil {
		t.Fatalf("load token: %v", err)
	}
	if accessToken != "new-access" || refreshToken != "old-refresh" {
		t.Fatalf("token = %q/%q, want new-access/old-refresh", accessToken, refreshToken)
	}
}
