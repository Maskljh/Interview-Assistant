package llm

import (
	"fmt"
	"strings"
)

func GenerateQuestionsSystem() string {
	return `You are an expert technical interviewer. Generate interview questions tailored to the job description, optional resume, and interview mode.

Respond with valid JSON only, no markdown fences or extra text. Use this exact schema:
{"questions":[{"seq":1,"question":"...","intent":"..."}]}

Rules:
- Produce exactly 5 to 8 questions
- seq must be 1-based and consecutive
- question should be clear and answerable in a live interview
- intent briefly describes what the question assesses (skills, behavior, etc.)
- Match the interview mode: behavioral (soft skills, past experience), technical (skills, problem-solving), or mixed`
}

func GenerateQuestionsUser(jobJD, resume, mode string) string {
	return fmt.Sprintf(`Generate interview questions for this session.

Job description:
%s

Resume:
%s

Interview mode: %s`, jobJD, resume, mode)
}

type DecideNextOut struct {
	Action        string `json:"action"`
	FollowUpText  string `json:"follow_up_text,omitempty"`
}

func DecideNextSystem() string {
	return `You are an expert interviewer conducting a live interview. After each candidate answer, decide the next step.

Respond with valid JSON only, no markdown fences or extra text. Use this exact schema:
{"action":"follow_up"|"next_question"|"finish","follow_up_text":"..."}

Rules:
- action "follow_up": ask a focused clarifying follow-up; follow_up_text is required
- action "next_question": move on when the current topic is sufficiently explored
- action "finish": end when all main questions are adequately covered
- Keep follow-ups concise and interview-appropriate`
}

func DecideNextUser(jobJD, mode, currentQuestion string, followUpsOnCurrent int, turns []TurnContext, latestAnswer string) string {
	var transcript strings.Builder
	for _, t := range turns {
		fmt.Fprintf(&transcript, "[%s/%s] %s\n", t.Role, t.Kind, t.Content)
	}
	return fmt.Sprintf(`Decide the next interview step.

Job description:
%s

Interview mode: %s

Current main question:
%s

Follow-ups already asked on this question: %d

Transcript so far:
%s

Latest candidate answer:
%s`, jobJD, mode, currentQuestion, followUpsOnCurrent, transcript.String(), latestAnswer)
}

type TurnContext struct {
	Role    string
	Kind    string
	Content string
}
