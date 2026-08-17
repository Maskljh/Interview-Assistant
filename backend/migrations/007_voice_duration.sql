-- backend/migrations/007_voice_duration.sql
ALTER TABLE interview_turns
  ADD COLUMN voice_duration_ms INT NULL;
