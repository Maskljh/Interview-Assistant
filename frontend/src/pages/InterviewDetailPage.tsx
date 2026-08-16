import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ApiError } from '../api/client';
import {
  getInterview,
  type Interview,
  type InputMode,
} from '../api/interviews';
import { importQuestionsFromSession } from '../api/questions';
import { useAuth } from '../auth/AuthContext';
import { APP_NAME, MODE_LABELS, STATUS_LABELS, formatDateZh } from '../lib/labels';
import './InterviewPages.css';

const INPUT_MODE_LABELS: Record<InputMode, string> = {
  text: '文本作答',
  voice: '语音作答',
};

function roleLabel(role: string): string {
  if (role === 'interviewer') return '面试官';
  if (role === 'candidate') return '我';
  return role;
}

export default function InterviewDetailPage() {
  const { logout } = useAuth();
  const { id } = useParams<{ id: string }>();
  const interviewId = Number(id);
  const [interview, setInterview] = useState<Interview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [savingToBank, setSavingToBank] = useState(false);
  const [bankMessage, setBankMessage] = useState('');
  const [bankError, setBankError] = useState('');

  useEffect(() => {
    if (!Number.isFinite(interviewId)) {
      setError('无效的面试 ID');
      setLoading(false);
      return;
    }

    let cancelled = false;

    async function load() {
      setLoading(true);
      setError('');
      try {
        const data = await getInterview(interviewId);
        if (!cancelled) {
          setInterview(data);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof ApiError ? err.message : '加载面试详情失败');
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

  const sortedTurns = interview
    ? [...interview.turns].sort((a, b) => a.seq - b.seq)
    : [];

  return (
    <div className="interview-page">
      <header className="interview-header">
        <Link className="interview-brand" to="/">
          {APP_NAME}
        </Link>
        <div className="interview-header-actions">
          <Link className="interview-header-link" to="/questions">
            题库
          </Link>
          <Link className="interview-header-link" to="/">
            返回列表
          </Link>
          <button type="button" className="interview-header-link" onClick={logout}>
            退出登录
          </button>
        </div>
      </header>
      <main className="interview-main">
        <Link className="interview-back-link" to="/">
          ← 全部面试
        </Link>

        {loading ? (
          <p className="interview-loading">加载中…</p>
        ) : error ? (
          <p className="interview-error">{error}</p>
        ) : interview ? (
          <>
            <h1>面试 #{interview.id}</h1>
            <div className="interview-detail-meta">
              <span className={`status-pill status-pill--${interview.status}`}>
                {STATUS_LABELS[interview.status]}
              </span>
              <span className="mode-pill">{MODE_LABELS[interview.mode]}</span>
              <span className="mode-pill">
                {INPUT_MODE_LABELS[interview.input_mode]}
              </span>
              {interview.score != null && (
                <span className="mode-pill">得分 {interview.score}</span>
              )}
            </div>

            <div className="interview-list-links" style={{ marginBottom: 'var(--space-xl)' }}>
              {interview.status === 'in_progress' && (
                <Link
                  className="interview-inline-link"
                  to={`/interviews/${interview.id}/room`}
                >
                  继续面试
                </Link>
              )}
              {interview.status === 'completed' && (
                <Link
                  className="interview-inline-link"
                  to={`/interviews/${interview.id}/report`}
                >
                  查看报告
                </Link>
              )}
              {interview.questions.length > 0 && (
                <button
                  type="button"
                  className="interview-inline-link"
                  onClick={() => void handleSaveToBank()}
                  disabled={savingToBank}
                >
                  {savingToBank ? '存入中…' : '存入题库'}
                </button>
              )}
            </div>
            {bankMessage && <p className="interview-success">{bankMessage}</p>}
            {bankError && <p className="interview-error">{bankError}</p>}

            <h2 className="interview-section-title">对话记录</h2>
            {sortedTurns.length === 0 ? (
              <p className="interview-subtitle">暂无对话记录。</p>
            ) : (
              <div className="interview-transcript">
                {sortedTurns.map((turn) => (
                  <article
                    key={turn.id}
                    className={`transcript-turn${
                      turn.role === 'interviewer' ? ' transcript-turn--interviewer' : ''
                    }`}
                  >
                    <div className="transcript-turn-header">
                      <span className="transcript-role">{roleLabel(turn.role)}</span>
                      <time className="transcript-time" dateTime={turn.created_at}>
                        {formatDateZh(turn.created_at)}
                      </time>
                    </div>
                    <p className="transcript-content">{turn.content}</p>
                  </article>
                ))}
              </div>
            )}
          </>
        ) : null}
      </main>
    </div>
  );
}
