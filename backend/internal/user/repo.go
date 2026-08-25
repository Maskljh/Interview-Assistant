package user

import (
	"database/sql"
	"errors"
	"strings"
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

func (r *Repo) Create(email, passwordHash, username string) (int64, error) {
	res, err := r.db.Exec(
		"INSERT INTO users (email, password_hash, username) VALUES (?, ?, ?)",
		email, passwordHash, username,
	)
	if err != nil {
		if isDuplicateKey(err) {
			return 0, ErrEmailTaken
		}
		return 0, err
	}
	return res.LastInsertId()
}

func (r *Repo) GetByEmail(email string) (id int64, passwordHash, username string, err error) {
	err = r.db.QueryRow(
		"SELECT id, password_hash, username FROM users WHERE email = ?",
		email,
	).Scan(&id, &passwordHash, &username)
	return
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

func isDuplicateKey(err error) bool {
	return err != nil && strings.Contains(err.Error(), "Duplicate entry")
}
