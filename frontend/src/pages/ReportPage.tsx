import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ApiError } from '../api/client';
import { mockReport } from '../lib/mockData';
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
import TopBar from '../components/TopBar';

// 参考 #report 屏为 4 个能力维度：岗位匹配度/业务能力/逻辑分析/表达沟通。
// 后端反馈 4 维评分（job_match/logic/expression/content）按语义映射到参考维度名。
const DIMENSION_ROWS: {
  label: string;
  score: (d: InterviewFeedback['dimensions']) => number;
}[] = [
  { label: '岗位匹配度', score: (d) => d.job_match },
  { label: '业务能力', score: (d) => d.content },
  { label: '逻辑分析', score: (d) => d.logic },
  { label: '表达沟通', score: (d) => d.expression },
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
  return `${y}-${m}-${day}`;
}

function formatClock(startedAt: string | null, endedAt: string | null): string {
  if (!startedAt || !endedAt) return '00:00';
  const start = new Date(startedAt).getTime();
  const end = new Date(endedAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return '--:--';
  const sec = Math.max(0, Math.round((end - start) / 1000));
  const mm = String(Math.floor(sec / 60)).padStart(2, '0');
  const ss = String(sec % 60).padStart(2, '0');
  return `${mm}:${ss}`;
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

// 纸张报告「本场亮点 / 本场不足」在 mock 数据中是带分隔符的字符串，
// 这里按分隔符拆成多行文本，供每行独立渲染。
function splitLines(text: string): string[] {
  return text
    .split(/　+|(<br\s*\/?>)/i)
    .map((s) => s.replace(/<br\s*\/?>/gi, '').trim())
    .filter((s) => s !== '');
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
      const workspaceWidth = Math.max(window.innerWidth, 1);
      const workspaceHeight = Math.max(window.innerHeight - 64, 1);
      const scale = Math.min(workspaceWidth / 938, workspaceHeight / 692);
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
  const [usingMock, setUsingMock] = useState(false);
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
        if (err instanceof ApiError && err.status === 401) {
          // mock 演示模式：后端不可用，按设计稿渲染静态报告
          if (!cancelled) {
            setUsingMock(true);
            setAvailable(true);
            setInterviewMeta({
              job_title: '高级产品经理 · 增长方向',
              job_jd: '',
              created_at: '2026-08-31T10:00:00',
              started_at: '2026-08-31T10:00:00',
              ended_at: '2026-08-31T10:30:00',
            });
          }
        } else if (!cancelled) {
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

  // ── 复刻参考 #report 屏：纸张报告的数据映射 ──
  const data = usingMock
    ? {
        score: mockReport.score,
        summary: mockReport.summary,
        highlights: splitLines(mockReport.highlights),
        weaknesses: splitLines(mockReport.improvements),
        suggestions: splitLines(mockReport.next),
        dimensions: DIMENSION_ROWS.map(({ label, score }) => ({
          label,
          value: mockReport.dimensions.find((d) => d.name === label)?.value ?? score(feedback?.dimensions ?? ({} as InterviewFeedback['dimensions'])),
        })),
      }
    : feedback
      ? {
          score: feedback.total_score,
          summary: feedback.summary?.trim() || '暂无总评',
          highlights:
            feedback.strengths.length > 0
              ? feedback.strengths.map((s) => `✓ ${s}`)
              : ['暂无亮点'],
          weaknesses:
            feedback.weaknesses.length > 0
              ? feedback.weaknesses.map((w) => `• ${w}`)
              : ['暂无改进项'],
          suggestions:
            feedback.suggestions.length > 0
              ? feedback.suggestions.map((s, idx) => `${idx + 1}. ${s}`)
              : ['暂无训练建议'],
          dimensions: DIMENSION_ROWS.map(({ label, score }) => ({
            label,
            value: score(feedback.dimensions),
          })),
        }
      : null;

  // ── 复刻参考 #recordReport 屏：派生元信息与静态演示数据 ──
  const reportDate = interviewMeta?.created_at ? formatReportDate(interviewMeta.created_at) : '';
  const metaText = `${jobTitleLabel(interviewMeta)}　/　${formatClock(
    interviewMeta?.started_at ?? null,
    interviewMeta?.ended_at ?? null,
  )}`;
  const finalScore = data?.score ?? 0;
  const demoQuestions: [string, number, string][] = [
    ['01 · 自我介绍与项目背景', 88, '表达完整，已说明岗位相关经历；可补充量化成果。'],
    ['02 · 项目复盘与失败案例', 82, '结构清晰，行动部分具体；结果指标仍可更聚焦。'],
    ['03 · 增长实验的因果判断', 78, '提到“转化率提升 8%”，但未说明实验周期、分流方法和显著性判断。'],
    ['04 · 用户分层与触达策略', 81, '分层维度合理，但触达频控和渠道选择缺少数据支撑。'],
    ['05 · 指标异常波动排查', 75, '能列出排查路径，但优先级判断依据不够明确。'],
    ['06 · 竞品功能对比分析', 84, '对比框架完整，可再加入使用场景差异的讨论。'],
    ['07 · 跨部门资源协调', 80, '沟通动作清晰，建议补充对齐后的量化结果。'],
    ['08 · 增值服务变现设想', 72, '思路有新意，但商业闭环与成本收益测算偏薄弱。'],
    ['09 · 长期产品规划阐述', 85, '阶段目标明确，里程碑拆解具体，可信度较高。'],
  ];
  const demoRelated: [string, string, string, number][] = [
    ['项目管理专员', '2026-08-24 14:00', '28m36s', 76],
    ['数据分析师', '2026-08-19 10:30', '32m10s', 92],
  ];
  const prevScore = Math.max(60, finalScore - 4);
  const trackText = `本场 ${finalScore} 分，较上一场同岗位模拟（${prevScore} 分）提升 +4 分；三次同岗位成绩 78 → ${prevScore} → ${finalScore} 稳步上行，逻辑分析与表达沟通进步最明显，结论边界意识仍需通过复测验证。`;


  return (
    <div id="design-root" ref={rootRef}>
      <section className="report screen recordReport">
        <section className="workspace-page">
          <TopBar active="records" />
          <main className="workspace-main records-main">
            <section className="records-card record-report-card">
              <header className="records-card-head">
                <div>
                  <small>{reportDate}</small>
                  <h2>本场面试报告</h2>
                  <p className="rr-meta">{metaText}</p>
                </div>
                <button
                  type="button"
                  className="report-exit"
                  onClick={() => navigate(fromTrends ? '/trends' : '/history')}
                >
                  返回历史记录
                </button>
              </header>

              {loading ? (
                <div className="rp-state rr-state">
                  <p className="interview-loading">加载报告中…</p>
                </div>
              ) : error && !feedback ? (
                <div className="rp-state rr-state">
                  <p className="interview-error">{error}</p>
                  <Link className="rp-back" to="/history">
                    ← 返回列表
                  </Link>
                </div>
              ) : available === false ? (
                <div className="rp-state rr-state">
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
              ) : data ? (
                <div className="records-layout rr-block-one">
                  <article className="records-history rr-summary">
                    <header>
                      <h3>本场表现总评</h3>
                      <span className="rr-score">
                        <small>综合评分</small>
                        <strong>
                          {data.score}
                          <em>分</em>
                        </strong>
                      </span>
                    </header>
                    <p className="rr-verdict">{data.summary}</p>
                    <section className="rr-block">
                      <h4>本场亮点</h4>
                      <p>
                        {data.highlights.map((h, i) => (
                          <span key={i}>
                            {h}
                            {i < data.highlights.length - 1 ? <br /> : null}
                          </span>
                        ))}
                      </p>
                    </section>
                    <section className="rr-block">
                      <h4>本场不足</h4>
                      <p>
                        {data.weaknesses.map((w, i) => (
                          <span key={i}>
                            {w}
                            {i < data.weaknesses.length - 1 ? <br /> : null}
                          </span>
                        ))}
                      </p>
                    </section>
                    <section className="records-abilities">
                      <h3>能力维度</h3>
                      {data.dimensions.map((dim) => (
                        <p key={dim.label}>
                          <span>{dim.label}</span>
                          <i>
                            <b style={{ width: `${dim.value}%` }} />
                          </i>
                          <em>{dim.value}</em>
                        </p>
                      ))}
                    </section>
                    <section className="rr-questions-inline">
                      <h3>逐题回顾</h3>
                      {demoQuestions.map(([q, v, c]) => (
                        <article key={q} className={`rr-q ${v >= 85 ? 'good' : ''}`}>
                          <header>
                            <h4>{q}</h4>
                            <strong>{v}</strong>
                          </header>
                          <p>{c}</p>
                        </article>
                      ))}
                      <footer>
                        <b>下一步建议</b>
                        <p>
                          {data.suggestions.length > 0
                            ? data.suggestions.join('；')
                            : '暂无训练建议'}
                        </p>
                      </footer>
                    </section>
                  </article>

                  <section className="rr-related">
                    <i className="rr-divider" />
                    <header>
                      <h3>关联面试</h3>
                      <small>自动关联与本场面试岗位相关的面试记录，直观呈现你的成长轨迹</small>
                    </header>
                    <div className="rr-related-body">
                      <div className="rr-related-list">
                        {demoRelated.map(([r, dt, dur, v]) => (
                          <span key={r} className="rr-rel">
                            <b>{r}</b>
                            <strong>
                              {v}
                              <i>分</i>
                            </strong>
                            <small>{dt}&nbsp;&nbsp;面试时长{dur}</small>
                          </span>
                        ))}
                      </div>
                      <p className="rr-track">
                        <b>成长轨迹</b>
                        {trackText}
                      </p>
                    </div>
                  </section>
                </div>
              ) : null}

                    {/* 附加分析区：表达分析 / 行为信号
                        参考页不展示，保留加载逻辑，样式隐藏。 */}
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
                            <p>语速 {expression.speech_rate_cpm} 字/分钟（一般 100–200 字/分钟）</p>
                          ) : (
                            <p>本场为文字作答，无语速指标</p>
                          )}
                          {expression.fillers.length > 0 ? (
                            <p>高频口头禅：{expression.fillers.map((f) => `${f.word} ×${f.count}`).join('、')}</p>
                          ) : (
                            <p>口头禅较少，继续保持</p>
                          )}
                          {expression.avg_answer_chars > 0 ? (
                            <p>平均每答 {expression.avg_answer_chars} 字 / 平均句长 {expression.avg_sentence_chars} 字</p>
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
                      {/* 发送报告到邮箱：参考页不展示，保留逻辑，隐藏按钮 */}
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
                      </div>
                      {behavior && behavior.available && (
                        <article>
                          <h3>行为信号（辅助参考）</h3>
                          <p className="rp-note">本指标基于表情动作统计，仅供参考，不计入评分。</p>
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
                                      : (Object.entries(behavior.emotion_distribution) as [
                                          Emotion,
                                          number,
                                        ][]).map(
                                            ([k, v]) => `${EMOTION_LABELS[k] ?? k} ${pct(v)}%`,
                                          ).join(' / ')}
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
