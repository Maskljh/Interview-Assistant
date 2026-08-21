import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../api/client';
import {
  listInterviews,
  type InterviewListItem,
} from '../api/interviews';
import {
  COMPANY_STYLE_LABELS,
  DIFFICULTY_LABELS,
  MODE_LABELS,
  PERSONA_LABELS,
  STATUS_LABELS,
  formatDateZh,
} from '../lib/labels';
import './InterviewPages.css';
import { entryLinksFor, type EntryStatus } from '../lib/listEntries';
import AppNav from '../components/AppNav';

function InterviewRow({ item }: { item: InterviewListItem }) {
  return (
    <li className="interview-list-item">
      <div className="interview-list-meta">
        <Link className="interview-list-title" to={`/interviews/${item.id}`}>
          面试 #{item.id}
        </Link>
        <span className="interview-list-date">{formatDateZh(item.created_at)}</span>
        <div className="interview-list-badges">
          <span className={`status-pill status-pill--${item.status}`}>
            {STATUS_LABELS[item.status]}
          </span>
          <span className="mode-pill">{MODE_LABELS[item.mode]}</span>
          {item.persona !== 'standard' && (
            <span className="mode-pill">{PERSONA_LABELS[item.persona]}</span>
          )}
          {item.difficulty !== 'medium' && (
            <span className="mode-pill">{DIFFICULTY_LABELS[item.difficulty]}</span>
          )}
          {item.company_style !== 'general' && (
            <span className="mode-pill">{COMPANY_STYLE_LABELS[item.company_style]}</span>
          )}
          {item.score != null && (
            <span className="mode-pill">得分 {item.score}</span>
          )}
        </div>
      </div>
      <div className="interview-list-links">
        {entryLinksFor((item.status === 'completed' || item.status === 'in_progress' ? item.status : 'other') as EntryStatus).map((link) => (
          <Link
            key={link.label}
            className="interview-inline-link"
            to={
              link.to === ''
                ? `/interviews/${item.id}`
                : `/interviews/${item.id}/${link.to}`
            }
          >
            {link.label}
          </Link>
        ))}
      </div>
    </li>
  );
}

export default function InterviewListPage() {
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
          setError(err instanceof ApiError ? err.message : '加载面试列表失败');
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
      <AppNav tab="interviews" />
      <main className="interview-main">
        <h1>我的面试</h1>
        <p className="interview-subtitle">练习记录与历史回看</p>

        {error && <p className="interview-error">{error}</p>}

        {loading ? (
          <p className="interview-loading">加载中…</p>
        ) : interviews.length === 0 ? (
          <div className="interview-empty">
            <p>还没有面试记录，开始你的第一场练习吧。</p>
            <Link className="interview-header-cta" to="/interviews/new">
              新建面试
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
