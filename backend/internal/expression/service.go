package expression

import (
	"context"
	"database/sql"
	"errors"
	"sort"
	"strings"

	"github.com/interview-assistant/backend/internal/interview"
)

var (
	ErrNotFound = errors.New("session not found")
)

// fillerWords are the preset filler phrases counted across candidate answers.
var fillerWords = []string{"嗯", "呃", "那个", "这个", "然后", "就是"}

type Fillers struct {
	Word  string `json:"word"`
	Count int    `json:"count"`
}

type Result struct {
	Available        bool      `json:"available"`
	VoiceAnswers     int       `json:"voice_answers"`
	TotalDurationMs  int       `json:"total_duration_ms"`
	SpeechRateCPM    *int      `json:"speech_rate_cpm"`
	Fillers          []Fillers `json:"fillers"`
	AvgAnswerChars   int       `json:"avg_answer_chars"`
	AvgSentenceChars int       `json:"avg_sentence_chars"`
}

type Service struct {
	repo *interview.Repo
}

func NewService(repo *interview.Repo) *Service {
	return &Service{repo: repo}
}

func (s *Service) Analyze(ctx context.Context, userID, sessionID int64) (Result, error) {
	session, err := s.repo.GetByID(sessionID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return Result{}, ErrNotFound
		}
		return Result{}, err
	}
	if session.UserID != userID {
		return Result{}, ErrNotFound
	}

	turns, err := s.repo.ListTurns(sessionID)
	if err != nil {
		return Result{}, err
	}

	var (
		answers       []string
		voiceChars    int
		totalDuration int
		voiceAnswers  int
	)
	for _, t := range turns {
		if t.Role != "candidate" || t.Kind != "answer" {
			continue
		}
		answers = append(answers, t.Content)
		if t.VoiceDurationMs != nil {
			voiceAnswers++
			totalDuration += *t.VoiceDurationMs
			voiceChars += runeLen(t.Content)
		}
	}

	res := Result{
		Available:       true,
		VoiceAnswers:    voiceAnswers,
		TotalDurationMs: totalDuration,
		Fillers:         []Fillers{},
	}
	if voiceAnswers > 0 && totalDuration > 0 {
		rate := int(float64(voiceChars)/(float64(totalDuration)/60000.0) + 0.5)
		res.SpeechRateCPM = &rate
	}

	fillerCounts := map[string]int{}
	for _, w := range fillerWords {
		for _, a := range answers {
			fillerCounts[w] += strings.Count(a, w)
		}
		if fillerCounts[w] > 0 {
			res.Fillers = append(res.Fillers, Fillers{Word: w, Count: fillerCounts[w]})
		}
	}
	sort.Slice(res.Fillers, func(i, j int) bool { return res.Fillers[i].Count > res.Fillers[j].Count })

	if len(answers) > 0 {
		totalChars := 0
		for _, a := range answers {
			totalChars += runeLen(a)
		}
		res.AvgAnswerChars = int(float64(totalChars)/float64(len(answers)) + 0.5)
		sentences := 0
		for _, a := range answers {
			sentences += countSentences(a)
		}
		if sentences > 0 {
			res.AvgSentenceChars = int(float64(totalChars)/float64(sentences) + 0.5)
		}
	}
	return res, nil
}

func runeLen(s string) int {
	return len([]rune(s))
}

func countSentences(s string) int {
	n := 0
	for _, r := range s {
		switch r {
		case '。', '！', '？', '.', '!', '?':
			n++
		}
	}
	return n
}
