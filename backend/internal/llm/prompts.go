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
- Match the interview mode: behavioral (soft skills, past experience), technical (skills, problem-solving), or mixed
- All question and intent text must be written in Chinese (Simplified). Do not use any other language.`
}

type JobTitleOut struct {
	Title string `json:"title"`
}

// JobTitleSystem instructs the model to derive a short job title from a JD
// (and optional resume). The title is stored on the session and shown in the
// report header and interview room top bar.
func JobTitleSystem() string {
	return `You are a hiring analyst. Derive the job title from the job description (and optional resume).

Respond with valid JSON only, no markdown fences or extra text. Use this exact schema:
{"title":"..."}

Rules:
- title must be a concise job title of at most 20 Chinese characters, e.g. "高级产品经理"
- Include the seniority or direction when the JD states it clearly, e.g. "高级产品经理 · 增长方向"
- Never fabricate details that are not in the job description; if the JD is a practice set with no real title, fall back to "未命名岗位"
- title must be written in Chinese (Simplified) unless the job description itself names the title in another language`

}

// JobTitleUser builds the user prompt for job-title derivation.
func JobTitleUser(jobJD, resume string) string {
	if resume == "" {
		return fmt.Sprintf(`Derive the job title from this job description.

Job description:
%s`, jobJD)
	}
	return fmt.Sprintf(`Derive the job title from this job description and resume.

Job description:
%s

Resume:
%s`, jobJD, resume)
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

// Difficulty levels.
const (
	StandardDifficulty = "medium"
	DifficultyEasy     = "easy"
	DifficultyMedium   = "medium"
	DifficultyHard     = "hard"
)

// Difficulties lists all selectable difficulty levels (single source of truth).
var Difficulties = []string{DifficultyEasy, DifficultyMedium, DifficultyHard}

// DifficultyLabels maps difficulty keys to Chinese labels for UI display.
var DifficultyLabels = map[string]string{
	DifficultyEasy:   "容易",
	DifficultyMedium: "中等",
	DifficultyHard:   "困难",
}

// DifficultyPrompts maps difficulty keys to directives injected into
// question-generation and follow-up prompts. medium/unknown has no entry.
var DifficultyPrompts = map[string]string{
	DifficultyEasy: "Keep the interview at a moderate difficulty: favor clear, well-known topics, avoid obscure edge cases, and keep a comfortable pace.",
	DifficultyHard: "Make the interview demanding: ask challenging, detail-oriented questions, include edge cases and deeper reasoning, and probe for depth.",
}

// StandardCompanyStyle is the default company style; it never alters prompts.
const StandardCompanyStyle = "general"

// CompanyStyles lists all selectable company styles (single source of truth).
var CompanyStyles = []string{StandardCompanyStyle, "foreign", "bigtech", "stateowned", "startup"}

// CompanyStyleLabels maps company style keys to Chinese labels for UI display.
var CompanyStyleLabels = map[string]string{
	StandardCompanyStyle: "通用",
	"foreign":            "外企",
	"bigtech":            "大厂",
	"stateowned":         "国企",
	"startup":            "创业公司",
}

// CompanyStylePrompts maps company style keys to context injected into
// question-generation and follow-up prompts. general has no entry.
var CompanyStylePrompts = map[string]string{
	"foreign":    "Adopt a foreign-company interview style: emphasize English proficiency when relevant, STAR-structured behavioral questions, and cross-cultural communication.",
	"bigtech":    "Adopt a big-tech interview style: emphasize algorithms, system design, and fundamentals, with a fast-paced technical bar.",
	"stateowned": "Adopt a state-owned enterprise interview style: emphasize structured, well-rounded questions, institutional awareness, stability, and soft qualities.",
	"startup":    "Adopt a startup interview style: emphasize full-stack breadth, ownership, resilience, and practical problem-solving under constraints.",
}

// MaxFollowUpsByPersona caps follow-up turns per main question per persona.
// standard/unknown fall back to 2 (legacy behavior).
var MaxFollowUpsByPersona = map[string]int{
	StandardPersona: 2,
	"strict_tech":   4,
	"warm_hr":       1,
	"stress":        4,
}

// FollowUpLimit returns the follow-up cap for a persona; unknown → 2.
func FollowUpLimit(persona string) int {
	if n, ok := MaxFollowUpsByPersona[persona]; ok {
		return n
	}
	return 2
}

// personaInjection returns the persona instruction block, or "" when the
// persona is standard/empty/unknown so prompts stay byte-identical to legacy.
func personaInjection(persona string) string {
	if persona == "" || persona == StandardPersona {
		return ""
	}
	return PersonaPrompts[persona]
}

// difficultyInjection returns the difficulty instruction block, or "" when the
// difficulty is medium/empty/unknown so prompts stay byte-identical to legacy.
func difficultyInjection(difficulty string) string {
	if difficulty == "" || difficulty == StandardDifficulty {
		return ""
	}
	return DifficultyPrompts[difficulty]
}

// companyStyleInjection returns the company style context block, or "" when the
// style is general/empty/unknown so prompts stay byte-identical to legacy.
func companyStyleInjection(style string) string {
	if style == "" || style == StandardCompanyStyle {
		return ""
	}
	return CompanyStylePrompts[style]
}

func GenerateQuestionsUser(jobJD, resume, mode string, weak []string, persona, difficulty, style string, precheckGaps []string) string {
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
	if inj := difficultyInjection(difficulty); inj != "" {
		base += "\n\n" + inj
	}
	if inj := companyStyleInjection(style); inj != "" {
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
- Keep follow-ups concise and interview-appropriate
- follow_up_text must be written in Chinese (Simplified). Do not use any other language.`
}

func DecideNextUser(jobJD, mode, currentQuestion string, followUpsOnCurrent int, turns []TurnContext, latestAnswer, persona, difficulty, style string) string {
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
	if inj := difficultyInjection(difficulty); inj != "" {
		prompt += "\n\n" + inj
	}
	if inj := companyStyleInjection(style); inj != "" {
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
	Summary      string   `json:"summary,omitempty"`
	ModelVersion string   `json:"model_version,omitempty"`
}

func EvaluateSessionSystem() string {
	return `You are an expert interview coach. Evaluate the candidate's performance in a completed interview session.

Respond with valid JSON only, no markdown fences or extra text. Use this exact schema:
{"total_score":0,"dimensions":{"expression":0,"logic":0,"content":0,"job_match":0},"strengths":["..."],"weaknesses":["..."],"suggestions":["..."],"summary":"...","model_version":"..."}

Rules:
- total_score and each dimension score must be integers from 0 to 100
- strengths, weaknesses, and suggestions must be non-empty arrays of specific, actionable strings
- summary must be a single concise sentence (under 60 characters) summarizing the overall performance, e.g. "表达清晰，实验思维较强；需补足结论边界与风险识别。"
- Avoid vague praise like "good communication" without evidence; cite what the candidate did well or poorly
- suggestions must be concrete actions the candidate can take to improve
- model_version may be omitted
- If the candidate gave no answers, or only very brief or perfunctory answers (e.g. "I don't know", "嗯", empty), then total_score and every dimension score must be at most 30, and weaknesses/suggestions must reflect the lack of substantive answers
- NEVER invent or fabricate candidate answers, behaviors, or experiences that do not appear in the transcript. Base every score strictly on the transcript content. If the transcript contains no candidate answer for a question, do not credit the candidate for it
- All strengths, weaknesses, suggestions, and summary text must be written in Chinese (Simplified). Do not use any other language.`
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
- suggestions must be a non-empty array of actionable preparation advice
- All gaps and suggestions text must be written in Chinese (Simplified). Do not use any other language.`
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

type ClassifyOut struct {
	Classifications []struct {
		Question  string `json:"question"`
		Dimension string `json:"dimension"`
	} `json:"classifications"`
}

// ClassifyDimensionsSystem instructs the model to tag each question with one
// of the four interview assessment dimensions.
func ClassifyDimensionsSystem() string {
	return `You are an interview coach. Tag each question with the interview dimension it assesses.

Respond with valid JSON only, no markdown fences or extra text. Use this exact schema:
{"classifications":[{"question":"...","dimension":"..."}]}

Rules:
- The question field must echo the original question text exactly, verbatim
- dimension must be one of: expression, logic, content, job_match
- expression: communication, delivery, wording; logic: structure, reasoning; content: depth, substance, knowledge; job_match: fit with the role's requirements
- If a question fits no dimension clearly, pick the closest one`
}

// ClassifyDimensionsUser builds the user prompt with the questions to classify.
func ClassifyDimensionsUser(questions []string) string {
	var sb strings.Builder
	for _, q := range questions {
		fmt.Fprintf(&sb, "- %s\n", q)
	}
	return fmt.Sprintf("Classify each of these interview questions into one dimension.\n\nQuestions:\n%s", sb.String())
}

type ParseImportOut struct {
	Items []struct {
		Question string `json:"question"`
		Answer   string `json:"answer,omitempty"`
	} `json:"items"`
}

// ParseImportSystem instructs the model to extract interview questions from a
// real interview transcript (面经). It only extracts; dimension classification
// is a separate later step.
func ParseImportSystem() string {
	return `You are an interview coach. Extract the interview questions from the provided real interview transcript (面经).

Respond with valid JSON only, no markdown fences or extra text. Use this exact schema:
{"items":[{"question":"...","answer":"..."}]}

Rules:
- Extract each interview question asked to the candidate, including follow-ups
- question must be the complete, self-contained question text, verbatim from the source
- answer is optional; include the candidate's answer to that question when present, otherwise omit it
- Skip narrative noise, headings, timestamps, and non-question content
- Do not invent questions that are not in the source
- All question and answer text must be written in Chinese (Simplified) unless the source itself is in another language`
}

// ParseImportUser builds the user prompt with the source text to parse.
func ParseImportUser(text string) string {
	return fmt.Sprintf("Extract the interview questions from this real interview transcript (面经).\n\nSource:\n%s", text)
}

type OpeningOut struct {
	Opening string `json:"opening"`
}

// GenerateOpeningSystem instructs the model to write the customized opening
// speech that greets the candidate, binds to the target role and resume, and
// invites a ~2-minute self-introduction.
func GenerateOpeningSystem() string {
	return `You are a friendly professional interviewer starting a mock interview. Write the interviewer's opening speech.

Respond with valid JSON only, no markdown fences or extra text. Use this exact schema:
{"opening":"..."}

Rules:
- Must include: a greeting; a brief reference to the target role (position/direction from the job description); a brief reference to one highlight from the resume if one is provided; then a natural transition inviting the candidate to give a self-introduction of about 2 minutes covering education, work experience, and the most impressive project
- Keep it concise and spoken in a natural, warm but professional tone (roughly 100 to 180 Chinese characters)
- Do NOT ask any actual interview questions in the opening; only invite the self-introduction
- The opening must be written in Chinese (Simplified). Do not use any other language`
}

// GenerateOpeningUser builds the user prompt for the opening speech.
func GenerateOpeningUser(jobJD, resume string) string {
	if strings.TrimSpace(resume) == "" {
		return fmt.Sprintf(`Write the opening speech for this interview session.

Job description:
%s

No resume was provided; omit any resume highlight reference.`, jobJD)
	}
	return fmt.Sprintf(`Write the opening speech for this interview session.

Job description:
%s

Resume:
%s`, jobJD, resume)
}

// DefaultOpening is the fixed fallback opening used when LLM generation fails
// (e.g. no API key, transient error). It never blocks session creation.
const DefaultOpening = "你好，欢迎参加本次模拟面试。请先做一个简单的自我介绍，时间大约两分钟，可以从教育背景、工作经历，以及你最想分享的一个项目亮点说起。"

// DefaultClosing is the fixed short closing speech broadcast when an interview
// completes naturally (all planned questions answered).
const DefaultClosing = "今天的面试到这里就结束了，感谢你的参与和配合。面试报告稍后生成，请留意查看。"

type ResumeCompletionOut struct {
	Questions []struct {
		Question string `json:"question"`
	} `json:"questions"`
}

// GenerateResumeCompletionSystem instructs the model to generate a small number
// of resume-completion questions that probe resume content NOT covered by the
// selected bank questions.
func GenerateResumeCompletionSystem() string {
	return `You are an expert interviewer. Generate a few extra questions to complete a question set for a mock interview, focusing on the candidate's resume.

Respond with valid JSON only, no markdown fences or extra text. Use this exact schema:
{"questions":[{"question":"..."}]}

Rules:
- Generate 2 to 3 questions (prefer 2-3, at least 1, at most 3)
- Focus on projects, experiences, or highlights in the resume that are NOT already covered by the selected bank questions — especially other projects or experiences the bank questions do not touch
- Each question must be concrete and grounded in the resume content; do not invent experiences that are not in the resume
- Avoid duplicating or overlapping the selected bank questions
- All question text must be written in Chinese (Simplified). Do not use any other language`
}

// GenerateResumeCompletionUser builds the user prompt for resume-completion
// question generation.
func GenerateResumeCompletionUser(jobJD, resume string, selectedBankQuestions []string) string {
	var bank strings.Builder
	for i, q := range selectedBankQuestions {
		fmt.Fprintf(&bank, "%d. %s\n", i+1, q)
	}
	return fmt.Sprintf(`Generate resume-completion interview questions for this session.

Job description:
%s

Resume:
%s

Already selected bank questions (do not duplicate or overlap these):
%s`, jobJD, resume, bank.String())
}
