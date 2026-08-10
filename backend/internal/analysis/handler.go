package analysis

import (
	"database/sql"
	"errors"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"github.com/interview-assistant/backend/internal/auth"
	"github.com/interview-assistant/backend/internal/llm"
)

type Handler struct {
	svc *Service
}

func NewHandler(db *sql.DB, llmClient llm.Client, modelVersion string) *Handler {
	return &Handler{svc: NewService(db, llmClient, modelVersion)}
}

func RegisterRoutes(r *gin.Engine, db *sql.DB, secret string, llmClient llm.Client, modelVersion string) {
	h := NewHandler(db, llmClient, modelVersion)
	protected := r.Group("/api/interviews")
	protected.Use(auth.Middleware(secret))
	protected.GET("/:id/report", h.GetReport)
	protected.POST("/:id/report/retry", h.RetryReport)
}

func (h *Handler) GetReport(c *gin.Context) {
	userID, ok := c.Get("userID")
	if !ok {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
		return
	}
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid id"})
		return
	}
	report, err := h.svc.GetReport(c.Request.Context(), userID.(int64), id)
	if errors.Is(err, ErrNotFound) {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}
	if errors.Is(err, ErrNotCompleted) {
		c.JSON(http.StatusConflict, gin.H{"error": "report not available"})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not get report"})
		return
	}
	if !report.Available {
		c.JSON(http.StatusOK, gin.H{"available": false})
		return
	}
	c.JSON(http.StatusOK, report.Feedback)
}

func (h *Handler) RetryReport(c *gin.Context) {
	userID, ok := c.Get("userID")
	if !ok {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
		return
	}
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid id"})
		return
	}
	report, err := h.svc.Retry(c.Request.Context(), userID.(int64), id)
	if errors.Is(err, ErrNotFound) {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}
	if errors.Is(err, ErrNotCompleted) {
		c.JSON(http.StatusConflict, gin.H{"error": "report not available"})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not retry report"})
		return
	}
	if !report.Available {
		c.JSON(http.StatusOK, gin.H{"available": false})
		return
	}
	c.JSON(http.StatusOK, report.Feedback)
}
