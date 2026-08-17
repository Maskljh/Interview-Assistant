package expression

import (
	"database/sql"
	"errors"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"github.com/interview-assistant/backend/internal/auth"
	"github.com/interview-assistant/backend/internal/interview"
)

type Handler struct {
	svc *Service
}

func NewHandler(repo *interview.Repo) *Handler {
	return &Handler{svc: NewService(repo)}
}

func RegisterRoutes(r *gin.Engine, db *sql.DB, secret string) {
	h := NewHandler(interview.NewRepo(db))
	protected := r.Group("/api/interviews")
	protected.Use(auth.Middleware(secret))
	protected.GET("/:id/expression", h.Get)
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
	res, err := h.svc.Analyze(c.Request.Context(), userID.(int64), id)
	if errors.Is(err, ErrNotFound) {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not analyze expression"})
		return
	}
	c.JSON(http.StatusOK, res)
}
