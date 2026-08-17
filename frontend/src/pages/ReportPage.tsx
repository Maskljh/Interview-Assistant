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
import { fetchExpression, type ExpressionResult } from '../api/expression';
import { useAuth } from '../auth/AuthContext';
import { APP_NAME } from '../lib/labels';
import './InterviewPages.css';
import MobileTabBar from '../components/MobileTabBar';

const DIMENSION_LABELS: { key: keyof InterviewFeedback['dimensions']; label: string }[] =
  [
    { key: 'expression', label: '表达能力' },
    { key: 'logic', label: '逻辑结构' },
    { key: 'content', label: '内容质量' },
    { key: 'job_match', label: '岗位匹配' },
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
  const [expression, setExpression] = useState<ExpressionResult | null>(null);

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
          setError(err instanceof ApiError ? err.message : '加载报告失败');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void load();

    fetchExpression(interviewId)
      .then((res) => {
        if (!cancelled) setExpression(res);
      })
      .catch(() => {
        /* silent: hide expression section on error */
      });

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
        setError('报告仍不可用，请稍后再试。');
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '重试生成报告失败');
    } finally {
      setRetrying(false);
    }
  }

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
          <Link className="interview-header-link" to="/trends">
            成长分析
          </Link>
          <Link className="interview-header-link" to={`/interviews/${id}`}>
            详情
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

        <h1>面试报告</h1>

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
          <p className="interview-loading">加载报告中…</p>
        ) : error && !feedback ? (
          <p className="interview-error">{error}</p>
        ) : available === false ? (
          <div className="interview-stub">
            <p>报告尚未就绪，可能仍在分析或上次生成失败。</p>
            {error && <p className="interview-error">{error}</p>}
            <button
              type="button"
              className="interview-submit"
              onClick={handleRetry}
              disabled={retrying}
            >
              {retrying ? '重试中…' : '重新生成报告'}
            </button>
          </div>
        ) : feedback ? (
          <>
            <div className="report-score-card">
              <span className="report-score-label">总分</span>
              <span className="report-score-value">{feedback.total_score}</span>
            </div>

            <h2 className="interview-section-title">维度评分</h2>
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

            <ReportList title="优点" items={feedback.strengths} />
            <ReportList title="问题" items={feedback.weaknesses} />
            <ReportList title="改进建议" items={feedback.suggestions} />

            {expression && (
              <div className="profile-card">
                <h3 className="interview-section-title">表达分析</h3>
                {expression.speech_rate_cpm !== null ? (
                  <p>
                    语速 {expression.speech_rate_cpm} 字/分钟（一般 100–200
                    字/分钟）
                  </p>
                ) : (
                  <p>本场为文字作答，无语速指标</p>
                )}
                {expression.fillers.length > 0 ? (
                  <p>
                    高频口头禅：
                    {expression.fillers
                      .map((f) => `${f.word} ×${f.count}`)
                      .join('、')}
                  </p>
                ) : (
                  <p>口头禅较少，继续保持</p>
                )}
                {expression.avg_answer_chars > 0 ? (
                  <p>
                    平均每答 {expression.avg_answer_chars} 字 / 平均句长{' '}
                    {expression.avg_sentence_chars} 字
                  </p>
                ) : (
                  <p>暂无答案数据</p>
                )}
              </div>
            )}

            <p className="report-model-version">模型：{feedback.model_version}</p>
          </>
        ) : null}
      </main>
      <MobileTabBar />
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
