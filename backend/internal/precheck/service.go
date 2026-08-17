package precheck

import (
	"context"
	"errors"
	"strings"

	"github.com/interview-assistant/backend/internal/llm"
)

var (
	ErrInvalidInput = errors.New("invalid input")
	ErrLLMFailure   = errors.New("llm failure")
)

type PreCheckOut struct {
	MatchScore  int      `json:"match_score"`
	Gaps        []string `json:"gaps"`
	Suggestions []string `json:"suggestions"`
}

type Service struct {
	llm llm.Client
}

func NewService(llmClient llm.Client) *Service {
	return &Service{llm: llmClient}
}

func (s *Service) Check(ctx context.Context, jobJD, resume string) (PreCheckOut, error) {
	if strings.TrimSpace(jobJD) == "" {
		return PreCheckOut{}, ErrInvalidInput
	}
	var out PreCheckOut
	if err := s.llm.ChatJSON(ctx, llm.PreCheckSystem(), llm.PreCheckUser(jobJD, resume), &out); err != nil {
		return PreCheckOut{}, ErrLLMFailure
	}
	return out, nil
}
