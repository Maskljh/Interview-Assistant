import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ApiError } from '../api/client';
import {
  getInterview,
  getReport,
  retryReport,
  type InterviewFeedback,
} from '../api/interviews';
import { importQuestionsFromSession } from '../api/questions';
import { useAuth } from '../auth/AuthContext';
import './InterviewPages.css';

const DIMENSION_LABELS: { key: keyof InterviewFeedback['dimensions']; label: string }[] =
  [
    { key: 'expression', label: 'Expression' },
    { key: 'logic', label: 'Logic' },
    { key: 'content', label: 'Content' },
    { key: 'job_match', label: 'Job match' },
  ];

export default function ReportPage() {
  const { logout } = useAuth();
  const { id } = useParams<{ id: string }>();
  const interviewId = Number(id);

  const [feedback, setFeedback] = useState<InterviewFeedback | null>(null);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [questionCount, setQuestionCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState('');
  const [savingToBank, setSavingToBank] = useState(false);
  const [bankMessage, setBankMessage] = useState('');
  const [bankError, setBankError] = useState('');

  useEffect(() => {
    if (!Number.isFinite(interviewId)) {
      setError('Invalid interview id');
      setLoading(false);
      return;
    }

    let cancelled = false;

    async function load() {
      setLoading(true);
      setError('');
      try {
        const [result, interview] = await Promise.all([
          getReport(interviewId),
          getInterview(interviewId),
        ]);
        if (cancelled) return;
        setQuestionCount(interview.questions.length);
        if (result.available) {
          setFeedback(result.feedback);
          setAvailable(true);
        } else {
          setFeedback(null);
          setAvailable(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof ApiError ? err.message : 'Failed to load report');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [interviewId]);

  async function handleSaveToBank() {
    setSavingToBank(true);
    setBankMessage('');
    setBankError('');
    try {
      const { imported } = await importQuestionsFromSession(interviewId);
      setBankMessage(`已存入 ${imported} 题`);
    } catch (err) {
      setBankError(err instanceof ApiError ? err.message : '存入题库失败');
    } finally {
      setSavingToBank(false);
    }
  }

  async function handleRetry() {
    setRetrying(true);
    setError('');
    try {
      const result = await retryReport(interviewId);
      if (result.available) {
        setFeedback(result.feedback);
        setAvailable(true);
      } else {
        setFeedback(null);
        setAvailable(false);
        setError('Report is still unavailable. Please try again later.');
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not retry report');
    } finally {
      setRetrying(false);
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
          <Link className="interview-header-link" to={`/interviews/${id}`}>
            Detail
          </Link>
          <button type="button" className="interview-header-link" onClick={logout}>
            Sign out
          </button>
        </div>
      </header>
      <main className="interview-main">
        <Link className="interview-back-link" to="/">
          ← All interviews
        </Link>

        <h1>Interview report</h1>

        {questionCount > 0 && !loading && (
          <div className="interview-list-links" style={{ marginBottom: 'var(--space-md)' }}>
            <button
              type="button"
              className="interview-inline-link"
              onClick={() => void handleSaveToBank()}
              disabled={savingToBank}
            >
              {savingToBank ? '存入中…' : '存入题库'}
            </button>
          </div>
        )}
        {bankMessage && <p className="interview-success">{bankMessage}</p>}
        {bankError && <p className="interview-error">{bankError}</p>}

        {loading ? (
          <p className="interview-loading">Loading report…</p>
        ) : error && !feedback ? (
          <p className="interview-error">{error}</p>
        ) : available === false ? (
          <div className="interview-stub">
            <p>Your report is not ready yet. Analysis may still be running or failed.</p>
            {error && <p className="interview-error">{error}</p>}
            <button
              type="button"
              className="interview-submit"
              onClick={handleRetry}
              disabled={retrying}
            >
              {retrying ? 'Retrying…' : 'Retry report'}
            </button>
          </div>
        ) : feedback ? (
          <>
            <div className="report-score-card">
              <span className="report-score-label">Total score</span>
              <span className="report-score-value">{feedback.total_score}</span>
            </div>

            <h2 className="interview-section-title">Dimensions</h2>
            <div className="report-dimensions">
              {DIMENSION_LABELS.map(({ key, label }) => (
                <div key={key} className="report-dimension">
                  <span className="report-dimension-label">{label}</span>
                  <span className="report-dimension-value">
                    {feedback.dimensions[key]}
                  </span>
                </div>
              ))}
            </div>

            <ReportList title="Strengths" items={feedback.strengths} />
            <ReportList title="Weaknesses" items={feedback.weaknesses} />
            <ReportList title="Suggestions" items={feedback.suggestions} />

            <p className="report-model-version">
              Model: {feedback.model_version}
            </p>
          </>
        ) : null}
      </main>
    </div>
  );
}

function ReportList({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;

  return (
    <>
      <h2 className="interview-section-title">{title}</h2>
      <ul className="report-list">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </>
  );
}
