-- 019：岗位信息库（JD 收藏）
-- 「面试信息管理 → 岗位信息」面板与创建面试页的岗位选择器依赖本表。
CREATE TABLE IF NOT EXISTS job_info (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  user_id BIGINT NOT NULL,
  name VARCHAR(255) NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_job_info_user FOREIGN KEY (user_id) REFERENCES users(id),
  INDEX idx_job_info_user (user_id, updated_at)
);
