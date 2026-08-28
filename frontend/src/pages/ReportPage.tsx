import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { ApiError } from '../api/client';
import {
  getInterview,
  getReport,
  retryReport,
  sendReportToEmail,
  type InterviewFeedback,
} from '../api/interviews';
import { fetchExpression, type ExpressionResult } from '../api/expression';
import {
  fetchBehavior,
  type BehaviorResult,
  type Emotion,
} from '../api/behavior';
import './InterviewPages.css';
import ConfirmModal from '../components/ConfirmModal';
import { getPrimaryEmail } from '../api/wps';
import { isFromTrends } from '../lib/detailSource';
import AppNav from '../components/AppNav';

const DIMENSION_LABELS: { key: keyof InterviewFeedback['dimensions']; label: string }[] =
  [
    { key: 'expression', label: '表达能力' },
    { key: 'logic', label: '逻辑结构' },
    { key: 'content', label: '内容质量' },
    { key: 'job_match', label: '岗位匹配' },
  ];

// 报告页元信息行：岗位名来自会话的 job_title（创建时由 LLM 从 JD+简历推理），
// 未推理到时回退为 JD 首行摘要；时长由 started_at → ended_at 计算。
function formatReportDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}.${m}.${day}`;
}

function formatDuration(startedAt: string | null, endedAt: string | null): string {
  if (!startedAt || !endedAt) return '进行中';
  const start = new Date(startedAt).getTime();
  const end = new Date(endedAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return '进行中';
  // 数据异常（结束时间早于开始时间）：不误报“进行中”，显示“时长未知”。
  if (end < start) return '时长未知';
  const mins = Math.max(1, Math.round((end - start) / 60000));
  return `${mins} 分钟`;
}

// jobTitleLabel 优先用 LLM 推理出的岗位名；为空时回退到 JD 第一行（截断 20 字）。
function jobTitleLabel(meta: {
  job_title: string | null;
  job_jd: string;
} | null): string {
  if (meta?.job_title && meta.job_title.trim()) {
    return meta.job_title.trim();
  }
  if (meta?.job_jd) {
    const firstLine = meta.job_jd.split('\n').map((l) => l.trim()).find((l) => l !== '');
    if (firstLine) {
      const runes = [...firstLine];
      return runes.length <= 20 ? firstLine : runes.slice(0, 20).join('') + '…';
    }
  }
  return '未命名岗位';
}

const EMOTION_LABELS: Record<Emotion, string> = {
  smile: '微笑',
  neutral: '中性',
  focus: '专注',
  surprise: '惊讶',
  frown: '皱眉',
};

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
  const [behavior, setBehavior] = useState<BehaviorResult | null>(null);
  const [expressionError, setExpressionError] = useState(false);
  const [behaviorError, setBehaviorError] = useState(false);
  const [interviewMeta, setInterviewMeta] = useState<{
    job_title: string | null;
    job_jd: string;
    created_at: string | null;
    started_at: string | null;
    ended_at: string | null;
  } | null>(null);
  const pollTimerRef = useRef<number | null>(null);
  const pollCountRef = useRef(0);
  const [pollFailed, setPollFailed] = useState(false);
  const [sendingEmail, setSendingEmail] = useState(false);
  const [emailSent, setEmailSent] = useState(false);
  const [emailTo, setEmailTo] = useState('');
  const [emailError, setEmailError] = useState('');
  const [emailConfirmOpen, setEmailConfirmOpen] = useState(false);
  const [emailTarget, setEmailTarget] = useState('');
  const [emailTargetLoading, setEmailTargetLoading] = useState(false);
  const [emailTargetError, setEmailTargetError] = useState('');

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
        } else if (pollCountRef.current >= 30) {
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

    getInterview(interviewId)
      .then((data) => {
        if (!cancelled) {
          setInterviewMeta({
            job_title: data.job_title,
            job_jd: data.job_jd,
            created_at: data.created_at,
            started_at: data.started_at,
            ended_at: data.ended_at,
          });
        }
      })
      .catch(() => {
        /* silent: meta line is optional */
      });

    fetchExpression(interviewId)
      .then((res) => {
        if (!cancelled) {
          setExpression(res);
          setExpressionError(false);
        }
      })
      .catch(() => {
        /* 弱提示：表达分析加载失败时不整段消失，展示可重试的空态卡 */
        if (!cancelled) setExpressionError(true);
      });

    fetchBehavior(interviewId)
      .then((res) => {
        if (!cancelled) {
          setBehavior(res);
          setBehaviorError(false);
        }
      })
      .catch(() => {
        /* 弱提示：行为信号加载失败时不整段消失，展示可重试的空态卡 */
        if (!cancelled) setBehaviorError(true);
      });

    return () => {
      cancelled = true;
      stopPolling();
    };
  }, [interviewId, startPolling]);

  /** 打开确认弹窗并拉取收件人（WPS 主邮箱），用户确认后再真正发送。 */
  async function openEmailConfirm() {
    setEmailConfirmOpen(true);
    setEmailTarget('');
    setEmailTargetError('');
    setEmailTargetLoading(true);
    try {
      const res = await getPrimaryEmail();
      setEmailTarget(res.email);
    } catch (err) {
      setEmailTargetError(
        err instanceof ApiError ? err.message : '无法获取收件人邮箱，请检查 WPS 授权',
      );
    } finally {
      setEmailTargetLoading(false);
    }
  }

  async function confirmSendEmail() {
    if (!emailTarget) return; // 未获取到收件人时不发送
    setSendingEmail(true);
    setEmailError('');
    setEmailSent(false);
    try {
      const res = await sendReportToEmail(interviewId);
      setEmailTo(res.to);
      setEmailSent(true);
      setEmailConfirmOpen(false);
    } catch (err) {
      setEmailError(err instanceof ApiError ? err.message : '发送报告到邮箱失败');
    } finally {
      setSendingEmail(false);
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
      <AppNav tab={fromTrends ? 'trends' : 'history'} />
      <main className="interview-main">
        {fromTrends && (
          <Link className="interview-back-link" to="/trends">
            ← 返回成长分析
          </Link>
        )}

        <h1>面试报告</h1>
        <p className="report-meta">
          {jobTitleLabel(interviewMeta)}
          {interviewMeta?.created_at && (
            <>
              {' | '}
              {formatReportDate(interviewMeta.created_at)}
            </>
          )}
          {' | '}
          {formatDuration(interviewMeta?.started_at ?? null, interviewMeta?.ended_at ?? null)}
        </p>

        {loading ? (
          <p className="interview-loading">加载报告中…</p>
        ) : error && !feedback ? (
          <div className="interview-stub">
            <p className="interview-error">{error}</p>
            <Link className="interview-inline-link" to="/history">
              ← 返回列表
            </Link>
          </div>
        ) : available === false ? (
          <div className="interview-stub">
            <p>
              {pollFailed
                ? '报告仍在生成中，可稍后刷新查看，或点击下方按钮重新生成。'
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
            <div className="report-actions">
              <button
                type="button"
                className="report-email-btn"
                onClick={() => void openEmailConfirm()}
                disabled={sendingEmail}
              >
                {sendingEmail ? '正在发送…' : '发送报告到我的邮箱'}
              </button>
              {emailSent && emailTo && (
                <span className="report-email-success">
                  已发送至 {emailTo}
                </span>
              )}
              {emailError && <p className="interview-error">{emailError}</p>}
            </div>
            {/* 2×2 布局：总评+优势与短板（上行）/ 能力维度+证据与建议（下行）（Figma 03 面试报告） */}
            <div className="report-grid">
              <div className="report-grid-row report-grid-row--top">
                {/* 总评 */}
                <section className="report-card report-card--score">
                  <span className="report-card-label">综合表现</span>
                  <div className="report-score-value">
                    <span className="report-score-num">{feedback.total_score}</span>
                    <span className="report-score-max">/ 100</span>
                  </div>
                  <p className="report-score-note">
                    {feedback.summary?.trim() || '暂无总评'}
                  </p>
                </section>

                {/* 优势与短板：左本场亮点，右优先改进 */}
                <section className="report-card report-card--strengths">
                  <div className="report-strengths-col">
                    <h2 className="report-card-title">本场亮点</h2>
                    <ul className="report-inline-list report-inline-list--good">
                      {feedback.strengths.length > 0 ? (
                        feedback.strengths.map((item) => <li key={item}>✓ {item}</li>)
                      ) : (
                        <li>暂无亮点</li>
                      )}
                    </ul>
                  </div>
                  <div className="report-strengths-col">
                    <h2 className="report-card-title">优先改进</h2>
                    <ul className="report-inline-list report-inline-list--warn">
                      {feedback.weaknesses.length > 0 ? (
                        feedback.weaknesses.map((item) => <li key={item}>• {item}</li>)
                      ) : (
                        <li>暂无改进项</li>
                      )}
                    </ul>
                  </div>
                </section>
              </div>

              <div className="report-grid-row report-grid-row--bottom">
                {/* 能力维度：4 维进度条 */}
                <section className="report-card report-card--dims">
                  <h2 className="report-card-title">能力维度</h2>
                  <div className="report-dim-bars">
                    {DIMENSION_LABELS.map(({ key, label }) => {
                      const score = feedback.dimensions[key];
                      return (
                        <div key={key} className="report-dim-bar">
                          <span className="report-dim-bar-label">{label}</span>
                          <div className="report-dim-bar-track">
                            <div
                              className="report-dim-bar-fill"
                              style={{ width: `${score}%` }}
                            />
                          </div>
                          <span className="report-dim-bar-value">{score}</span>
                        </div>
                      );
                    })}
                  </div>
                </section>

                {/* 证据与建议：下一轮训练建议 */}
                <section className="report-card report-card--advice">
                  <h2 className="report-card-title">下一轮训练建议</h2>
                  {feedback.suggestions.length > 0 ? (
                    <ol className="report-suggestions">
                      {feedback.suggestions.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ol>
                  ) : (
                    <p className="report-quick-empty">暂无训练建议</p>
                  )}
                </section>
              </div>
            </div>

            {/* 附加区：表达分析 / 行为信号（2×2 网格下方） */}
            <div className="report-extra">
            {!expression && expressionError && (
              <div className="report-card report-extra-muted">
                <h2 className="report-card-title">表达分析</h2>
                <p className="behavior-note">表达分析暂不可用，可稍后刷新重试。</p>
              </div>
            )}
            {!behavior && behaviorError && (
              <div className="report-card report-extra-muted">
                <h2 className="report-card-title">行为信号（辅助参考）</h2>
                <p className="behavior-note">行为信号暂不可用，可稍后刷新重试。</p>
              </div>
            )}
            {expression && (
              <div className="report-card">
                <h2 className="report-card-title">表达分析</h2>
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

            {behavior && behavior.available && (
              <div className="report-card">
                <h2 className="report-card-title">行为信号（辅助参考）</h2>
                <p className="behavior-note">
                  本指标基于表情动作统计，仅供参考，不计入评分。
                </p>
                {behavior.face_detected_frames > 0 && behavior.duration_ms > 0
                  ? (() => {
                      const total = Object.values(
                        behavior.emotion_distribution,
                      ).reduce((a, b) => a + b, 0);
                      const pct = (v: number) =>
                        total > 0 ? Math.round((v / total) * 100) : 0;
                      return (
                        <>
                          <p>
                            情绪分布：
                            {Object.keys(behavior.emotion_distribution).length === 0
                              ? '暂无情绪数据'
                              : (
                                  (Object.entries(
                                    behavior.emotion_distribution,
                                  ) as [Emotion, number][])
                                    .map(
                                      ([k, v]) =>
                                        `${EMOTION_LABELS[k] ?? k} ${pct(v)}%`,
                                    )
                                    .join(' / ')
                                )}
                          </p>
                          <p>点头：{behavior.nod_count} 次</p>
                          <p>
                            紧张度：{behavior.stress_level} / 100
                            {behavior.stress_level < 40
                              ? '（较放松）'
                              : behavior.stress_level < 70
                                ? '（中等）'
                                : '（偏高）'}
                          </p>
                          {behavior.stress_segments.length > 0 && (
                            <p>
                              紧张度走势：分段
                              {behavior.stress_segments.length} 段（
                              {Math.round(behavior.duration_ms / 1000)}s
                              有效分析）
                            </p>
                          )}
                        </>
                      );
                    })()
                  : (
                    <p>未检测到清晰人脸，数据可能不准确</p>
                  )}
              </div>
            )}
            </div>

          </>
        ) : null}
      </main>
      <ConfirmModal
        open={emailConfirmOpen}
        title="发送报告到我的邮箱"
        description={
          emailTargetLoading
            ? '正在获取收件人邮箱…'
            : emailTargetError
              ? emailTargetError
              : `报告摘要将发送到你的 WPS 邮箱：${emailTarget}`
        }
        confirmLabel="确认发送"
        cancelLabel="取消"
        loading={sendingEmail}
        onConfirm={() => void confirmSendEmail()}
        onCancel={() => setEmailConfirmOpen(false)}
      />
    </div>
  );
}
