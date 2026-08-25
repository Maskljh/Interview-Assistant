package question

import (
	"database/sql"
	"errors"
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
		`SELECT question FROM interview_questions WHERE session_id = ? AND asked = 1 ORDER BY seq`,
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

// ListSessionUserAnswers returns questions and user answers in the ORDER
// they were actually asked during the interview (turns order), not the
// pre-generated question order.
func (r *Repo) ListSessionUserAnswers(sessionID int64) ([]UserAnswer, error) {
	// Get all turns in order
	tRows, err := r.db.Query(
		`SELECT seq, role, content FROM interview_turns
		 WHERE session_id = ? AND role IN ('interviewer', 'candidate')
		 ORDER BY seq`,
		sessionID,
	)
	if err != nil {
		return nil, err
	}
	defer tRows.Close()

	type turn struct {
		Seq     int
		Role    string
		Content string
	}
	var turns []turn
	for tRows.Next() {
		var t turn
		if err := tRows.Scan(&t.Seq, &t.Role, &t.Content); err != nil {
			return nil, err
		}
		turns = append(turns, t)
	}
	if err := tRows.Err(); err != nil {
		return nil, err
	}

	// Walk turns in order: pair each interviewer turn with the next candidate turn.
	// If the interviewer asks twice in a row (no answer in between), the first
	// question was unanswered — skip it so it is not paired with the follow-up's answer.
	var result []UserAnswer
	for i, t := range turns {
		if t.Role != "interviewer" {
			continue
		}
		if i+1 < len(turns) && turns[i+1].Role == "interviewer" {
			continue // 面试官连续问：当前题未回答，跳过
		}
		// Find next candidate turn
		for j := i + 1; j < len(turns); j++ {
			if turns[j].Role == "candidate" {
				result = append(result, UserAnswer{
					Question: t.Content,
					Answer:   turns[j].Content,
				})
				break
			}
		}
	}
	return result, nil
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
			// 已存在：若 user_answer 为空则补全（覆盖面试中途导入后补答、重新导入的场景）
			if q.UserAnswer != "" {
				if _, err := tx.Exec(
					`UPDATE question_bank SET user_answer = ?
					 WHERE user_id = ? AND question = ? AND (user_answer IS NULL OR user_answer = '')`,
					q.UserAnswer, userID, q.Question,
				); err != nil {
					return 0, err
				}
			}
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

// truncateRunes returns s truncated to at most n runes (rune-aware, so a
// multi-byte UTF-8 character is never split in half).
func truncateRunes(s string, n int) string {
	if n <= 0 {
		return ""
	}
	runes := []rune(s)
	if len(runes) <= n {
		return s
	}
	return string(runes[:n])
}

// InsertImportedBatch inserts user-confirmed imported questions with
// source='import', source_session_id NULL, and an optional reference. It
// reuses the exact-question-text dedupe rule and returns imported/skipped.
func (r *Repo) InsertImportedBatch(userID int64, questions []ParsedQuestion, jobTag string) (ImportResult, error) {
	if len(questions) == 0 {
		return ImportResult{}, nil
	}
	// job_tag 是 VARCHAR(64)：超长标签会让整批 INSERT 失败，必须在写库前
	// 按 rune 截断到 64，避免单个标签拖垮整批导入。
	jobTag = truncateRunes(jobTag, 64)
	tx, err := r.db.Begin()
	if err != nil {
		return ImportResult{}, err
	}
	defer tx.Rollback()

	var res ImportResult
	for _, q := range questions {
		if strings.TrimSpace(q.Question) == "" {
			continue
		}
		var exists int
		if err := tx.QueryRow(
			`SELECT COUNT(*) FROM question_bank WHERE user_id = ? AND question = ?`,
			userID, q.Question,
		).Scan(&exists); err != nil {
			return ImportResult{}, err
		}
		if exists > 0 {
			res.Skipped++
			continue
		}
		_, err := tx.Exec(
			`INSERT INTO question_bank (user_id, question, answer, user_answer, source, source_session_id, job_tag, reference, starred)
			 VALUES (?, ?, ?, NULL, 'import', NULL, ?, ?, 0)`,
			userID, q.Question, nullStr(q.Answer), nullStr(jobTag), nullStr(q.Reference),
		)
		if err != nil {
			return ImportResult{}, err
		}
		res.Imported++
	}
	if err := tx.Commit(); err != nil {
		return ImportResult{}, err
	}
	return res, nil
}

func (r *Repo) List(userID int64, f ListFilter) ([]Item, error) {
	var clauses []string
	var args []any
	clauses = append(clauses, "qb.user_id = ?")
	args = append(args, userID)

	if f.Starred != nil {
		clauses = append(clauses, "qb.starred = ?")
		if *f.Starred {
			args = append(args, 1)
		} else {
			args = append(args, 0)
		}
	}
	if f.JobTag != "" {
		clauses = append(clauses, "qb.job_tag = ?")
		args = append(args, f.JobTag)
	}
	if f.Query != "" {
		clauses = append(clauses, "qb.question LIKE ?")
		args = append(args, "%"+f.Query+"%")
	}
	if f.Dimension != "" {
		clauses = append(clauses, "qb.dimension = ?")
		args = append(args, f.Dimension)
	}

	query := fmt.Sprintf(
		`SELECT qb.id, qb.user_id, MAX(qb.question), MAX(qb.answer), MAX(qb.user_answer), MAX(qb.source), MAX(qb.source_session_id), MAX(qb.job_tag), MAX(qb.dimension), MAX(qb.reference), MAX(qb.starred), MAX(qb.created_at),
		        COUNT(qu.id) AS usage_count
		 FROM question_bank qb
		 LEFT JOIN question_usage qu ON qu.question_id = qb.id AND qu.user_id = qb.user_id
		 WHERE %s
		 GROUP BY qb.id
		 ORDER BY qb.created_at DESC`,
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
		`SELECT qb.id, qb.user_id, MAX(qb.question), MAX(qb.answer), MAX(qb.user_answer), MAX(qb.source), MAX(qb.source_session_id), MAX(qb.job_tag), MAX(qb.dimension), MAX(qb.reference), MAX(qb.starred), MAX(qb.created_at),
		        COUNT(qu.id) AS usage_count
		 FROM question_bank qb
		 LEFT JOIN question_usage qu ON qu.question_id = qb.id AND qu.user_id = qb.user_id
		 WHERE qb.id = ?
		 GROUP BY qb.id`,
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
		`SELECT qb.id, qb.user_id, MAX(qb.question), MAX(qb.answer), MAX(qb.user_answer), MAX(qb.source), MAX(qb.source_session_id), MAX(qb.job_tag), MAX(qb.dimension), MAX(qb.reference), MAX(qb.starred), MAX(qb.created_at),
		        COUNT(qu.id) AS usage_count
		 FROM question_bank qb
		 LEFT JOIN question_usage qu ON qu.question_id = qb.id AND qu.user_id = qb.user_id
		 WHERE qb.user_id = ? AND qb.dimension = ?
		 GROUP BY qb.id
		 ORDER BY qb.starred DESC, qb.created_at DESC
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

// UpdateField sets a non-nullable text column (whitelisted) on a bank question.
func (r *Repo) UpdateField(id int64, column, value string) error {
	if !allowedQuestionColumn(column) {
		return errors.New("invalid column")
	}
	_, err := r.db.Exec(`UPDATE question_bank SET `+column+` = ? WHERE id = ?`, value, id)
	return err
}

// UpdateNullableField sets a nullable text column; empty value clears it to NULL.
func (r *Repo) UpdateNullableField(id int64, column, value string) error {
	if !allowedQuestionColumn(column) {
		return errors.New("invalid column")
	}
	if value == "" {
		_, err := r.db.Exec(`UPDATE question_bank SET `+column+` = NULL WHERE id = ?`, id)
		return err
	}
	_, err := r.db.Exec(`UPDATE question_bank SET `+column+` = ? WHERE id = ?`, value, id)
	return err
}

func allowedQuestionColumn(column string) bool {
	switch column {
	case "question", "answer", "job_tag", "dimension":
		return true
	}
	return false
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
	var reference sql.NullString
	var starred int
	if err := row.Scan(
		&item.ID, &item.UserID, &item.Question, &answer, &userAnswer,
		&item.Source, &sourceSessionID, &jobTag, &dimension, &reference, &starred, &item.CreatedAt,
		&item.UsageCount,
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
	if reference.Valid {
		item.Reference = &reference.String
	}
	item.Starred = starred != 0
	return &item, nil
}
