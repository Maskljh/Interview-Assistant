package llm

import (
	"strings"
	"testing"
)

func TestGenerateQuestionsUserEmptyWeakMatchesLegacy(t *testing.T) {
	got := GenerateQuestionsUser("jd", "resume", "technical", nil)
	if strings.Contains(got, "Targeted focus") {
		t.Fatalf("weak=nil should not inject directive, got: %s", got)
	}
	if !strings.Contains(got, "Job description:") || !strings.Contains(got, "Interview mode: technical") {
		t.Fatalf("base prompt missing sections: %s", got)
	}
}

func TestGenerateQuestionsUserInjectsWeakDirective(t *testing.T) {
	got := GenerateQuestionsUser("jd", "resume", "mixed", []string{"logic", "expression"})
	if !strings.Contains(got, "Targeted focus: this user's weak dimensions are 逻辑结构, 表达能力") {
		t.Fatalf("directive missing or labels wrong: %s", got)
	}
	if !strings.Contains(got, "at least half of the questions") {
		t.Fatalf("allocation rule missing: %s", got)
	}
}

func TestGenerateQuestionsUserIgnoresUnknownKeys(t *testing.T) {
	got := GenerateQuestionsUser("jd", "resume", "mixed", []string{"unknown"})
	if strings.Contains(got, "Targeted focus") {
		t.Fatalf("unknown key should not inject directive: %s", got)
	}
}
