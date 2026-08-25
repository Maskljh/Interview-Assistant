package question

import (
	"database/sql"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/interview-assistant/backend/internal/auth"
	"github.com/interview-assistant/backend/internal/llm"
	"github.com/interview-assistant/backend/internal/ocr"
)

type Handler struct {
	svc *Service
}

func NewHandler(svc *Service) *Handler {
	return &Handler{svc: svc}
}

func RegisterRoutes(r *gin.Engine, db *sql.DB, secret string, llmClient llm.Client, ocrClient ocr.Client) {
	svc := NewService(db, llmClient)
	svc.SetOCR(ocrClient)
	h := NewHandler(svc)
	protected := r.Group("/api/questions")
	protected.Use(auth.Middleware(secret))
	protected.GET("", h.List)
	protected.POST("/from-session/:sessionId", h.ImportFromSession)
	protected.POST("/import/parse", h.ImportParse)
	protected.POST("/import/confirm", h.ImportConfirm)
	protected.POST("/question-bank/focused", h.Focused)
	protected.PATCH("/:id", h.Patch)
	protected.DELETE("/:id", h.Delete)
	protected.POST("/batch-delete", h.BatchDelete)
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
	f.Dimension = c.Query("dimension")

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

type focusedRequest struct {
	Dimensions  []string `json:"dimensions"`
	LimitPerDim int      `json:"limit_per_dimension"`
}

func (h *Handler) Focused(c *gin.Context) {
	userID, ok := c.Get("userID")
	if !ok {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
		return
	}
	var req focusedRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request"})
		return
	}
	items, err := h.svc.Focused(c.Request.Context(), userID.(int64), req.Dimensions, req.LimitPerDim)
	if errors.Is(err, ErrInvalidInput) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid dimensions"})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not build focused set"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"items": items})
}

type patchRequest struct {
	Starred   *bool   `json:"starred"`
	Question  *string `json:"question"`
	Answer    *string `json:"answer"`
	JobTag    *string `json:"job_tag"`
	Dimension *string `json:"dimension"`
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

	item, err := h.svc.Patch(c.Request.Context(), userID.(int64), id, req.Starred, req.Question, req.Answer, req.JobTag, req.Dimension)
	if errors.Is(err, ErrNotFound) {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}
	if errors.Is(err, ErrInvalidInput) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid question fields"})
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

func (h *Handler) BatchDelete(c *gin.Context) {
	userID, ok := c.Get("userID")
	if !ok {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
		return
	}
	var req struct {
		IDs []int64 `json:"ids"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || len(req.IDs) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid ids"})
		return
	}
	deleted := 0
	for _, id := range req.IDs {
		if err := h.svc.Delete(c.Request.Context(), userID.(int64), id); err == nil {
			deleted++
		}
	}
	c.JSON(http.StatusOK, gin.H{"deleted": deleted})
}

const (
	maxImportImageBytes         = 5 << 20                     // 单个图片文件大小上限
	maxImportMultipartBodyBytes = maxImportImageBytes + 1<<20 // 整个 multipart body 上限：图片 + 头部等开销
)

type parseRequest struct {
	Text string `json:"text"`
}

type confirmItem struct {
	Question  string `json:"question"`
	Answer    string `json:"answer"`
	Reference string `json:"reference"`
}

type confirmRequest struct {
	Items  []confirmItem `json:"items"`
	JobTag string        `json:"job_tag"`
}

func (h *Handler) ImportParse(c *gin.Context) {
	_, ok := c.Get("userID")
	if !ok {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
		return
	}

	// 图片（multipart）或文本（JSON）二选一
	var res ParseResult
	if strings.HasPrefix(c.GetHeader("Content-Type"), "multipart/form-data") {
		// 在解析整个 multipart body 前套上总大小上限，避免已认证客户端
		// 流式发送超大 body 在付费 OCR 调用之前形成 DoS。
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxImportMultipartBodyBytes)
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
		if file.Size > maxImportImageBytes {
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
		switch http.DetectContentType(image) {
		case "image/jpeg", "image/png", "image/webp":
		default:
			c.JSON(http.StatusBadRequest, gin.H{"error": "unsupported image type"})
			return
		}
		res, err = h.svc.ParseFromImage(c.Request.Context(), image)
		if errors.Is(err, ErrOCRUnavailable) {
			c.JSON(http.StatusBadGateway, gin.H{"error": "image recognition unavailable, please use text input"})
			return
		}
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "could not parse image"})
			return
		}
	} else {
		var req parseRequest
		if err := c.ShouldBindJSON(&req); err != nil || strings.TrimSpace(req.Text) == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "text is required"})
			return
		}
		var err error
		res, err = h.svc.ParseFromText(c.Request.Context(), req.Text)
		if errors.Is(err, ErrInvalidInput) {
			c.JSON(http.StatusBadRequest, gin.H{"error": "text is required"})
			return
		}
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "could not parse text"})
			return
		}
	}

	type itemJSON struct {
		Question string `json:"question"`
		Answer   string `json:"answer,omitempty"`
	}
	items := make([]itemJSON, 0, len(res.Items))
	for _, it := range res.Items {
		items = append(items, itemJSON{Question: it.Question, Answer: it.Answer})
	}
	c.JSON(http.StatusOK, gin.H{
		"items":    items,
		"raw":      res.Raw,
		"ocr_text": res.OcrText,
	})
}

func (h *Handler) ImportConfirm(c *gin.Context) {
	userID, ok := c.Get("userID")
	if !ok {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
		return
	}
	var req confirmRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request"})
		return
	}
	items := make([]ParsedQuestion, 0, len(req.Items))
	for _, it := range req.Items {
		items = append(items, ParsedQuestion{
			Question:  it.Question,
			Answer:    it.Answer,
			Reference: it.Reference,
		})
	}
	res, err := h.svc.ImportConfirmed(c.Request.Context(), userID.(int64), items, req.JobTag)
	if errors.Is(err, ErrInvalidInput) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "items are required"})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not import questions"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"imported": res.Imported, "skipped": res.Skipped})
}
