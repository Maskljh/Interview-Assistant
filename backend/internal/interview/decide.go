package interview

import "time"

type DecideAction string // follow_up | next_question | finish

type DecideInput struct {
	MainQuestionCount    int
	CurrentQuestionIndex int // 0-based
	FollowUpsOnCurrent   int
	MaxFollowUps         int // per-persona follow-up cap; <=0 falls back to legacy default
	TurnCount            int
	StartedAt            time.Time
	Now                  time.Time
	ModelAction          DecideAction // from LLM; empty if LLM failed
	ModelFollowUpText    string
}

type DecideResult struct {
	Action       DecideAction
	FollowUpText string
	Reason       string
}

func ApplyDecideRules(in DecideInput) DecideResult {
	isLastQuestion := in.MainQuestionCount > 0 && in.CurrentQuestionIndex >= in.MainQuestionCount-1

	if in.TurnCount >= MaxTurnsApprox {
		return DecideResult{Action: "finish", Reason: "turn cap reached"}
	}
	if !in.StartedAt.IsZero() && !in.Now.Before(in.StartedAt.Add(MaxDuration)) {
		return DecideResult{Action: "finish", Reason: "time cap reached"}
	}
	followUpCap := in.MaxFollowUps
	if followUpCap <= 0 {
		followUpCap = MaxFollowUpsPerQuestion // legacy default
	}
	if in.FollowUpsOnCurrent >= followUpCap {
		return DecideResult{Action: "next_question", Reason: "follow-up cap reached"}
	}
	if isLastQuestion && in.ModelAction == "next_question" {
		return DecideResult{Action: "finish", Reason: "last question complete"}
	}
	if in.ModelAction == "" {
		if isLastQuestion {
			return DecideResult{Action: "finish", Reason: "llm fallback on last question"}
		}
		return DecideResult{Action: "next_question", Reason: "llm fallback"}
	}
	return DecideResult{
		Action:       in.ModelAction,
		FollowUpText: in.ModelFollowUpText,
		Reason:       "model decision",
	}
}
