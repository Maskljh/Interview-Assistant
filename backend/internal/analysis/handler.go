package analysis

import (
	"database/sql"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/interview-assistant/backend/internal/auth"
	"github.com/interview-assistant/backend/internal/llm"
	"github.com/interview-assistant/backend/internal/wps"
)

type Handler struct {
	svc  *Service
	mail *EmailReporter
}

func NewHandler(db *sql.DB, llmClient llm.Client, modelVersion string, tokens wps.TokenProvider) *Handler {
	h := &Handler{svc: NewService(db, llmClient, modelVersion)}
	h.mail = NewEmailReporter(h.svc, wps.NewClient(), tokens)
	return h
}

func RegisterRoutes(r *gin.Engine, db *sql.DB, secret string, llmClient llm.Client, modelVersion string, tokens wps.TokenProvider) {
	h := NewHandler(db, llmClient, modelVersion, tokens)
	protected := r.Group("/api/interviews")
	protected.Use(auth.Middleware(secret))
	protected.GET("/:id/report", h.GetReport)
	protected.POST("/:id/report/retry", h.RetryReport)
	protected.POST("/:id/report/email", h.EmailReport)
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

// EmailReport 把报告摘要发送到当前用户的 WPS 邮箱。
func (h *Handler) EmailReport(c *gin.Context) {
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
	if h.mail == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "邮箱功能未配置"})
		return
	}
	addr, err := h.mail.SendReportEmail(c.Request.Context(), userID.(int64), id)
	if errors.Is(err, ErrNotFound) {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}
	if errors.Is(err, ErrNotCompleted) {
		c.JSON(http.StatusConflict, gin.H{"error": "report not available"})
		return
	}
	if err != nil {
		var ae *wps.APIError
		if errors.As(err, &ae) && (ae.Code == http.StatusForbidden || containsAny(ae.Msg, "权限")) {
			c.JSON(http.StatusForbidden, gin.H{"error": "WPS 邮箱权限未开通，请在 WPS 开放平台为应用申请邮箱权限后重试"})
			return
		}
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"status": "sent", "to": addr})
}

func containsAny(s string, keys ...string) bool {
	for _, k := range keys {
		if strings.Contains(s, k) {
			return true
		}
	}
	return false
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
