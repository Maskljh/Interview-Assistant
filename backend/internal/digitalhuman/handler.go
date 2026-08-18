package digitalhuman

import (
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	"github.com/interview-assistant/backend/internal/auth"
)

const maxVideoTextRunes = 500

func RegisterRoutes(r *gin.Engine, secret string, provider Provider) {
	h := &handler{provider: provider}
	protected := r.Group("/api/digital-human")
	protected.Use(auth.Middleware(secret))
	protected.POST("/videos", h.Submit)
	protected.GET("/videos/:taskId", h.Result)
}

type handler struct {
	provider Provider
}

type submitRequest struct {
	Text string `json:"text"`
}

func (h *handler) Submit(c *gin.Context) {
	if h.provider == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "digital human service unavailable"})
		return
	}
	var req submitRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request"})
		return
	}
	if strings.TrimSpace(req.Text) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "text is required"})
		return
	}
	if utf8.RuneCountInString(req.Text) > maxVideoTextRunes {
		c.JSON(http.StatusBadRequest, gin.H{"error": "text is too long"})
		return
	}
	taskID, err := h.provider.Submit(c.Request.Context(), req.Text)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": "digital human service unavailable"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"taskId": taskID})
}

func (h *handler) Result(c *gin.Context) {
	if h.provider == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "digital human service unavailable"})
		return
	}
	status, videoURL, err := h.provider.Result(c.Request.Context(), c.Param("taskId"))
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": "digital human service unavailable"})
		return
	}
	resp := gin.H{"status": status}
	if videoURL != "" {
		resp["videoURL"] = videoURL
	}
	c.JSON(http.StatusOK, resp)
}
