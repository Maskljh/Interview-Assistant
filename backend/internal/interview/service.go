package interview

import (
	"context"
	"database/sql"
	"errors"
	"strings"

	"github.com/interview-assistant/backend/internal/llm"
)

var (
	ErrNotFound     = errors.New("session not found")
	ErrLLMFailure   = errors.New("llm failure")
	ErrInvalidState = errors.New("invalid session state")
)

type Service struct {
	repo *Repo
	llm  llm.Client
}

func NewService(db *sql.DB, llmClient llm.Client) *Service {
	return &Service{repo: NewRepo(db), llm: llmClient}
}

func (s *Service) Create(ctx context.Context, userID int64, jobJD string, resume *string, mode Mode) (*Session, error) {
	jobJD = strings.TrimSpace(jobJD)
	if jobJD == "" {
		return nil, ErrInvalidInput
	}
	if err := ValidateMode(mode); err != nil {
		return nil, err
	}
	return s.repo.Create(userID, jobJD, resume, mode)
}

func (s *Service) List(ctx context.Context, userID int64) ([]Session, error) {
	sessions, err := s.repo.ListByUser(userID)
	if sessions == nil {
		sessions = []Session{}
	}
	return sessions, err
}

func (s *Service) Get(ctx context.Context, userID, id int64) (*Session, []Question, []Turn, error) {
	session, err := s.repo.GetByID(id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil, nil, ErrNotFound
		}
		return nil, nil, nil, err
	}
	if session.UserID != userID {
		return nil, nil, nil, ErrNotFound
	}
	questions, err := s.repo.ListQuestions(id)
	if err != nil {
		return nil, nil, nil, err
	}
	if questions == nil {
		questions = []Question{}
	}
	turns, err := s.repo.ListTurns(id)
	if err != nil {
		return nil, nil, nil, err
	}
	if turns == nil {
		turns = []Turn{}
	}
	return session, questions, turns, nil
}

func (s *Service) Start(ctx context.Context, userID, sessionID int64) (*Session, []Question, error) {
	session, err := s.repo.GetByID(sessionID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil, ErrNotFound
		}
		return nil, nil, err
	}
	if session.UserID != userID {
		return nil, nil, ErrNotFound
	}
	if session.Status != StatusDraft && session.Status != StatusFailed {
		return nil, nil, ErrInvalidState
	}
	if s.llm == nil {
		return nil, nil, ErrLLMFailure
	}

	resume := "none"
	if session.ResumeText != nil && strings.TrimSpace(*session.ResumeText) != "" {
		resume = *session.ResumeText
	}

	var out llm.GenQuestionsOut
	if err := s.llm.ChatJSON(ctx, llm.GenerateQuestionsSystem(), llm.GenerateQuestionsUser(session.JobJD, resume, string(session.Mode)), &out); err != nil {
		return nil, nil, ErrLLMFailure
	}
	if len(out.Questions) < 5 || len(out.Questions) > 8 {
		return nil, nil, ErrLLMFailure
	}

	toInsert := make([]struct {
		Seq      int
		Question string
		Intent   string
	}, len(out.Questions))
	for i, q := range out.Questions {
		toInsert[i] = struct {
			Seq      int
			Question string
			Intent   string
		}{Seq: q.Seq, Question: q.Question, Intent: q.Intent}
	}

	questions, err := s.repo.StartSession(sessionID, toInsert)
	if err != nil {
		return nil, nil, err
	}
	session.Status = StatusReady
	return session, questions, nil
}

var ErrInvalidInput = errors.New("invalid input")
