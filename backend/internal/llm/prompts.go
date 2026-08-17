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

// DimensionLabels maps dimension keys to Chinese labels for prompt text.
var DimensionLabels = map[string]string{
	"expression": "表达能力",
	"logic":      "逻辑结构",
	"content":    "内容质量",
	"job_match":  "岗位匹配",
}

// StandardPersona is the default persona; it never alters prompts.
const StandardPersona = "standard"

// Personas lists all selectable interviewer personas (single source of truth).
var Personas = []string{StandardPersona, "strict_tech", "warm_hr", "stress"}

// PersonaLabels maps persona keys to Chinese labels for UI display.
var PersonaLabels = map[string]string{
	StandardPersona: "标准",
	"strict_tech":   "严厉技术面",
	"warm_hr":       "温和 HR 面",
	"stress":        "压力面",
}

// PersonaPrompts maps persona keys to interviewer-style instructions injected
// into question-generation and follow-up prompts. standard has no entry.
var PersonaPrompts = map[string]string{
	"strict_tech": "You are a strict senior technical interviewer. Ask probing follow-ups, dig into details, challenge assumptions, and keep questions demanding.",
	"warm_hr":     "You are a warm and supportive HR interviewer. Use a guiding tone, ask follow-ups that help candidates elaborate, focus on soft skills and past experience, and encourage them.",
	"stress":      "You are a fast-paced stress interviewer. Ask rapid successive follow-ups, apply pressure, and keep the pace quick to test composure under stress.",
}

// personaInjection returns the persona instruction block, or "" when the
// persona is standard/empty/unknown so prompts stay byte-identical to legacy.
func personaInjection(persona string) string {
	if persona == "" || persona == StandardPersona {
		return ""
	}
	return PersonaPrompts[persona]
}

func GenerateQuestionsUser(jobJD, resume, mode string, weak []string, persona string, precheckGaps []string) string {
	base := fmt.Sprintf(`Generate interview questions for this session.

Job description:
%s

Resume:
%s

Interview mode: %s`, jobJD, resume, mode)

	if len(weak) > 0 {
		labels := make([]string, 0, len(weak))
		for _, w := range weak {
			if label, ok := DimensionLabels[w]; ok {
				labels = append(labels, label)
			}
		}
		if len(labels) > 0 {
			base += fmt.Sprintf(`
	
Targeted focus: this user's weak dimensions are %s. Generate at least half of the questions to assess these weak dimensions.`, strings.Join(labels, ", "))
		}
	}

	if inj := personaInjection(persona); inj != "" {
		base += "\n\n" + inj
	}

	if inj := precheckInjection(precheckGaps); inj != "" {
		base += "\n\n" + inj
	}
	return base
}

// precheckInjection returns the pre-check gap directive, or "" when gaps are
// empty so prompts stay byte-identical to legacy.
func precheckInjection(gaps []string) string {
	if len(gaps) == 0 {
		return ""
	}
	return fmt.Sprintf("Targeted focus (pre-check): the candidate's JD-match gaps are %s. Include questions that probe these gaps.", strings.Join(gaps, ", "))
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

func DecideNextUser(jobJD, mode, currentQuestion string, followUpsOnCurrent int, turns []TurnContext, latestAnswer string, persona string) string {
	var transcript strings.Builder
	for _, t := range turns {
		fmt.Fprintf(&transcript, "[%s/%s] %s\n", t.Role, t.Kind, t.Content)
	}
	prompt := fmt.Sprintf(`Decide the next interview step.

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

	if inj := personaInjection(persona); inj != "" {
		prompt += "\n\n" + inj
	}
	return prompt
}

type TurnContext struct {
	Role    string
	Kind    string
	Content string
}

type QuestionContext struct {
	Seq      int
	Question string
	Intent   string
}

type EvaluateOut struct {
	TotalScore   int `json:"total_score"`
	Dimensions   struct {
		Expression int `json:"expression"`
		Logic      int `json:"logic"`
		Content    int `json:"content"`
		JobMatch   int `json:"job_match"`
	} `json:"dimensions"`
	Strengths    []string `json:"strengths"`
	Weaknesses   []string `json:"weaknesses"`
	Suggestions  []string `json:"suggestions"`
	ModelVersion string   `json:"model_version,omitempty"`
}

func EvaluateSessionSystem() string {
	return `You are an expert interview coach. Evaluate the candidate's performance in a completed interview session.

Respond with valid JSON only, no markdown fences or extra text. Use this exact schema:
{"total_score":0,"dimensions":{"expression":0,"logic":0,"content":0,"job_match":0},"strengths":["..."],"weaknesses":["..."],"suggestions":["..."],"model_version":"..."}

Rules:
- total_score and each dimension score must be integers from 0 to 100
- strengths, weaknesses, and suggestions must be non-empty arrays of specific, actionable strings
- Avoid vague praise like "good communication" without evidence; cite what the candidate did well or poorly
- suggestions must be concrete actions the candidate can take to improve
- model_version may be omitted`
}

func EvaluateSessionUser(jobJD, resume, mode string, questions []QuestionContext, turns []TurnContext) string {
	var qLines strings.Builder
	for _, q := range questions {
		if q.Intent != "" {
			fmt.Fprintf(&qLines, "%d. %s (intent: %s)\n", q.Seq, q.Question, q.Intent)
		} else {
			fmt.Fprintf(&qLines, "%d. %s\n", q.Seq, q.Question)
		}
	}
	var transcript strings.Builder
	for _, t := range turns {
		fmt.Fprintf(&transcript, "[%s/%s] %s\n", t.Role, t.Kind, t.Content)
	}
	return fmt.Sprintf(`Evaluate this completed interview session.

Job description:
%s

Resume:
%s

Interview mode: %s

Planned questions:
%s

Full transcript:
%s`, jobJD, resume, mode, qLines.String(), transcript.String())
}

// PreCheckSystem instructs the model to score resume-vs-JD match and list gaps.
func PreCheckSystem() string {
	return `You are a hiring analyst. Score how well the candidate's resume matches the job description and list the concrete gaps.

Respond with valid JSON only, no markdown fences or extra text. Use this exact schema:
{"match_score":0,"gaps":["..."],"suggestions":["..."]}

Rules:
- match_score must be an integer from 0 to 100
- gaps must be a non-empty array of specific, concrete gaps between the resume and the job description (missing skills, insufficient experience, etc.)
- suggestions must be a non-empty array of actionable preparation advice`
}

// PreCheckUser builds the user prompt for a match precheck. An empty resume
// produces JD-focused gaps and practice advice instead.
func PreCheckUser(jobJD, resume string) string {
	if resume == "" {
		return fmt.Sprintf(`Assess this job description.

Job description:
%s

No resume was provided. Output the core competency points of this role as gaps, practice advice as suggestions, and a match_score reflecting the baseline difficulty of this role.`, jobJD)
	}
	return fmt.Sprintf(`Assess the match between the resume and the job description.

Job description:
%s

Resume:
%s`, jobJD, resume)
}
