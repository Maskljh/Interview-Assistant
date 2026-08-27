package interview

import (
	"testing"
	"time"
)

func TestApplyDecideRules(t *testing.T) {
	cases := []struct {
		name string
		in   DecideInput
		want DecideAction
	}{
		{"force next when followups full", DecideInput{FollowUpsOnCurrent: 2, ModelAction: "follow_up", CurrentQuestionIndex: 0, MainQuestionCount: 5}, "next_question"},
		{"force finish when last question done", DecideInput{CurrentQuestionIndex: 4, MainQuestionCount: 5, FollowUpsOnCurrent: 0, ModelAction: "next_question"}, "finish"},
		{"force finish on turn cap", DecideInput{TurnCount: 30, MainQuestionCount: 5, ModelAction: "follow_up"}, "finish"},
		{"force finish on time", DecideInput{StartedAt: time.Now().Add(-61 * time.Minute), Now: time.Now(), MainQuestionCount: 5, ModelAction: "follow_up"}, "finish"},
		{"honor model follow_up", DecideInput{FollowUpsOnCurrent: 0, MainQuestionCount: 5, ModelAction: "follow_up", ModelFollowUpText: "why?"}, "follow_up"},
		{"llm fail with remaining questions", DecideInput{CurrentQuestionIndex: 1, MainQuestionCount: 5, ModelAction: ""}, "next_question"},
		{"llm fail on last", DecideInput{CurrentQuestionIndex: 4, MainQuestionCount: 5, ModelAction: ""}, "finish"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := ApplyDecideRules(c.in)
			if got.Action != c.want {
				t.Fatalf("ApplyDecideRules() = %q, want %q", got.Action, c.want)
			}
		})
	}
}

func TestApplyDecideRulesPerPersonaFollowUpCap(t *testing.T) {
	cases := []struct {
		name       string
		max        int
		followUps  int
		wantAction DecideAction
	}{
		{"cap 1 forces next after first follow-up", 1, 1, "next_question"},
		{"cap 1 allows zero follow-ups", 1, 0, "follow_up"},
		{"cap 4 forces next after fourth follow-up", 4, 4, "next_question"},
		{"cap 4 allows three follow-ups", 4, 3, "follow_up"},
		{"cap 0 falls back to legacy 2", 0, 2, "next_question"},
		{"cap 0 allows one follow-up", 0, 1, "follow_up"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := ApplyDecideRules(DecideInput{
				MainQuestionCount:    5,
				CurrentQuestionIndex: 0,
				FollowUpsOnCurrent:   c.followUps,
				MaxFollowUps:         c.max,
				ModelAction:          "follow_up",
				ModelFollowUpText:    "why?",
			})
			if got.Action != c.wantAction {
				t.Fatalf("ApplyDecideRules() = %q, want %q", got.Action, c.wantAction)
			}
		})
	}
}
