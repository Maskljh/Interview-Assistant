-- 014：岗位名称（job_title）与题库练习记录
-- 报告页/面试房顶栏展示的岗位名，由 LLM 从 JD+简历推理后落库；
-- question_usage 记录题库练习（from-bank）每道题的使用，驱动「已使用 N 次」。

ALTER TABLE interview_sessions ADD COLUMN job_title VARCHAR(128) NULL AFTER job_jd;

-- 题库练习使用记录：每场 from-bank 面试被创建时，为每道选中题目插入一行。
CREATE TABLE IF NOT EXISTS question_usage (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  user_id BIGINT NOT NULL,
  question_id BIGINT NOT NULL,
  session_id BIGINT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_usage_user FOREIGN KEY (user_id) REFERENCES users(id),
  CONSTRAINT fk_usage_question FOREIGN KEY (question_id) REFERENCES question_bank(id),
  CONSTRAINT fk_usage_session FOREIGN KEY (session_id) REFERENCES interview_sessions(id) ON DELETE CASCADE,
  INDEX idx_usage_user_question (user_id, question_id),
  INDEX idx_usage_session (session_id)
);
