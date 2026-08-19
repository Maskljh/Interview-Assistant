package livestream

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	"github.com/interview-assistant/backend/internal/auth"
)

const maxSpeakTextRunes = 1000

func RegisterRoutes(r *gin.Engine, secret string, provider Provider, cfg *Config) {
	h := &handler{provider: provider, sessions: make(map[string]Session), appKey: cfg.APIKey, accessToken: cfg.Secret, projectID: cfg.AvatarID}
	protected := r.Group("/api/livestream")
	protected.Use(auth.Middleware(secret))
	protected.POST("/sessions", h.Create)
	protected.POST("/sessions/:id/speak", h.Speak)
	protected.POST("/sessions/:id/close", h.Close)
	protected.GET("/sign", h.Sign)
}

type handler struct {
	provider    Provider
	mu          sync.Mutex
	sessions    map[string]Session
	appKey      string
	accessToken string
	projectID   string
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
		log.Printf("livestream StartSession: %v", err)
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
		log.Printf("livestream speak: %v", err)
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

// rawIVHSignature 生成腾讯 IVH 签名原始值：query 公共参数按字典序拼 k=v&k=v，
// 用 AccessToken 作密钥 HmacSha256，返回 Base64 编码（未做 URL 转义）。
func rawIVHSignature(appkey, timestamp, accessToken string) string {
	plain := "appkey=" + appkey + "&timestamp=" + timestamp
	mac := hmac.New(sha256.New, []byte(accessToken))
	mac.Write([]byte(plain))
	return base64.StdEncoding.EncodeToString(mac.Sum(nil))
}

// signIVHParams 返回已做 URL 编码的签名，供 /sign 接口原样返回给前端插入 query。
// 后端 ivhCall 应使用 rawIVHSignature，让 url.Values.Encode() 完成唯一一次转义，
// 避免对 signIVHParams 的输出再次编码造成二次转义（% 变 %25）。
func signIVHParams(appkey, timestamp, accessToken string) string {
	return url.QueryEscape(rawIVHSignature(appkey, timestamp, accessToken))
}

func (h *handler) Sign(c *gin.Context) {
	if h.provider == nil || h.appKey == "" || h.accessToken == "" || h.projectID == "" {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "livestream service unavailable"})
		return
	}
	timestamp := strconv.FormatInt(time.Now().Unix(), 10)
	c.JSON(http.StatusOK, gin.H{
		"appkey":              h.appKey,
		"timestamp":           timestamp,
		"signature":           signIVHParams(h.appKey, timestamp, h.accessToken),
		"virtualmanProjectId": h.projectID,
		"userId":              fmt.Sprintf("interview-%d", time.Now().UnixNano()),
	})
}
