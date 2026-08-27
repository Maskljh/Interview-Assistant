package wpsoauth

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"log"
	"net/http"
	"net/url"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/interview-assistant/backend/internal/auth"
	"github.com/redis/go-redis/v9"
)

const (
	// stateTTL 是授权 state 的有效期；超过后回调被拒绝，需要重新发起登录。
	stateTTL = 10 * time.Minute
	// codeTTL 是一次性 oauth_code 的有效期，前端必须在窗口内换取应用 token。
	codeTTL = 60 * time.Second
	// tokenTTL 与应用签发 JWT 的过期时间保持一致（现有账号登录同为 24h）。
	tokenTTL = 24 * time.Hour
)

const (
	keyStatePrefix = "interview:oauth:state:"
	keyCodePrefix  = "interview:oauth:code:"
)

// Handler 处理 WPS OAuth 三个端点。
type Handler struct {
	cfg    Config
	client *Client
	repo   *Repo
	rdb    *redis.Client
	secret string
}

func NewHandler(cfg Config, db *sql.DB, rdb *redis.Client, secret string) *Handler {
	return &Handler{
		cfg:    cfg,
		client: NewClient(cfg),
		repo:   NewRepo(db),
		rdb:    rdb,
		secret: secret,
	}
}

// RegisterRoutes 在 /api/auth 下挂载 WPS OAuth 端点，并返回 Handler
// 供主进程在回调专用端口（如 18365）复用同一个 Callback 处理逻辑。
func RegisterRoutes(r *gin.Engine, db *sql.DB, secret string, cfg Config, rdb *redis.Client) *Handler {
	h := NewHandler(cfg, db, rdb, secret)
	group := r.Group("/api/auth")
	group.GET("/wps/authorize", h.Authorize)
	group.GET("/wps/callback", h.Callback)
	group.POST("/wps/exchange", h.Exchange)
	return h
}

// RegisterCallbackListener 在独立端口挂载 /callback 路由（兼容 mini-wps-comate
// 在开放平台登记的 http://127.0.0.1:18365/callback 回调地址）。
func (h *Handler) RegisterCallbackListener(r *gin.Engine) {
	r.GET("/callback", h.Callback)
}

type userResponse struct {
	ID       int64  `json:"id"`
	Email    string `json:"email"`
	Username string `json:"username"`
	UserID   string `json:"user_id,omitempty"` // WPS 账号全局数字 ID
}

type authResponse struct {
	Token string       `json:"token"`
	User  userResponse `json:"user"`
}

// Authorize 生成随机 state 存 Redis，返回 WPS 授权页地址，由前端整页跳转。
func (h *Handler) Authorize(c *gin.Context) {
	if h.cfg.ClientID == "" || h.cfg.ClientSecret == "" {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "WPS OAuth 未配置"})
		return
	}
	state, err := randomToken(24)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not generate state"})
		return
	}
	if err := h.rdb.Set(c.Request.Context(), keyStatePrefix+state, "1", stateTTL).Err(); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not store state"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"url": h.client.BuildAuthURL(state)})
}

// Callback 接收 WPS 授权回调：校验 state → 换 token → 拉用户信息 → upsert 用户
// → 生成一次性 oauth_code 存 Redis → 302 回前端登录页（token 不进 URL）。
func (h *Handler) Callback(c *gin.Context) {
	code := c.Query("code")
	state := c.Query("state")
	if code == "" || state == "" {
		h.redirectWithError(c, "missing code or state")
		return
	}
	ctx := c.Request.Context()
	if _, ok, err := h.consume(ctx, keyStatePrefix+state); err != nil {
		log.Printf("[wpsoauth] callback: consume state failed: %v", err)
		h.redirectWithError(c, "服务内部错误")
		return
	} else if !ok {
		h.redirectWithError(c, "state 校验不通过")
		return
	}

	accessToken, refreshToken, expiresIn, err := h.client.ExchangeCode(ctx, code)
	if err != nil {
		log.Printf("[wpsoauth] callback: ExchangeCode failed: %v", err)
		h.redirectWithError(c, err.Error())
		return
	}
	wpsUser, err := h.client.FetchUser(ctx, accessToken)
	if err != nil {
		log.Printf("[wpsoauth] callback: FetchUser failed: %v", err)
		h.redirectWithError(c, err.Error())
		return
	}
	u, err := h.repo.UpsertWPSUser(wpsUser.OpenID, wpsUser.UserID, wpsUser.Name, wpsUser.Avatar)
	if err != nil {
		log.Printf("[wpsoauth] callback: UpsertWPSUser failed: %v", err)
		h.redirectWithError(c, "保存用户失败")
		return
	}

	// 持久化 WPS 授权凭证，供云文档（简历）与邮箱（报告）能力使用。
	if err := h.saveWPSToken(u.ID, accessToken, refreshToken, expiresIn); err != nil {
		log.Printf("[wpsoauth] callback: save wps token failed: %v", err)
	}

	oauthCode, err := randomToken(24)
	if err != nil {
		h.redirectWithError(c, "服务内部错误")
		return
	}
	if err := h.rdb.Set(ctx, keyCodePrefix+oauthCode, u.ID, codeTTL).Err(); err != nil {
		log.Printf("[wpsoauth] callback: Set oauth_code failed: %v", err)
		h.redirectWithError(c, "服务内部错误")
		return
	}
	log.Printf("[wpsoauth] callback: success, userID=%d", u.ID)
	c.Redirect(http.StatusFound, h.cfg.FrontendRedirect+"/login?oauth_code="+url.QueryEscape(oauthCode))
}

// Exchange 前端用一次性 oauth_code 换取应用 JWT 与用户信息。
func (h *Handler) Exchange(c *gin.Context) {
	var req struct {
		Code string `json:"code"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || req.Code == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request"})
		return
	}
	ctx := c.Request.Context()
	raw, ok, err := h.consume(ctx, keyCodePrefix+req.Code)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not look up code"})
		return
	}
	if !ok {
		c.JSON(http.StatusBadRequest, gin.H{"error": "登录凭证无效或已过期"})
		return
	}
	userID, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not look up code"})
		return
	}

	// 从 users 表取回 email（占位地址），签发应用 token。
	dbUser, err := h.repo.GetByID(userID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not look up user"})
		return
	}
	token, err := auth.IssueToken(h.secret, dbUser.ID, dbUser.Email, tokenTTL)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not issue token"})
		return
	}
	c.JSON(http.StatusOK, authResponse{
		Token: token,
		User:  userResponse{ID: dbUser.ID, Email: dbUser.Email, Username: dbUser.Username, UserID: dbUser.UserID},
	})
}

func (h *Handler) redirectWithError(c *gin.Context, msg string) {
	c.Redirect(http.StatusFound, h.cfg.FrontendRedirect+"/login?error="+url.QueryEscape(msg))
}

// consume 原子地读取并删除一个一次性 key（兼容不支持 GETDEL 的旧版 Redis），
// 返回 (值, key 是否存在, 错误)。
func (h *Handler) consume(ctx context.Context, key string) (string, bool, error) {
	pipe := h.rdb.TxPipeline()
	get := pipe.Get(ctx, key)
	pipe.Del(ctx, key)
	_, err := pipe.Exec(ctx)
	if err == redis.Nil {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return get.Val(), true, nil
}

func randomToken(n int) (string, error) {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}

// saveWPSToken 把授权下发的凭证写入数据库（过期时间由 expiresIn 秒推算）。
func (h *Handler) saveWPSToken(userID int64, accessToken, refreshToken string, expiresIn int64) error {
	tok := WPSToken{AccessToken: accessToken, RefreshToken: refreshToken, Scope: h.cfg.Scope}
	if expiresIn > 0 {
		tok.ExpiresAt = time.Now().Add(time.Duration(expiresIn) * time.Second)
	}
	return h.repo.SaveWPSToken(userID, tok)
}

// ErrNoWPSToken 表示用户尚未完成可用的 WPS 授权（未登录或 token 已失效且无法刷新）。
var ErrNoWPSToken = errors.New("wps token unavailable")

// TokenForUser 返回用户当前可用的 WPS access_token；若过期则用 refresh_token 刷新并落库。
// 供云文档/邮箱等业务模块调用。无可用凭证时返回 ErrNoWPSToken。
func (h *Handler) TokenForUser(ctx context.Context, userID int64) (string, error) {
	tok, err := h.repo.GetWPSToken(userID)
	if err != nil {
		return "", ErrNoWPSToken
	}
	if !tok.HasToken() {
		return "", ErrNoWPSToken
	}
	if !tok.Expired() {
		return tok.AccessToken, nil
	}
	// access_token 过期：尝试用 refresh_token 刷新。
	if tok.RefreshToken == "" {
		return "", ErrNoWPSToken
	}
	at, rt, expiresIn, err := h.client.RefreshToken(ctx, tok.RefreshToken)
	if err != nil {
		return "", ErrNoWPSToken
	}
	if err := h.saveWPSToken(userID, at, rt, expiresIn); err != nil {
		log.Printf("[wpsoauth] refresh save failed: %v", err)
	}
	return at, nil
}
