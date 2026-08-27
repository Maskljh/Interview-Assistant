package interview

import (
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
	JobJD         string    `json:"job_jd"`
	ResumeText    *string   `json:"resume_text"`
	ResumeFileURL *string   `json:"resume_file_url"`
	JDFileURL     *string   `json:"jd_file_url"`
	Mode          Mode      `json:"mode"`
	InputMode     InputMode `json:"input_mode"`
	Persona       string    `json:"persona"`
	Difficulty    string    `json:"difficulty"`
	CompanyStyle  string    `json:"company_style"`
	CameraEnabled bool      `json:"camera_enabled"`
	PrecheckGaps  []string  `json:"precheck_gaps"`
}

type fromBankRequest struct {
	QuestionIDs   []int64   `json:"question_ids"`
	JobJD         string    `json:"job_jd"`
	ResumeText    *string   `json:"resume_text"`
	ResumeFileURL *string   `json:"resume_file_url"`
	JDFileURL     *string   `json:"jd_file_url"`
	Mode          Mode      `json:"mode"`
	InputMode     InputMode `json:"input_mode"`
	Persona       string    `json:"persona"`
	Difficulty    string    `json:"difficulty"`
	CompanyStyle  string    `json:"company_style"`
	CameraEnabled bool      `json:"camera_enabled"`
	PrecheckGaps  []string  `json:"precheck_gaps"`
}

type listItemResponse struct {
	ID        int64     `json:"id"`
	Mode      Mode      `json:"mode"`
	Status       Status    `json:"status"`
	Persona      string    `json:"persona"`
	Difficulty   string    `json:"difficulty"`
	CompanyStyle string    `json:"company_style"`
	CreatedAt    time.Time `json:"created_at"`
	Score        *int      `json:"score"`
}

type sessionResponse struct {
	ID            int64              `json:"id"`
	JobJD         string             `json:"job_jd"`
	JobTitle      *string            `json:"job_title"`
	ResumeText    *string            `json:"resume_text"`
	ResumeFileURL *string            `json:"resume_file_url"`
	JDFileURL     *string            `json:"jd_file_url"`
	Mode          Mode               `json:"mode"`
	InputMode     InputMode          `json:"input_mode"`
	Persona       string             `json:"persona"`
	Difficulty    string             `json:"difficulty"`
	CompanyStyle  string             `json:"company_style"`
	CameraEnabled bool               `json:"camera_enabled"`
	PrecheckGaps  []string           `json:"precheck_gaps,omitempty"`
	Status        Status             `json:"status"`
	Score         *int            `json:"score"`
	FeedbackJSON  any             `json:"feedback_json"`
	StartedAt     *time.Time      `json:"started_at"`
	EndedAt       *time.Time      `json:"ended_at"`
	CreatedAt     time.Time       `json:"created_at"`
	Questions     []questionResponse `json:"questions"`
	Turns         []turnResponse     `json:"turns"`
}

type questionResponse struct {
	ID       int64   `json:"id"`
	Seq      int     `json:"seq"`
	Question string  `json:"question"`
	Kind     string  `json:"kind"`
	Intent   *string `json:"intent"`
	Asked    bool    `json:"asked"`
}

type turnResponse struct {
	ID              int64     `json:"id"`
	Seq             int       `json:"seq"`
	Role            string    `json:"role"`
	Kind            string    `json:"kind"`
	Content         string    `json:"content"`
	VoiceDurationMs *int      `json:"voice_duration_ms"`
	CreatedAt       time.Time `json:"created_at"`
}

func NewHandler(svc *Service) *Handler {
	return &Handler{svc: svc}
}

func RegisterRoutes(r *gin.Engine, secret string, svc *Service) {
	h := NewHandler(svc)
	protected := r.Group("/api/interviews")
	protected.Use(auth.Middleware(secret))
	protected.POST("", h.Create)
	protected.GET("", h.List)
	protected.POST("/from-bank", h.CreateFromBank)
	protected.GET("/:id", h.Get)
	protected.POST("/:id/start", h.Start)
	protected.POST("/:id/end", h.End)
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
	session, err := h.svc.Create(c.Request.Context(), userID.(int64), req.JobJD, req.ResumeText, req.ResumeFileURL, req.JDFileURL, req.Mode, req.InputMode, req.Persona, req.Difficulty, req.CompanyStyle, req.PrecheckGaps, req.CameraEnabled)
	if errors.Is(err, ErrInvalidInput) || errors.Is(err, ErrInvalidMode) || errors.Is(err, ErrInvalidPersona) || errors.Is(err, ErrInvalidDifficulty) || errors.Is(err, ErrInvalidCompanyStyle) {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not create interview"})
		return
	}
	c.JSON(http.StatusCreated, toSessionResponse(session, nil, nil))
}

func (h *Handler) CreateFromBank(c *gin.Context) {
	userID, ok := c.Get("userID")
	if !ok {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
		return
	}
	var req fromBankRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request"})
		return
	}
	session, questions, err := h.svc.CreateFromBank(c.Request.Context(), userID.(int64), req.QuestionIDs, req.JobJD, req.ResumeText, req.ResumeFileURL, req.JDFileURL, req.Mode, req.InputMode, req.Persona, req.Difficulty, req.CompanyStyle, req.PrecheckGaps, req.CameraEnabled)
	if errors.Is(err, ErrInvalidInput) || errors.Is(err, ErrInvalidMode) || errors.Is(err, ErrInvalidPersona) || errors.Is(err, ErrInvalidDifficulty) || errors.Is(err, ErrInvalidCompanyStyle) {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if errors.Is(err, ErrNotFound) {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not create interview from bank"})
		return
	}
	c.JSON(http.StatusCreated, toSessionResponse(session, questions, nil))
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
			ID:           s.ID,
			Mode:         s.Mode,
			Status:       s.Status,
			Persona:      s.Persona,
			Difficulty:   s.Difficulty,
			CompanyStyle: s.CompanyStyle,
			CreatedAt:    s.CreatedAt,
			Score:        s.Score,
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

func (h *Handler) Start(c *gin.Context) {
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
	session, questions, err := h.svc.Start(c.Request.Context(), userID.(int64), id)
	if errors.Is(err, ErrNotFound) {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}
	if errors.Is(err, ErrInvalidState) {
		c.JSON(http.StatusConflict, gin.H{"error": "session cannot be started"})
		return
	}
	if errors.Is(err, ErrLLMFailure) {
		c.JSON(http.StatusBadGateway, gin.H{"error": "question generation failed"})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not start interview"})
		return
	}
	c.JSON(http.StatusOK, toSessionResponse(session, questions, nil))
}

func (h *Handler) End(c *gin.Context) {
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
	if err := h.svc.ForceEnd(c.Request.Context(), userID.(int64), id); err != nil {
		if errors.Is(err, ErrNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
			return
		}
		if errors.Is(err, ErrInvalidState) {
			c.JSON(http.StatusConflict, gin.H{"error": "session cannot be ended"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not end interview"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"status": "completed"})
}

func toSessionResponse(session *Session, questions []Question, turns []Turn) sessionResponse {
	var feedback any
	if len(session.FeedbackJSON) > 0 {
		feedback = session.FeedbackJSON
	}
	resp := sessionResponse{
		ID:            session.ID,
		JobJD:         session.JobJD,
		JobTitle:      session.JobTitle,
		ResumeText:    session.ResumeText,
		ResumeFileURL: session.ResumeFileURL,
		JDFileURL:     session.JDFileURL,
		Mode:          session.Mode,
		InputMode:     session.InputMode,
		Persona:       session.Persona,
		Difficulty:    session.Difficulty,
		CompanyStyle:  session.CompanyStyle,
		CameraEnabled: session.CameraEnabled,
		PrecheckGaps:  session.PrecheckGaps,
		Status:        session.Status,
		Score:         session.Score,
		FeedbackJSON:  feedback,
		StartedAt:     session.StartedAt,
		EndedAt:       session.EndedAt,
		CreatedAt:     session.CreatedAt,
		Questions:     []questionResponse{},
		Turns:         []turnResponse{},
	}
	for _, q := range questions {
		resp.Questions = append(resp.Questions, questionResponse{
			ID:       q.ID,
			Seq:      q.Seq,
			Question: q.Question,
			Kind:     q.Kind,
			Intent:   q.Intent,
			Asked:    q.Asked,
		})
	}
	for _, t := range turns {
		resp.Turns = append(resp.Turns, turnResponse{
			ID:              t.ID,
			Seq:             t.Seq,
			Role:            t.Role,
			Kind:            t.Kind,
			Content:         t.Content,
			VoiceDurationMs: t.VoiceDurationMs,
			CreatedAt:       t.CreatedAt,
		})
	}
	return resp
}
