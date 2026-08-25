import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../api/client';
import {
  listInterviews,
  type InterviewListItem,
} from '../api/interviews';
import {
  MODE_LABELS,
  STATUS_LABELS,
  formatDateZh,
} from '../lib/labels';
import './InterviewPages.css';
import { entryLinksFor, type EntryStatus } from '../lib/listEntries';
import AppNav from '../components/AppNav';

function InterviewRow({ item, index }: { item: InterviewListItem; index: number }) {
  return (
    <li className="history-row">
      <span className="history-no">{String(index + 1).padStart(2, '0')}</span>
      <div className="history-row-main">
        <Link className="history-row-title" to={`/interviews/${item.id}`}>
          面试 #{item.id}
        </Link>
        <span className="history-row-date">{formatDateZh(item.created_at)}</span>
        <div className="history-row-badges">
          <span className={`status-pill status-pill--${item.status}`}>
            {STATUS_LABELS[item.status]}
          </span>
          <span className="mode-pill">{MODE_LABELS[item.mode]}</span>
          {item.score != null && (
            <span className="history-score">得分 {item.score}</span>
          )}
        </div>
      </div>
      <div className="history-row-links">
        {entryLinksFor((item.status === 'completed' || item.status === 'in_progress' ? item.status : 'other') as EntryStatus).map((link) => (
          <Link
            key={link.label}
            className="history-link"
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

  // 概览：总数 / 已完成 / 平均分
  const totalCount = interviews.length;
  const completedCount = interviews.filter((i) => i.status === 'completed').length;
  const avgScore = useMemo(() => {
    const scored = interviews.filter((i) => i.score != null);
    if (scored.length === 0) return null;
    const sum = scored.reduce((acc, i) => acc + (i.score ?? 0), 0);
    return Math.round(sum / scored.length);
  }, [interviews]);

  return (
    <div className="interview-page">
      <AppNav tab="history" />
      <main className="interview-main interview-main--wide interview-main--history">
        <div className="question-bank-head">
          <div>
            <h1>我的面试</h1>
            <p className="interview-subtitle">练习记录与历史回看</p>
          </div>
          <Link className="question-bank-new-btn" to="/interviews/new">
            ＋ 新建面试
          </Link>
        </div>

        {error && <p className="interview-error">{error}</p>}

        {/* 概览卡 */}
        <div className="question-bank-overview">
          <div className="question-bank-overview-card">
            <span className="question-bank-overview-num">{totalCount}</span>
            <span className="question-bank-overview-label">面试总数</span>
          </div>
          <div className="question-bank-overview-card">
            <span className="question-bank-overview-num question-bank-overview-num--blue">
              {completedCount}
            </span>
            <span className="question-bank-overview-label">已完成场次</span>
          </div>
          <div className="question-bank-overview-card">
            <span className="question-bank-overview-num question-bank-overview-num--blue">
              {avgScore ?? '—'}
            </span>
            <span className="question-bank-overview-label">平均得分</span>
          </div>
        </div>

        {loading ? (
          <p className="interview-loading">加载中…</p>
        ) : interviews.length === 0 ? (
          <div className="interview-empty">
            <p>还没有面试记录，开始你的第一场练习吧。</p>
            <Link className="interview-submit" to="/interviews/new">
              新建面试
            </Link>
          </div>
        ) : (
          <ul className="history-list">
            {interviews.map((item, index) => (
              <InterviewRow key={item.id} item={item} index={index} />
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}
