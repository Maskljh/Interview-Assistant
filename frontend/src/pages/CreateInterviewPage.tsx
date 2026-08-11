import { type FormEvent, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError } from '../api/client';
import {
  createInterview,
  startInterview,
  type InputMode,
  type InterviewMode,
} from '../api/interviews';
import { useAuth } from '../auth/AuthContext';
import './InterviewPages.css';

const MODES: { value: InterviewMode; label: string }[] = [
  { value: 'behavioral', label: 'Behavioral' },
  { value: 'technical', label: 'Technical' },
  { value: 'mixed', label: 'Mixed' },
];

const INPUT_MODES: { value: InputMode; label: string }[] = [
  { value: 'text', label: '文本' },
  { value: 'voice', label: '语音' },
];

export default function CreateInterviewPage() {
  const { logout } = useAuth();
  const navigate = useNavigate();
  const [jobJd, setJobJd] = useState('');
  const [resumeText, setResumeText] = useState('');
  const [mode, setMode] = useState<InterviewMode>('mixed');
  const [inputMode, setInputMode] = useState<InputMode>('text');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const trimmedJd = jobJd.trim();
      const trimmedResume = resumeText.trim();
      const created = await createInterview({
        job_jd: trimmedJd,
        mode,
        input_mode: inputMode,
        ...(trimmedResume ? { resume_text: trimmedResume } : {}),
      });
      await startInterview(created.id);
      navigate(`/interviews/${created.id}/room`, { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create interview');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="interview-page">
      <header className="interview-header">
        <Link className="interview-brand" to="/">
          Interview Assistant
        </Link>
        <div className="interview-header-actions">
          <Link className="interview-header-link" to="/questions">
            题库
          </Link>
          <Link className="interview-header-link" to="/">
            Back to list
          </Link>
          <button type="button" className="interview-header-link" onClick={logout}>
            Sign out
          </button>
        </div>
      </header>
      <main className="interview-main">
        <h1>New interview</h1>
        <p className="interview-subtitle">
          Paste the job description and choose a practice mode.
        </p>

        <form className="interview-form" onSubmit={handleSubmit}>
          {error && <p className="interview-error">{error}</p>}

          <div className="interview-field">
            <label htmlFor="job-jd">Job description</label>
            <textarea
              id="job-jd"
              required
              value={jobJd}
              onChange={(e) => setJobJd(e.target.value)}
              placeholder="Paste the job description here…"
            />
          </div>

          <div className="interview-field">
            <label htmlFor="resume">Resume (optional)</label>
            <textarea
              id="resume"
              value={resumeText}
              onChange={(e) => setResumeText(e.target.value)}
              placeholder="Paste your resume for tailored questions…"
            />
          </div>

          <div className="interview-field">
            <label htmlFor="mode">Mode</label>
            <select
              id="mode"
              value={mode}
              onChange={(e) => setMode(e.target.value as InterviewMode)}
            >
              {MODES.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          <div className="interview-field">
            <label htmlFor="input-mode">作答方式</label>
            <select
              id="input-mode"
              value={inputMode}
              onChange={(e) => setInputMode(e.target.value as InputMode)}
            >
              {INPUT_MODES.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          <button className="interview-submit" type="submit" disabled={loading}>
            {loading ? 'Starting interview…' : 'Start interview'}
          </button>
        </form>
      </main>
    </div>
  );
}
