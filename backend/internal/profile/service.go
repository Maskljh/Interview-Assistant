package profile

import (
	"context"
	"database/sql"
	"encoding/json"
	"sort"
	"time"
)

type dims struct {
	Dimensions struct {
		Expression int `json:"expression"`
		Logic      int `json:"logic"`
		Content    int `json:"content"`
		JobMatch   int `json:"job_match"`
	} `json:"dimensions"`
}

type Profile struct {
	WeakDimensions []string `json:"weak_dimensions"`
	BasedOnSessions int     `json:"based_on_sessions"`
}

type Service struct {
	db *sql.DB
}

func NewService(db *sql.DB) *Service {
	return &Service{db: db}
}

func (s *Service) Weaknesses(ctx context.Context, userID int64, maxSessions int) (Profile, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT feedback_json, created_at
		 FROM interview_sessions
		 WHERE user_id = ? AND status = 'completed' AND score IS NOT NULL
		 ORDER BY created_at DESC
		 LIMIT ?`,
		userID, maxSessions,
	)
	if err != nil {
		return Profile{}, err
	}
	defer rows.Close()

	var (
		sums    [4]int
		counts  [4]int
		parsed  int
		names   = [4]string{"expression", "logic", "content", "job_match"}
	)
	for rows.Next() {
		var raw sql.NullString
		var created time.Time
		if err := rows.Scan(&raw, &created); err != nil {
			return Profile{}, err
		}
		var d dims
		if err := json.Unmarshal([]byte(raw.String), &d); err != nil {
			continue // unparseable feedback: skip this session
		}
		parsed++
		sums[0] += d.Dimensions.Expression
		sums[1] += d.Dimensions.Logic
		sums[2] += d.Dimensions.Content
		sums[3] += d.Dimensions.JobMatch
		counts[0]++
		counts[1]++
		counts[2]++
		counts[3]++
	}
	if err := rows.Err(); err != nil {
		return Profile{}, err
	}
	if parsed == 0 {
		return Profile{WeakDimensions: []string{}, BasedOnSessions: 0}, nil
	}

	means := [4]float64{}
	var total float64
	for i := 0; i < 4; i++ {
		means[i] = float64(sums[i]) / float64(counts[i])
		total += means[i]
	}
	average := total / 4

	type gap struct {
		name string
		gap  float64
	}
	var gaps []gap
	for i := 0; i < 4; i++ {
		if means[i] < average {
			gaps = append(gaps, gap{name: names[i], gap: average - means[i]})
		}
	}
	sort.Slice(gaps, func(a, b int) bool { return gaps[a].gap > gaps[b].gap })
	if len(gaps) > 2 {
		gaps = gaps[:2]
	}

	weak := make([]string, 0, len(gaps))
	for _, g := range gaps {
		weak = append(weak, g.name)
	}
	return Profile{WeakDimensions: weak, BasedOnSessions: parsed}, nil
}
