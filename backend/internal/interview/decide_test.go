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
		{"force finish on time", DecideInput{StartedAt: time.Now().Add(-46 * time.Minute), Now: time.Now(), MainQuestionCount: 5, ModelAction: "follow_up"}, "finish"},
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
