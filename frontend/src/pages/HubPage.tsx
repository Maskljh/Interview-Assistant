import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError } from '../api/client';
import { listInterviews, type InterviewListItem } from '../api/interviews';
import { STATUS_LABELS } from '../lib/labels';
import './hub-page.css';
import TopBar from '../components/TopBar';

/** 卷宗卡色调（设计稿 dossier-card blue/amber/sage/ink 循环）。 */
const CARD_TONES = ['blue', 'amber', 'sage', 'ink'] as const;
/** 卷宗卡倾斜角（设计稿 dossierTilts）。 */
const CARD_TILTS = [-3.2, 1.6, -1.5, 2.8];

/** 把面试列表项映射为卷宗卡数据。 */
function toDossier(item: InterviewListItem, index: number): {
  label: string;
  meta: string;
  grade: string;
  tone: (typeof CARD_TONES)[number];
  tilt: number;
  id: number;
} {
  const title = item.job_title ? item.job_title : `面试 #${item.id}`;
  const date = new Date(item.created_at);
  const time = Number.isNaN(date.getTime())
    ? item.created_at
    : `${String(date.getMonth() + 1).padStart(2, '0')}.${String(date.getDate()).padStart(2, '0')}`;
  return {
    label: `案件卷宗 / ${String(index + 1).padStart(2, '0')}`,
    meta: `${time} · ${title}`,
    grade: item.score != null ? String(item.score) : STATUS_LABELS[item.status] ?? item.status,
    tone: CARD_TONES[index % CARD_TONES.length],
    tilt: CARD_TILTS[index % CARD_TILTS.length],
    id: item.id,
  };
}

export default function HubPage() {
  const navigate = useNavigate();
  const [interviews, setInterviews] = useState<InterviewListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

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
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(compute) : null;
    ro?.observe(root);
    window.addEventListener('resize', compute);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', compute);
    };
  }, []);

  // 加载真实历史面试记录填充卷宗卡
  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError('');
      try {
        const data = await listInterviews();
        if (!cancelled) setInterviews(Array.isArray(data) ? data : []);
      } catch (err) {
        if (!cancelled && !(err instanceof ApiError && err.status === 401)) {
          setError(err instanceof ApiError ? err.message : '加载面试记录失败');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const dossiers = useMemo(() => interviews.slice(0, 4).map(toDossier), [interviews]);

  return (
    <div id="design-root" ref={rootRef}>
      <section className="hub screen">
        <section className="home-page hub-page">
          <TopBar active="hub" />
          <main className="home-main hub-main">
            <section className="hub-hero">
              <div className="hub-hero-copy">
                <span className="hub-stamp">CONFIDENTIAL / 面试档案</span>
                <small>PERSONAL INTERVIEW INVESTIGATION</small>
                <h1>
                  面知，把每一场模拟
                  <br />
                  变成下一次可验证的进步
                </h1>
                <p>面试可定制、历史可复盘、进步可感知</p>
                <button
                  type="button"
                  className="hub-start"
                  onClick={() => navigate('/interviews/new/prep')}
                >
                  开始模拟面试 <i>→</i>
                </button>
              </div>
              <div className="hub-visual">
                <div className="hub-video" aria-hidden="true">
                  <img className="hub-video-logo" src="/mianzhi-ribbon-simple.svg" alt="" />
                  <span className="hub-video-rec">
                    <i />
                    REC
                  </span>
                  <span className="hub-video-tc">TC 00:12:38:17</span>
                </div>
                <div className="hub-cabinet" aria-hidden="true">
                  <em>新口供录入</em>
                  <div>
                    <i />
                    <i />
                    <i />
                    <i />
                    <i />
                    <i />
                    <i />
                  </div>
                  <span className="hub-paper-back" />
                  <strong className="hub-folder-name">INTERVIEW CASE</strong>
                </div>
              </div>
            </section>

            <section className="dossier-history">
              <header>
                <div>
                  <small>INTERVIEW HISTORY / ARCHIVED SESSIONS</small>
                  <h2>历史面试记录</h2>
                </div>
                <button type="button" className="history-more" onClick={() => navigate('/history')}>
                  更多 <i>→</i>
                </button>
              </header>
              {loading ? (
                <p className="interview-loading">加载卷宗…</p>
              ) : error ? (
                <p className="dialog-error">{error}</p>
              ) : dossiers.length === 0 ? (
                <p className="hub-empty">还没有历史面试记录，点击「开始模拟面试」开启第一场模拟。</p>
              ) : (
                <div className="dossier-grid">
                  {dossiers.map((d) => (
                    <button
                      key={d.id}
                      type="button"
                      className={`dossier-card ${d.tone}`}
                      style={{ '--tilt': `${d.tilt}deg` } as React.CSSProperties}
                      onClick={() => navigate(`/interviews/${d.id}/report`)}
                    >
                      <div>
                        <strong>{d.label}</strong>
                      </div>
                      <footer>
                        <span>{d.meta}</span>
                        <b>{d.grade}</b>
                      </footer>
                      <i />
                    </button>
                  ))}
                </div>
              )}
            </section>
          </main>
        </section>
      </section>
    </div>
  );
}
