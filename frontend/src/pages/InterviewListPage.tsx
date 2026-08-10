import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../api/client';
import {
  listInterviews,
  type InterviewListItem,
  type InterviewMode,
  type InterviewStatus,
} from '../api/interviews';
import { useAuth } from '../auth/AuthContext';
import './InterviewPages.css';

const MODE_LABELS: Record<InterviewMode, string> = {
  behavioral: 'Behavioral',
  technical: 'Technical',
  mixed: 'Mixed',
};

const STATUS_LABELS: Record<InterviewStatus, string> = {
  draft: 'Draft',
  ready: 'Ready',
  in_progress: 'In progress',
  completed: 'Completed',
  failed: 'Failed',
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

function InterviewRow({ item }: { item: InterviewListItem }) {
  return (
    <li className="interview-list-item">
      <div className="interview-list-meta">
        <Link className="interview-list-title" to={`/interviews/${item.id}`}>
          Interview #{item.id}
        </Link>
        <span className="interview-list-date">{formatDate(item.created_at)}</span>
        <div className="interview-list-badges">
          <span className={`status-pill status-pill--${item.status}`}>
            {STATUS_LABELS[item.status]}
          </span>
          <span className="mode-pill">{MODE_LABELS[item.mode]}</span>
          {item.score != null && (
            <span className="mode-pill">Score {item.score}</span>
          )}
        </div>
      </div>
      <div className="interview-list-links">
        <Link className="interview-inline-link" to={`/interviews/${item.id}`}>
          Detail
        </Link>
        {item.status === 'in_progress' && (
          <Link className="interview-inline-link" to={`/interviews/${item.id}/room`}>
            Room
          </Link>
        )}
        {item.status === 'completed' && (
          <Link className="interview-inline-link" to={`/interviews/${item.id}/report`}>
            Report
          </Link>
        )}
      </div>
    </li>
  );
}

export default function InterviewListPage() {
  const { logout } = useAuth();
  const [interviews, setInterviews] = useState<InterviewListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError('');
      try {
        const data = await listInterviews();
        if (!cancelled) {
          setInterviews(data);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof ApiError ? err.message : 'Failed to load interviews');
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
  }, []);

  return (
    <div className="interview-page">
      <header className="interview-header">
        <Link className="interview-brand" to="/">
          Interview Assistant
        </Link>
        <div className="interview-header-actions">
          <Link className="interview-header-cta" to="/interviews/new">
            New interview
          </Link>
          <button type="button" className="interview-header-link" onClick={logout}>
            Sign out
          </button>
        </div>
      </header>
      <main className="interview-main">
        <h1>Interviews</h1>
        <p className="interview-subtitle">Practice sessions and history</p>

        {error && <p className="interview-error">{error}</p>}

        {loading ? (
          <p className="interview-loading">Loading interviews…</p>
        ) : interviews.length === 0 ? (
          <div className="interview-empty">
            <p>No interviews yet. Start your first practice session.</p>
            <Link className="interview-header-cta" to="/interviews/new">
              New interview
            </Link>
          </div>
        ) : (
          <ul className="interview-list">
            {interviews.map((item) => (
              <InterviewRow key={item.id} item={item} />
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}
