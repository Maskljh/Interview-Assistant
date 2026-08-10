package question

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

func NewHandler(svc *Service) *Handler {
	return &Handler{svc: svc}
}

func RegisterRoutes(r *gin.Engine, db *sql.DB, secret string) {
	svc := NewService(db)
	h := NewHandler(svc)
	protected := r.Group("/api/questions")
	protected.Use(auth.Middleware(secret))
	protected.GET("", h.List)
	protected.POST("/from-session/:sessionId", h.ImportFromSession)
	protected.PATCH("/:id", h.Patch)
	protected.DELETE("/:id", h.Delete)
}

func (h *Handler) List(c *gin.Context) {
	userID, ok := c.Get("userID")
	if !ok {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
		return
	}

	var f ListFilter
	if starred := c.Query("starred"); starred == "1" {
		v := true
		f.Starred = &v
	}
	f.JobTag = c.Query("job_tag")
	f.Query = c.Query("q")

	items, err := h.svc.List(c.Request.Context(), userID.(int64), f)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not list questions"})
		return
	}
	c.JSON(http.StatusOK, items)
}

func (h *Handler) ImportFromSession(c *gin.Context) {
	userID, ok := c.Get("userID")
	if !ok {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
		return
	}
	sessionID, err := strconv.ParseInt(c.Param("sessionId"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid session id"})
		return
	}

	imported, err := h.svc.ImportFromSession(c.Request.Context(), userID.(int64), sessionID)
	if errors.Is(err, ErrNotFound) {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}
	if errors.Is(err, ErrInvalidInput) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "session has no questions"})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not import questions"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"imported": imported})
}

type patchRequest struct {
	Starred bool `json:"starred"`
}

func (h *Handler) Patch(c *gin.Context) {
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
	var req patchRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request"})
		return
	}

	item, err := h.svc.PatchStar(c.Request.Context(), userID.(int64), id, req.Starred)
	if errors.Is(err, ErrNotFound) {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not update question"})
		return
	}
	c.JSON(http.StatusOK, item)
}

func (h *Handler) Delete(c *gin.Context) {
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

	if err := h.svc.Delete(c.Request.Context(), userID.(int64), id); err != nil {
		if errors.Is(err, ErrNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not delete question"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}
