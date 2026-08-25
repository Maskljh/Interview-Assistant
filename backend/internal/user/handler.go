package user

import (
	"database/sql"
	"fmt"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"github.com/interview-assistant/backend/internal/auth"
)

type Handler struct {
	repo   *Repo
	secret string
}

type userResponse struct {
	ID       int64  `json:"id"`
	Email    string `json:"email"`
	Username string `json:"username"`
}

func NewHandler(db *sql.DB, secret string) *Handler {
	return &Handler{repo: NewRepo(db), secret: secret}
}

func RegisterRoutes(r *gin.Engine, db *sql.DB, secret string) {
	h := NewHandler(db, secret)
	me := r.Group("/api/auth/me")
	me.Use(auth.Middleware(secret))
	me.GET("", h.Me)
}

// Me 返回当前登录用户的资料（用户名等）。需要鉴权。
func (h *Handler) Me(c *gin.Context) {
	raw, ok := c.Get("userID")
	if !ok {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
		return
	}
	id, ok := raw.(int64)
	if !ok {
		id, _ = strconv.ParseInt(fmt.Sprint(raw), 10, 64)
	}
	u, err := h.repo.GetByID(id)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "user not found"})
		return
	}
	c.JSON(http.StatusOK, userResponse{ID: u.ID, Email: u.Email, Username: u.Username})
}
