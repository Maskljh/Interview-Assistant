package analytics

import (
	"database/sql"
	"net/http"

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
	protected := r.Group("/api/analytics")
	protected.Use(auth.Middleware(secret))
	protected.GET("/trends", h.Trends)
}

func (h *Handler) Trends(c *gin.Context) {
	userID, ok := c.Get("userID")
	if !ok {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
		return
	}

	trends, err := h.svc.Trends(c.Request.Context(), userID.(int64), c.Query("job_tag"), c.Query("mode"))
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not load trends"})
		return
	}
	c.JSON(http.StatusOK, trends)
}
