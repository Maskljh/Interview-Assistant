import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError } from '../api/client';
import {
  deleteInterview,
  listInterviews,
  startInterview,
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
import ConfirmModal from '../components/ConfirmModal';

function InterviewRow({
  item,
  index,
  starting,
  onDelete,
  onStart,
}: {
  item: InterviewListItem;
  index: number;
  starting: boolean;
  onDelete: (item: InterviewListItem) => void;
  onStart: (item: InterviewListItem) => void;
}) {
  return (
    <li className="history-row">
      <span className="history-no">{String(index + 1).padStart(2, '0')}</span>
      <div className="history-row-main">
        <Link className="history-row-title" to={`/interviews/${item.id}`}>
          {item.job_title ? `${item.job_title} · 面试 #${item.id}` : `面试 #${item.id}`}
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
        {entryLinksFor((item.status === 'failed' ? 'other' : item.status) as EntryStatus).map((link) => (
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
        {item.status === 'draft' && (
          <button
            type="button"
            className="history-link"
            onClick={() => onStart(item)}
            disabled={starting}
          >
            {starting ? '准备题目中…' : '开始面试'}
          </button>
        )}
        <button
          type="button"
          className="history-link history-link--danger"
          onClick={() => onDelete(item)}
          aria-label={`删除面试 #${item.id}`}
        >
          删除
        </button>
      </div>
    </li>
  );
}

export default function InterviewListPage() {
  const [interviews, setInterviews] = useState<InterviewListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<InterviewListItem | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [startingId, setStartingId] = useState<number | null>(null);
  const navigate = useNavigate();

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

  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    setError('');
    try {
      await deleteInterview(deleteTarget.id);
      setInterviews((prev) => prev.filter((i) => i.id !== deleteTarget.id));
      setDeleteTarget(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '删除失败');
    } finally {
      setDeleting(false);
    }
  }

  // draft 会话题目未生成：先调 startInterview 生成题目，再进入面试室
  async function handleStart(item: InterviewListItem) {
    setStartingId(item.id);
    setError('');
    try {
      await startInterview(item.id);
      navigate(`/interviews/${item.id}/room`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '开始面试失败');
      setStartingId(null);
    }
  }

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
              <InterviewRow
                key={item.id}
                item={item}
                index={index}
                starting={startingId === item.id}
                onDelete={setDeleteTarget}
                onStart={(it) => void handleStart(it)}
              />
            ))}
          </ul>
        )}
      </main>

      <ConfirmModal
        open={deleteTarget !== null}
        title="删除面试记录"
        description={
          deleteTarget
            ? `确定删除「${deleteTarget.job_title || `面试 #${deleteTarget.id}`}」吗？删除后该场面试的对话、报告与行为数据将一并清除，且不可恢复。`
            : ''
        }
        confirmLabel="删除该场面试"
        loading={deleting}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
