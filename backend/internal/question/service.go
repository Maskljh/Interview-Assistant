package question

import (
	"context"
	"database/sql"
	"errors"
	"strings"

	"github.com/interview-assistant/backend/internal/llm"
	"github.com/interview-assistant/backend/internal/ocr"
)

var (
	ErrNotFound       = errors.New("not found")
	ErrInvalidInput   = errors.New("invalid input")
	ErrOCRUnavailable = errors.New("ocr unavailable")
)

type Service struct {
	repo *Repo
	llm  llm.Client
	ocr  ocr.Client
}

func NewService(db *sql.DB, llmClient llm.Client) *Service {
	return &Service{repo: NewRepo(db), llm: llmClient}
}

// SetOCR injects the OCR client used for image import parsing. SetOCR(nil)
// makes image parsing return ErrOCRUnavailable; text parsing is unaffected.
func (s *Service) SetOCR(c ocr.Client) {
	s.ocr = c
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

// Patch updates any of the provided optional fields on a bank question.
// Nil pointers leave the corresponding field unchanged; empty strings clear
// nullable text fields. starred is applied separately to keep old callers working.
func (s *Service) Patch(ctx context.Context, userID, id int64, starred *bool, question, answer, jobTag, dimension *string) (*Item, error) {
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

	changed := false
	if starred != nil {
		if err := s.repo.UpdateStarred(id, *starred); err != nil {
			return nil, err
		}
		item.Starred = *starred
		changed = true
	}
	if question != nil {
		trimmed := strings.TrimSpace(*question)
		if trimmed == "" {
			return nil, ErrInvalidInput
		}
		if err := s.repo.UpdateField(id, "question", trimmed); err != nil {
			return nil, err
		}
		item.Question = trimmed
		changed = true
	}
	if answer != nil {
		trimmed := strings.TrimSpace(*answer)
		if err := s.repo.UpdateNullableField(id, "answer", trimmed); err != nil {
			return nil, err
		}
		if trimmed == "" {
			item.Answer = nil
		} else {
			item.Answer = &trimmed
		}
		changed = true
	}
	if jobTag != nil {
		trimmed := strings.TrimSpace(*jobTag)
		if err := s.repo.UpdateNullableField(id, "job_tag", trimmed); err != nil {
			return nil, err
		}
		if trimmed == "" {
			item.JobTag = nil
		} else {
			item.JobTag = &trimmed
		}
		changed = true
	}
	if dimension != nil {
		trimmed := strings.TrimSpace(*dimension)
		if err := s.repo.UpdateNullableField(id, "dimension", trimmed); err != nil {
			return nil, err
		}
		if trimmed == "" {
			item.Dimension = nil
		} else {
			item.Dimension = &trimmed
		}
		changed = true
	}

	if !changed {
		return item, nil
	}
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

// ParseFromText extracts candidate questions from a transcript using the LLM.
// On LLM failure it degrades to returning the raw text for manual editing;
// it never fails the request.
func (s *Service) ParseFromText(ctx context.Context, text string) (ParseResult, error) {
	text = strings.TrimSpace(text)
	if text == "" {
		return ParseResult{}, ErrInvalidInput
	}
	var out llm.ParseImportOut
	if err := s.llm.ChatJSON(ctx, llm.ParseImportSystem(), llm.ParseImportUser(text), &out); err != nil {
		return ParseResult{Raw: text}, nil // 降级：返回原文供手动编辑
	}
	var res ParseResult
	for _, it := range out.Items {
		q := strings.TrimSpace(it.Question)
		if q == "" {
			continue
		}
		res.Items = append(res.Items, ParsedQuestion{
			Question: q,
			Answer:   strings.TrimSpace(it.Answer),
		})
	}
	if len(res.Items) == 0 {
		res.Raw = text
	}
	return res, nil
}

// ParseFromImage OCRs an image then runs ParseFromText on the recognized text.
func (s *Service) ParseFromImage(ctx context.Context, image []byte) (ParseResult, error) {
	if s.ocr == nil {
		return ParseResult{}, ErrOCRUnavailable
	}
	text, err := s.ocr.Recognize(ctx, image)
	if err != nil {
		return ParseResult{}, ErrOCRUnavailable
	}
	res, err := s.ParseFromText(ctx, text)
	res.OcrText = text
	return res, err
}

// ImportConfirmed inserts user-confirmed parsed questions with source='import'
// and classifies their dimensions via the existing async pipeline.
func (s *Service) ImportConfirmed(ctx context.Context, userID int64, items []ParsedQuestion, jobTag string) (ImportResult, error) {
	if len(items) == 0 {
		return ImportResult{}, ErrInvalidInput
	}
	res, err := s.repo.InsertImportedBatch(userID, items, jobTag)
	if err != nil {
		return ImportResult{}, err
	}
	if res.Imported > 0 {
		texts := make([]string, 0, len(items))
		for _, it := range items {
			if strings.TrimSpace(it.Question) != "" {
				texts = append(texts, it.Question)
			}
		}
		s.classifyAsync(userID, texts) // best-effort dimension tagging
	}
	return res, nil
}
