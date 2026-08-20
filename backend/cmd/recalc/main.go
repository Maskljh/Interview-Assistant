// Command recalc re-evaluates historical completed interview sessions whose
// candidate gave no answers (or only trivially short ones). After the scoring
// guard was introduced, these sessions must be re-scored to a low value
// instead of the fabricated mid-range score the LLM produced before.
package main

import (
	"context"
	"database/sql"
	"fmt"
	"log"

	"github.com/interview-assistant/backend/internal/analysis"
	"github.com/interview-assistant/backend/internal/config"
	"github.com/interview-assistant/backend/internal/db"
	"github.com/interview-assistant/backend/internal/llm"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("config: %v", err)
	}
	sqlDB, err := db.Open(cfg.MySQLDSN)
	if err != nil {
		log.Fatalf("db: %v", err)
	}
	defer sqlDB.Close()

	llmClient := llm.NewDeepSeekClient(cfg.DeepSeekAPIKey, cfg.DeepSeekBaseURL, cfg.DeepSeekModel)
	analysisSvc := analysis.NewService(sqlDB, llmClient, cfg.DeepSeekModel)

	ctx := context.Background()

	// Completed sessions with no candidate answers, or whose total answer
	// length is below the guard threshold.
	rows, err := sqlDB.Query(`
		SELECT s.id, s.user_id, s.score
		FROM interview_sessions s
		LEFT JOIN interview_turns t ON t.session_id = s.id
		WHERE s.status = 'completed' AND s.score IS NOT NULL
		GROUP BY s.id
		HAVING SUM(CASE WHEN t.role = 'candidate' THEN 1 ELSE 0 END) = 0
		    OR COALESCE(SUM(CASE WHEN t.role = 'candidate' THEN CHAR_LENGTH(TRIM(t.content)) ELSE 0 END), 0) < 20
		ORDER BY s.id DESC`)
	if err != nil {
		log.Fatalf("query: %v", err)
	}
	defer rows.Close()

	type target struct {
		id     int64
		userID int64
		old    sql.NullInt64
	}
	var targets []target
	for rows.Next() {
		var t target
		if err := rows.Scan(&t.id, &t.userID, &t.old); err != nil {
			log.Fatalf("scan: %v", err)
		}
		targets = append(targets, t)
	}
	if err := rows.Err(); err != nil {
		log.Fatalf("rows: %v", err)
	}

	fmt.Printf("found %d sessions to recalculate\n", len(targets))
	for _, t := range targets {
		report, err := analysisSvc.Retry(ctx, t.userID, t.id)
		if err != nil {
			fmt.Printf("session %d: ERROR %v\n", t.id, err)
			continue
		}
		if !report.Available || report.Feedback == nil {
			fmt.Printf("session %d: report not available\n", t.id)
			continue
		}
		fmt.Printf("session %d: score %v -> %d\n", t.id, t.old, report.Feedback.TotalScore)
	}
}
