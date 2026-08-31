package upload

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/interview-assistant/backend/internal/auth"
)

type uploadResponse struct {
	Key       string `json:"key"`
	URL       string `json:"url"` // same-origin URL via /api/uploads/object
	ExpiresIn int    `json:"expires_in"`
}

func RegisterRoutes(r *gin.Engine, secret string, svc *Service) {
	g := r.Group("/api/uploads")
	g.Use(auth.Middleware(secret))

	// POST /api/uploads — upload a resume/JD file to OSS via server proxy.
	g.POST("", func(c *gin.Context) {
		userID, ok := c.Get("userID")
		if !ok {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
			return
		}

		kind := c.PostForm("kind")
		fileHeader, err := c.FormFile("file")
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "file is required"})
			return
		}
		if fileHeader.Size > MaxFileSize {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid size"})
			return
		}
		f, err := fileHeader.Open()
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "failed to read file"})
			return
		}
		defer f.Close()

		key, objectURL, err := svc.Upload(userID.(int64), kind, fileHeader.Filename, fileHeader.Header.Get("Content-Type"), f, fileHeader.Size)
		if err != nil {
			status := http.StatusBadRequest
			if errors.Is(err, ErrNotConfigured) {
				status = http.StatusServiceUnavailable
			}
			c.JSON(status, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, uploadResponse{Key: key, URL: objectURL, ExpiresIn: int(PutURLTTL.Seconds())})
	})

	// GET /api/uploads/object?key=... — proxy an OSS object through the API server.
	g.GET("/object", func(c *gin.Context) {
		userID, ok := c.Get("userID")
		if !ok {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
			return
		}
		if err := svc.Proxy(c.Writer, userID.(int64), c.Query("key")); err != nil {
			status := http.StatusBadRequest
			if errors.Is(err, ErrNotConfigured) {
				status = http.StatusServiceUnavailable
			}
			c.JSON(status, gin.H{"error": err.Error()})
			return
		}
	})
}
