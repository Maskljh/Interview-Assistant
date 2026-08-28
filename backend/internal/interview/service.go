package interview

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"math/rand"
	"strings"
	"time"

	"github.com/interview-assistant/backend/internal/llm"
	"github.com/interview-assistant/backend/internal/profile"
	"github.com/interview-assistant/backend/internal/sessionredis"
)

var (
	ErrNotFound     = errors.New("session not found")
	ErrLLMFailure   = errors.New("llm failure")
	ErrInvalidState = errors.New("invalid session state")
)

const liveStateTTL = 48 * time.Hour

type Progress struct {
	Current int
	Total   int
}

type OutboundMessage struct {
	Type     string
	Content  string
	Progress *Progress
}

type SessionNotifier interface {
	BroadcastDone(sessionID int64)
	BroadcastClosing(sessionID int64, closing string)
}

type SessionEvaluator interface {
	Evaluate(ctx context.Context, sessionID int64) (score int, feedbackJSON []byte, err error)
}

// SessionProfileProvider supplies a user's weak dimensions for targeted
// question generation. Implemented by *profile.Service.
type SessionProfileProvider interface {
	Weaknesses(ctx context.Context, userID int64, maxSessions int) (profile.Profile, error)
}

type Service struct {
	repo            *Repo
	llm             llm.Client
	store           sessionredis.Store
	notify          SessionNotifier
	evaluator       SessionEvaluator
	profileProvider SessionProfileProvider
}

func NewService(db *sql.DB, llmClient llm.Client, store sessionredis.Store) *Service {
	return &Service{repo: NewRepo(db), llm: llmClient, store: store}
}

func (s *Service) SetSessionNotifier(n SessionNotifier) {
	s.notify = n
}

func (s *Service) SetEvaluator(e SessionEvaluator) {
	s.evaluator = e
}

func (s *Service) SetProfileProvider(p SessionProfileProvider) {
	s.profileProvider = p
}

func (s *Service) Create(ctx context.Context, userID int64, jobJD string, resume *string, resumeFileURL, jdFileURL *string, mode Mode, inputMode InputMode, persona, difficulty, style string, precheckGaps []string, cameraEnabled bool) (*Session, error) {
	jobJD = strings.TrimSpace(jobJD)
	if jobJD == "" {
		return nil, ErrInvalidInput
	}
	if err := ValidateMode(mode); err != nil {
		return nil, err
	}
	if inputMode == "" {
		inputMode = InputModeVoice
	} else if err := ValidateInputMode(inputMode); err != nil {
		return nil, err
	}
	// Voice-only interviews: any client-supplied mode (e.g. 'text') is coerced to voice.
	inputMode = InputModeVoice
	if persona == "" {
		persona = llm.StandardPersona
	}
	if err := validatePersona(persona); err != nil {
		return nil, err
	}
	if difficulty == "" {
		difficulty = llm.StandardDifficulty
	}
	if err := validateDifficulty(difficulty); err != nil {
		return nil, err
	}
	if style == "" {
		style = llm.StandardCompanyStyle
	}
	if err := validateCompanyStyle(style); err != nil {
		return nil, err
	}

	// Derive a short job title from the JD (and resume) for the report header
	// and interview room top bar. Best-effort: a failed LLM call leaves the
	// title NULL and the UI falls back to the JD.
	title := s.deriveJobTitle(ctx, jobJD, resume)

	session, err := s.repo.Create(userID, jobJD, title, resume, resumeFileURL, jdFileURL, mode, inputMode, persona, difficulty, style, precheckGaps, cameraEnabled)
	if err != nil {
		return nil, err
	}
	return session, nil
}

// deriveJobTitle asks the LLM for a concise job title. On any failure it
// returns "" so creation never blocks on the title.
func (s *Service) deriveJobTitle(ctx context.Context, jobJD string, resume *string) string {
	if s.llm == nil {
		return ""
	}
	resumeText := ""
	if resume != nil {
		resumeText = *resume
	}
	var out llm.JobTitleOut
	if err := s.llm.ChatJSON(ctx, llm.JobTitleSystem(), llm.JobTitleUser(jobJD, resumeText), &out); err != nil {
		return ""
	}
	return strings.TrimSpace(out.Title)
}

func (s *Service) CreateFromBank(ctx context.Context, userID int64, questionIDs []int64, jobJD string, resume *string, resumeFileURL, jdFileURL *string, mode Mode, inputMode InputMode, persona, difficulty, style string, precheckGaps []string, cameraEnabled bool) (*Session, []Question, error) {
	if len(questionIDs) == 0 {
		return nil, nil, ErrInvalidInput
	}
	if err := ValidateMode(mode); err != nil {
		return nil, nil, err
	}
	if inputMode == "" {
		inputMode = InputModeVoice
	} else if err := ValidateInputMode(inputMode); err != nil {
		return nil, nil, err
	}
	// Voice-only interviews: force voice (see Create).
	inputMode = InputModeVoice
	if persona == "" {
		persona = llm.StandardPersona
	}
	if err := validatePersona(persona); err != nil {
		return nil, nil, err
	}
	if difficulty == "" {
		difficulty = llm.StandardDifficulty
	}
	if err := validateDifficulty(difficulty); err != nil {
		return nil, nil, err
	}
	if style == "" {
		style = llm.StandardCompanyStyle
	}
	if err := validateCompanyStyle(style); err != nil {
		return nil, nil, err
	}

	texts := make([]string, 0, len(questionIDs))
	for _, id := range questionIDs {
		text, err := s.repo.GetBankQuestionText(userID, id)
		if err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return nil, nil, ErrNotFound
			}
			return nil, nil, err
		}
		texts = append(texts, text)
	}

	// 用户未填岗位信息时保留题库练习占位；已填 JD/简历则一并参与定制。
	jobJD = strings.TrimSpace(jobJD)
	isPlainPractice := jobJD == ""
	if isPlainPractice {
		jobJD = fmt.Sprintf("题库练习（%d题）", len(texts))
	}
	// 仅对真实 JD 派生标题，避免对占位文本浪费 LLM 调用。
	var title string
	if !isPlainPractice {
		title = s.deriveJobTitle(ctx, jobJD, resume)
	}

	// 完整面试编排：seq 1 为定制开场+自我介绍；题库题打乱后与 2~3 道简历补全
	// 生成题均匀穿插；开场与补全题均为 best-effort，失败不阻塞建会话。
	opening := llm.DefaultOpening
	if !isPlainPractice {
		opening = s.buildOpening(ctx, jobJD, resume)
	}
	generated := s.buildResumeCompletionQuestions(ctx, jobJD, resume, texts)
	items := buildQuestionItems(opening, texts, generated, rand.New(rand.NewSource(time.Now().UnixNano())))

	session, questions, err := s.repo.CreateReadyWithQuestions(userID, jobJD, title, resume, resumeFileURL, jdFileURL, mode, inputMode, persona, difficulty, style, precheckGaps, items, cameraEnabled)
	if err != nil {
		return nil, nil, err
	}
	// Record which bank questions were used so the question bank can show real
	// usage counts. Best-effort: never blocks session creation.
	s.repo.RecordQuestionUsage(userID, questionIDs, session.ID)
	return session, questions, nil
}

// buildOpening generates the customized opening speech (greeting + role binding
// + resume highlight + self-introduction invitation of ~2 minutes). Any failure
// falls back to a fixed generic opening; it never blocks session creation.
func (s *Service) buildOpening(ctx context.Context, jobJD string, resume *string) string {
	if s.llm == nil {
		return llm.DefaultOpening
	}
	resumeText := ""
	if resume != nil {
		resumeText = *resume
	}
	var out llm.OpeningOut
	if err := s.llm.ChatJSON(ctx, llm.GenerateOpeningSystem(), llm.GenerateOpeningUser(jobJD, resumeText), &out); err != nil {
		return llm.DefaultOpening
	}
	if strings.TrimSpace(out.Opening) == "" {
		return llm.DefaultOpening
	}
	return strings.TrimSpace(out.Opening)
}

// buildResumeCompletionQuestions generates 2~3 resume-completion questions that
// probe resume content NOT covered by the selected bank questions. Any failure
// returns nil (0 generated questions) and never blocks session creation.
func (s *Service) buildResumeCompletionQuestions(ctx context.Context, jobJD string, resume *string, bankTexts []string) []string {
	if s.llm == nil {
		return nil
	}
	resumeText := ""
	if resume != nil {
		resumeText = *resume
	}
	if strings.TrimSpace(resumeText) == "" {
		return nil
	}
	var out llm.ResumeCompletionOut
	if err := s.llm.ChatJSON(ctx, llm.GenerateResumeCompletionSystem(), llm.GenerateResumeCompletionUser(jobJD, resumeText, bankTexts), &out); err != nil {
		return nil
	}
	var qs []string
	for _, q := range out.Questions {
		if t := strings.TrimSpace(q.Question); t != "" {
			qs = append(qs, t)
		}
	}
	return qs
}

// buildQuestionItems assembles the full question sequence for a from-bank
// session: seq 1 is the self-introduction opening, followed by the shuffled bank
// questions interleaved with the resume-completion questions spread evenly.
func buildQuestionItems(opening string, bankTexts, generatedTexts []string, rnd *rand.Rand) []QuestionInput {
	// Fisher-Yates shuffle of the bank questions (rand nil = keep order, for tests).
	shuffled := make([]string, len(bankTexts))
	copy(shuffled, bankTexts)
	if rnd != nil {
		rnd.Shuffle(len(shuffled), func(i, j int) { shuffled[i], shuffled[j] = shuffled[j], shuffled[i] })
	}

	items := make([]QuestionInput, 0, 1+len(shuffled)+len(generatedTexts))
	seq := 1
	items = append(items, QuestionInput{Seq: seq, Question: opening, Kind: QuestionKindSelfIntro})
	seq++

	if len(generatedTexts) == 0 {
		for _, q := range shuffled {
			items = append(items, QuestionInput{Seq: seq, Question: q, Kind: QuestionKindBank})
			seq++
		}
		return items
	}

	// Spread generated questions evenly among the shuffled bank questions:
	// the k-th generated question is inserted right after ceil((k+1)*len(bank)/(gen+1))-th bank question.
	step := float64(len(shuffled)) / float64(len(generatedTexts)+1)
	genIdx := 0
	for i, q := range shuffled {
		items = append(items, QuestionInput{Seq: seq, Question: q, Kind: QuestionKindBank})
		seq++
		for genIdx < len(generatedTexts) && float64(i+1) >= float64(genIdx+1)*step {
			items = append(items, QuestionInput{Seq: seq, Question: generatedTexts[genIdx], Kind: QuestionKindGenerated})
			seq++
			genIdx++
		}
	}
	return items
}

func (s *Service) List(ctx context.Context, userID int64) ([]Session, error) {
	sessions, err := s.repo.ListByUser(userID)
	if sessions == nil {
		sessions = []Session{}
	}
	return sessions, err
}

func (s *Service) Get(ctx context.Context, userID, id int64) (*Session, []Question, []Turn, error) {
	session, err := s.repo.GetByID(id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil, nil, ErrNotFound
		}
		return nil, nil, nil, err
	}
	if session.UserID != userID {
		return nil, nil, nil, ErrNotFound
	}
	questions, err := s.repo.ListQuestions(id)
	if err != nil {
		return nil, nil, nil, err
	}
	if questions == nil {
		questions = []Question{}
	}
	turns, err := s.repo.ListTurns(id)
	if err != nil {
		return nil, nil, nil, err
	}
	if turns == nil {
		turns = []Turn{}
	}
	return session, questions, turns, nil
}

func (s *Service) Start(ctx context.Context, userID, sessionID int64) (*Session, []Question, error) {
	session, err := s.repo.GetByID(sessionID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil, ErrNotFound
		}
		return nil, nil, err
	}
	if session.UserID != userID {
		return nil, nil, ErrNotFound
	}
	if session.Status != StatusDraft && session.Status != StatusFailed {
		return nil, nil, ErrInvalidState
	}
	if s.llm == nil {
		return nil, nil, ErrLLMFailure
	}

	resume := "none"
	if session.ResumeText != nil && strings.TrimSpace(*session.ResumeText) != "" {
		resume = *session.ResumeText
	}

	var weak []string
	if s.profileProvider != nil {
		if p, err := s.profileProvider.Weaknesses(ctx, session.UserID, 5); err == nil {
			weak = p.WeakDimensions
		} // on error, fall back to no injection (never block generation)
	}

	var out llm.GenQuestionsOut
	if err := s.llm.ChatJSON(ctx, llm.GenerateQuestionsSystem(), llm.GenerateQuestionsUser(session.JobJD, resume, string(session.Mode), weak, session.Persona, session.Difficulty, session.CompanyStyle, session.PrecheckGaps), &out); err != nil {
		return nil, nil, ErrLLMFailure
	}
	if len(out.Questions) < 5 || len(out.Questions) > 8 {
		return nil, nil, ErrLLMFailure
	}

	// 完整面试编排：seq 1 为定制开场+自我介绍；其后为 AI 生成的正式题。
	toInsert := make([]QuestionInput, 0, len(out.Questions)+1)
	opening := s.buildOpening(ctx, session.JobJD, session.ResumeText)
	toInsert = append(toInsert, QuestionInput{Seq: 1, Question: opening, Kind: QuestionKindSelfIntro})
	for i, q := range out.Questions {
		toInsert = append(toInsert, QuestionInput{Seq: i + 2, Question: q.Question, Kind: QuestionKindGenerated, Intent: q.Intent})
	}

	questions, err := s.repo.StartSession(sessionID, toInsert)
	if err != nil {
		return nil, nil, err
	}
	session.Status = StatusReady
	return session, questions, nil
}

func (s *Service) BeginLive(ctx context.Context, userID, sessionID int64) ([]OutboundMessage, error) {
	session, questions, err := s.loadOwnedSession(ctx, userID, sessionID)
	if err != nil {
		return nil, err
	}
	total := len(questions)
	if total == 0 {
		return nil, ErrInvalidState
	}

	if session.Status == StatusReady {
		started, err := s.repo.BeginSession(sessionID)
		if err != nil {
			return nil, err
		}
		if started {
			return s.initFirstQuestion(ctx, sessionID, total)
		}
		session, err = s.repo.GetByID(sessionID)
		if err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return nil, ErrNotFound
			}
			return nil, err
		}
		if session.Status != StatusInProgress {
			return nil, ErrInvalidState
		}
	}

	if session.Status == StatusInProgress {
		return s.reconnectLive(ctx, sessionID, total)
	}
	return nil, ErrInvalidState
}

func (s *Service) initFirstQuestion(ctx context.Context, sessionID int64, total int) ([]OutboundMessage, error) {
	q, err := s.repo.GetQuestionByIndex(sessionID, 0)
	if err != nil {
		return nil, err
	}
	if err := s.repo.MarkQuestionAsked(sessionID, q.Seq); err != nil {
		return nil, err
	}
	if _, err := s.repo.AppendTurn(sessionID, "interviewer", "question", q.Question, nil); err != nil {
		return nil, err
	}
	state := &sessionredis.LiveState{
		SessionID:          sessionID,
		QuestionIndex:      0,
		FollowUpsOnCurrent: 0,
		TurnCount:          1,
		PendingKind:        "question",
		PendingText:        q.Question,
	}
	if err := s.store.Save(ctx, state, liveStateTTL); err != nil {
		return nil, err
	}
	progress := &Progress{Current: 1, Total: total}
	return []OutboundMessage{
		{Type: "session_started", Progress: progress},
		{Type: "question", Content: q.Question, Progress: progress},
	}, nil
}

func (s *Service) reconnectLive(ctx context.Context, sessionID int64, total int) ([]OutboundMessage, error) {
	state, err := s.store.Get(ctx, sessionID)
	if err != nil {
		return nil, err
	}
	if state == nil {
		return nil, ErrInvalidState
	}
	progress := &Progress{Current: state.QuestionIndex + 1, Total: total}
	msgType := state.PendingKind
	if msgType == "" {
		msgType = "question"
	}
	return []OutboundMessage{
		{Type: "session_started", Progress: progress},
		{Type: msgType, Content: state.PendingText, Progress: progress},
	}, nil
}

func (s *Service) HandleAnswer(ctx context.Context, userID, sessionID int64, content string, voiceDurationMs *int64) ([]OutboundMessage, error) {
	session, questions, err := s.loadOwnedSession(ctx, userID, sessionID)
	if err != nil {
		return nil, err
	}
	if session.Status != StatusInProgress {
		return nil, ErrInvalidState
	}
	state, err := s.store.Get(ctx, sessionID)
	if err != nil {
		return nil, err
	}
	if state == nil {
		return nil, ErrInvalidState
	}

	total := len(questions)
	progress := &Progress{Current: state.QuestionIndex + 1, Total: total}
	msgs := []OutboundMessage{{Type: "status", Content: "thinking"}}

	if _, err := s.repo.AppendTurn(sessionID, "candidate", "answer", content, voiceDurationMs); err != nil {
		return nil, err
	}
	state.TurnCount++

	decide, err := s.decideNext(ctx, session, questions, state, content)
	if err != nil {
		return nil, err
	}

	switch decide.Action {
	case "follow_up":
		if _, err := s.repo.AppendTurn(sessionID, "interviewer", "follow_up", decide.FollowUpText, nil); err != nil {
			return nil, err
		}
		state.FollowUpsOnCurrent++
		state.TurnCount++
		state.PendingKind = "follow_up"
		state.PendingText = decide.FollowUpText
		if err := s.store.Save(ctx, state, liveStateTTL); err != nil {
			return nil, err
		}
		msgs = append(msgs, OutboundMessage{Type: "follow_up", Content: decide.FollowUpText, Progress: progress})
		return msgs, nil

	case "next_question":
		nextIndex := state.QuestionIndex + 1
		if nextIndex >= total {
			// 自然完成：播报简短结束语后进报告（ForceEnd/跳过仍走 finishSession 直接 done）。
			doneMsgs, err := s.finishSessionWithClosing(ctx, sessionID, state)
			if err != nil {
				return nil, err
			}
			return append(msgs, doneMsgs...), nil
		}
		q, err := s.repo.GetQuestionByIndex(sessionID, nextIndex)
		if err != nil {
			return nil, err
		}
		if err := s.repo.MarkQuestionAsked(sessionID, q.Seq); err != nil {
			return nil, err
		}
		if _, err := s.repo.AppendTurn(sessionID, "interviewer", "question", q.Question, nil); err != nil {
			return nil, err
		}
		state.QuestionIndex = nextIndex
		state.FollowUpsOnCurrent = 0
		state.TurnCount++
		state.PendingKind = "question"
		state.PendingText = q.Question
		if err := s.store.Save(ctx, state, liveStateTTL); err != nil {
			return nil, err
		}
		progress.Current = nextIndex + 1
		msgs = append(msgs, OutboundMessage{Type: "question", Content: q.Question, Progress: progress})
		return msgs, nil

	case "finish":
		// 自然完成：播报简短结束语后进报告。
		doneMsgs, err := s.finishSessionWithClosing(ctx, sessionID, state)
		if err != nil {
			return nil, err
		}
		return append(msgs, doneMsgs...), nil

	default:
		return nil, ErrLLMFailure
	}
}

// SkipQuestion advances the live session to the next question without scoring
// the current one: the skipped turn never gets a candidate answer, so the
// evaluator has nothing to score it against. Skipping the final question ends
// the session.
func (s *Service) SkipQuestion(ctx context.Context, userID, sessionID int64) ([]OutboundMessage, error) {
	session, questions, err := s.loadOwnedSession(ctx, userID, sessionID)
	if err != nil {
		return nil, err
	}
	if session.Status != StatusInProgress {
		return nil, ErrInvalidState
	}
	state, err := s.store.Get(ctx, sessionID)
	if err != nil {
		return nil, err
	}
	if state == nil {
		return nil, ErrInvalidState
	}

	total := len(questions)
	progress := &Progress{Current: state.QuestionIndex + 1, Total: total}
	nextIndex := state.QuestionIndex + 1
	if nextIndex >= total {
		doneMsgs, err := s.finishSession(ctx, sessionID, state)
		if err != nil {
			return nil, err
		}
		return append([]OutboundMessage{{Type: "status", Content: "thinking"}}, doneMsgs...), nil
	}

	q, err := s.repo.GetQuestionByIndex(sessionID, nextIndex)
	if err != nil {
		return nil, err
	}
	if err := s.repo.MarkQuestionAsked(sessionID, q.Seq); err != nil {
		return nil, err
	}
	if _, err := s.repo.AppendTurn(sessionID, "interviewer", "question", q.Question, nil); err != nil {
		return nil, err
	}
	state.QuestionIndex = nextIndex
	state.FollowUpsOnCurrent = 0
	state.TurnCount++
	state.PendingKind = "question"
	state.PendingText = q.Question
	if err := s.store.Save(ctx, state, liveStateTTL); err != nil {
		return nil, err
	}
	progress.Current = nextIndex + 1
	return []OutboundMessage{{Type: "question", Content: q.Question, Progress: progress}}, nil
}

// Delete 删除属于该用户的面试会话及其全部关联数据（题目/对话/行为/题目使用记录）。
// 支持任意状态（含 draft/ready/completed/失败会话），方便用户清理历史记录。
func (s *Service) Delete(ctx context.Context, userID, sessionID int64) error {
	deleted, err := s.repo.DeleteOwned(userID, sessionID)
	if err != nil {
		return err
	}
	if !deleted {
		return ErrNotFound
	}
	// 清理可能残留的实时会话状态（Redis），避免孤儿数据。
	_ = s.store.Delete(ctx, sessionID)
	return nil
}

func (s *Service) ForceEnd(ctx context.Context, userID, sessionID int64) error {
	session, _, err := s.loadOwnedSession(ctx, userID, sessionID)
	if err != nil {
		return err
	}
	if session.Status != StatusInProgress {
		return ErrInvalidState
	}
	state, _ := s.store.Get(ctx, sessionID)
	if state != nil {
		_, err = s.finishSession(ctx, sessionID, state)
		return err
	}
	if err := s.finishAndNotify(ctx, sessionID); err != nil {
		return err
	}
	return nil
}

func (s *Service) Finish(ctx context.Context, sessionID int64) error {
	if err := s.repo.CompleteSession(sessionID); err != nil {
		return err
	}
	_ = s.store.Delete(ctx, sessionID)

	if s.evaluator != nil {
		s.evaluateAsync(sessionID)
	}
	return nil
}

// evaluationTimeout bounds a single background LLM evaluation.
const evaluationTimeout = 2 * time.Minute

// evaluateAsync scores a completed session in the background so ending an
// interview never blocks on the LLM. It is safe to call more than once: the
// first write wins via a conditional update, and already-scored sessions are
// skipped up front.
func (s *Service) evaluateAsync(sessionID int64) {
	has, err := s.repo.HasFeedback(sessionID)
	if err != nil || has {
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), evaluationTimeout)
	defer cancel()

	score, fbJSON, err := s.evaluator.Evaluate(ctx, sessionID)
	if err != nil {
		_ = s.repo.SaveEvaluationFailure(sessionID, err.Error())
		return
	}
	_ = s.repo.SaveEvaluationSuccessIfEmpty(sessionID, score, fbJSON)
}

func (s *Service) finishAndNotify(ctx context.Context, sessionID int64) error {
	if err := s.Finish(ctx, sessionID); err != nil {
		return err
	}
	if s.notify != nil {
		s.notify.BroadcastDone(sessionID)
	}
	return nil
}

func (s *Service) finishSession(ctx context.Context, sessionID int64, state *sessionredis.LiveState) ([]OutboundMessage, error) {
	if err := s.finishAndNotify(ctx, sessionID); err != nil {
		return nil, err
	}
	// When a notifier is wired (production WS), BroadcastDone already reaches all clients.
	if s.notify != nil {
		return nil, nil
	}
	return []OutboundMessage{{Type: "done"}}, nil
}

// finishSessionWithClosing ends a naturally-completed session: it appends a
// short closing speech as the final interviewer turn, completes the session
// (starting background evaluation), and delivers the closing to the client so
// the frontend can play it before navigating to the report. ForceEnd and
// skip-on-last keep using finishSession (straight to done).
func (s *Service) finishSessionWithClosing(ctx context.Context, sessionID int64, state *sessionredis.LiveState) ([]OutboundMessage, error) {
	if _, err := s.repo.AppendTurn(sessionID, "interviewer", "closing", llm.DefaultClosing, nil); err != nil {
		return nil, err
	}
	if err := s.Finish(ctx, sessionID); err != nil {
		return nil, err
	}
	if s.notify != nil {
		s.notify.BroadcastClosing(sessionID, llm.DefaultClosing)
		return nil, nil
	}
	return []OutboundMessage{{Type: "closing", Content: llm.DefaultClosing}}, nil
}

func (s *Service) decideNext(ctx context.Context, session *Session, questions []Question, state *sessionredis.LiveState, answer string) (DecideResult, error) {
	// 自我介绍开场题：不追问、不结束，答完直接进入第一道正式题（不调 LLM）。
	if questions[state.QuestionIndex].Kind == QuestionKindSelfIntro {
		return DecideResult{Action: "next_question", Reason: "self-introduction complete"}, nil
	}

	var modelAction DecideAction
	var modelFollowUp string

	if s.llm != nil {
		currentQ := questions[state.QuestionIndex].Question
		turns, _ := s.repo.ListTurns(session.ID)
		var turnCtx []llm.TurnContext
		for _, t := range turns {
			turnCtx = append(turnCtx, llm.TurnContext{Role: t.Role, Kind: t.Kind, Content: t.Content})
		}
		var out llm.DecideNextOut
		err := s.llm.ChatJSON(ctx,
			llm.DecideNextSystem(),
			llm.DecideNextUser(session.JobJD, string(session.Mode), currentQ, state.FollowUpsOnCurrent, turnCtx, answer, session.Persona, session.Difficulty, session.CompanyStyle),
			&out,
		)
		if err == nil {
			modelAction = DecideAction(out.Action)
			modelFollowUp = out.FollowUpText
		}
	}

	startedAt := time.Now()
	if session.StartedAt != nil {
		startedAt = *session.StartedAt
	}

	result := ApplyDecideRules(DecideInput{
		MainQuestionCount:    len(questions),
		CurrentQuestionIndex: state.QuestionIndex,
		FollowUpsOnCurrent:   state.FollowUpsOnCurrent,
		MaxFollowUps:         llm.FollowUpLimit(session.Persona),
		TurnCount:            state.TurnCount,
		StartedAt:            startedAt,
		Now:                  time.Now(),
		ModelAction:          modelAction,
		ModelFollowUpText:    modelFollowUp,
	})
	if result.Action == "follow_up" && result.FollowUpText == "" {
		result.FollowUpText = "Could you tell me more about that?"
	}
	return result, nil
}

func (s *Service) loadOwnedSession(ctx context.Context, userID, sessionID int64) (*Session, []Question, error) {
	session, err := s.repo.GetByID(sessionID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil, ErrNotFound
		}
		return nil, nil, err
	}
	if session.UserID != userID {
		return nil, nil, ErrNotFound
	}
	questions, err := s.repo.ListQuestions(sessionID)
	if err != nil {
		return nil, nil, err
	}
	if questions == nil {
		questions = []Question{}
	}
	return session, questions, nil
}

var ErrInvalidInput = errors.New("invalid input")
