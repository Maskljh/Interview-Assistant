package interview

import (
	"context"
	"database/sql"
	"errors"
	"strings"
)

var ErrNotFound = errors.New("session not found")

type Service struct {
	repo *Repo
}

func NewService(db *sql.DB) *Service {
	return &Service{repo: NewRepo(db)}
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

var ErrInvalidInput = errors.New("invalid input")
