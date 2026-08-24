package behavior

import (
	"database/sql"
	"encoding/json"
	"errors"

	"github.com/go-sql-driver/mysql"
)

var errDuplicate = &mysql.MySQLError{Number: 1062}

type repo struct {
	db *sql.DB
}

func (r *repo) insert(sessionID, userID int64, p Payload) error {
	distJSON, err := json.Marshal(p.EmotionDistribution)
	if err != nil {
		return err
	}
	var segJSON any
	if len(p.StressSegments) > 0 {
		b, err := json.Marshal(p.StressSegments)
		if err != nil {
			return err
		}
		segJSON = string(b)
	}
	_, err = r.db.Exec(
		`INSERT INTO interview_behavior
		   (session_id, user_id, emotion_distribution, nod_count, stress_level, stress_segments, face_detected_frames, duration_ms)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		sessionID, userID, string(distJSON), p.NodCount, p.StressLevel, segJSON, p.FaceDetectedFrames, p.DurationMs,
	)
	if err != nil && isDuplicate(err) {
		return nil // idempotent: first write wins
	}
	return err
}

func (r *repo) get(sessionID int64) (*Result, error) {
	row := r.db.QueryRow(
		`SELECT emotion_distribution, nod_count, stress_level, stress_segments, face_detected_frames, duration_ms
		 FROM interview_behavior WHERE session_id = ?`, sessionID,
	)
	var distJSON, segJSON []byte
	var nod, stress, frames, dur int
	err := row.Scan(&distJSON, &nod, &stress, &segJSON, &frames, &dur)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	res := &Result{
		Available:          true,
		NodCount:           nod,
		StressLevel:        stress,
		FaceDetectedFrames: frames,
		DurationMs:         dur,
	}
	_ = json.Unmarshal(distJSON, &res.EmotionDistribution)
	if len(segJSON) > 0 {
		_ = json.Unmarshal(segJSON, &res.StressSegments)
	}
	return res, nil
}

func isDuplicate(err error) bool {
	var me *mysql.MySQLError
	return errors.As(err, &me) && me.Number == 1062
}
