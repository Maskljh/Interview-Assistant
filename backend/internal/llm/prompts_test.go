package llm

import (
	"strings"
	"testing"
)

func TestGenerateQuestionsUserEmptyWeakMatchesLegacy(t *testing.T) {
	got := GenerateQuestionsUser("jd", "resume", "technical", nil, StandardPersona, StandardDifficulty, StandardCompanyStyle, nil)
	if strings.Contains(got, "Targeted focus") {
		t.Fatalf("weak=nil should not inject directive, got: %s", got)
	}
	if !strings.Contains(got, "Job description:") || !strings.Contains(got, "Interview mode: technical") {
		t.Fatalf("base prompt missing sections: %s", got)
	}
}

func TestGenerateQuestionsUserInjectsWeakDirective(t *testing.T) {
	got := GenerateQuestionsUser("jd", "resume", "mixed", []string{"logic", "expression"}, StandardPersona, StandardDifficulty, StandardCompanyStyle, nil)
	if !strings.Contains(got, "Targeted focus: this user's weak dimensions are 逻辑结构, 表达能力") {
		t.Fatalf("directive missing or labels wrong: %s", got)
	}
	if !strings.Contains(got, "at least half of the questions") {
		t.Fatalf("allocation rule missing: %s", got)
	}
}

func TestGenerateQuestionsUserIgnoresUnknownKeys(t *testing.T) {
	got := GenerateQuestionsUser("jd", "resume", "mixed", []string{"unknown"}, StandardPersona, StandardDifficulty, StandardCompanyStyle, nil)
	if strings.Contains(got, "Targeted focus") {
		t.Fatalf("unknown key should not inject directive: %s", got)
	}
}

func TestGenerateQuestionsUserStandardMatchesNoPersona(t *testing.T) {
	with := GenerateQuestionsUser("jd", "resume", "technical", []string{"logic"}, StandardPersona, StandardDifficulty, StandardCompanyStyle, nil)
	empty := GenerateQuestionsUser("jd", "resume", "technical", []string{"logic"}, "", StandardDifficulty, StandardCompanyStyle, nil)
	if with != empty {
		t.Fatalf("standard persona must not alter prompt:\nwith: %s\nempty: %s", with, empty)
	}
}

func TestGenerateQuestionsUserInjectsPersona(t *testing.T) {
	got := GenerateQuestionsUser("jd", "resume", "mixed", nil, "strict_tech", StandardDifficulty, StandardCompanyStyle, nil)
	if !strings.Contains(got, "strict senior technical interviewer") {
		t.Fatalf("persona directive missing: %s", got)
	}
}

func TestGenerateQuestionsUserUnknownPersonaNoInjection(t *testing.T) {
	got := GenerateQuestionsUser("jd", "resume", "mixed", nil, "evil", StandardDifficulty, StandardCompanyStyle, nil)
	if strings.Contains(got, "strict senior technical interviewer") {
		t.Fatalf("unknown persona must not inject: %s", got)
	}
}

func TestFollowUpLimit(t *testing.T) {
	cases := []struct {
		persona string
		want    int
	}{
		{StandardPersona, 2},
		{"", 2},
		{"unknown", 2},
		{"strict_tech", 4},
		{"stress", 4},
		{"warm_hr", 1},
	}
	for _, c := range cases {
		if got := FollowUpLimit(c.persona); got != c.want {
			t.Fatalf("FollowUpLimit(%q) = %d, want %d", c.persona, got, c.want)
		}
	}
}

func TestDecideNextUserStandardNoInjection(t *testing.T) {
	got := DecideNextUser("jd", "technical", "Q", 0, nil, "answer", StandardPersona, StandardDifficulty, StandardCompanyStyle)
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
	got := DecideNextUser("jd", "technical", "Q", 0, nil, "answer", "stress", StandardDifficulty, StandardCompanyStyle)
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
	got := GenerateQuestionsUser("jd", "resume", "mixed", nil, StandardPersona, StandardDifficulty, StandardCompanyStyle, []string{"缺少 Kubernetes 经验", "无高并发项目"})
	if !strings.Contains(got, "Targeted focus (pre-check):") || !strings.Contains(got, "缺少 Kubernetes 经验") {
		t.Fatalf("precheck directive missing: %s", got)
	}
}

func TestGenerateQuestionsUserEmptyGapsMatchesLegacy(t *testing.T) {
	noGaps := GenerateQuestionsUser("jd", "resume", "mixed", []string{"logic"}, "strict_tech", StandardDifficulty, StandardCompanyStyle, nil)
	withEmpty := GenerateQuestionsUser("jd", "resume", "mixed", []string{"logic"}, "strict_tech", StandardDifficulty, StandardCompanyStyle, []string{})
	if noGaps != withEmpty {
		t.Fatalf("empty gaps must not alter prompt:\nnoGaps: %s\nwithEmpty: %s", noGaps, withEmpty)
	}
}

func TestGenerateQuestionsUserInjectionsCoexist(t *testing.T) {
	got := GenerateQuestionsUser("jd", "resume", "mixed", []string{"logic"}, "strict_tech", StandardDifficulty, StandardCompanyStyle, []string{"缺经验"})
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

func TestClassifyDimensionsSystemRequiresSchema(t *testing.T) {
	sys := ClassifyDimensionsSystem()
	if !strings.Contains(sys, `"classifications"`) || !strings.Contains(sys, `"dimension"`) {
		t.Fatalf("schema fields missing: %s", sys)
	}
	for _, d := range []string{"expression", "logic", "content", "job_match"} {
		if !strings.Contains(sys, d) {
			t.Fatalf("dimension %s missing from rules: %s", d, sys)
		}
	}
}

func TestEvaluateSessionSystemRequiresLowScoreForNoAnswers(t *testing.T) {
	sys := EvaluateSessionSystem()
	if !strings.Contains(sys, "at most 30") {
		t.Fatalf("no-answer low-score rule missing: %s", sys)
	}
}

func TestEvaluateSessionSystemForbidsFabrication(t *testing.T) {
	sys := strings.ToLower(EvaluateSessionSystem())
	if !strings.Contains(sys, "fabricate") && !strings.Contains(sys, "invent") {
		t.Fatalf("fabrication rule missing: %s", sys)
	}
}

func TestAllUserFacingSystemPromptsRequireChinese(t *testing.T) {
	cases := map[string]string{
		"GenerateQuestionsSystem": GenerateQuestionsSystem(),
		"DecideNextSystem":        DecideNextSystem(),
		"EvaluateSessionSystem":   EvaluateSessionSystem(),
		"PreCheckSystem":          PreCheckSystem(),
	}
	for name, sys := range cases {
		if !strings.Contains(sys, "Chinese (Simplified)") {
			t.Fatalf("%s must require Chinese output: %s", name, sys)
		}
	}
}

func TestClassifyDimensionsUserListsQuestions(t *testing.T) {
	got := ClassifyDimensionsUser([]string{"Q1", "Q2"})
	if !strings.Contains(got, "- Q1") || !strings.Contains(got, "- Q2") {
		t.Fatalf("questions missing from prompt: %s", got)
	}
}

func TestParseImportSystem(t *testing.T) {
	s := ParseImportSystem()
	if !strings.Contains(s, "JSON") || !strings.Contains(s, "items") {
		t.Fatalf("ParseImportSystem should instruct JSON output with items, got: %s", s)
	}
	if strings.Contains(s, "expression") || strings.Contains(s, "logic") {
		t.Fatalf("ParseImportSystem should not mention dimension classification, got: %s", s)
	}
}

func TestParseImportUser(t *testing.T) {
	u := ParseImportUser("第一题：请介绍你自己。\n答案：我是……")
	if !strings.Contains(u, "第一题") {
		t.Fatalf("ParseImportUser should embed the source text, got: %s", u)
	}
}
