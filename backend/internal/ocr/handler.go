package ocr

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/interview-assistant/backend/internal/auth"
)

const (
	maxImageBytes         = 5 << 20               // single image file cap
	maxMultipartBodyBytes = maxImageBytes + 1<<20 // whole multipart body bound: image + overhead
	recognizeTimeout      = 30 * time.Second
)

func RegisterRoutes(r *gin.Engine, secret string, client Client) {
	// Cap in-memory multipart buffering so an oversized body spills to disk
	// instead of exhausting RAM while the per-file size check runs later.
	r.MaxMultipartMemory = maxMultipartBodyBytes
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
	// Hard-bound the request body before Gin parses the multipart form: a body
	// larger than maxMultipartBodyBytes is rejected outright instead of being
	// buffered (in memory or on disk) first.
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxMultipartBodyBytes)
	file, err := c.FormFile("file")
	if err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) || strings.Contains(err.Error(), "request body too large") {
			c.JSON(http.StatusBadRequest, gin.H{"error": "image is too large"})
			return
		}
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
	ctx, cancel := context.WithTimeout(c.Request.Context(), recognizeTimeout)
	defer cancel()
	text, err := h.client.Recognize(ctx, image)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": "image recognition unavailable, please use text input"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"text": text})
}
