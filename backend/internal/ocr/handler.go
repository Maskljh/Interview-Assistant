package ocr

import (
	"io"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/interview-assistant/backend/internal/auth"
)

const maxImageBytes = 5 << 20

func RegisterRoutes(r *gin.Engine, secret string, client Client) {
	h := &handler{client: client}
	protected := r.Group("/api/ocr")
	protected.Use(auth.Middleware(secret))
	protected.POST("/recognize", h.Recognize)
}

type handler struct {
	client Client
}

func (h *handler) Recognize(c *gin.Context) {
	if h.client == nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": "image recognition unavailable, please use text input"})
		return
	}
	file, err := c.FormFile("file")
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "file is required"})
		return
	}
	if file.Size > maxImageBytes {
		c.JSON(http.StatusBadRequest, gin.H{"error": "image is too large"})
		return
	}
	f, err := file.Open()
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "could not read image"})
		return
	}
	defer f.Close()
	image, err := io.ReadAll(f)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "could not read image"})
		return
	}
	ct := http.DetectContentType(image)
	if ct != "image/jpeg" && ct != "image/png" && ct != "image/webp" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "unsupported image type"})
		return
	}
	text, err := h.client.Recognize(c.Request.Context(), image)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": "image recognition unavailable, please use text input"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"text": text})
}
