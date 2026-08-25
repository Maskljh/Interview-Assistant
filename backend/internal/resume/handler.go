package resume

import (
	"database/sql"
	"errors"
	"io"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"github.com/interview-assistant/backend/internal/auth"
	"github.com/interview-assistant/backend/internal/upload"
)

type resumeResponse struct {
	ID         int64  `json:"id"`
	Name       string `json:"name"`
	FileURL    string `json:"file_url"`
	SizeBytes  int64  `json:"size_bytes"`
	ResumeText string `json:"resume_text"`
	UpdatedAt  string `json:"updated_at"`
}

// uploader 抽象 OSS 上传，便于测试注入 fake。
type uploader interface {
	Upload(userID int64, kind, filename, contentType string, r io.Reader, size int64) (key, objectURL string, err error)
}

type Handler struct {
	repo   *Repo
	upload uploader
}

func NewHandler(db *sql.DB, uploadSvc uploader) *Handler {
	return &Handler{repo: NewRepo(db), upload: uploadSvc}
}

func RegisterRoutes(r *gin.Engine, db *sql.DB, secret string, uploadSvc uploader) {
	h := NewHandler(db, uploadSvc)
	g := r.Group("/api/resumes")
	g.Use(auth.Middleware(secret))
	g.GET("", h.List)
	g.POST("", h.Upload)
	g.PATCH("/:id", h.Rename)
	g.DELETE("/:id", h.Delete)
}

func toResponse(f ResumeFile) resumeResponse {
	return resumeResponse{
		ID:         f.ID,
		Name:       f.Name,
		FileURL:    f.FileURL,
		SizeBytes:  f.SizeBytes,
		ResumeText: f.ResumeText,
		UpdatedAt:  f.UpdatedAt.Format("2006-01-02 15:04"),
	}
}

func userID(c *gin.Context) (int64, bool) {
	v, ok := c.Get("userID")
	if !ok {
		return 0, false
	}
	return v.(int64), true
}

func (h *Handler) List(c *gin.Context) {
	uid, ok := userID(c)
	if !ok {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
		return
	}
	items, err := h.repo.List(uid)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not list resumes"})
		return
	}
	out := make([]resumeResponse, 0, len(items))
	for _, f := range items {
		out = append(out, toResponse(f))
	}
	c.JSON(http.StatusOK, gin.H{"items": out})
}

// Upload 上传一份简历：文件经 OSS 上传，简历文本由前端解析后随表单提交。
func (h *Handler) Upload(c *gin.Context) {
	uid, ok := userID(c)
	if !ok {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
		return
	}
	count, err := h.repo.Count(uid)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not count resumes"})
		return
	}
	if count >= MaxResumesPerUser {
		c.JSON(http.StatusBadRequest, gin.H{"error": "最多上传 5 份简历"})
		return
	}

	fileHeader, err := c.FormFile("file")
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "file is required"})
		return
	}
	text := c.PostForm("text")

	f, err := fileHeader.Open()
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "failed to read file"})
		return
	}
	defer f.Close()

	key, objectURL, err := h.upload.Upload(uid, upload.KindResume, fileHeader.Filename, fileHeader.Header.Get("Content-Type"), f, fileHeader.Size)
	if err != nil {
		status := http.StatusBadRequest
		if errors.Is(err, upload.ErrNotConfigured) {
			status = http.StatusServiceUnavailable
		}
		c.JSON(status, gin.H{"error": err.Error()})
		return
	}
	_ = key

	id, err := h.repo.Create(uid, fileHeader.Filename, objectURL, fileHeader.Size, text)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not save resume"})
		return
	}
	item, err := h.repo.GetOwned(uid, id)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not load resume"})
		return
	}
	c.JSON(http.StatusCreated, toResponse(*item))
}

func (h *Handler) Rename(c *gin.Context) {
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
		Name string `json:"name"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || req.Name == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "name is required"})
		return
	}
	if err := h.repo.Rename(uid, id, req.Name); err != nil {
		if errors.Is(err, ErrNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "resume not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not rename resume"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"status": "ok"})
}

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
			c.JSON(http.StatusNotFound, gin.H{"error": "resume not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not delete resume"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"status": "ok"})
}
