import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError } from '../api/client';
import { fetchTrends, type TrendsData } from '../api/analytics';
import './InterviewPages.css';
import DesignSidebar from '../components/DesignSidebar';

const DIM_KEYS = ['expression', 'logic', 'content', 'job_match'] as const;
const DIM_LABELS: Record<(typeof DIM_KEYS)[number], string> = {
  expression: '表达能力',
  logic: '逻辑结构',
  content: '内容质量',
  job_match: '岗位匹配',
};

/** 把分数映射为设计稿柱高（px），保证视觉与数据一致。 */
function barHeight(score: number | null | undefined): number {
  if (score == null) return 6;
  return Math.max(6, Math.round(score * 1.1));
}

export default function TrendsPage() {
  const navigate = useNavigate();
  const [data, setData] = useState<TrendsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

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
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(compute) : null;
    ro?.observe(root);
    window.addEventListener('resize', compute);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', compute);
    };
  }, []);


  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await fetchTrends({});
      setData(result);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '加载成长分析失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const s = data?.summary;
  const points = data?.points ?? [];
  const recent = points.slice(-7);

  // 各维度平均分（用于「能力维度」）
  const dimAvg = (() => {
    if (points.length === 0) return null;
    const sums: Record<string, number> = { expression: 0, logic: 0, content: 0, job_match: 0 };
    for (const p of points) {
      for (const k of DIM_KEYS) sums[k] += p[k] ?? 0;
    }
    return DIM_KEYS.map((k) => ({
      name: DIM_LABELS[k],
      value: Math.round(sums[k] / points.length),
    }));
  })();

  // 连续练习天数
  const consecutive = (() => {
    let n = 0;
    for (let i = recent.length - 1; i >= 0; i -= 1) {
      if (recent[i].total != null) n += 1;
      else break;
    }
    return n;
  })();

  // 最弱维度（用于成长建议）
  const weakestDim = (() => {
    if (!dimAvg || dimAvg.length === 0) return null;
    return dimAvg.reduce((a, b) => (b.value < a.value ? b : a));
  })();

  // dash-metrics 数据：综合表现 / 累计练习 / 完成目标
  const metrics = {
    score: String(s?.avg_score ?? '—'),
    total: `${s?.total_sessions ?? 0}`,
    goal: `${consecutive}`,
  };

  const bars = recent.map((p) => barHeight(p.total));
  const dims = dimAvg ?? [];
  const tip = weakestDim
    ? `优先补强「${weakestDim.name}」：结合真实项目案例加强表达，并在复盘中记录每次回答的结构。`
    : '积累更多面试场次后，再定位需要优先补齐的能力维度。';

  return (
    <div id="design-root" ref={rootRef}>
      <section className="growth screen">
        <section className="workspace-page">
          <DesignSidebar active="growth" />
          <main className="workspace-main">
            <section className="dash">
              <h1>成长看板</h1>
              <p>用练习数据记录能力变化，让下一次准备更有方向</p>
              <div className="dash-metrics">
                <b>
                  综合表现
                  <strong>{metrics.score}</strong>
                  <small>分</small>
                </b>
                <b>
                  累计练习
                  <strong>{metrics.total}</strong>
                  <small>场</small>
                </b>
                <b>
                  连续练习
                  <strong>{metrics.goal}</strong>
                  <small>场</small>
                </b>
              </div>
              {error && <p className="interview-error" role="alert">{error}</p>}
              {loading ? (
                <p className="interview-loading">加载中…</p>
              ) : (
                <>
                  <div className="dash-grid">
                    <article>
                      <h2>近 {Math.max(bars.length, 1)} 场练习趋势</h2>
                      <div className="bars">
                        {bars.map((h, i) => (
                          <i
                            key={i}
                            style={{ height: typeof h === 'number' ? h : barHeight(h) }}
                            className={i === bars.length - 1 ? 'latest' : ''}
                          />
                        ))}
                      </div>
                    </article>
                    <article>
                      <h2>能力维度</h2>
                      {dims.map((d) => (
                        <p key={d.name}>
                          {d.name}
                          <span>
                            <i style={{ width: `${d.value}%` }} />
                          </span>
                          {d.value}
                        </p>
                      ))}
                    </article>
                  </div>
                  <article className="dash-tip">
                    <h2>本周成长建议</h2>
                    <p>{tip}</p>
                    <button type="button" onClick={() => navigate('/interviews/new')}>
                      开始练习
                    </button>
                  </article>
                </>
              )}
            </section>
          </main>
        </section>
      </section>
    </div>
  );
}
