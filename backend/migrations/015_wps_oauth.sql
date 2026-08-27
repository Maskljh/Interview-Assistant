-- 015：WPS OAuth 登录 + 补齐 username 列
-- wps_openid/nickname/avatar_url/user_id 由 017 迁移幂等补齐（原依赖的 D 盘迁移 013 未纳入仓库，干净环境缺失）。
-- 此处幂等补齐：username 列（desktop 013 的 username 部分因编号冲突未生效）。

SET @has_username := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'username'
);

SET @sql := IF(@has_username = 0,
  'ALTER TABLE users ADD COLUMN username VARCHAR(64) NULL AFTER email',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- username：WPS 登录时写入真实昵称；老用户回填占位名。
UPDATE users SET username = CONCAT('用户', LPAD(id, 4, '0')) WHERE username IS NULL OR username = '';
ALTER TABLE users MODIFY COLUMN username VARCHAR(64) NOT NULL;
