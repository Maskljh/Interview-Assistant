package user

import (
	"database/sql"
	"errors"
	"net/http"
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
	ID    int64  `json:"id"`
	Email string `json:"email"`
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
	id, err := h.repo.Create(req.Email, hash)
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
	id, hash, err := h.repo.GetByEmail(req.Email)
	if errors.Is(err, sql.ErrNoRows) || !auth.CheckPassword(hash, req.Password) {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid credentials"})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not look up user"})
		return
	}
	h.respondWithToken(c, id, req.Email)
}

func (h *Handler) respondWithToken(c *gin.Context, id int64, email string) {
	token, err := auth.IssueToken(h.secret, id, email, tokenTTL)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not issue token"})
		return
	}
	c.JSON(http.StatusOK, authResponse{
		Token: token,
		User:  userResponse{ID: id, Email: email},
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
