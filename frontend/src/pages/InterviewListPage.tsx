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

/** 设计稿 v2.1 能力维度静态值。 */
const ABILITIES: [string, number][] = [
  ['岗位匹配度', 86],
  ['业务能力', 82],
  ['逻辑分析', 76],
  ['表达沟通', 71],
];

/** 设计稿 y 轴刻度与网格基线（由低到高，score-plot 内 bottom 定位）。 */
const SCORE_GRIDS = [66, 48, 30, 12];
const SCORE_YAXIS = [
  { label: '90', bottom: 62 },
  { label: '80', bottom: 44 },
  { label: '70', bottom: 26 },
  { label: '60', bottom: 8 },
];

export default function InterviewListPage() {
  const navigate = useNavigate();
  const [interviews, setInterviews] = useState<InterviewListItem[]>([]);
  // mock 演示行（id 为负数），静态只读
  const mockRows = useMemo(() => mockRecords.map(mockToRow), []);
  const [usingMock, setUsingMock] = useState(false);
  const [loading, setLoading] = useState(true);
  const [, setError] = useState('');
  // 过滤状态：岗位关键字 + 岗位下拉
  const [keyword, setKeyword] = useState('');
  const [roleFilter, setRoleFilter] = useState('');

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

  // 岗位下拉可选项（全部 + 去重岗位）
  const roleOptions = useMemo(() => {
    const set = new Set<string>();
    rows.forEach((r) => set.add(r.title));
    return [...set];
  }, [rows]);

  // 依据搜索关键字 + 岗位下拉过滤历史行
  const filteredRows = useMemo(() => {
    const kw = keyword.trim();
    return rows.filter((r) => {
      const matchKeyword = !kw || r.title.includes(kw) || r.time.includes(kw);
      const matchRole = !roleFilter || r.title === roleFilter;
      return matchKeyword && matchRole;
    });
  }, [rows, keyword, roleFilter]);

  // growth-metrics：累计模拟 / 平均表现
  const metrics = useMemo(() => {
    if (usingMock) {
      return { total: 12, recent: 86 };
    }
    const scored = interviews.filter((i) => i.score != null);
    const latest = interviews[0]?.score ?? null;
    return {
      total: interviews.length,
      recent: latest ?? (scored.length > 0 ? Math.round(scored.reduce((a, b) => a + (b.score ?? 0), 0) / scored.length) : null),
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

              <div className="records-layout">
                {/* 左侧：成长档案（growth，order:1） */}
                <aside className="records-growth">
                  <div className="growth-metrics">
                    <p><span>累计模拟</span><b>{metrics.total}<i>次</i></b></p>
                    <p><span>平均表现</span><b>{metrics.recent ?? '—'}<i>分</i></b></p>
                  </div>

                  <div className="score-chart">
                    <div className="score-chart-head">
                      <h4>历次得分</h4>
                      <small>SCORE TIMELINE</small>
                    </div>
                    <div className="score-plot">
                      {SCORE_GRIDS.map((b) => (
                        <i key={b} className="score-grid" style={{ bottom: `${b}px` }} />
                      ))}
                      <div className="score-yaxis">
                        {SCORE_YAXIS.map((y) => (
                          <span key={y.label} style={{ bottom: `${y.bottom}px` }}>{y.label}</span>
                        ))}
                      </div>
                      <div className="score-bars">
                        {/* 设计稿间隔48px+柱宽26px，容器可用宽457px最多容纳 6 根 */}
                        {filteredRows.slice(0, 6).map((r) => {
                          const sc = r.score ?? 0;
                          const h = Math.max(Math.round((sc - 60) * 1.8), 2);
                          const label = r.time.length >= 5 ? r.time.slice(5, 10) : '';
                          return (
                            <span key={r.id}>
                              <b>{sc}</b>
                              <i style={{ height: `${h}px` }} />
                              <small>{label}</small>
                            </span>
                          );
                        })}
                      </div>
                    </div>
                  </div>

                  <section className="records-abilities">
                    <h3>各能力维度平均得分</h3>
                    {ABILITIES.map(([name, value]) => (
                      <p key={name}>
                        <span>{name}</span>
                        <i><b style={{ width: `${value}%` }} /></i>
                        <em>{value}</em>
                      </p>
                    ))}
                  </section>

                  <footer>
                    <b>本周成长建议</b>
                    <p>优先补强「应变能力」：进行 2 次追问型模拟并记录回答结构。</p>
                  </footer>
                </aside>

                {/* 右侧：历史台帐（history，order:2） */}
                <article className="records-history">
                  <header>
                    <h3>历史记录</h3>
                  </header>
                  <div className="history-filters">
                    <input
                      className="history-search"
                      type="text"
                      placeholder="搜索面试岗位"
                      value={keyword}
                      onChange={(e) => setKeyword(e.target.value)}
                    />
                    <select
                      className="history-role"
                      value={roleFilter}
                      onChange={(e) => setRoleFilter(e.target.value)}
                    >
                      <option value="">全部岗位</option>
                      {roleOptions.map((r) => (
                        <option key={r} value={r}>{r}</option>
                      ))}
                    </select>
                  </div>
                  <div className="history-divider" />
                  <div className="records-history-list">
                    {loading ? (
                      <p className="interview-loading">加载中…</p>
                    ) : filteredRows.length === 0 ? (
                      <p className="record-empty">还没有面试记录，开始你的第一场练习吧。</p>
                    ) : (
                      filteredRows.map((r) => (
                        <button key={r.id} type="button" onClick={() => openReport(r.id)}>
                          <span>
                            <p className="row-head">
                              <b>{r.title}</b>
                              <i>{r.status}</i>
                            </p>
                            <small>{r.time.replace(/\./g, '-')}&nbsp;&nbsp;面试时长30m00s</small>
                          </span>
                          <strong>{r.score ?? '—'}</strong>
                          <em>查看报告</em>
                        </button>
                      ))
                    )}
                  </div>
                </article>
              </div>
            </section>
          </main>
        </section>
      </section>
    </div>
  );
}
