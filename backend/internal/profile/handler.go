package profile

import (
	"database/sql"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"github.com/interview-assistant/backend/internal/auth"
)

type Handler struct {
	svc *Service
}

func NewHandler(svc *Service) *Handler {
	return &Handler{svc: svc}
}

func RegisterRoutes(r *gin.Engine, db *sql.DB, secret string) {
	svc := NewService(db)
	h := NewHandler(svc)
	protected := r.Group("/api/profile")
	protected.Use(auth.Middleware(secret))
	protected.GET("", h.Get)
}

func (h *Handler) Get(c *gin.Context) {
	userID, ok := c.Get("userID")
	if !ok {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
		return
	}
	maxSessions := 5
	if v := c.Query("sessions"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 1 && n <= 10 {
			maxSessions = n
		}
	}
	p, err := h.svc.Weaknesses(c.Request.Context(), userID.(int64), maxSessions)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not load profile"})
		return
	}
	c.JSON(http.StatusOK, p)
}
