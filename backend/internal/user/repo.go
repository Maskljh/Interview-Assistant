package user

import (
	"database/sql"
	"errors"
)

var ErrEmailTaken = errors.New("email already registered")

type User struct {
	ID        int64
	Email     string
	Username  string
	Nickname  string
	AvatarURL string
	UserID    string // WPS 账号全局数字 ID
}

type Repo struct {
	db *sql.DB
}

func NewRepo(db *sql.DB) *Repo {
	return &Repo{db: db}
}

func (r *Repo) GetByID(id int64) (*User, error) {
	u := &User{ID: id}
	err := r.db.QueryRow(
		"SELECT email, username, COALESCE(nickname, ''), COALESCE(avatar_url, ''), COALESCE(user_id, '') FROM users WHERE id = ?",
		id,
	).Scan(&u.Email, &u.Username, &u.Nickname, &u.AvatarURL, &u.UserID)
	if err != nil {
		return nil, err
	}
	return u, nil
}
