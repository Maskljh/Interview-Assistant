package question

import (
	"context"
	"database/sql"
	"errors"
	"strings"

	"github.com/interview-assistant/backend/internal/llm"
)

var (
	ErrNotFound     = errors.New("not found")
	ErrInvalidInput = errors.New("invalid input")
)

type Service struct {
	repo *Repo
	llm  llm.Client
}

func NewService(db *sql.DB, llmClient llm.Client) *Service {
	return &Service{repo: NewRepo(db), llm: llmClient}
}

// JobTagFromJD derives the job tag from a JD: trim, truncate to 40 runes, append "…".
func JobTagFromJD(jd string) string {
	// 清理换行和多余空格，只取第一行有意义的内容
	jd = strings.TrimSpace(jd)
	// 取第一个非空行
	for _, line := range strings.Split(jd, "\n") {
		line = strings.TrimSpace(line)
		if line != "" {
			jd = line
			break
		}
	}
	runes := []rune(jd)
	if len(runes) <= 20 {
		return jd
	}
	return string(runes[:20]) + "…"
}

func (s *Service) ImportFromSession(ctx context.Context, userID, sessionID int64) (int, error) {
	session, err := s.repo.GetSession(sessionID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return 0, ErrNotFound
		}
		return 0, err
	}
	if session.UserID != userID {
		return 0, ErrNotFound
	}

	// 按面试实际提问顺序获取题目和用户作答（来自 turns）
	userAnswers, err := s.repo.ListSessionUserAnswers(sessionID)
	if err != nil {
		return 0, err
	}
	if len(userAnswers) == 0 {
		return 0, ErrInvalidInput
	}

	var items []InsertQuestion
	var allTexts []string
	for _, ua := range userAnswers {
		items = append(items, InsertQuestion{
			Question:   ua.Question,
			UserAnswer: ua.Answer,
		})
		allTexts = append(allTexts, ua.Question)
	}

	jobTag := JobTagFromJD(session.JobJD)
	imported, err := s.repo.InsertBatch(userID, items, sessionID, jobTag)
	if err != nil {
		return 0, err
	}
	s.classifyAsync(userID, allTexts) // best-effort; never blocks or fails import
	return imported, nil
}

// dedupeStrings removes duplicate strings while preserving first-occurrence
// order. Comparison is whitespace-trimmed so near-identical text collapses.
func dedupeStrings(items []string) []string {
	seen := make(map[string]struct{}, len(items))
	out := make([]string, 0, len(items))
	for _, it := range items {
		key := strings.TrimSpace(it)
		if key == "" {
			continue
		}
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, it)
	}
	return out
}

// classifyAsync tags freshly imported questions with an LLM dimension. Any
// failure leaves dimensions NULL; the import itself never fails.
func (s *Service) classifyAsync(userID int64, questions []string) {
	if s.llm == nil || len(questions) == 0 {
		return
	}
	var out llm.ClassifyOut
	if err := s.llm.ChatJSON(context.Background(), llm.ClassifyDimensionsSystem(), llm.ClassifyDimensionsUser(questions), &out); err != nil {
		return
	}
	for _, c := range out.Classifications {
		if validateDimension(c.Dimension) != nil {
			continue
		}
		// Match by exact question text; update that row's dimension.
		for _, q := range questions {
			if q == c.Question {
				_ = s.repo.UpdateDimensionByText(userID, q, c.Dimension)
				break
			}
		}
	}
}

// Focused assembles a practice set: for each dimension, starred-first
// questions capped at limitPerDim; total capped at 10.
func (s *Service) Focused(ctx context.Context, userID int64, dimensions []string, limitPerDim int) ([]Item, error) {
	if len(dimensions) == 0 {
		return nil, ErrInvalidInput
	}
	for _, d := range dimensions {
		if err := validateDimension(d); err != nil {
			return nil, err
		}
	}
	if limitPerDim < 1 {
		limitPerDim = 5
	}
	if limitPerDim > 10 {
		limitPerDim = 10
	}
	var items []Item
	for _, d := range dimensions {
		dimItems, err := s.repo.ListByDimensionForFocused(userID, d, limitPerDim)
		if err != nil {
			return nil, err
		}
		items = append(items, dimItems...)
		if len(items) >= 10 {
			items = items[:10]
			break
		}
	}
	if items == nil {
		items = []Item{}
	}
	return items, nil
}

func (s *Service) List(ctx context.Context, userID int64, f ListFilter) ([]Item, error) {
	items, err := s.repo.List(userID, f)
	if items == nil {
		items = []Item{}
	}
	return items, err
}

func (s *Service) PatchStar(ctx context.Context, userID, id int64, starred bool) (*Item, error) {
	item, err := s.repo.GetByID(id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if item.UserID != userID {
		return nil, ErrNotFound
	}
	if err := s.repo.UpdateStarred(id, starred); err != nil {
		return nil, err
	}
	item.Starred = starred
	return item, nil
}

func (s *Service) Delete(ctx context.Context, userID, id int64) error {
	item, err := s.repo.GetByID(id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		return err
	}
	if item.UserID != userID {
		return ErrNotFound
	}
	return s.repo.Delete(id)
}
