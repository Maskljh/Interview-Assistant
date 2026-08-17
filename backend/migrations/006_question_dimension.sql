-- backend/migrations/006_question_dimension.sql
ALTER TABLE question_bank
  ADD COLUMN dimension VARCHAR(16) NULL AFTER job_tag;
