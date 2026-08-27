-- 018：interview_questions 增加 kind 列，区分题目来源
-- 背景：为"完整面试"编排新增三类题目：自我介绍开场题（self_intro）、用户勾选的题库题（bank）、
-- AI 生成的题目（generated，含普通模式 5~8 题与题库模式下的简历补全题）。
-- 幂等：列已存在时跳过，保证干净环境与已有环境均可按序执行。

SET @has_kind := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'interview_questions' AND COLUMN_NAME = 'kind'
);

SET @sql := IF(@has_kind = 0,
  "ALTER TABLE interview_questions ADD COLUMN kind VARCHAR(16) NOT NULL DEFAULT 'generated' AFTER question",
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
