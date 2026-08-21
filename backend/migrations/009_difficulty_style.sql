ALTER TABLE interview_sessions
  ADD COLUMN difficulty VARCHAR(16) NOT NULL DEFAULT 'medium' AFTER persona,
  ADD COLUMN company_style VARCHAR(16) NOT NULL DEFAULT 'general' AFTER difficulty;
