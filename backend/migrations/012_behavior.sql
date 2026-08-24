ALTER TABLE interview_sessions
  ADD COLUMN camera_enabled TINYINT(1) NOT NULL DEFAULT 0 AFTER company_style;

CREATE TABLE IF NOT EXISTS interview_behavior (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  session_id BIGINT NOT NULL,
  user_id BIGINT NOT NULL,
  emotion_distribution JSON NOT NULL,
  nod_count INT NOT NULL DEFAULT 0,
  stress_level INT NOT NULL,
  stress_segments JSON NULL,
  face_detected_frames INT NOT NULL DEFAULT 0,
  duration_ms INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_behavior_session FOREIGN KEY (session_id) REFERENCES interview_sessions(id) ON DELETE CASCADE,
  UNIQUE KEY uq_behavior_session (session_id)
);
