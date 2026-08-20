package interview

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
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

func (s *Service) Create(ctx context.Context, userID int64, jobJD string, resume *string, mode Mode, inputMode InputMode, persona string, precheckGaps []string) (*Session, error) {
	jobJD = strings.TrimSpace(jobJD)
	if jobJD == "" {
		return nil, ErrInvalidInput
	}
	if err := ValidateMode(mode); err != nil {
		return nil, err
	}
	if inputMode == "" {
		inputMode = InputModeText
	}
	if err := ValidateInputMode(inputMode); err != nil {
		return nil, err
	}
	if persona == "" {
		persona = llm.StandardPersona
	}
	if err := validatePersona(persona); err != nil {
		return nil, err
	}
	return s.repo.Create(userID, jobJD, resume, mode, inputMode, persona, precheckGaps)
}

func (s *Service) CreateFromBank(ctx context.Context, userID int64, questionIDs []int64, mode Mode, inputMode InputMode, persona string, precheckGaps []string) (*Session, []Question, error) {
	if len(questionIDs) == 0 {
		return nil, nil, ErrInvalidInput
	}
	if err := ValidateMode(mode); err != nil {
		return nil, nil, err
	}
	if inputMode == "" {
		inputMode = InputModeText
	}
	if err := ValidateInputMode(inputMode); err != nil {
		return nil, nil, err
	}
	if persona == "" {
		persona = llm.StandardPersona
	}
	if err := validatePersona(persona); err != nil {
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

	jobJD := fmt.Sprintf("题库练习（%d题）", len(texts))
	return s.repo.CreateReadyWithQuestions(userID, jobJD, mode, inputMode, persona, precheckGaps, texts)
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
	if err := s.llm.ChatJSON(ctx, llm.GenerateQuestionsSystem(), llm.GenerateQuestionsUser(session.JobJD, resume, string(session.Mode), weak, session.Persona, session.PrecheckGaps), &out); err != nil {
		return nil, nil, ErrLLMFailure
	}
	if len(out.Questions) < 5 || len(out.Questions) > 8 {
		return nil, nil, ErrLLMFailure
	}

	toInsert := make([]struct {
		Seq      int
		Question string
		Intent   string
	}, len(out.Questions))
	for i, q := range out.Questions {
		toInsert[i] = struct {
			Seq      int
			Question string
			Intent   string
		}{Seq: q.Seq, Question: q.Question, Intent: q.Intent}
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
			doneMsgs, err := s.finishSession(ctx, sessionID, state)
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
		doneMsgs, err := s.finishSession(ctx, sessionID, state)
		if err != nil {
			return nil, err
		}
		return append(msgs, doneMsgs...), nil

	default:
		return nil, ErrLLMFailure
	}
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

func (s *Service) decideNext(ctx context.Context, session *Session, questions []Question, state *sessionredis.LiveState, answer string) (DecideResult, error) {
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
			llm.DecideNextUser(session.JobJD, string(session.Mode), currentQ, state.FollowUpsOnCurrent, turnCtx, answer, session.Persona),
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
