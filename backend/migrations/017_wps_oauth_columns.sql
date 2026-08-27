-- 017：补齐 WPS OAuth 用户列（wps_openid / user_id / nickname / avatar_url）
-- 背景：015 曾注释“users 表已具备 wps_openid/nickname/avatar_url（D 盘迁移 013 已应用）”，
-- 但仓库迁移链（001–016）从未创建这 4 列，仅当前机器因额外应用过一份 D 盘迁移而存在。
-- 干净环境按 001→016 执行时，016 的 AFTER avatar_url 因列缺失直接失败，导致迁移中断、服务无法启动。
-- 本迁移幂等补齐这 4 列并给 wps_openid 加唯一索引（对齐既有环境的实际结构：varchar(255) + uq_users_wps_openid），
-- 与 016（已改为 AFTER username）配套，保证干净环境全链可执行。
-- 依赖：013 保证 username 列存在（本迁移将 wps_openid 置于 username 之后）。

-- 1) 逐列幂等补齐（缺失才 ADD，列顺序对齐既有环境）
SET @has_openid := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'wps_openid'
);
SET @has_userid := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'user_id'
);
SET @has_nickname := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'nickname'
);
SET @has_avatar := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'avatar_url'
);

-- 每条列独立幂等 ALTER：避免多条 ADD 拼接的语法问题，且对任意“部分列已存在”的环境都安全
SET @sql := IF(@has_openid = 0,
  'ALTER TABLE users ADD COLUMN wps_openid VARCHAR(255) NULL AFTER username',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql := IF(@has_userid = 0,
  'ALTER TABLE users ADD COLUMN user_id VARCHAR(64) NULL AFTER wps_openid',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql := IF(@has_nickname = 0,
  'ALTER TABLE users ADD COLUMN nickname VARCHAR(255) NULL AFTER user_id',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql := IF(@has_avatar = 0,
  'ALTER TABLE users ADD COLUMN avatar_url VARCHAR(1024) NULL AFTER nickname',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 2) wps_openid 唯一索引（UpsertWPSUser 的 ON DUPLICATE KEY UPDATE 依赖唯一约束；已存在则跳过）
SET @has_idx := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND INDEX_NAME = 'uq_users_wps_openid'
);
SET @sql2 := IF(@has_idx = 0,
  'ALTER TABLE users ADD UNIQUE INDEX uq_users_wps_openid (wps_openid)',
  'SELECT 1');
PREPARE stmt2 FROM @sql2;
EXECUTE stmt2;
DEALLOCATE PREPARE stmt2;
