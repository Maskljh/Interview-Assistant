package interview

import (
	"database/sql"
	"encoding/json"
)

type Repo struct {
	db *sql.DB
}

func NewRepo(db *sql.DB) *Repo {
	return &Repo{db: db}
}

func (r *Repo) Create(userID int64, jobJD string, resume *string, mode Mode) (*Session, error) {
	res, err := r.db.Exec(
		`INSERT INTO interview_sessions (user_id, job_jd, resume_text, mode, status)
		 VALUES (?, ?, ?, ?, ?)`,
		userID, jobJD, nullString(resume), string(mode), string(StatusDraft),
	)
	if err != nil {
		return nil, err
	}
	id, err := res.LastInsertId()
	if err != nil {
		return nil, err
	}
	return r.GetByID(id)
}

func (r *Repo) ListByUser(userID int64) ([]Session, error) {
	rows, err := r.db.Query(
		`SELECT id, user_id, job_jd, resume_text, mode, status, score, feedback_json,
		        started_at, ended_at, created_at
		 FROM interview_sessions
		 WHERE user_id = ?
		 ORDER BY created_at DESC`,
		userID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var sessions []Session
	for rows.Next() {
		s, err := scanSession(rows)
		if err != nil {
			return nil, err
		}
		sessions = append(sessions, *s)
	}
	return sessions, rows.Err()
}

func (r *Repo) GetByID(id int64) (*Session, error) {
	row := r.db.QueryRow(
		`SELECT id, user_id, job_jd, resume_text, mode, status, score, feedback_json,
		        started_at, ended_at, created_at
		 FROM interview_sessions
		 WHERE id = ?`,
		id,
	)
	return scanSession(row)
}

func (r *Repo) ListQuestions(sessionID int64) ([]Question, error) {
	rows, err := r.db.Query(
		`SELECT id, session_id, seq, question, intent, asked
		 FROM interview_questions
		 WHERE session_id = ?
		 ORDER BY seq`,
		sessionID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var questions []Question
	for rows.Next() {
		var q Question
		var intent sql.NullString
		var asked int
		if err := rows.Scan(&q.ID, &q.SessionID, &q.Seq, &q.Question, &intent, &asked); err != nil {
			return nil, err
		}
		if intent.Valid {
			s := intent.String
			q.Intent = &s
		}
		q.Asked = asked != 0
		questions = append(questions, q)
	}
	return questions, rows.Err()
}

func (r *Repo) ListTurns(sessionID int64) ([]Turn, error) {
	rows, err := r.db.Query(
		`SELECT id, session_id, seq, role, kind, content, created_at
		 FROM interview_turns
		 WHERE session_id = ?
		 ORDER BY seq`,
		sessionID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var turns []Turn
	for rows.Next() {
		var t Turn
		if err := rows.Scan(&t.ID, &t.SessionID, &t.Seq, &t.Role, &t.Kind, &t.Content, &t.CreatedAt); err != nil {
			return nil, err
		}
		turns = append(turns, t)
	}
	return turns, rows.Err()
}

type rowScanner interface {
	Scan(dest ...any) error
}

func scanSession(row rowScanner) (*Session, error) {
	var s Session
	var resume sql.NullString
	var score sql.NullInt64
	var feedback []byte
	var mode, status string

	err := row.Scan(
		&s.ID, &s.UserID, &s.JobJD, &resume, &mode, &status, &score, &feedback,
		&s.StartedAt, &s.EndedAt, &s.CreatedAt,
	)
	if err != nil {
		return nil, err
	}
	if resume.Valid {
		v := resume.String
		s.ResumeText = &v
	}
	if score.Valid {
		v := int(score.Int64)
		s.Score = &v
	}
	if len(feedback) > 0 {
		s.FeedbackJSON = json.RawMessage(feedback)
	}
	s.Mode = Mode(mode)
	s.Status = Status(status)
	return &s, nil
}

func nullString(s *string) sql.NullString {
	if s == nil {
		return sql.NullString{}
	}
	return sql.NullString{String: *s, Valid: true}
}
