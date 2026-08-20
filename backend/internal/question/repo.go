package question

import (
	"database/sql"
	"fmt"
	"strings"
)

type Repo struct {
	db *sql.DB
}

func NewRepo(db *sql.DB) *Repo {
	return &Repo{db: db}
}

type sessionRow struct {
	ID     int64
	UserID int64
	JobJD  string
}

func (r *Repo) GetSession(sessionID int64) (*sessionRow, error) {
	row := r.db.QueryRow(
		`SELECT id, user_id, job_jd FROM interview_sessions WHERE id = ?`,
		sessionID,
	)
	var s sessionRow
	if err := row.Scan(&s.ID, &s.UserID, &s.JobJD); err != nil {
		return nil, err
	}
	return &s, nil
}

func (r *Repo) ListSessionQuestions(sessionID int64) ([]string, error) {
	rows, err := r.db.Query(
		`SELECT question FROM interview_questions WHERE session_id = ? ORDER BY seq`,
		sessionID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var questions []string
	for rows.Next() {
		var q string
		if err := rows.Scan(&q); err != nil {
			return nil, err
		}
		questions = append(questions, q)
	}
	return questions, rows.Err()
}

// ListSessionFollowUps returns the interviewer's follow-up questions asked
// during a session, in order. Follow-ups live in interview_turns (kind =
// 'follow_up'), not in interview_questions, so they must be read separately.
func (r *Repo) ListSessionFollowUps(sessionID int64) ([]string, error) {
	rows, err := r.db.Query(
		`SELECT content FROM interview_turns
		 WHERE session_id = ? AND role = 'interviewer' AND kind = 'follow_up'
		 ORDER BY seq`,
		sessionID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var followUps []string
	for rows.Next() {
		var f string
		if err := rows.Scan(&f); err != nil {
			return nil, err
		}
		followUps = append(followUps, f)
	}
	return followUps, rows.Err()
}

type UserAnswer struct {
	Question string
	Answer   string
}

// ListSessionUserAnswers pairs each interviewer question with the candidate's
// answer from interview_turns, preserving order.
func (r *Repo) ListSessionUserAnswers(sessionID int64) ([]UserAnswer, error) {
	rows, err := r.db.Query(
		`SELECT role, content FROM interview_turns
		 WHERE session_id = ? AND role IN ('interviewer', 'candidate')
		 ORDER BY seq`,
		sessionID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var result []UserAnswer
	var lastQ string
	for rows.Next() {
		var role, content string
		if err := rows.Scan(&role, &content); err != nil {
			return nil, err
		}
		if role == "interviewer" {
			lastQ = content
		} else if role == "candidate" && lastQ != "" {
			result = append(result, UserAnswer{Question: lastQ, Answer: content})
			lastQ = ""
		}
	}
	return result, rows.Err()
}

type InsertQuestion struct {
	Question   string
	UserAnswer string
}

// InsertBatch inserts questions into the bank, skipping any the user already
// has (matched by exact question text). Returns the number actually inserted.
func (r *Repo) InsertBatch(userID int64, questions []InsertQuestion, sessionID int64, jobTag string) (int, error) {
	if len(questions) == 0 {
		return 0, nil
	}
	tx, err := r.db.Begin()
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()

	imported := 0
	for _, q := range questions {
		var exists int
		if err := tx.QueryRow(
			`SELECT COUNT(*) FROM question_bank WHERE user_id = ? AND question = ?`,
			userID, q.Question,
		).Scan(&exists); err != nil {
			return 0, err
		}
		if exists > 0 {
			continue
		}
		_, err := tx.Exec(
			`INSERT INTO question_bank (user_id, question, answer, user_answer, source, source_session_id, job_tag, starred)
			 VALUES (?, ?, NULL, ?, 'interview', ?, ?, 0)`,
			userID, q.Question, nullStr(q.UserAnswer), sessionID, jobTag,
		)
		if err != nil {
			return 0, err
		}
		imported++
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return imported, nil
}

func nullStr(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func (r *Repo) List(userID int64, f ListFilter) ([]Item, error) {
	var clauses []string
	var args []any
	clauses = append(clauses, "user_id = ?")
	args = append(args, userID)

	if f.Starred != nil {
		clauses = append(clauses, "starred = ?")
		if *f.Starred {
			args = append(args, 1)
		} else {
			args = append(args, 0)
		}
	}
	if f.JobTag != "" {
		clauses = append(clauses, "job_tag = ?")
		args = append(args, f.JobTag)
	}
	if f.Query != "" {
		clauses = append(clauses, "question LIKE ?")
		args = append(args, "%"+f.Query+"%")
	}
	if f.Dimension != "" {
		clauses = append(clauses, "dimension = ?")
		args = append(args, f.Dimension)
	}

	query := fmt.Sprintf(
		`SELECT id, user_id, question, answer, user_answer, source, source_session_id, job_tag, dimension, starred, created_at
		 FROM question_bank
		 WHERE %s
		 ORDER BY created_at DESC`,
		strings.Join(clauses, " AND "),
	)
	rows, err := r.db.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var items []Item
	for rows.Next() {
		item, err := scanItem(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, *item)
	}
	return items, rows.Err()
}

func (r *Repo) GetByID(id int64) (*Item, error) {
	row := r.db.QueryRow(
		`SELECT id, user_id, question, answer, user_answer, source, source_session_id, job_tag, dimension, starred, created_at
		 FROM question_bank WHERE id = ?`,
		id,
	)
	return scanItem(row)
}

// UpdateDimension sets a bank question's dimension tag (empty clears it).
func (r *Repo) UpdateDimension(id int64, dimension string) error {
	if dimension == "" {
		_, err := r.db.Exec(`UPDATE question_bank SET dimension = NULL WHERE id = ?`, id)
		return err
	}
	_, err := r.db.Exec(`UPDATE question_bank SET dimension = ? WHERE id = ?`, dimension, id)
	return err
}

// UpdateDimensionByText sets dimension for the user's bank question whose text
// matches exactly (used to apply LLM classification by echoed text).
func (r *Repo) UpdateDimensionByText(userID int64, questionText, dimension string) error {
	_, err := r.db.Exec(`UPDATE question_bank SET dimension = ? WHERE user_id = ? AND question = ?`, dimension, userID, questionText)
	return err
}

// ListByDimensionForFocused returns starred-first, newest-first questions for
// one dimension, capped at limit, belonging to the user.
func (r *Repo) ListByDimensionForFocused(userID int64, dimension string, limit int) ([]Item, error) {
	rows, err := r.db.Query(
		`SELECT id, user_id, question, answer, user_answer, source, source_session_id, job_tag, dimension, starred, created_at
		 FROM question_bank
		 WHERE user_id = ? AND dimension = ?
		 ORDER BY starred DESC, created_at DESC
		 LIMIT ?`,
		userID, dimension, limit,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var items []Item
	for rows.Next() {
		item, err := scanItem(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, *item)
	}
	return items, rows.Err()
}

func (r *Repo) UpdateStarred(id int64, starred bool) error {
	val := 0
	if starred {
		val = 1
	}
	_, err := r.db.Exec(`UPDATE question_bank SET starred = ? WHERE id = ?`, val, id)
	return err
}

func (r *Repo) Delete(id int64) error {
	_, err := r.db.Exec(`DELETE FROM question_bank WHERE id = ?`, id)
	return err
}

type scanner interface {
	Scan(dest ...any) error
}

func scanItem(row scanner) (*Item, error) {
	var item Item
	var answer sql.NullString
	var userAnswer sql.NullString
	var sourceSessionID sql.NullInt64
	var jobTag sql.NullString
	var dimension sql.NullString
	var starred int
	if err := row.Scan(
		&item.ID, &item.UserID, &item.Question, &answer, &userAnswer,
		&item.Source, &sourceSessionID, &jobTag, &dimension, &starred, &item.CreatedAt,
	); err != nil {
		return nil, err
	}
	if answer.Valid {
		item.Answer = &answer.String
	}
	if userAnswer.Valid {
		item.UserAnswer = &userAnswer.String
	}
	if sourceSessionID.Valid {
		v := sourceSessionID.Int64
		item.SourceSessionID = &v
	}
	if jobTag.Valid {
		item.JobTag = &jobTag.String
	}
	if dimension.Valid {
		item.Dimension = &dimension.String
	}
	item.Starred = starred != 0
	return &item, nil
}
