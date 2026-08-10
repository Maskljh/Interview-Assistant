package llm

import "fmt"

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
