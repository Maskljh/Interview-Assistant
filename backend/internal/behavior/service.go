package behavior

import (
	"context"
	"database/sql"
	"errors"

	"github.com/interview-assistant/backend/internal/interview"
)

var (
	ErrNotFound       = errors.New("session not found")
	ErrInvalidPayload = errors.New("invalid behavior payload")
)

type Service struct {
	db   *sql.DB
	repo *interview.Repo
}

func NewService(db *sql.DB) *Service {
	return &Service{db: db, repo: interview.NewRepo(db)}
}

func (s *Service) Save(ctx context.Context, userID, sessionID int64, p Payload) error {
	if err := validate(p); err != nil {
		return err
	}
	session, err := s.repo.GetByID(sessionID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		return err
	}
	if session.UserID != userID {
		return ErrNotFound
	}
	return (&repo{db: s.db}).insert(ctx, sessionID, userID, p)
}

func (s *Service) Get(ctx context.Context, userID, sessionID int64) (Result, error) {
	session, err := s.repo.GetByID(sessionID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return Result{}, ErrNotFound
		}
		return Result{}, err
	}
	if session.UserID != userID {
		return Result{}, ErrNotFound
	}
	res, err := (&repo{db: s.db}).get(ctx, sessionID)
	if err != nil {
		return Result{}, err
	}
	if res == nil {
		return Result{Available: false}, nil
	}
	return *res, nil
}

func validate(p Payload) error {
	if p.StressLevel < 0 || p.StressLevel > 100 {
		return ErrInvalidPayload
	}
	if p.NodCount < 0 || p.FaceDetectedFrames < 0 || p.DurationMs < 0 {
		return ErrInvalidPayload
	}
	if len(p.EmotionDistribution) == 0 {
		return ErrInvalidPayload
	}
	for _, seg := range p.StressSegments {
		if seg.V < 0 || seg.V > 100 || seg.TMs < 0 {
			return ErrInvalidPayload
		}
	}
	return nil
}
