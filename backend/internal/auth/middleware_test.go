package auth_test

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/interview-assistant/backend/internal/auth"
)

func TestMiddleware(t *testing.T) {
	gin.SetMode(gin.TestMode)
	const secret = "test-secret"

	t.Run("invalid token returns 401", func(t *testing.T) {
		r := gin.New()
		r.GET("/protected", auth.Middleware(secret), func(c *gin.Context) {
			c.Status(http.StatusOK)
		})

		w := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/protected", nil)
		req.Header.Set("Authorization", "Bearer not-a-valid-token")
		r.ServeHTTP(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Fatalf("status = %d, want 401", w.Code)
		}
	})

	t.Run("valid Bearer sets userID in context", func(t *testing.T) {
		const wantUserID int64 = 42
		token, err := auth.IssueToken(secret, wantUserID, "u@example.com", time.Hour)
		if err != nil {
			t.Fatalf("issue token: %v", err)
		}

		r := gin.New()
		var gotUserID int64
		r.GET("/protected", auth.Middleware(secret), func(c *gin.Context) {
			v, ok := c.Get("userID")
			if !ok {
				t.Fatal("userID not set in context")
			}
			gotUserID, ok = v.(int64)
			if !ok {
				t.Fatalf("userID type = %T, want int64", v)
			}
			c.Status(http.StatusOK)
		})

		w := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/protected", nil)
		req.Header.Set("Authorization", "Bearer "+token)
		r.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200", w.Code)
		}
		if gotUserID != wantUserID {
			t.Fatalf("userID = %d, want %d", gotUserID, wantUserID)
		}
	})
}
