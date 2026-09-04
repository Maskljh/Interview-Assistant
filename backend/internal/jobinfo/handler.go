package jobinfo

import (
	"database/sql"
	"errors"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"github.com/interview-assistant/backend/internal/auth"
)

// jobInfoResponse 岗位信息对外结构。
type jobInfoResponse struct {
	ID        int64  `json:"id"`
	Name      string `json:"name"`
	Content   string `json:"content"`
	CreatedAt string `json:"created_at"`
}

// Handler 岗位信息 CRUD。
type Handler struct {
	repo *Repo
}

// NewHandler 创建岗位信息处理器。
func NewHandler(db *sql.DB) *Handler {
	return &Handler{repo: NewRepo(db)}
}

// RegisterRoutes 注册 /api/job-info 路由（需登录）。
func RegisterRoutes(r *gin.Engine, db *sql.DB, secret string) {
	h := NewHandler(db)
	g := r.Group("/api/job-info")
	g.Use(auth.Middleware(secret))
	g.GET("", h.List)
	g.POST("", h.Create)
	g.PATCH("/:id", h.Update)
	g.DELETE("/:id", h.Delete)
}

func toResponse(f JobInfo) jobInfoResponse {
	return jobInfoResponse{
		ID:        f.ID,
		Name:      f.Name,
		Content:   f.Content,
		CreatedAt: f.CreatedAt.Format("2006-01-02 15:04"),
	}
}

func userID(c *gin.Context) (int64, bool) {
	v, ok := c.Get("userID")
	if !ok {
		return 0, false
	}
	return v.(int64), true
}

// List 返回当前用户的全部岗位信息。
func (h *Handler) List(c *gin.Context) {
	uid, ok := userID(c)
	if !ok {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
		return
	}
	items, err := h.repo.List(uid)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not list job info"})
		return
	}
	out := make([]jobInfoResponse, 0, len(items))
	for _, f := range items {
		out = append(out, toResponse(f))
	}
	c.JSON(http.StatusOK, gin.H{"items": out})
}

// Create 新建岗位信息。
func (h *Handler) Create(c *gin.Context) {
	uid, ok := userID(c)
	if !ok {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
		return
	}
	var req struct {
		Name    string `json:"name"`
		Content string `json:"content"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || req.Name == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "name is required"})
		return
	}
	id, err := h.repo.Create(uid, req.Name, req.Content)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not save job info"})
		return
	}
	item, err := h.repo.GetOwned(uid, id)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not load job info"})
		return
	}
	c.JSON(http.StatusCreated, toResponse(*item))
}

// Update 更新岗位名称与内容。
func (h *Handler) Update(c *gin.Context) {
	uid, ok := userID(c)
	if !ok {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
		return
	}
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid id"})
		return
	}
	var req struct {
		Name    string `json:"name"`
		Content string `json:"content"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || req.Name == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "name is required"})
		return
	}
	if err := h.repo.Update(uid, id, req.Name, req.Content); err != nil {
		if errors.Is(err, ErrNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "job info not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not update job info"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"status": "ok"})
}

// Delete 删除一条岗位信息（仅限本人）。
func (h *Handler) Delete(c *gin.Context) {
	uid, ok := userID(c)
	if !ok {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
		return
	}
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid id"})
		return
	}
	if err := h.repo.Delete(uid, id); err != nil {
		if errors.Is(err, ErrNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "job info not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not delete job info"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"status": "ok"})
}
