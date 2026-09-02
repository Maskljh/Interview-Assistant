import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError } from '../api/client';
import { listInterviews, type InterviewListItem } from '../api/interviews';
import { STATUS_LABELS } from '../lib/labels';
import './InterviewPages.css';
import TopBar from '../components/TopBar';
import { mockRecords, type MockRecord } from '../lib/mockData';

/** 把面试列表项渲染为记录行数据。 */
function toRecordRow(item: InterviewListItem): {
  title: string;
  time: string;
  status: string;
  score: number | null;
  id: number;
  statusKey: string;
} {
  const title = item.job_title ? item.job_title : `面试 #${item.id}`;
  const date = new Date(item.created_at);
  const time = Number.isNaN(date.getTime())
    ? item.created_at
    : `${date.getFullYear()}.${String(date.getMonth() + 1).padStart(2, '0')}.${String(date.getDate()).padStart(2, '0')}　${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  return {
    title,
    time,
    status: STATUS_LABELS[item.status] ?? item.status,
    score: item.score ?? null,
    id: item.id,
    statusKey: item.status,
  };
}

function mockToRow(r: MockRecord, index: number): {
  title: string;
  time: string;
  status: string;
  score: number | null;
  id: number;
  statusKey: string;
} {
  return { title: r.title, time: r.time, status: '已完成', score: r.score, id: -index - 1, statusKey: 'completed' };
}

export default function InterviewListPage() {
  const navigate = useNavigate();
  const [interviews, setInterviews] = useState<InterviewListItem[]>([]);
  // mock 演示行（id 为负数），静态只读
  const mockRows = useMemo(() => mockRecords.map(mockToRow), []);
  const [usingMock, setUsingMock] = useState(false);
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
    // jsdom 等非浏览器环境没有 ResizeObserver，做存在性守卫以便测试可运行
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(compute) : null;
    ro?.observe(root);
    window.addEventListener('resize', compute);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', compute);
    };
  }, []);


  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError('');
      try {
        const data = await listInterviews();
        if (!cancelled) {
          setInterviews(data);
          setUsingMock(false);
        }
      } catch (err) {
        if (!cancelled) {
          // 后端不可用：用演示记录兜底，保证页面可看。
          // mock 演示模式下后端 401 属预期：不显示错误条，直接回退演示数据。
          if (!(err instanceof ApiError && err.status === 401)) {
            setError(err instanceof ApiError ? err.message : '加载面试列表失败');
          }
          setUsingMock(true);
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

  const rows = useMemo(() => {
    if (usingMock) return mockRows;
    return interviews.map(toRecordRow);
  }, [mockRows, interviews, usingMock]);

  // dash-metrics：累计模拟 / 最近表现 / 本周练习
  const metrics = useMemo(() => {
    if (usingMock) {
      return { total: 12, recent: 86, week: 3 };
    }
    const scored = interviews.filter((i) => i.score != null);
    const latest = interviews[0]?.score ?? null;
    const now = new Date();
    const weekStart = new Date(now);
    const day = (now.getDay() + 6) % 7;
    weekStart.setDate(now.getDate() - day);
    weekStart.setHours(0, 0, 0, 0);
    const weekCount = interviews.filter((i) => new Date(i.created_at).getTime() >= weekStart.getTime()).length;
    return {
      total: interviews.length,
      recent: latest ?? (scored.length > 0 ? Math.round(scored.reduce((a, b) => a + (b.score ?? 0), 0) / scored.length) : null),
      week: weekCount,
    };
  }, [interviews, usingMock]);

  function openReport(id: number) {
    navigate(`/interviews/${id}/report`);
  }

  return (
    <div id="design-root" ref={rootRef}>
      <section className="records screen">
        <section className="home-page records-page">
          <TopBar active="records" />
          <main className="records-main">
            <section className="records-card">
              <header className="records-card-head">
                <div>
                  <small>INTERVIEW HISTORY</small>
                  <h2>历史面试记录</h2>
                  <p>沉淀每一次模拟，复盘成长线索与能力变化。</p>
                </div>
              </header>

              <div className="records-metrics">
                <article>
                  <small>累计模拟</small>
                  <strong>{metrics.total}</strong>
                  <span>次</span>
                </article>
                <article>
                  <small>平均表现</small>
                  <strong>{metrics.recent ?? '—'}</strong>
                  <span>平均分</span>
                </article>
                <article>
                  <small>本周练习</small>
                  <strong>{metrics.week}</strong>
                  <span>次</span>
                </article>
              </div>

              <div className="records-layout">
                <article className="records-history">
                  <header>
                    <h3>历史记录</h3>
                    <small>点击查看面试报告</small>
                  </header>
                  {loading ? (
                    <p className="interview-loading">加载中…</p>
                  ) : rows.length === 0 ? (
                    <p className="record-empty">还没有面试记录，开始你的第一场练习吧。</p>
                  ) : (
                    rows.map((r) => (
                      <button key={r.id} type="button" onClick={() => openReport(r.id)}>
                        <span>
                          <b>{r.title}</b>
                          <small>{r.time}</small>
                        </span>
                        <i>{r.status}</i>
                        <strong>{r.score ?? '—'}</strong>
                        <em>查看报告</em>
                      </button>
                    ))
                  )}
                </article>

                <aside className="records-growth">
                  <header>
                    <h3>成长轨迹</h3>
                    <small>近 30 天练习趋势</small>
                  </header>
                  <div className="records-bars">
                    {[35, 54, 43, 70, 82, 97, 110].map((h, i) => (
                      <i key={i} className={i === 6 ? 'latest' : ''} style={{ height: `${h}px` }} />
                    ))}
                  </div>
                  <section className="records-abilities">
                    <h3>能力维度</h3>
                    <p><span>岗位匹配度</span><i><b style={{ width: '86%' }} /></i><em>86</em></p>
                    <p><span>业务能力</span><i><b style={{ width: '82%' }} /></i><em>82</em></p>
                    <p><span>逻辑分析</span><i><b style={{ width: '76%' }} /></i><em>76</em></p>
                    <p><span>表达沟通</span><i><b style={{ width: '71%' }} /></i><em>71</em></p>
                  </section>
                  <footer>
                    <b>本周成长建议</b>
                    <p>优先补强「应变能力」：进行 2 次追问型模拟并记录回答结构。</p>
                  </footer>
                </aside>
              </div>
            </section>
          </main>
        </section>
      </section>
    </div>
  );
}
