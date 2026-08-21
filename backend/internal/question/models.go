package question

import "time"

type Item struct {
	ID              int64     `json:"id"`
	UserID          int64     `json:"-"`
	Question        string    `json:"question"`
	Answer          *string   `json:"answer"`
	UserAnswer      *string   `json:"user_answer"`
	Source          string    `json:"source"`
	SourceSessionID *int64    `json:"source_session_id"`
	JobTag          *string   `json:"job_tag"`
	Dimension       *string   `json:"dimension"`
	Reference       *string   `json:"reference"`
	Starred         bool      `json:"starred"`
	CreatedAt       time.Time `json:"created_at"`
}

type ParsedQuestion struct {
	Question  string
	Answer    string
	Reference string
}

type ParseResult struct {
	Items   []ParsedQuestion
	Raw     string
	OcrText string
}

type ImportResult struct {
	Imported int
	Skipped  int
}

type ListFilter struct {
	Starred   *bool
	JobTag    string
	Query     string
	Dimension string
}

// dimensionKeys are the four valid assessment dimensions (single source).
var dimensionKeys = []string{"expression", "logic", "content", "job_match"}

func validateDimension(d string) error {
	for _, k := range dimensionKeys {
		if d == k {
			return nil
		}
	}
	return ErrInvalidInput
}
