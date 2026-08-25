package user

import (
	"database/sql"
	"errors"
	"fmt"
	"math/rand"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/interview-assistant/backend/internal/auth"
)

const tokenTTL = 24 * time.Hour

type Handler struct {
	repo   *Repo
	secret string
}

type authRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

type userResponse struct {
	ID       int64  `json:"id"`
	Email    string `json:"email"`
	Username string `json:"username"`
}

type authResponse struct {
	Token string       `json:"token"`
	User  userResponse `json:"user"`
}

func NewHandler(db *sql.DB, secret string) *Handler {
	return &Handler{repo: NewRepo(db), secret: secret}
}

func RegisterRoutes(r *gin.Engine, db *sql.DB, secret string) {
	h := NewHandler(db, secret)
	authGroup := r.Group("/api/auth")
	authGroup.POST("/register", h.Register)
	authGroup.POST("/login", h.Login)
	me := authGroup.Group("/me")
	me.Use(auth.Middleware(secret))
	me.GET("", h.Me)
}

// randomUsername 生成一个随机的本地用户名；接入 WPS 登录后可替换为真实昵称。
func randomUsername(seed string) string {
	return fmt.Sprintf("用户%04d", rand.Intn(10000))
}

func (h *Handler) Register(c *gin.Context) {
	var req authRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request"})
		return
	}
	if err := validateCredentials(req.Email, req.Password); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	hash, err := auth.HashPassword(req.Password)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not hash password"})
		return
	}
	id, err := h.repo.Create(req.Email, hash, randomUsername(req.Email))
	if errors.Is(err, ErrEmailTaken) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "email already registered"})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not create user"})
		return
	}
	h.respondWithToken(c, id, req.Email)
}

func (h *Handler) Login(c *gin.Context) {
	var req authRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request"})
		return
	}
	if err := validateCredentials(req.Email, req.Password); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	id, hash, _, err := h.repo.GetByEmail(req.Email)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid credentials"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not look up user"})
		return
	}
	if !auth.CheckPassword(hash, req.Password) {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid credentials"})
		return
	}
	h.respondWithToken(c, id, req.Email)
}

// Me 返回当前登录用户的资料（用户名等）。需要鉴权。
func (h *Handler) Me(c *gin.Context) {
	raw, ok := c.Get("userID")
	if !ok {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
		return
	}
	id, ok := raw.(int64)
	if !ok {
		id, _ = strconv.ParseInt(fmt.Sprint(raw), 10, 64)
	}
	u, err := h.repo.GetByID(id)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "user not found"})
		return
	}
	c.JSON(http.StatusOK, userResponse{ID: u.ID, Email: u.Email, Username: u.Username})
}

func (h *Handler) respondWithToken(c *gin.Context, id int64, email string) {
	token, err := auth.IssueToken(h.secret, id, email, tokenTTL)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not issue token"})
		return
	}
	username := ""
	// 注册/登录后尽量回填用户名；查不到时保持空（前端会降级显示邮箱）。
	if u, uerr := h.repo.GetByID(id); uerr == nil {
		username = u.Username
	}
	c.JSON(http.StatusOK, authResponse{
		Token: token,
		User:  userResponse{ID: id, Email: email, Username: username},
	})
}

func validateCredentials(email, password string) error {
	email = strings.TrimSpace(email)
	if email == "" || !strings.Contains(email, "@") {
		return errors.New("invalid email")
	}
	if len(password) < 8 {
		return errors.New("password must be at least 8 characters")
	}
	return nil
}
