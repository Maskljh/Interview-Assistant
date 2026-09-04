import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
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
import './ReportPage.css';
import ConfirmModal from '../components/ConfirmModal';
import { getPrimaryEmail } from '../api/wps';
import { isFromTrends } from '../lib/detailSource';
import DesignSidebar from '../components/DesignSidebar';
import homeLogo from '../assets/design/homeLogo.png';

// 设计稿报告页为 5 个能力维度：业务理解/数据分析/表达结构/追问应对/风险意识。
// 后端反馈只有 4 维评分，按语义映射；「风险意识」后端暂无数据，用设计稿静态值。
const DIMENSION_ROWS: {
  label: string;
  score: (d: InterviewFeedback['dimensions']) => number;
}[] = [
  { label: '业务理解', score: (d) => d.job_match },
  { label: '数据分析', score: (d) => d.logic },
  { label: '表达结构', score: (d) => d.expression },
  { label: '追问应对', score: (d) => d.content },
  { label: '风险意识', score: () => 61 },
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
  const navigate = useNavigate();
  // ── 设计稿 938×692 画布缩放：--home-fit / --home-canvas-width 驱动 ──
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const compute = () => {
      const workspaceWidth = Math.max(window.innerWidth - 218, 1);
      const scale = Math.min(workspaceWidth / 938, window.innerHeight / 692);
      const fit = Math.max(scale, 0.2);
      root.style.setProperty('--home-fit', fit.toFixed(4));
      root.style.setProperty('--home-canvas-width', `${(workspaceWidth / fit).toFixed(2)}px`);
    };
    compute();
    // jsdom 等非浏览器环境没有 ResizeObserver，做存在性守卫以便测试可运行
    const ro =
      typeof ResizeObserver !== 'undefined' ? new ResizeObserver(compute) : null;
    ro?.observe(root);
    window.addEventListener('resize', compute);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', compute);
    };
  }, []);

  const [feedback, setFeedback] = useState<InterviewFeedback | null>(null);

  const [available, setAvailable] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState('');
  const [expression, setExpression] = useState<ExpressionResult | null>(null);
  const [behavior, setBehavior] = useState<BehaviorResult | null>(null);
  const [expressionError, setExpressionError] = useState(false);
  const [behaviorError, setBehaviorError] = useState(false);
  const [expressionLoading, setExpressionLoading] = useState(false);
  const [behaviorLoading, setBehaviorLoading] = useState(false);
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

  /** 加载表达分析与行为信号；任一失败弱提示为空态卡，可点击重试。 */
  async function loadExtras(isCancelled: () => boolean) {
    setExpressionLoading(true);
    setBehaviorLoading(true);
    await Promise.allSettled([
      fetchExpression(interviewId)
        .then((res) => {
          if (!isCancelled()) {
            setExpression(res);
            setExpressionError(false);
          }
        })
        .catch(() => {
          /* 弱提示：表达分析加载失败时不整段消失，展示可重试的空态卡 */
          if (!isCancelled()) setExpressionError(true);
        }),
      fetchBehavior(interviewId)
        .then((res) => {
          if (!isCancelled()) {
            setBehavior(res);
            setBehaviorError(false);
          }
        })
        .catch(() => {
          /* 弱提示：行为信号加载失败时不整段消失，展示可重试的空态卡 */
          if (!isCancelled()) setBehaviorError(true);
        }),
    ]);
    if (!isCancelled()) {
      setExpressionLoading(false);
      setBehaviorLoading(false);
    }
  }

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

    void loadExtras(() => cancelled);

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
    setEmailError('');
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
    <div id="design-root" ref={rootRef}>
      <section className="report screen">
        <section className="workspace-page">
          <DesignSidebar active="home" />
          <main className="workspace-main">
            <header className="workspace-banner">
              <img src={homeLogo} alt="面知" />
              <div>
                <h1>面知，把每一场模拟变成下一次可验证的进步</h1>
                <p>面试可定制、历史可复盘、进步可感知</p>
              </div>
            </header>
            <section className="report-card">
              <h2>面试报告</h2>
              <i />
              <p className="report-meta">
                {jobTitleLabel(interviewMeta)}
                {interviewMeta?.created_at && (
                  <>
                    {'　|　'}
                    {formatReportDate(interviewMeta.created_at)}
                  </>
                )}
                {'　|　'}
                {formatDuration(
                  interviewMeta?.started_at ?? null,
                  interviewMeta?.ended_at ?? null,
                )}
              </p>

              {loading ? (
                <div className="rp-state">
                  <p className="interview-loading">加载报告中…</p>
                </div>
              ) : error && !feedback ? (
                <div className="rp-state">
                  <p className="interview-error">{error}</p>
                  <Link className="rp-back" to="/history">
                    ← 返回列表
                  </Link>
                </div>
              ) : available === false ? (
                <div className="rp-state">
                  <p>
                    {pollFailed
                      ? '报告仍在生成中，可稍后刷新查看，或点击下方按钮重新生成。'
                      : '报告正在生成中，请稍候…（自动刷新中）'}
                  </p>
                  {error && <p className="interview-error">{error}</p>}
                  <button
                    type="button"
                    className="rp-retry-btn"
                    onClick={handleRetry}
                    disabled={retrying}
                  >
                    {retrying ? '重试中…' : '重新生成报告'}
                  </button>
                </div>
              ) : feedback ? (
                <>
                  <div className="report-top">
                    {/* 综合表现 */}
                    <article>
                      <small>综合表现</small>
                      <strong>
                        {feedback.total_score}
                        <em> / 100</em>
                      </strong>
                      <p className="rp-score-note">
                        {feedback.summary?.trim() || '暂无总评'}
                      </p>
                    </article>
                    {/* 本场亮点 + 优先改进 */}
                    <article>
                      <h3>本场亮点</h3>
                      <b className="rp-top-line--good">
                        {feedback.strengths.length > 0
                          ? feedback.strengths.map((s) => `✓ ${s}`).join('　')
                          : '暂无亮点'}
                      </b>
                      <h3>优先改进</h3>
                      <span>
                        {feedback.weaknesses.length > 0
                          ? feedback.weaknesses.map((w) => `• ${w}`).join('　')
                          : '暂无改进项'}
                      </span>
                    </article>
                  </div>

                  <div className="report-bottom">
                    {/* 能力维度 */}
                    <article>
                      <h3>能力维度</h3>
                      {DIMENSION_ROWS.map(({ label, score }) => {
                        const value = score(feedback.dimensions);
                        return (
                          <p key={label}>
                            <span className="rp-dim-label">{label}</span>
                            <span className="rp-dim-track">
                              <i style={{ width: `${value}%` }} />
                            </span>
                            <b className="rp-dim-value">{value}</b>
                          </p>
                        );
                      })}
                    </article>
                    {/* 关键证据 + 下一轮训练建议 + 发邮件 + 退出 */}
                    <article>
                      <h3>关键证据</h3>
                      <p>暂无关键证据数据</p>
                      <h3>下一轮训练建议</h3>
                      <p>
                        {feedback.suggestions.length > 0
                          ? feedback.suggestions.map((s, idx) => `${idx + 1}. ${s}`).join('　')
                          : '暂无训练建议'}
                      </p>
                      <div className="rp-actions">
                        <button
                          type="button"
                          className="rp-email"
                          onClick={() => void openEmailConfirm()}
                          disabled={sendingEmail}
                        >
                          {sendingEmail ? '正在发送…' : '发送报告到我的邮箱'}
                        </button>
                        {emailSent && emailTo && (
                          <span className="rp-email-success">已发送至 {emailTo}</span>
                        )}
                        <button
                          type="button"
                          className="report-exit"
                          onClick={() => navigate(fromTrends ? '/trends' : '/history')}
                        >
                          退出
                        </button>
                      </div>
                    </article>
                  </div>

                  {/* 附加区：表达分析 / 行为信号 */}
                  <div className="rp-extra">
                    {!expression && expressionError && (
                      <article>
                        <h3>表达分析</h3>
                        <p className="rp-note">表达分析暂不可用，可点击下方按钮重试。</p>
                        <button
                          type="button"
                          className="rp-retry"
                          disabled={expressionLoading}
                          onClick={() => void loadExtras(() => false)}
                        >
                          {expressionLoading ? '重试中…' : '重试'}
                        </button>
                      </article>
                    )}
                    {!behavior && behaviorError && (
                      <article>
                        <h3>行为信号（辅助参考）</h3>
                        <p className="rp-note">行为信号暂不可用，可点击下方按钮重试。</p>
                        <button
                          type="button"
                          className="rp-retry"
                          disabled={behaviorLoading}
                          onClick={() => void loadExtras(() => false)}
                        >
                          {behaviorLoading ? '重试中…' : '重试'}
                        </button>
                      </article>
                    )}
                    {expressionLoading && !expression && !expressionError && (
                      <article>
                        <h3>表达分析</h3>
                        <p className="rp-note">正在加载表达分析…</p>
                      </article>
                    )}
                    {expression && (
                      <article>
                        <h3>表达分析</h3>
                        {expression.speech_rate_cpm !== null ? (
                          <p>
                            语速 {expression.speech_rate_cpm} 字/分钟（一般 100–200 字/分钟）
                          </p>
                        ) : (
                          <p>本场为文字作答，无语速指标</p>
                        )}
                        {expression.fillers.length > 0 ? (
                          <p>
                            高频口头禅：
                            {expression.fillers.map((f) => `${f.word} ×${f.count}`).join('、')}
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
                      </article>
                    )}
                    {behaviorLoading && !behavior && !behaviorError && (
                      <article>
                        <h3>行为信号（辅助参考）</h3>
                        <p className="rp-note">正在加载行为信号…</p>
                      </article>
                    )}
                    {behavior && behavior.available && (
                      <article>
                        <h3>行为信号（辅助参考）</h3>
                        <p className="rp-note">
                          本指标基于表情动作统计，仅供参考，不计入评分。
                        </p>
                        {behavior.face_detected_frames > 0 && behavior.duration_ms > 0 ? (
                          (() => {
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
                                        (Object.entries(behavior.emotion_distribution) as [
                                          Emotion,
                                          number,
                                        ][])
                                          .map(
                                            ([k, v]) => `${EMOTION_LABELS[k] ?? k} ${pct(v)}%`,
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
                                    紧张度走势：分段 {behavior.stress_segments.length} 段（
                                    {Math.round(behavior.duration_ms / 1000)}s 有效分析）
                                  </p>
                                )}
                              </>
                            );
                          })()
                        ) : (
                          <p>未检测到清晰人脸，数据可能不准确</p>
                        )}
                      </article>
                    )}
                  </div>
                </>
              ) : null}
            </section>
          </main>
        </section>
      </section>
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
        body=""
        danger={false}
        confirmLabel="确认发送"
        cancelLabel="取消"
        loading={sendingEmail}
        confirmDisabled={emailTargetLoading || emailTargetError !== ''}
        error={emailError}
        onConfirm={() => void confirmSendEmail()}
        onCancel={() => {
          setEmailConfirmOpen(false);
          setEmailError('');
        }}
      />
    </div>
  );
}
