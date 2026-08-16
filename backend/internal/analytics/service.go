package analytics

import (
	"context"
	"database/sql"
	"encoding/json"
	"math"

	"github.com/interview-assistant/backend/internal/question"
)

type dims struct {
	TotalScore int `json:"total_score"`
	Dimensions struct {
		Expression int `json:"expression"`
		Logic      int `json:"logic"`
		Content    int `json:"content"`
		JobMatch   int `json:"job_match"`
	} `json:"dimensions"`
}

type Service struct {
	repo *Repo
}

func NewService(db *sql.DB) *Service {
	return &Service{repo: NewRepo(db)}
}

func (s *Service) Trends(ctx context.Context, userID int64, jobTag, mode string) (*Trends, error) {
	rows, err := s.repo.ListCompletedScored(ctx, userID)
	if err != nil {
		return nil, err
	}

	type candidate struct {
		point TrendPoint
	}
	var cands []candidate
	seenTags := make(map[string]bool)
	jobTags := []string{}

	for _, row := range rows {
		tag := question.JobTagFromJD(row.JobJD)
		if !seenTags[tag] {
			seenTags[tag] = true
			jobTags = append(jobTags, tag)
		}
		if jobTag != "" && tag != jobTag {
			continue
		}
		if mode != "" && row.Mode != mode {
			continue
		}

		var d dims
		if err := json.Unmarshal(row.FeedbackJSON, &d); err != nil {
			continue // bad feedback_json: skip this session entirely
		}
		cands = append(cands, candidate{
			point: TrendPoint{
				Date:       row.CreatedAt.Format("2006-01-02"),
				SessionID:  row.ID,
				JobTag:     tag,
				Mode:       row.Mode,
				Total:      row.Score,
				Expression: d.Dimensions.Expression,
				Logic:      d.Dimensions.Logic,
				Content:    d.Dimensions.Content,
				JobMatch:   d.Dimensions.JobMatch,
			},
		})
	}

	t := &Trends{Points: []TrendPoint{}, JobTags: jobTags}
	if len(cands) == 0 {
		return t, nil
	}

	points := make([]TrendPoint, len(cands))
	sum := 0
	minScore, maxScore := cands[0].point.Total, cands[0].point.Total
	for i, c := range cands {
		points[i] = c.point
		sum += c.point.Total
		if c.point.Total < minScore {
			minScore = c.point.Total
		}
		if c.point.Total > maxScore {
			maxScore = c.point.Total
		}
	}

	t.Points = points
	t.Summary = Summary{
		TotalSessions: len(points),
		AvgScore:      int(math.Round(float64(sum) / float64(len(points)))),
		MaxScore:      maxScore,
		MinScore:      minScore,
		FirstScore:    points[0].Total,
		LatestScore:   points[len(points)-1].Total,
		Delta:         points[len(points)-1].Total - points[0].Total,
	}
	return t, nil
}
