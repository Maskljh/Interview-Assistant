package wpsoauth

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
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
}

var ErrNoUser = errors.New("user not found")

// GetByWPSOpenID 按 WPS 开放平台 openid 查找用户。
func (r *Repo) GetByWPSOpenID(openid string) (*User, error) {
	var u User
	err := r.db.QueryRow(
		"SELECT id, email, username FROM users WHERE wps_openid = ?",
		openid,
	).Scan(&u.ID, &u.Email, &u.Username)
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
		"SELECT id, email, username FROM users WHERE id = ?",
		id,
	).Scan(&u.ID, &u.Email, &u.Username)
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
// username 写入 WPS 昵称，供侧边栏/用户弹窗展示。
func (r *Repo) UpsertWPSUser(openid, nickname, avatarURL string) (*User, error) {
	email := "wps_" + sanitizeOpenID(openid) + "@wps.local"
	passwordHash, err := randomHash()
	if err != nil {
		return nil, err
	}
	_, err = r.db.Exec(`
		INSERT INTO users (email, password_hash, username, wps_openid, nickname, avatar_url)
		VALUES (?, ?, ?, ?, ?, ?)
		ON DUPLICATE KEY UPDATE
		  username = VALUES(username),
		  nickname = VALUES(nickname),
		  avatar_url = VALUES(avatar_url)`,
		email, passwordHash, nickname, openid, nickname, avatarURL,
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
