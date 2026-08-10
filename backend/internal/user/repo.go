package user

import (
	"database/sql"
	"errors"
	"strings"
)

var ErrEmailTaken = errors.New("email already registered")

type User struct {
	ID    int64
	Email string
}

type Repo struct {
	db *sql.DB
}

func NewRepo(db *sql.DB) *Repo {
	return &Repo{db: db}
}

func (r *Repo) Create(email, passwordHash string) (int64, error) {
	res, err := r.db.Exec(
		"INSERT INTO users (email, password_hash) VALUES (?, ?)",
		email, passwordHash,
	)
	if err != nil {
		if isDuplicateKey(err) {
			return 0, ErrEmailTaken
		}
		return 0, err
	}
	return res.LastInsertId()
}

func (r *Repo) GetByEmail(email string) (id int64, passwordHash string, err error) {
	err = r.db.QueryRow(
		"SELECT id, password_hash FROM users WHERE email = ?",
		email,
	).Scan(&id, &passwordHash)
	return
}

func isDuplicateKey(err error) bool {
	return err != nil && strings.Contains(err.Error(), "Duplicate entry")
}
