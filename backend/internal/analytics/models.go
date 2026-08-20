package analytics

// Session source kinds used to split trends between regular JD-driven
// interviews and question-bank practice sessions.
const (
	SourceRegular = "regular"
	SourceBank    = "bank"
)

type Summary struct {
	TotalSessions int `json:"total_sessions"`
	AvgScore      int `json:"avg_score"`
	MaxScore      int `json:"max_score"`
	MinScore      int `json:"min_score"`
	FirstScore    int `json:"first_score"`
	LatestScore   int `json:"latest_score"`
	Delta         int `json:"delta"`
}

type TrendPoint struct {
	Date       string `json:"date"`
	SessionID  int64  `json:"session_id"`
	JobTag     string `json:"job_tag"`
	Mode       string `json:"mode"`
	Source     string `json:"source"`
	Total      int    `json:"total"`
	Expression int    `json:"expression"`
	Logic      int    `json:"logic"`
	Content    int    `json:"content"`
	JobMatch   int    `json:"job_match"`
}

type Trends struct {
	Summary Summary      `json:"summary"`
	Points  []TrendPoint `json:"points"`
	JobTags []string     `json:"job_tags"`
}
