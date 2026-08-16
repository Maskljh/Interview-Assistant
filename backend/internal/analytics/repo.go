package analytics

import (
	"context"
	"database/sql"
	"time"
)

type CompletedRow struct {
	ID           int64
	JobJD        string
	Mode         string
	Score        int
	FeedbackJSON []byte
	CreatedAt    time.Time
}

type Repo struct {
	db *sql.DB
}

func NewRepo(db *sql.DB) *Repo {
	return &Repo{db: db}
}

func (r *Repo) ListCompletedScored(ctx context.Context, userID int64) ([]CompletedRow, error) {
	rows, err := r.db.QueryContext(ctx,
		`SELECT id, job_jd, mode, score, feedback_json, created_at
		 FROM interview_sessions
		 WHERE user_id = ? AND status = 'completed' AND score IS NOT NULL
		 ORDER BY created_at ASC`,
		userID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []CompletedRow
	for rows.Next() {
		var row CompletedRow
		var ns sql.NullString
		if err := rows.Scan(&row.ID, &row.JobJD, &row.Mode, &row.Score, &ns, &row.CreatedAt); err != nil {
			return nil, err
		}
		row.FeedbackJSON = []byte(ns.String)
		out = append(out, row)
	}
	return out, rows.Err()
}
