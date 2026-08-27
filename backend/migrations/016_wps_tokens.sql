-- 016：WPS access_token / refresh_token 持久化（云文档 + 邮箱能力）
-- 现有 WPS 登录只在回调时临时使用 access_token 换取用户信息后丢弃。
-- 为支持「从 WPS 云文档选简历」和「报告发送到邮箱」，需要持久化用户授权 token，
-- 并在过期时用 refresh_token 刷新。幂等：仅当列不存在时添加。
-- 注意：列位置 AFTER username（而非 avatar_url）——avatar_url 由 017 补齐，
-- 016 先于 017 执行，若依赖 avatar_url 会在干净环境迁移中断。username 由 013 保证存在。

SET @has_at := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'wps_access_token'
);

SET @sql := IF(@has_at = 0,
  'ALTER TABLE users
     ADD COLUMN wps_access_token VARCHAR(2048) NULL AFTER username,
     ADD COLUMN wps_refresh_token VARCHAR(2048) NULL AFTER wps_access_token,
     ADD COLUMN wps_token_expires_at DATETIME NULL AFTER wps_refresh_token,
     ADD COLUMN wps_token_scope VARCHAR(512) NULL AFTER wps_token_expires_at',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
