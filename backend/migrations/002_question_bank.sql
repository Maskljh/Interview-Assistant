CREATE TABLE IF NOT EXISTS question_bank (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  user_id BIGINT NOT NULL,
  question TEXT NOT NULL,
  answer TEXT NULL,
  source VARCHAR(32) NOT NULL,
  source_session_id BIGINT NULL,
  job_tag VARCHAR(64) NULL,
  starred TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_qb_user FOREIGN KEY (user_id) REFERENCES users(id),
  INDEX idx_qb_user_created (user_id, created_at),
  INDEX idx_qb_user_starred (user_id, starred),
  INDEX idx_qb_user_job_tag (user_id, job_tag)
);
