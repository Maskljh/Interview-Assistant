package question

import "time"

type Item struct {
	ID              int64     `json:"id"`
	UserID          int64     `json:"-"`
	Question        string    `json:"question"`
	Answer          *string   `json:"answer"`
	Source          string    `json:"source"`
	SourceSessionID *int64    `json:"source_session_id"`
	JobTag          *string   `json:"job_tag"`
	Starred         bool      `json:"starred"`
	CreatedAt       time.Time `json:"created_at"`
}

type ListFilter struct {
	Starred *bool
	JobTag  string
	Query   string
}
