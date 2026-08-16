package speech

import (
	"fmt"
	"io"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	"github.com/interview-assistant/backend/internal/auth"
)

const maxAudioBytes = 10 << 20
const maxTTSTextRunes = 300

func RegisterRoutes(r *gin.Engine, secret string, client Client) {
	h := &handler{client: client}
	protected := r.Group("/api/speech")
	protected.Use(auth.Middleware(secret))
	protected.POST("/asr", h.ASR)
	protected.POST("/tts", h.TTS)
}

type handler struct {
	client Client
}

type ttsRequest struct {
	Text string `json:"text"`
}

func (h *handler) ASR(c *gin.Context) {
	if h.client == nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": "speech service unavailable"})
		return
	}
	file, err := c.FormFile("audio")
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "audio is required"})
		return
	}
	if file.Size > maxAudioBytes {
		c.JSON(http.StatusBadRequest, gin.H{"error": "audio is too large"})
		return
	}
	f, err := file.Open()
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "could not read audio"})
		return
	}
	defer f.Close()
	audio, err := io.ReadAll(f)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "could not read audio"})
		return
	}
	if len(audio) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "audio is empty"})
		return
	}

	format := strings.TrimSpace(c.PostForm("format"))
	text, err := h.client.Transcribe(c.Request.Context(), audio, format)
	if err != nil {
		fmt.Printf("speech asr error: %v\n", err)
		c.JSON(http.StatusBadGateway, gin.H{"error": "speech service unavailable"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"text": text})
}

func (h *handler) TTS(c *gin.Context) {
	if h.client == nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": "speech service unavailable"})
		return
	}
	var req ttsRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request"})
		return
	}
	if strings.TrimSpace(req.Text) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "text is required"})
		return
	}
	if utf8.RuneCountInString(req.Text) > maxTTSTextRunes {
		c.JSON(http.StatusBadRequest, gin.H{"error": "text is too long"})
		return
	}

	audio, err := h.client.Synthesize(c.Request.Context(), req.Text)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": "speech service unavailable"})
		return
	}
	c.Data(http.StatusOK, "audio/mpeg", audio)
}
