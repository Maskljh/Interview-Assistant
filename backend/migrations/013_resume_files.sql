-- 013：用户资料（username）与简历库
-- 侧边栏用户区（头像+用户名）与用户管理弹窗的简历管理依赖本迁移。

-- 用户名：注册时随机生成，后续接入 WPS 登录后可替换为真实昵称。
ALTER TABLE users ADD COLUMN username VARCHAR(64) NULL AFTER email;
UPDATE users SET username = CONCAT('用户', LPAD(id, 4, '0')) WHERE username IS NULL;
ALTER TABLE users MODIFY COLUMN username VARCHAR(64) NOT NULL;

-- 简历库：用户上传的多份简历（上限 5 份），供创建面试时挑选。
CREATE TABLE IF NOT EXISTS resume_files (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  user_id BIGINT NOT NULL,
  name VARCHAR(255) NOT NULL,
  file_url VARCHAR(1024) NOT NULL,
  size_bytes BIGINT NOT NULL DEFAULT 0,
  resume_text MEDIUMTEXT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_resume_files_user FOREIGN KEY (user_id) REFERENCES users(id),
  INDEX idx_resume_files_user (user_id, updated_at)
);
