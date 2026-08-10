package analysis

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/interview-assistant/backend/internal/interview"
	"github.com/interview-assistant/backend/internal/llm"
)

var (
	ErrNotFound     = errors.New("session not found")
	ErrNotCompleted = errors.New("session not completed")
	ErrLLMFailure   = errors.New("llm failure")
)

type Feedback struct {
	TotalScore   int `json:"total_score"`
	Dimensions   struct {
		Expression int `json:"expression"`
		Logic      int `json:"logic"`
		Content    int `json:"content"`
		JobMatch   int `json:"job_match"`
	} `json:"dimensions"`
	Strengths    []string `json:"strengths"`
	Weaknesses   []string `json:"weaknesses"`
	Suggestions  []string `json:"suggestions"`
	ModelVersion string   `json:"model_version"`
}

type Report struct {
	Available bool      `json:"available"`
	Feedback  *Feedback `json:"feedback,omitempty"`
}

type Service struct {
	repo         *interview.Repo
	llm          llm.Client
	modelVersion string
}

func NewService(db *sql.DB, llmClient llm.Client, modelVersion string) *Service {
	if modelVersion == "" {
		modelVersion = "deepseek-chat"
	}
	return &Service{
		repo:         interview.NewRepo(db),
		llm:          llmClient,
		modelVersion: modelVersion,
	}
}

func (s *Service) Evaluate(ctx context.Context, sessionID int64) (int, []byte, error) {
	fb, err := s.evaluate(ctx, sessionID)
	if err != nil {
		return 0, nil, err
	}
	fbJSON, err := json.Marshal(fb)
	if err != nil {
		return 0, nil, err
	}
	return fb.TotalScore, fbJSON, nil
}

func (s *Service) evaluate(ctx context.Context, sessionID int64) (*Feedback, error) {
	session, err := s.repo.GetByID(sessionID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}

	turns, err := s.repo.ListTurns(sessionID)
	if err != nil {
		return nil, err
	}
	questions, err := s.repo.ListQuestions(sessionID)
	if err != nil {
		return nil, err
	}

	if s.llm == nil {
		return nil, ErrLLMFailure
	}

	resume := "none"
	if session.ResumeText != nil && strings.TrimSpace(*session.ResumeText) != "" {
		resume = *session.ResumeText
	}

	var turnCtx []llm.TurnContext
	for _, t := range turns {
		turnCtx = append(turnCtx, llm.TurnContext{Role: t.Role, Kind: t.Kind, Content: t.Content})
	}
	var qCtx []llm.QuestionContext
	for _, q := range questions {
		intent := ""
		if q.Intent != nil {
			intent = *q.Intent
		}
		qCtx = append(qCtx, llm.QuestionContext{Seq: q.Seq, Question: q.Question, Intent: intent})
	}

	var out llm.EvaluateOut
	if err := s.llm.ChatJSON(ctx,
		llm.EvaluateSessionSystem(),
		llm.EvaluateSessionUser(session.JobJD, resume, string(session.Mode), qCtx, turnCtx),
		&out,
	); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrLLMFailure, err)
	}

	fb, err := validateFeedback(out, s.modelVersion)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrLLMFailure, err)
	}
	return fb, nil
}

func validateFeedback(out llm.EvaluateOut, modelVersion string) (*Feedback, error) {
	if err := checkScore(out.TotalScore); err != nil {
		return nil, err
	}
	if err := checkScore(out.Dimensions.Expression); err != nil {
		return nil, err
	}
	if err := checkScore(out.Dimensions.Logic); err != nil {
		return nil, err
	}
	if err := checkScore(out.Dimensions.Content); err != nil {
		return nil, err
	}
	if err := checkScore(out.Dimensions.JobMatch); err != nil {
		return nil, err
	}
	if len(out.Strengths) == 0 || len(out.Weaknesses) == 0 || len(out.Suggestions) == 0 {
		return nil, fmt.Errorf("missing strengths, weaknesses, or suggestions")
	}

	mv := out.ModelVersion
	if strings.TrimSpace(mv) == "" {
		mv = modelVersion
	}

	return &Feedback{
		TotalScore: out.TotalScore,
		Dimensions: struct {
			Expression int `json:"expression"`
			Logic      int `json:"logic"`
			Content    int `json:"content"`
			JobMatch   int `json:"job_match"`
		}{
			Expression: out.Dimensions.Expression,
			Logic:      out.Dimensions.Logic,
			Content:    out.Dimensions.Content,
			JobMatch:   out.Dimensions.JobMatch,
		},
		Strengths:    out.Strengths,
		Weaknesses:   out.Weaknesses,
		Suggestions:  out.Suggestions,
		ModelVersion: mv,
	}, nil
}

func checkScore(n int) error {
	if n < 0 || n > 100 {
		return fmt.Errorf("score %d out of range 0-100", n)
	}
	return nil
}

func (s *Service) GetReport(ctx context.Context, userID, sessionID int64) (*Report, error) {
	session, err := s.repo.GetByID(sessionID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if session.UserID != userID {
		return nil, ErrNotFound
	}
	if session.Status != interview.StatusCompleted {
		return nil, ErrNotCompleted
	}
	if len(session.FeedbackJSON) == 0 {
		return &Report{Available: false}, nil
	}
	var fb Feedback
	if err := json.Unmarshal(session.FeedbackJSON, &fb); err != nil {
		return &Report{Available: false}, nil
	}
	return &Report{Available: true, Feedback: &fb}, nil
}

func (s *Service) Retry(ctx context.Context, userID, sessionID int64) (*Report, error) {
	session, err := s.repo.GetByID(sessionID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if session.UserID != userID {
		return nil, ErrNotFound
	}
	if session.Status != interview.StatusCompleted {
		return nil, ErrNotCompleted
	}

	fb, err := s.evaluate(ctx, sessionID)
	if err != nil {
		_ = s.repo.SaveEvaluationFailure(sessionID, err.Error())
		return &Report{Available: false}, nil
	}
	fbJSON, err := json.Marshal(fb)
	if err != nil {
		return nil, err
	}
	if err := s.repo.SaveEvaluationSuccess(sessionID, fb.TotalScore, fbJSON); err != nil {
		return nil, err
	}
	return &Report{Available: true, Feedback: fb}, nil
}
