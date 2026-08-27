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

// Hard guards applied before asking the LLM to score. A session where the
// candidate gave no answers (or only trivially short ones) must never receive
// a mid-range score, because the LLM tends to fabricate plausible-sounding
// feedback from the questions alone.
const (
	// minAnswerCount is the minimum number of candidate answer turns required
	// to ask the LLM for a real evaluation.
	minAnswerCount = 1
	// minAnswerChars is the minimum total (whitespace-trimmed) answer length
	// required to ask the LLM for a real evaluation.
	minAnswerChars = 20
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
	Summary      string   `json:"summary,omitempty"`
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

	// Hard guard: never let the LLM score a session where the candidate gave
	// no real answers. The LLM otherwise fabricates feedback from the question
	// text alone and returns mid-range scores (e.g. 70+) for empty sessions.
	if fb := guardNoAnswer(turns, s.modelVersion); fb != nil {
		return fb, nil
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
	// 自我介绍开场题不作为评分题目（回答仅作为对话上下文），避免拉低/干扰维度评分。
	var qCtx []llm.QuestionContext
	for _, q := range questions {
		if q.Kind == interview.QuestionKindSelfIntro {
			continue
		}
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
		Summary:      strings.TrimSpace(out.Summary),
		ModelVersion: mv,
	}, nil
}

func checkScore(n int) error {
	if n < 0 || n > 100 {
		return fmt.Errorf("score %d out of range 0-100", n)
	}
	return nil
}

// guardNoAnswer inspects the candidate's answer turns. It returns a fixed
// low-score Feedback (nil otherwise) when the candidate gave no answers or
// only trivially short ones, so the LLM is never asked to score an empty
// session.
func guardNoAnswer(turns []interview.Turn, modelVersion string) *Feedback {
	var count int
	var chars int
	for _, t := range turns {
		if t.Role != "candidate" {
			continue
		}
		count++
		chars += len([]rune(strings.TrimSpace(t.Content)))
	}
	if count == 0 {
		return noAnswerFeedback(modelVersion)
	}
	if chars < minAnswerChars {
		return tooBriefFeedback(modelVersion)
	}
	return nil
}

func noAnswerFeedback(modelVersion string) *Feedback {
	return &Feedback{
		TotalScore: 10,
		Dimensions: struct {
			Expression int `json:"expression"`
			Logic      int `json:"logic"`
			Content    int `json:"content"`
			JobMatch   int `json:"job_match"`
		}{},
		Strengths:    []string{"面试已结束，但未检测到任何候选人回答。"},
		Weaknesses:   []string{"未回答任何问题，无法评估表达能力、逻辑结构、内容质量与岗位匹配。"},
		Suggestions:  []string{"重新开始一次面试，并完整回答每个问题后再查看评估报告。"},
		Summary:      "本次未检测到有效回答，建议重新练习。",
		ModelVersion: modelVersion,
	}
}

func tooBriefFeedback(modelVersion string) *Feedback {
	return &Feedback{
		TotalScore: 20,
		Dimensions: struct {
			Expression int `json:"expression"`
			Logic      int `json:"logic"`
			Content    int `json:"content"`
			JobMatch   int `json:"job_match"`
		}{},
		Strengths:    []string{"面试已结束，但候选人回答内容过少。"},
		Weaknesses:   []string{"回答过于简短，缺乏实质内容，无法有效评估各项能力。"},
		Suggestions:  []string{"重新开始一次面试，针对每个问题给出具体、完整的回答。"},
		Summary:      "回答内容过少，未能充分展示能力，建议完整作答后重新评估。",
		ModelVersion: modelVersion,
	}
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
