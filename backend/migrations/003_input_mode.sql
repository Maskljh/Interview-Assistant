ALTER TABLE interview_sessions
  ADD COLUMN input_mode VARCHAR(16) NOT NULL DEFAULT 'text' AFTER mode;
