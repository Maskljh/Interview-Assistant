package precheck

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/interview-assistant/backend/internal/auth"
	"github.com/interview-assistant/backend/internal/llm"
)

type Handler struct {
	svc *Service
}

type precheckRequest struct {
	JobJD      string `json:"job_jd"`
	ResumeText string `json:"resume_text"`
}

func NewHandler(svc *Service) *Handler {
	return &Handler{svc: svc}
}

func RegisterRoutes(r *gin.Engine, llmClient llm.Client, secret string) {
	svc := NewService(llmClient)
	h := NewHandler(svc)
	protected := r.Group("/api/precheck")
	protected.Use(auth.Middleware(secret))
	protected.POST("", h.Check)
}

func (h *Handler) Check(c *gin.Context) {
	var req precheckRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request"})
		return
	}
	out, err := h.svc.Check(c.Request.Context(), req.JobJD, req.ResumeText)
	if errors.Is(err, ErrInvalidInput) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "job_jd is required"})
		return
	}
	if errors.Is(err, ErrLLMFailure) {
		c.JSON(http.StatusBadGateway, gin.H{"error": "precheck failed"})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not run precheck"})
		return
	}
	c.JSON(http.StatusOK, out)
}
