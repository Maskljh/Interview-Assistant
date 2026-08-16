package llm

import (
	"strings"
	"testing"
)

func TestGenerateQuestionsUserEmptyWeakMatchesLegacy(t *testing.T) {
	got := GenerateQuestionsUser("jd", "resume", "technical", nil, StandardPersona)
	if strings.Contains(got, "Targeted focus") {
		t.Fatalf("weak=nil should not inject directive, got: %s", got)
	}
	if !strings.Contains(got, "Job description:") || !strings.Contains(got, "Interview mode: technical") {
		t.Fatalf("base prompt missing sections: %s", got)
	}
}

func TestGenerateQuestionsUserInjectsWeakDirective(t *testing.T) {
	got := GenerateQuestionsUser("jd", "resume", "mixed", []string{"logic", "expression"}, StandardPersona)
	if !strings.Contains(got, "Targeted focus: this user's weak dimensions are 逻辑结构, 表达能力") {
		t.Fatalf("directive missing or labels wrong: %s", got)
	}
	if !strings.Contains(got, "at least half of the questions") {
		t.Fatalf("allocation rule missing: %s", got)
	}
}

func TestGenerateQuestionsUserIgnoresUnknownKeys(t *testing.T) {
	got := GenerateQuestionsUser("jd", "resume", "mixed", []string{"unknown"}, StandardPersona)
	if strings.Contains(got, "Targeted focus") {
		t.Fatalf("unknown key should not inject directive: %s", got)
	}
}

func TestGenerateQuestionsUserStandardMatchesNoPersona(t *testing.T) {
	with := GenerateQuestionsUser("jd", "resume", "technical", []string{"logic"}, StandardPersona)
	empty := GenerateQuestionsUser("jd", "resume", "technical", []string{"logic"}, "")
	if with != empty {
		t.Fatalf("standard persona must not alter prompt:\nwith: %s\nempty: %s", with, empty)
	}
}

func TestGenerateQuestionsUserInjectsPersona(t *testing.T) {
	got := GenerateQuestionsUser("jd", "resume", "mixed", nil, "strict_tech")
	if !strings.Contains(got, "strict senior technical interviewer") {
		t.Fatalf("persona directive missing: %s", got)
	}
}

func TestGenerateQuestionsUserUnknownPersonaNoInjection(t *testing.T) {
	got := GenerateQuestionsUser("jd", "resume", "mixed", nil, "evil")
	if strings.Contains(got, "strict senior technical interviewer") {
		t.Fatalf("unknown persona must not inject: %s", got)
	}
}

func TestDecideNextUserStandardNoInjection(t *testing.T) {
	got := DecideNextUser("jd", "technical", "Q", 0, nil, "answer", StandardPersona)
	if strings.Contains(got, "interviewer") && !strings.Contains(got, "strict senior") {
		// "interviewer" appears in persona text only; base prompt has none
	}
	if strings.Contains(got, "strict senior technical interviewer") {
		t.Fatalf("standard persona must not inject: %s", got)
	}
	if !strings.Contains(got, "Latest candidate answer:") {
		t.Fatalf("base prompt missing sections: %s", got)
	}
}

func TestDecideNextUserInjectsPersona(t *testing.T) {
	got := DecideNextUser("jd", "technical", "Q", 0, nil, "answer", "stress")
	if !strings.Contains(got, "fast-paced stress interviewer") {
		t.Fatalf("stress directive missing: %s", got)
	}
}
