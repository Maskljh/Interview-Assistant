package wpsoauth

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"
)

// Repo 按 wps_openid 关联 users 表。
type Repo struct {
	db *sql.DB
}

func NewRepo(db *sql.DB) *Repo {
	return &Repo{db: db}
}

// User 是登录回调落库后返回给前端的用户信息（复用现有 authResponse 结构）。
type User struct {
	ID       int64
	Email    string
	Username string
	UserID   string // WPS 账号全局数字 ID（个人中心可见）
}

// WPSToken 是用户在授权时下发的 WPS 开放平台访问凭证（持久化用于云文档/邮箱能力）。
type WPSToken struct {
	AccessToken  string
	RefreshToken string
	ExpiresAt    time.Time
	Scope        string
}

// HasToken 报告当前用户是否已有可用（未过期）的 WPS 授权凭证。
func (t WPSToken) HasToken() bool {
	return t.AccessToken != ""
}

// Expired 判断 access_token 是否已过期或即将过期（提前 5 分钟视为过期，留刷新余量）。
func (t WPSToken) Expired() bool {
	if t.AccessToken == "" {
		return true
	}
	if t.ExpiresAt.IsZero() {
		return false
	}
	return time.Now().Add(5 * time.Minute).After(t.ExpiresAt)
}

var ErrNoUser = errors.New("user not found")

const tokenColumns = "wps_access_token, wps_refresh_token, wps_token_expires_at, wps_token_scope"

// GetByWPSOpenID 按 WPS 开放平台 openid 查找用户。
func (r *Repo) GetByWPSOpenID(openid string) (*User, error) {
	var u User
	err := r.db.QueryRow(
		"SELECT id, email, username, COALESCE(user_id, '') FROM users WHERE wps_openid = ?",
		openid,
	).Scan(&u.ID, &u.Email, &u.Username, &u.UserID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNoUser
	}
	if err != nil {
		return nil, err
	}
	return &u, nil
}

// GetByID 按主键查找用户（exchange 阶段用）。
func (r *Repo) GetByID(id int64) (*User, error) {
	var u User
	err := r.db.QueryRow(
		"SELECT id, email, username, COALESCE(user_id, '') FROM users WHERE id = ?",
		id,
	).Scan(&u.ID, &u.Email, &u.Username, &u.UserID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNoUser
	}
	if err != nil {
		return nil, err
	}
	return &u, nil
}

// UpsertWPSUser 按 openid 插入或更新用户：首次登录创建，之后刷新昵称/头像。
// email 用占位地址（users.email NOT NULL UNIQUE），password_hash 填随机值使其无法用密码登录；
// username 写入 WPS 昵称，供侧边栏/用户弹窗展示。user_id 存 WPS 账号全局数字 ID。
func (r *Repo) UpsertWPSUser(openid, userID, nickname, avatarURL string) (*User, error) {
	email := "wps_" + sanitizeOpenID(openid) + "@wps.local"
	passwordHash, err := randomHash()
	if err != nil {
		return nil, err
	}
	_, err = r.db.Exec(`
		INSERT INTO users (email, password_hash, username, wps_openid, user_id, nickname, avatar_url)
		VALUES (?, ?, ?, ?, ?, ?, ?)
		ON DUPLICATE KEY UPDATE
		  username = VALUES(username),
		  user_id = VALUES(user_id),
		  nickname = VALUES(nickname),
		  avatar_url = VALUES(avatar_url)`,
		email, passwordHash, nickname, openid, userID, nickname, avatarURL,
	)
	if err != nil {
		return nil, err
	}
	u, err := r.GetByWPSOpenID(openid)
	if err != nil {
		return nil, err
	}
	return u, nil
}

// SaveWPSToken 持久化用户在授权时下发的 access_token / refresh_token。
func (r *Repo) SaveWPSToken(userID int64, tok WPSToken) error {
	var expiresAt any
	if !tok.ExpiresAt.IsZero() {
		expiresAt = tok.ExpiresAt
	}
	_, err := r.db.Exec(
		"UPDATE users SET wps_access_token = ?, wps_refresh_token = ?, wps_token_expires_at = ?, wps_token_scope = ? WHERE id = ?",
		tok.AccessToken, tok.RefreshToken, expiresAt, tok.Scope, userID,
	)
	return err
}

// GetWPSToken 读取用户的 WPS 授权凭证；无记录时返回 ErrNoToken。
func (r *Repo) GetWPSToken(userID int64) (WPSToken, error) {
	var tok WPSToken
	var at, rt, scope sql.NullString
	var exp sql.NullTime
	err := r.db.QueryRow(
		"SELECT "+tokenColumns+" FROM users WHERE id = ?",
		userID,
	).Scan(&at, &rt, &exp, &scope)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return WPSToken{}, ErrNoUser
		}
		return WPSToken{}, err
	}
	tok.AccessToken = at.String
	tok.RefreshToken = rt.String
	tok.Scope = scope.String
	if exp.Valid {
		tok.ExpiresAt = exp.Time
	}
	return tok, nil
}

// ClearWPSToken 清空用户 WPS 凭证（token 失效/重新授权时调用）。
func (r *Repo) ClearWPSToken(userID int64) error {
	_, err := r.db.Exec(
		"UPDATE users SET wps_access_token = NULL, wps_refresh_token = NULL, wps_token_expires_at = NULL, wps_token_scope = NULL WHERE id = ?",
		userID,
	)
	return err
}

func sanitizeOpenID(openid string) string {
	var b strings.Builder
	for _, c := range openid {
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9':
			b.WriteRune(c)
		default:
			b.WriteByte('-')
		}
	}
	return b.String()
}

// randomHash 生成一个无法用于密码登录的随机 bcrypt 哈希（WPS 用户没有密码）。
func randomHash() (string, error) {
	buf := make([]byte, 24)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("generate random password: %w", err)
	}
	return "$2a$10$" + hex.EncodeToString(buf), nil
}
