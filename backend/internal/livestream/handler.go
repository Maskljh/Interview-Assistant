package livestream

import (
	"crypto/rand"
	"encoding/hex"
	"net/http"
	"strings"
	"sync"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	"github.com/interview-assistant/backend/internal/auth"
)

const maxSpeakTextRunes = 1000

func RegisterRoutes(r *gin.Engine, secret string, provider Provider) {
	h := &handler{provider: provider, sessions: make(map[string]Session)}
	protected := r.Group("/api/livestream")
	protected.Use(auth.Middleware(secret))
	protected.POST("/sessions", h.Create)
	protected.POST("/sessions/:id/speak", h.Speak)
	protected.POST("/sessions/:id/close", h.Close)
}

type handler struct {
	provider Provider
	mu       sync.Mutex
	sessions map[string]Session
}

type createResponse struct {
	SessionID string `json:"sessionId"`
	StreamURL string `json:"streamURL"`
}

func (h *handler) Create(c *gin.Context) {
	if h.provider == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "livestream service unavailable"})
		return
	}
	sess, err := h.provider.StartSession(c.Request.Context(), "")
	if err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "livestream service unavailable"})
		return
	}
	sessionID := randomID()
	h.mu.Lock()
	h.sessions[sessionID] = sess
	h.mu.Unlock()
	c.JSON(http.StatusOK, createResponse{SessionID: sessionID, StreamURL: sess.StreamURL()})
}

type speakRequest struct {
	Text string `json:"text"`
}

func (h *handler) Speak(c *gin.Context) {
	id := c.Param("id")
	if id == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "id is required"})
		return
	}
	sess, ok := h.lookup(id)
	if !ok {
		c.JSON(http.StatusNotFound, gin.H{"error": "session not found"})
		return
	}
	var req speakRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request"})
		return
	}
	if strings.TrimSpace(req.Text) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "text is required"})
		return
	}
	if utf8.RuneCountInString(req.Text) > maxSpeakTextRunes {
		c.JSON(http.StatusBadRequest, gin.H{"error": "text is too long"})
		return
	}
	if err := sess.Speak(c.Request.Context(), req.Text); err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": "livestream speak failed"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (h *handler) Close(c *gin.Context) {
	id := c.Param("id")
	if id == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "id is required"})
		return
	}
	h.mu.Lock()
	sess, ok := h.sessions[id]
	if ok {
		delete(h.sessions, id)
	}
	h.mu.Unlock()
	if !ok {
		c.JSON(http.StatusNotFound, gin.H{"error": "session not found"})
		return
	}
	_ = sess.Close()
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (h *handler) lookup(id string) (Session, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	s, ok := h.sessions[id]
	return s, ok
}

func randomID() string {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		return "session"
	}
	return hex.EncodeToString(b)
}
