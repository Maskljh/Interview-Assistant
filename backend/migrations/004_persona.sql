ALTER TABLE interview_sessions
  ADD COLUMN persona VARCHAR(32) NOT NULL DEFAULT 'standard' AFTER input_mode;
