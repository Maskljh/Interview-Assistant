package behavior

import (
	"database/sql"
	"errors"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"github.com/interview-assistant/backend/internal/auth"
)

type Handler struct {
	svc *Service
}

func NewHandler(db *sql.DB) *Handler {
	return &Handler{svc: NewService(db)}
}

func RegisterRoutes(r *gin.Engine, db *sql.DB, secret string) {
	h := NewHandler(db)
	protected := r.Group("/api/interviews")
	protected.Use(auth.Middleware(secret))
	protected.GET("/:id/behavior", h.Get)
	protected.POST("/:id/behavior", h.Save)
}

func (h *Handler) Get(c *gin.Context) {
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
	res, err := h.svc.Get(c.Request.Context(), userID.(int64), id)
	if errors.Is(err, ErrNotFound) {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not get behavior"})
		return
	}
	c.JSON(http.StatusOK, res)
}

func (h *Handler) Save(c *gin.Context) {
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
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 64<<10) // 64KB
	var p Payload
	if err := c.ShouldBindJSON(&p); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request"})
		return
	}
	if err := h.svc.Save(c.Request.Context(), userID.(int64), id, p); err != nil {
		if errors.Is(err, ErrNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
			return
		}
		if errors.Is(err, ErrInvalidPayload) {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid payload"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not save behavior"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"status": "saved"})
}
