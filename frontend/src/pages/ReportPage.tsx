import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { ApiError } from '../api/client';
import {
  getReport,
  retryReport,
  type InterviewFeedback,
} from '../api/interviews';
import { fetchExpression, type ExpressionResult } from '../api/expression';
import './InterviewPages.css';
import { isFromTrends } from '../lib/detailSource';
import AppNav from '../components/AppNav';

const DIMENSION_LABELS: { key: keyof InterviewFeedback['dimensions']; label: string }[] =
  [
    { key: 'expression', label: '表达能力' },
    { key: 'logic', label: '逻辑结构' },
    { key: 'content', label: '内容质量' },
    { key: 'job_match', label: '岗位匹配' },
  ];

export default function ReportPage() {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const fromTrends = isFromTrends(searchParams.get('from'));
  const interviewId = Number(id);

  const [feedback, setFeedback] = useState<InterviewFeedback | null>(null);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState('');
  const [expression, setExpression] = useState<ExpressionResult | null>(null);
  const pollTimerRef = useRef<number | null>(null);
  const pollCountRef = useRef(0);
  const [pollFailed, setPollFailed] = useState(false);

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current != null) {
      window.clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const startPolling = useCallback(() => {
    stopPolling();
    pollCountRef.current = 0;
    setPollFailed(false);
    pollTimerRef.current = window.setInterval(async () => {
      pollCountRef.current += 1;
      try {
        const result = await getReport(interviewId);
        if (result.available) {
          setFeedback(result.feedback);
          setAvailable(true);
          stopPolling();
        } else if (pollCountRef.current >= 12) {
          stopPolling();
          setPollFailed(true);
        }
      } catch {
        stopPolling();
        setError('报告加载失败，请稍后重试');
      }
    }, 10000);
  }, [getReport, interviewId, setFeedback, setAvailable, stopPolling]);

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
        const result = await getReport(interviewId);
        if (cancelled) return;
        if (result.available) {
          setFeedback(result.feedback);
          setAvailable(true);
        } else {
          setFeedback(null);
          setAvailable(false);
          startPolling();
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
      stopPolling();
    };
  }, [interviewId, startPolling]);

  async function handleRetry() {
    setRetrying(true);
    setError('');
    try {
      const result = await retryReport(interviewId);
      if (result.available) {
        setFeedback(result.feedback);
        setAvailable(true);
        stopPolling();
      } else {
        setFeedback(null);
        setAvailable(false);
        setPollFailed(false);
        setError('');
        startPolling(); // 重启轮询
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '重试生成报告失败');
    } finally {
      setRetrying(false);
    }
  }

  return (
    <div className="interview-page">
      <AppNav tab={fromTrends ? 'trends' : 'interviews'} />
      <main className="interview-main">
        {fromTrends ? (
          <Link className="interview-back-link" to="/trends">
            ← 返回成长分析
          </Link>
        ) : (
          <Link className="interview-back-link" to="/">
            ← 全部面试
          </Link>
        )}

        <h1>面试报告</h1>

        {loading ? (
          <p className="interview-loading">加载报告中…</p>
        ) : error && !feedback ? (
          <div className="interview-stub">
            <p className="interview-error">{error}</p>
            <Link className="interview-inline-link" to="/">
              ← 返回列表
            </Link>
          </div>
        ) : available === false ? (
          <div className="interview-stub">
            <p>
              {pollFailed
                ? '报告生成失败，可点击下方按钮重新生成。'
                : '报告正在生成中，请稍候…（自动刷新中）'}
            </p>
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
