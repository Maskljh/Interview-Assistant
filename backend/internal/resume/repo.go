package resume

import (
	"database/sql"
	"errors"
	"time"
)

const MaxResumesPerUser = 5

var ErrNotFound = errors.New("resume not found")

type ResumeFile struct {
	ID         int64
	UserID     int64
	Name       string
	FileURL    string
	SizeBytes  int64
	ResumeText string
	CreatedAt  time.Time
	UpdatedAt  time.Time
}

type Repo struct {
	db *sql.DB
}

func NewRepo(db *sql.DB) *Repo {
	return &Repo{db: db}
}

func (r *Repo) List(userID int64) ([]ResumeFile, error) {
	rows, err := r.db.Query(
		`SELECT id, user_id, name, file_url, size_bytes, resume_text, created_at, updated_at
		 FROM resume_files
		 WHERE user_id = ?
		 ORDER BY updated_at DESC`,
		userID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []ResumeFile
	for rows.Next() {
		var f ResumeFile
		var text sql.NullString
		if err := rows.Scan(&f.ID, &f.UserID, &f.Name, &f.FileURL, &f.SizeBytes, &text, &f.CreatedAt, &f.UpdatedAt); err != nil {
			return nil, err
		}
		if text.Valid {
			f.ResumeText = text.String
		}
		out = append(out, f)
	}
	if out == nil {
		out = []ResumeFile{}
	}
	return out, rows.Err()
}

func (r *Repo) Count(userID int64) (int, error) {
	var n int
	err := r.db.QueryRow(
		"SELECT COUNT(*) FROM resume_files WHERE user_id = ?",
		userID,
	).Scan(&n)
	return n, err
}

func (r *Repo) Create(userID int64, name, fileURL string, sizeBytes int64, resumeText string) (int64, error) {
	res, err := r.db.Exec(
		`INSERT INTO resume_files (user_id, name, file_url, size_bytes, resume_text)
		 VALUES (?, ?, ?, ?, ?)`,
		userID, name, fileURL, sizeBytes, resumeText,
	)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

func (r *Repo) GetOwned(userID, id int64) (*ResumeFile, error) {
	var f ResumeFile
	var text sql.NullString
	err := r.db.QueryRow(
		`SELECT id, user_id, name, file_url, size_bytes, resume_text, created_at, updated_at
		 FROM resume_files
		 WHERE id = ? AND user_id = ?`,
		id, userID,
	).Scan(&f.ID, &f.UserID, &f.Name, &f.FileURL, &f.SizeBytes, &text, &f.CreatedAt, &f.UpdatedAt)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if text.Valid {
		f.ResumeText = text.String
	}
	return &f, nil
}

func (r *Repo) Rename(userID, id int64, name string) error {
	res, err := r.db.Exec(
		"UPDATE resume_files SET name = ? WHERE id = ? AND user_id = ?",
		name, id, userID,
	)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

func (r *Repo) Delete(userID, id int64) error {
	res, err := r.db.Exec(
		"DELETE FROM resume_files WHERE id = ? AND user_id = ?",
		id, userID,
	)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	return nil
}
