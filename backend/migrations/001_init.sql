CREATE TABLE IF NOT EXISTS users (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  email VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS interview_sessions (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  user_id BIGINT NOT NULL,
  job_jd TEXT NOT NULL,
  resume_text TEXT NULL,
  mode VARCHAR(32) NOT NULL,
  status VARCHAR(32) NOT NULL,
  score INT NULL,
  feedback_json JSON NULL,
  raw_feedback MEDIUMTEXT NULL,
  started_at TIMESTAMP NULL,
  ended_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users(id),
  INDEX idx_sessions_user (user_id)
);

CREATE TABLE IF NOT EXISTS interview_questions (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  session_id BIGINT NOT NULL,
  seq INT NOT NULL,
  question TEXT NOT NULL,
  intent VARCHAR(255) NULL,
  asked TINYINT(1) NOT NULL DEFAULT 0,
  CONSTRAINT fk_questions_session FOREIGN KEY (session_id) REFERENCES interview_sessions(id) ON DELETE CASCADE,
  UNIQUE KEY uq_session_seq (session_id, seq)
);

CREATE TABLE IF NOT EXISTS interview_turns (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  session_id BIGINT NOT NULL,
  seq INT NOT NULL,
  role VARCHAR(32) NOT NULL,
  kind VARCHAR(32) NOT NULL,
  content MEDIUMTEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_turns_session FOREIGN KEY (session_id) REFERENCES interview_sessions(id) ON DELETE CASCADE,
  UNIQUE KEY uq_turn_seq (session_id, seq)
);
