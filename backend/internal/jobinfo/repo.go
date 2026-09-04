package jobinfo

import (
	"database/sql"
	"errors"
	"time"
)

// ErrNotFound 表示记录不存在或不属于当前用户。
var ErrNotFound = errors.New("job info not found")

// JobInfo 岗位信息（JD 收藏库）记录。
type JobInfo struct {
	ID        int64
	UserID    int64
	Name      string
	Content   string
	CreatedAt time.Time
	UpdatedAt time.Time
}

// Repo 负责 job_info 表的存取。
type Repo struct {
	db *sql.DB
}

// NewRepo 创建岗位信息仓库。
func NewRepo(db *sql.DB) *Repo {
	return &Repo{db: db}
}

// List 返回当前用户的岗位信息（按更新时间倒序）。
func (r *Repo) List(userID int64) ([]JobInfo, error) {
	rows, err := r.db.Query(
		`SELECT id, user_id, name, content, created_at, updated_at
		 FROM job_info
		 WHERE user_id = ?
		 ORDER BY updated_at DESC, id DESC`,
		userID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []JobInfo
	for rows.Next() {
		var f JobInfo
		if err := rows.Scan(&f.ID, &f.UserID, &f.Name, &f.Content, &f.CreatedAt, &f.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	if out == nil {
		out = []JobInfo{}
	}
	return out, rows.Err()
}

// Create 新建一条岗位信息。
func (r *Repo) Create(userID int64, name, content string) (int64, error) {
	res, err := r.db.Exec(
		`INSERT INTO job_info (user_id, name, content)
		 VALUES (?, ?, ?)`,
		userID, name, content,
	)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

// GetOwned 返回属于当前用户的单条岗位信息。
func (r *Repo) GetOwned(userID, id int64) (*JobInfo, error) {
	var f JobInfo
	err := r.db.QueryRow(
		`SELECT id, user_id, name, content, created_at, updated_at
		 FROM job_info
		 WHERE id = ? AND user_id = ?`,
		id, userID,
	).Scan(&f.ID, &f.UserID, &f.Name, &f.Content, &f.CreatedAt, &f.UpdatedAt)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return &f, nil
}

// Update 更新岗位名称与内容。
func (r *Repo) Update(userID, id int64, name, content string) error {
	res, err := r.db.Exec(
		`UPDATE job_info SET name = ?, content = ? WHERE id = ? AND user_id = ?`,
		name, content, id, userID,
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

// Delete 删除一条岗位信息（仅限本人）。
func (r *Repo) Delete(userID, id int64) error {
	res, err := r.db.Exec(
		"DELETE FROM job_info WHERE id = ? AND user_id = ?",
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
