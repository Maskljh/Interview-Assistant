package question

import (
	"context"
	"database/sql"
	"errors"
	"strings"
)

var (
	ErrNotFound     = errors.New("not found")
	ErrInvalidInput = errors.New("invalid input")
)

type Service struct {
	repo *Repo
}

func NewService(db *sql.DB) *Service {
	return &Service{repo: NewRepo(db)}
}

func jobTagFromJD(jd string) string {
	jd = strings.TrimSpace(jd)
	runes := []rune(jd)
	if len(runes) <= 40 {
		return jd
	}
	return string(runes[:40]) + "…"
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

	questions, err := s.repo.ListSessionQuestions(sessionID)
	if err != nil {
		return 0, err
	}
	if len(questions) == 0 {
		return 0, ErrInvalidInput
	}

	jobTag := jobTagFromJD(session.JobJD)
	return s.repo.InsertBatch(userID, questions, sessionID, jobTag)
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
