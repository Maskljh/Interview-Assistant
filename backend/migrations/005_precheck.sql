-- backend/migrations/005_precheck.sql
ALTER TABLE interview_sessions
  ADD COLUMN precheck_gaps JSON NULL AFTER persona;
