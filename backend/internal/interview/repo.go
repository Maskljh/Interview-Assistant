package interview

import (
	"database/sql"
	"encoding/json"
	"time"
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

func (r *Repo) StartSession(sessionID int64, questions []struct {
	Seq      int
	Question string
	Intent   string
}) ([]Question, error) {
	tx, err := r.db.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	if _, err := tx.Exec(`DELETE FROM interview_questions WHERE session_id = ?`, sessionID); err != nil {
		return nil, err
	}
	for _, q := range questions {
		var intentPtr *string
		if q.Intent != "" {
			intentPtr = &q.Intent
		}
		if _, err := tx.Exec(
			`INSERT INTO interview_questions (session_id, seq, question, intent, asked) VALUES (?, ?, ?, ?, 0)`,
			sessionID, q.Seq, q.Question, nullString(intentPtr),
		); err != nil {
			return nil, err
		}
	}
	if _, err := tx.Exec(`UPDATE interview_sessions SET status = ? WHERE id = ?`, string(StatusReady), sessionID); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return r.ListQuestions(sessionID)
}

func (r *Repo) BeginSession(sessionID int64) (bool, error) {
	res, err := r.db.Exec(
		`UPDATE interview_sessions SET status = ?, started_at = COALESCE(started_at, NOW()) WHERE id = ? AND status = ?`,
		string(StatusInProgress), sessionID, string(StatusReady),
	)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, err
	}
	return n > 0, nil
}

func (r *Repo) AppendTurn(sessionID int64, role, kind, content string) (int, error) {
	var maxSeq sql.NullInt64
	if err := r.db.QueryRow(`SELECT MAX(seq) FROM interview_turns WHERE session_id = ?`, sessionID).Scan(&maxSeq); err != nil {
		return 0, err
	}
	seq := 1
	if maxSeq.Valid {
		seq = int(maxSeq.Int64) + 1
	}
	_, err := r.db.Exec(
		`INSERT INTO interview_turns (session_id, seq, role, kind, content) VALUES (?, ?, ?, ?, ?)`,
		sessionID, seq, role, kind, content,
	)
	return seq, err
}

func (r *Repo) MarkQuestionAsked(sessionID int64, questionSeq int) error {
	_, err := r.db.Exec(`UPDATE interview_questions SET asked = 1 WHERE session_id = ? AND seq = ?`, sessionID, questionSeq)
	return err
}

func (r *Repo) GetQuestionByIndex(sessionID int64, index int) (*Question, error) {
	row := r.db.QueryRow(
		`SELECT id, session_id, seq, question, intent, asked
		 FROM interview_questions
		 WHERE session_id = ?
		 ORDER BY seq
		 LIMIT 1 OFFSET ?`,
		sessionID, index,
	)
	var q Question
	var intent sql.NullString
	var asked int
	if err := row.Scan(&q.ID, &q.SessionID, &q.Seq, &q.Question, &intent, &asked); err != nil {
		return nil, err
	}
	if intent.Valid {
		s := intent.String
		q.Intent = &s
	}
	q.Asked = asked != 0
	return &q, nil
}

func (r *Repo) CompleteSession(sessionID int64) error {
	_, err := r.db.Exec(
		`UPDATE interview_sessions SET status = ?, ended_at = ? WHERE id = ?`,
		string(StatusCompleted), time.Now(), sessionID,
	)
	return err
}

func (r *Repo) SaveEvaluationSuccess(sessionID int64, score int, feedbackJSON []byte) error {
	_, err := r.db.Exec(
		`UPDATE interview_sessions SET score = ?, feedback_json = ?, raw_feedback = NULL WHERE id = ?`,
		score, feedbackJSON, sessionID,
	)
	return err
}

func (r *Repo) SaveEvaluationFailure(sessionID int64, rawFeedback string) error {
	_, err := r.db.Exec(
		`UPDATE interview_sessions SET raw_feedback = ? WHERE id = ?`,
		rawFeedback, sessionID,
	)
	return err
}
