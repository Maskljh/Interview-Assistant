package upload

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/interview-assistant/backend/internal/auth"
)

type signRequest struct {
	Kind        string `json:"kind"`
	Filename    string `json:"filename"`
	ContentType string `json:"content_type"`
	Size        int64  `json:"size"`
}

type signResponse struct {
	Key       string `json:"key"`
	PutURL    string `json:"put_url"`
	ObjectURL string `json:"object_url"`
	ExpiresIn int    `json:"expires_in"`
}

func RegisterRoutes(r *gin.Engine, secret string, svc *Service) {
	g := r.Group("/api/uploads")
	g.Use(auth.Middleware(secret))
	g.POST("/sign", func(c *gin.Context) {
		_, ok := c.Get("userID")
		if !ok {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
			return
		}
		var req signRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request"})
			return
		}
		key, putURL, objectURL, expiresIn, err := svc.SignUpload(req.Kind, req.Filename, req.ContentType, req.Size)
		if err != nil {
			msg := err.Error()
			status := http.StatusBadRequest
			if msg == "oss not configured" {
				status = http.StatusServiceUnavailable
			}
			c.JSON(status, gin.H{"error": msg})
			return
		}
		c.JSON(http.StatusOK, signResponse{Key: key, PutURL: putURL, ObjectURL: objectURL, ExpiresIn: expiresIn})
	})
}
