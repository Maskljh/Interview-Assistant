import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { ApiError } from '../api/client';
import {
  getInterview,
  type Interview,
} from '../api/interviews';
import { importQuestionsFromSession } from '../api/questions';
import {
  COMPANY_STYLE_LABELS,
  DIFFICULTY_LABELS,
  PERSONA_LABELS,
  STATUS_LABELS,
} from '../lib/labels';
import './InterviewPages.css';
import { isFromQuestions } from '../lib/detailSource';
import AppNav from '../components/AppNav';
import FollowUpTree from '../components/FollowUpTree';

export default function InterviewDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const fromQuestions = isFromQuestions(searchParams.get('from'));
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
      <AppNav tab={fromQuestions ? 'questions' : 'history'} />
      <main className="interview-main interview-main--wide">
        {fromQuestions && (
          <Link className="interview-back-link" to="/questions">
            ← 返回题库页
          </Link>
        )}

        {loading ? (
          <p className="interview-loading">加载中…</p>
        ) : error ? (
          <p className="interview-error">{error}</p>
        ) : interview ? (
          <>
            {/* 标题区卡片 */}
            <section className="interview-detail-card">
              <h1>面试 #{interview.id}</h1>
              <div className="interview-detail-meta">
                <span className={`status-pill status-pill--${interview.status}`}>
                  {STATUS_LABELS[interview.status]}
                </span>
                {interview.persona !== 'standard' && (
                  <span className="mode-pill">
                    {PERSONA_LABELS[interview.persona]}
                  </span>
                )}
                {interview.difficulty !== 'medium' && (
                  <span className="mode-pill">
                    {DIFFICULTY_LABELS[interview.difficulty]}
                  </span>
                )}
                {interview.company_style !== 'general' && (
                  <span className="mode-pill">
                    {COMPANY_STYLE_LABELS[interview.company_style]}
                  </span>
                )}
                {interview.score != null && (
                  <span className="mode-pill">得分 {interview.score}</span>
                )}
              </div>

              {/* 操作区 */}
              <div className="interview-detail-actions">
                {interview.status === 'in_progress' && (
                  <Link
                    className="interview-submit"
                    to={`/interviews/${interview.id}/room`}
                  >
                    继续面试
                  </Link>
                )}
                {!fromQuestions && interview.questions.length > 0 && (
                  <button
                    type="button"
                    className="interview-submit"
                    onClick={() => void handleSaveToBank()}
                    disabled={savingToBank}
                  >
                    {savingToBank ? '存入中…' : '存入题库'}
                  </button>
                )}
              </div>

              {interview.resume_file_url && (
                <div className="interview-detail-files">
                  <a
                    className="interview-inline-link"
                    href={interview.resume_file_url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    查看简历原文件
                  </a>
                </div>
              )}
              {bankMessage && <p className="interview-success">{bankMessage}</p>}
              {bankError && <p className="interview-error">{bankError}</p>}
            </section>

            {/* 对话记录卡片 */}
            <section className="interview-detail-card">
              <div className="interview-section-head">
                <h2 className="interview-section-title">对话记录</h2>
              </div>
              {sortedTurns.length === 0 ? (
                <p className="interview-subtitle">暂无对话记录。</p>
              ) : (
                <FollowUpTree turns={sortedTurns} />
              )}
            </section>
          </>
        ) : null}
      </main>
    </div>
  );
}
