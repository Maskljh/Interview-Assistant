ALTER TABLE interview_sessions
  ADD COLUMN resume_file_url VARCHAR(1024) NULL AFTER resume_text,
  ADD COLUMN jd_file_url VARCHAR(1024) NULL AFTER job_jd;
