package interview_test

import (
	"testing"

	"github.com/interview-assistant/backend/internal/interview"
)

func TestValidateInputModeVideo(t *testing.T) {
	if err := interview.ValidateInputMode(interview.InputModeVideo); err != nil {
		t.Fatalf("video should be valid: %v", err)
	}
}
