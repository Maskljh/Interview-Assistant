package interview

import (
	"database/sql"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/interview-assistant/backend/internal/auth"
)

type Handler struct {
	svc *Service
}

type createRequest struct {
	JobJD      string  `json:"job_jd"`
	ResumeText *string `json:"resume_text"`
	Mode       Mode    `json:"mode"`
}

type listItemResponse struct {
	ID        int64     `json:"id"`
	Mode      Mode      `json:"mode"`
	Status    Status    `json:"status"`
	CreatedAt time.Time `json:"created_at"`
	Score     *int      `json:"score"`
}

type sessionResponse struct {
	ID           int64           `json:"id"`
	JobJD        string          `json:"job_jd"`
	ResumeText   *string         `json:"resume_text"`
	Mode         Mode            `json:"mode"`
	Status       Status          `json:"status"`
	Score        *int            `json:"score"`
	FeedbackJSON any             `json:"feedback_json"`
	StartedAt    *time.Time      `json:"started_at"`
	EndedAt      *time.Time      `json:"ended_at"`
	CreatedAt    time.Time       `json:"created_at"`
	Questions    []questionResponse `json:"questions"`
	Turns        []turnResponse     `json:"turns"`
}

type questionResponse struct {
	ID       int64   `json:"id"`
	Seq      int     `json:"seq"`
	Question string  `json:"question"`
	Intent   *string `json:"intent"`
	Asked    bool    `json:"asked"`
}

type turnResponse struct {
	ID        int64     `json:"id"`
	Seq       int       `json:"seq"`
	Role      string    `json:"role"`
	Kind      string    `json:"kind"`
	Content   string    `json:"content"`
	CreatedAt time.Time `json:"created_at"`
}

func NewHandler(db *sql.DB) *Handler {
	return &Handler{svc: NewService(db)}
}

func RegisterRoutes(r *gin.Engine, db *sql.DB, secret string) {
	h := NewHandler(db)
	protected := r.Group("/api/interviews")
	protected.Use(auth.Middleware(secret))
	protected.POST("", h.Create)
	protected.GET("", h.List)
	protected.GET("/:id", h.Get)
}

func (h *Handler) Create(c *gin.Context) {
	userID, ok := c.Get("userID")
	if !ok {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
		return
	}
	var req createRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request"})
		return
	}
	session, err := h.svc.Create(c.Request.Context(), userID.(int64), req.JobJD, req.ResumeText, req.Mode)
	if errors.Is(err, ErrInvalidInput) || errors.Is(err, ErrInvalidMode) {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not create interview"})
		return
	}
	c.JSON(http.StatusCreated, toSessionResponse(session, nil, nil))
}

func (h *Handler) List(c *gin.Context) {
	userID, ok := c.Get("userID")
	if !ok {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
		return
	}
	sessions, err := h.svc.List(c.Request.Context(), userID.(int64))
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not list interviews"})
		return
	}
	items := make([]listItemResponse, 0, len(sessions))
	for _, s := range sessions {
		items = append(items, listItemResponse{
			ID:        s.ID,
			Mode:      s.Mode,
			Status:    s.Status,
			CreatedAt: s.CreatedAt,
			Score:     s.Score,
		})
	}
	c.JSON(http.StatusOK, items)
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
	session, questions, turns, err := h.svc.Get(c.Request.Context(), userID.(int64), id)
	if errors.Is(err, ErrNotFound) {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not get interview"})
		return
	}
	c.JSON(http.StatusOK, toSessionResponse(session, questions, turns))
}

func toSessionResponse(session *Session, questions []Question, turns []Turn) sessionResponse {
	var feedback any
	if len(session.FeedbackJSON) > 0 {
		feedback = session.FeedbackJSON
	}
	resp := sessionResponse{
		ID:           session.ID,
		JobJD:        session.JobJD,
		ResumeText:   session.ResumeText,
		Mode:         session.Mode,
		Status:       session.Status,
		Score:        session.Score,
		FeedbackJSON: feedback,
		StartedAt:    session.StartedAt,
		EndedAt:      session.EndedAt,
		CreatedAt:    session.CreatedAt,
		Questions:    []questionResponse{},
		Turns:        []turnResponse{},
	}
	for _, q := range questions {
		resp.Questions = append(resp.Questions, questionResponse{
			ID:       q.ID,
			Seq:      q.Seq,
			Question: q.Question,
			Intent:   q.Intent,
			Asked:    q.Asked,
		})
	}
	for _, t := range turns {
		resp.Turns = append(resp.Turns, turnResponse{
			ID:        t.ID,
			Seq:       t.Seq,
			Role:      t.Role,
			Kind:      t.Kind,
			Content:   t.Content,
			CreatedAt: t.CreatedAt,
		})
	}
	return resp
}
