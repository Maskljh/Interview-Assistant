import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError } from '../api/client';
import {
  Bar,
  BarChart,
  Cell,
  LabelList,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from 'recharts';
import { fetchTrends, type TrendsData, type TrendsSource } from '../api/analytics';
import type { InterviewMode } from '../api/interviews';
import './InterviewPages.css';
import AppNav from '../components/AppNav';

const MODE_OPTIONS: { value: InterviewMode; label: string }[] = [
  { value: 'behavioral', label: '行为面试' },
  { value: 'technical', label: '技术面试' },
  { value: 'mixed', label: '综合面试' },
];

const SOURCE_TABS: { value: TrendsSource; label: string }[] = [
  { value: 'regular', label: '常规面试' },
  { value: 'bank', label: '题库练习' },
];

const DIM_KEYS = ['expression', 'logic', 'content', 'job_match'] as const;
const DIM_LABELS: Record<(typeof DIM_KEYS)[number], string> = {
  expression: '表达能力',
  logic: '逻辑结构',
  content: '内容质量',
  job_match: '岗位匹配',
};

/** 柱状图蓝色透明度渐变（Figma #1A52C7，0.55 → 0.9） */
const BAR_OPACITIES = [0.55, 0.62, 0.69, 0.76, 0.83, 0.9];

export default function TrendsPage() {
  const navigate = useNavigate();
  const [data, setData] = useState<TrendsData | null>(null);
  const [jobTag, setJobTag] = useState('');
  const [mode, setMode] = useState('');
  const [source, setSource] = useState<TrendsSource>('regular');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await fetchTrends({
        ...(jobTag ? { job_tag: jobTag } : {}),
        ...(mode ? { mode: mode as InterviewMode } : {}),
        source,
      });
      setData(result);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '加载成长分析失败');
    } finally {
      setLoading(false);
    }
  }, [jobTag, mode, source]);

  useEffect(() => {
    void load();
  }, [load]);

  const s = data?.summary;
  const points = data?.points ?? [];

  // 最近 6 场（按返回顺序取最后 6 条，倒序展示为第1场→第6场）
  const recent6 = points.slice(-6);

  // 连续练习：从最近一场往前数，最近连续有分数的场次
  const consecutive = (() => {
    let n = 0;
    for (let i = recent6.length - 1; i >= 0; i -= 1) {
      if (recent6[i].total != null) n += 1;
      else break;
    }
    return n;
  })();

  // 优先短板：所有场次中各维度平均分最低的一项
  const weakestDim = (() => {
    if (points.length === 0) return null;
    const sums: Record<string, number> = { expression: 0, logic: 0, content: 0, job_match: 0 };
    for (const p of points) {
      for (const k of DIM_KEYS) sums[k] += p[k] ?? 0;
    }
    let minKey: (typeof DIM_KEYS)[number] | null = null;
    let minAvg = Infinity;
    for (const k of DIM_KEYS) {
      const avg = sums[k] / points.length;
      if (avg < minAvg) {
        minAvg = avg;
        minKey = k;
      }
    }
    return minKey ? DIM_LABELS[minKey] : null;
  })();

  // 保持强项：所有场次中各维度平均分最高的一项
  const strongestDim = (() => {
    if (points.length === 0) return null;
    const sums: Record<string, number> = { expression: 0, logic: 0, content: 0, job_match: 0 };
    for (const p of points) {
      for (const k of DIM_KEYS) sums[k] += p[k] ?? 0;
    }
    let maxKey: (typeof DIM_KEYS)[number] | null = null;
    let maxAvg = -Infinity;
    for (const k of DIM_KEYS) {
      const avg = sums[k] / points.length;
      if (avg > maxAvg) {
        maxAvg = avg;
        maxKey = k;
      }
    }
    return maxKey ? DIM_LABELS[maxKey] : null;
  })();

  // 波动关注：各维度跨场次标准差最大的一项
  const volatileDim = (() => {
    if (points.length < 3) return null;
    const means: Record<string, number> = { expression: 0, logic: 0, content: 0, job_match: 0 };
    for (const k of DIM_KEYS) {
      means[k] = points.reduce((a, p) => a + (p[k] ?? 0), 0) / points.length;
    }
    let maxKey: (typeof DIM_KEYS)[number] | null = null;
    let maxStd = -Infinity;
    for (const k of DIM_KEYS) {
      const variance =
        points.reduce((a, p) => a + ((p[k] ?? 0) - means[k]) ** 2, 0) / points.length;
      const std = Math.sqrt(variance);
      if (std > maxStd) {
        maxStd = std;
        maxKey = k;
      }
    }
    return maxKey ? DIM_LABELS[maxKey] : null;
  })();

  // 训练计划：基于维度分数的 3 条建议（弱项 / 强项 / 波动），数据不足时给出通用文案
  const planItems = [
    weakestDim
      ? { title: `1. ${weakestDim}专项`, desc: '优先补齐最低分维度，结合真实项目案例加强表达。' }
      : { title: '1. 综合能力专项', desc: '积累更多面试场次后，再定位需要优先补齐的维度。' },
    strongestDim
      ? { title: `2. 保持${strongestDim}优势`, desc: '在稳定发挥优势维度的同时，思考如何把优势迁移到其他环节。' }
      : { title: '2. 保持优势维度', desc: '完成更多场次后，识别稳定高分项并持续巩固。' },
    volatileDim
      ? { title: `3. 关注${volatileDim}波动`, desc: '该维度跨场次波动较大，建议针对不稳定因素做专项复盘。' }
      : { title: '3. 复盘稳定性', desc: '完成更多场次后，观察各维度跨场波动，定位发挥不稳定的环节。' },
  ];

  const barData = recent6.map((p, i) => ({
    name: `第${i + 1}场`,
    score: p.total,
    sessionId: p.session_id,
    fillOpacity: BAR_OPACITIES[i] ?? 0.9,
  }));

  return (
    <div className="interview-page">
      <AppNav tab="trends" />
      <main className="interview-main interview-main--wide">
        <h1>成长看板</h1>
        <p className="interview-subtitle">把单场反馈转化为下一轮可验证的改进。</p>

        {error && <p className="interview-error">{error}</p>}

        <div className="trends-tabs">
          {SOURCE_TABS.map((tab) => (
            <button
              key={tab.value}
              type="button"
              className={`trends-tab${source === tab.value ? ' trends-tab-active' : ''}`}
              onClick={() => setSource(tab.value)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="interview-filter-row">
          <select value={jobTag} onChange={(e) => setJobTag(e.target.value)}>
            <option value="">全部岗位</option>
            {data?.job_tags.map((tag) => (
              <option key={tag} value={tag}>
                {tag}
              </option>
            ))}
          </select>
          <select value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="">全部模式</option>
            {MODE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        {loading ? (
          <p className="interview-loading">加载中…</p>
        ) : data && data.points.length === 0 ? (
          <p className="interview-empty">
            {source === 'bank'
              ? '还没有题库练习记录，去题库页选择题目开始练习吧。'
              : '还没有已完成评分的常规面试，完成一场面试后再来看成长趋势吧。'}
          </p>
        ) : data ? (
          <>
            {/* 4 个统计卡 */}
            <div className="trends-figma-stats">
              <div className="trends-figma-stat">
                <span className="trends-figma-stat-label">本周训练</span>
                <span className="trends-figma-stat-value">{s?.total_sessions} 场</span>
              </div>
              <div className="trends-figma-stat">
                <span className="trends-figma-stat-label">平均得分</span>
                <span className="trends-figma-stat-value">{s?.avg_score}</span>
              </div>
              <div className="trends-figma-stat">
                <span className="trends-figma-stat-label">连续练习</span>
                <span className="trends-figma-stat-value">{consecutive} 场</span>
              </div>
              <div className="trends-figma-stat">
                <span className="trends-figma-stat-label">优先短板</span>
                <span className="trends-figma-stat-value">{weakestDim ?? '—'}</span>
              </div>
            </div>

            {/* 下排：柱状图 + 下一步训练计划 */}
            <div className="trends-figma-grid">
              <section className="trends-figma-card trends-figma-chart-card">
                <h2 className="trends-figma-card-title">近 {recent6.length} 场综合得分</h2>
                <div className="trends-figma-chart">
                  <ResponsiveContainer width="100%" height={300}>
                    <BarChart data={barData} margin={{ top: 24, right: 16, bottom: 8, left: -20 }}>
                      <XAxis
                        dataKey="name"
                        tick={{ fontSize: 12, fill: '#131e2b' }}
                        axisLine={{ stroke: '#e3e0d8' }}
                        tickLine={false}
                      />
                      <YAxis domain={[0, 100]} tick={{ fontSize: 12, fill: '#8b95a3' }} axisLine={false} tickLine={false} />
                      <Bar
                        dataKey="score"
                        radius={[8, 8, 0, 0]}
                        barSize={64}
                        onClick={(entry: any) => {
                          if (entry?.sessionId) {
                            navigate(`/interviews/${entry.sessionId}/report?from=trends`);
                          }
                        }}
                      >
                        <LabelList dataKey="score" position="top" offset={24} style={{ fontSize: 12, fill: '#131e2b' }} />
                        {barData.map((entry, i) => (
                          <Cell
                            key={i}
                            fill="#1a52c7"
                            fillOpacity={entry.fillOpacity}
                            cursor="pointer"
                          />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </section>

              <section className="trends-figma-card trends-figma-plan-card">
                <h2 className="trends-figma-card-title">下一步训练计划</h2>
                {planItems.map((item) => (
                  <div key={item.title} className="trends-figma-plan-item">
                    <p className="trends-figma-plan-title">{item.title}</p>
                    <p className="trends-figma-plan-desc">{item.desc}</p>
                  </div>
                ))}
                <Link className="trends-figma-plan-btn" to="/interviews/new">
                  安排下一次练习
                </Link>
              </section>
            </div>
          </>
        ) : null}
      </main>
    </div>
  );
}
