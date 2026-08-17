package interview

import (
	"encoding/json"
	"errors"
	"time"

	"github.com/interview-assistant/backend/internal/llm"
)

type Mode string

const (
	ModeBehavioral Mode = "behavioral"
	ModeTechnical  Mode = "technical"
	ModeMixed      Mode = "mixed"
)

type Status string

const (
	StatusDraft      Status = "draft"
	StatusReady      Status = "ready"
	StatusInProgress Status = "in_progress"
	StatusCompleted  Status = "completed"
	StatusFailed     Status = "failed"
)

var ErrInvalidMode = errors.New("invalid mode")

type InputMode string

const (
	InputModeText  InputMode = "text"
	InputModeVoice InputMode = "voice"
)

type Session struct {
	ID           int64
	UserID       int64
	JobJD        string
	ResumeText   *string
	Mode         Mode
	InputMode    InputMode
	Persona      string
	PrecheckGaps []string
	Status       Status
	Score        *int
	FeedbackJSON json.RawMessage
	StartedAt    *time.Time
	EndedAt      *time.Time
	CreatedAt    time.Time
}

type Question struct {
	ID        int64
	SessionID int64
	Seq       int
	Question  string
	Intent    *string
	Asked     bool
}

type Turn struct {
	ID        int64
	SessionID int64
	Seq       int
	Role      string
	Kind      string
	Content   string
	CreatedAt time.Time
}

func ValidateMode(mode Mode) error {
	switch mode {
	case ModeBehavioral, ModeTechnical, ModeMixed:
		return nil
	default:
		return ErrInvalidMode
	}
}

func ValidateInputMode(m InputMode) error {
	switch m {
	case InputModeText, InputModeVoice:
		return nil
	default:
		return ErrInvalidInput
	}
}

var ErrInvalidPersona = errors.New("invalid persona")

func validatePersona(p string) error {
	for _, k := range llm.Personas {
		if p == k {
			return nil
		}
	}
	return ErrInvalidPersona
}
