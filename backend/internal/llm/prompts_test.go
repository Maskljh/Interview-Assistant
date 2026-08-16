package llm

import (
	"strings"
	"testing"
)

func TestGenerateQuestionsUserEmptyWeakMatchesLegacy(t *testing.T) {
	got := GenerateQuestionsUser("jd", "resume", "technical", nil, StandardPersona, nil)
	if strings.Contains(got, "Targeted focus") {
		t.Fatalf("weak=nil should not inject directive, got: %s", got)
	}
	if !strings.Contains(got, "Job description:") || !strings.Contains(got, "Interview mode: technical") {
		t.Fatalf("base prompt missing sections: %s", got)
	}
}

func TestGenerateQuestionsUserInjectsWeakDirective(t *testing.T) {
	got := GenerateQuestionsUser("jd", "resume", "mixed", []string{"logic", "expression"}, StandardPersona, nil)
	if !strings.Contains(got, "Targeted focus: this user's weak dimensions are 逻辑结构, 表达能力") {
		t.Fatalf("directive missing or labels wrong: %s", got)
	}
	if !strings.Contains(got, "at least half of the questions") {
		t.Fatalf("allocation rule missing: %s", got)
	}
}

func TestGenerateQuestionsUserIgnoresUnknownKeys(t *testing.T) {
	got := GenerateQuestionsUser("jd", "resume", "mixed", []string{"unknown"}, StandardPersona, nil)
	if strings.Contains(got, "Targeted focus") {
		t.Fatalf("unknown key should not inject directive: %s", got)
	}
}

func TestGenerateQuestionsUserStandardMatchesNoPersona(t *testing.T) {
	with := GenerateQuestionsUser("jd", "resume", "technical", []string{"logic"}, StandardPersona, nil)
	empty := GenerateQuestionsUser("jd", "resume", "technical", []string{"logic"}, "", nil)
	if with != empty {
		t.Fatalf("standard persona must not alter prompt:\nwith: %s\nempty: %s", with, empty)
	}
}

func TestGenerateQuestionsUserInjectsPersona(t *testing.T) {
	got := GenerateQuestionsUser("jd", "resume", "mixed", nil, "strict_tech", nil)
	if !strings.Contains(got, "strict senior technical interviewer") {
		t.Fatalf("persona directive missing: %s", got)
	}
}

func TestGenerateQuestionsUserUnknownPersonaNoInjection(t *testing.T) {
	got := GenerateQuestionsUser("jd", "resume", "mixed", nil, "evil", nil)
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

func TestPersonaLabelsConsistent(t *testing.T) {
	personaSet := make(map[string]bool, len(Personas))
	for _, p := range Personas {
		personaSet[p] = true
	}

	for key := range PersonaLabels {
		if !personaSet[key] {
			t.Fatalf("PersonaLabels key %q not in Personas", key)
		}
	}
	for _, p := range Personas {
		if label, ok := PersonaLabels[p]; !ok || label == "" {
			t.Fatalf("persona %q has no non-empty label", p)
		}
	}
	for _, p := range []string{"strict_tech", "warm_hr", "stress"} {
		if _, ok := PersonaPrompts[p]; !ok {
			t.Fatalf("persona %q missing prompt in PersonaPrompts", p)
		}
	}
	if _, ok := PersonaPrompts[StandardPersona]; ok {
		t.Fatalf("standard persona must not have a prompt in PersonaPrompts")
	}
}

func TestPreCheckSystemRequiresSchema(t *testing.T) {
	sys := PreCheckSystem()
	if !strings.Contains(sys, "match_score") || !strings.Contains(sys, `"gaps"`) || !strings.Contains(sys, `"suggestions"`) {
		t.Fatalf("schema fields missing: %s", sys)
	}
}

func TestPreCheckUserWithResume(t *testing.T) {
	got := PreCheckUser("Backend engineer JD", "Go, SQL experience")
	if !strings.Contains(got, "Resume:") || !strings.Contains(got, "Backend engineer JD") {
		t.Fatalf("resume branch wrong: %s", got)
	}
}

func TestPreCheckUserWithoutResume(t *testing.T) {
	got := PreCheckUser("Backend engineer JD", "")
	if !strings.Contains(got, "No resume was provided") {
		t.Fatalf("empty-resume branch missing: %s", got)
	}
}

func TestGenerateQuestionsUserInjectsPrecheckGaps(t *testing.T) {
	got := GenerateQuestionsUser("jd", "resume", "mixed", nil, StandardPersona, []string{"缺少 Kubernetes 经验", "无高并发项目"})
	if !strings.Contains(got, "Targeted focus (pre-check):") || !strings.Contains(got, "缺少 Kubernetes 经验") {
		t.Fatalf("precheck directive missing: %s", got)
	}
}

func TestGenerateQuestionsUserEmptyGapsMatchesLegacy(t *testing.T) {
	noGaps := GenerateQuestionsUser("jd", "resume", "mixed", []string{"logic"}, "strict_tech", nil)
	withEmpty := GenerateQuestionsUser("jd", "resume", "mixed", []string{"logic"}, "strict_tech", []string{})
	if noGaps != withEmpty {
		t.Fatalf("empty gaps must not alter prompt:\nnoGaps: %s\nwithEmpty: %s", noGaps, withEmpty)
	}
}

func TestGenerateQuestionsUserInjectionsCoexist(t *testing.T) {
	got := GenerateQuestionsUser("jd", "resume", "mixed", []string{"logic"}, "strict_tech", []string{"缺经验"})
	if !strings.Contains(got, "Targeted focus: this user's weak dimensions are") {
		t.Fatalf("weak directive missing: %s", got)
	}
	if !strings.Contains(got, "strict senior technical interviewer") {
		t.Fatalf("persona directive missing: %s", got)
	}
	if !strings.Contains(got, "Targeted focus (pre-check):") {
		t.Fatalf("precheck directive missing: %s", got)
	}
}
