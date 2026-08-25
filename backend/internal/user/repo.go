package user

import (
	"database/sql"
	"errors"
)

var ErrEmailTaken = errors.New("email already registered")

type User struct {
	ID       int64
	Email    string
	Username string
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
		"SELECT email, username FROM users WHERE id = ?",
		id,
	).Scan(&u.Email, &u.Username)
	if err != nil {
		return nil, err
	}
	return u, nil
}
