import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError } from '../api/client';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
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

const DIM_LINES: { key: 'expression' | 'logic' | 'content' | 'job_match'; label: string }[] = [
  { key: 'expression', label: '表达能力' },
  { key: 'logic', label: '逻辑结构' },
  { key: 'content', label: '内容质量' },
  { key: 'job_match', label: '岗位匹配' },
];

const DIM_COLORS: Record<string, string> = {
  expression: '#0070f3',
  logic: '#7928ca',
  content: '#f5a623',
  job_match: '#50e3c2',
};

// 自定义 Tooltip 内容，确保每个节点显示正确的分数
function TotalTooltipContent({ active, payload }: any) {
  if (!active || !payload?.length) return null;
  const point = payload[0]?.payload;
  return (
    <div style={{
      background: '#fff',
      border: '1px solid #e8e8e8',
      borderRadius: 8,
      padding: '8px 12px',
      boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
      fontSize: 13,
      lineHeight: 1.5,
    }}>
      <div style={{ fontWeight: 500, marginBottom: 2 }}>{point?.date}</div>
      <div>{payload[0]?.value} 分 · {point?.job_tag}</div>
    </div>
  );
}

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

  return (
    <div className="interview-page">
      <AppNav
        tab="trends"
        actions={[{ to: '/', label: '面试列表' }]}
      />
      <main className="interview-main">
        <h1>成长分析</h1>
        <p className="interview-subtitle">查看历史面试的分数趋势与维度变化。</p>

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
            <div className="trends-summary-grid">
              <div className="trends-summary-card">
                <span className="trends-summary-label">面试场次</span>
                <span className="trends-summary-value">{s?.total_sessions}</span>
              </div>
              <div className="trends-summary-card">
                <span className="trends-summary-label">平均分</span>
                <span className="trends-summary-value">{s?.avg_score}</span>
              </div>
              <div className="trends-summary-card">
                <span className="trends-summary-label">最高分</span>
                <span className="trends-summary-value">{s?.max_score}</span>
              </div>
              <div className="trends-summary-card">
                <span className="trends-summary-label">最低分</span>
                <span className="trends-summary-value">{s?.min_score}</span>
              </div>
              <div className="trends-summary-card">
                <span className="trends-summary-label">最近 vs 最早</span>
                <span
                  className={`trends-summary-value${
                    (s?.delta ?? 0) >= 0 ? ' trends-delta-up' : ' trends-delta-down'
                  }`}
                >
                  {(s?.delta ?? 0) >= 0 ? `+${s?.delta}` : `${s?.delta}`}
                </span>
              </div>
            </div>

            <h2 className="interview-section-title">总分趋势</h2>
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={data.points.map((p, i) => ({ ...p, idx: i }))}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="idx" tick={{ fontSize: 12 }} />
                <YAxis domain={[0, 100]} />
                <Tooltip content={<TotalTooltipContent />} />
                <Line
                  type="monotone"
                  dataKey="total"
                  name="总分"
                  stroke="#171717"
                  strokeWidth={2}
                  dot={(props: any) => {
                    const { cx, cy, payload } = props;
                    return (
                      <circle
                        cx={cx}
                        cy={cy}
                        r={5}
                        fill="#171717"
                        stroke="#fff"
                        strokeWidth={2}
                        style={{ cursor: 'pointer' }}
                        onClick={() => navigate(`/interviews/${payload.session_id}/report`)}
                      />
                    );
                  }}
                />
              </LineChart>
            </ResponsiveContainer>

            <h2 className="interview-section-title">维度趋势</h2>
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={data.points.map((p, i) => ({ ...p, idx: i }))}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="idx" tick={{ fontSize: 12 }} />
                <YAxis domain={[0, 100]} />
                <Tooltip />
                <Legend />
                {DIM_LINES.map((dim) => (
                  <Line
                    key={dim.key}
                    type="monotone"
                    dataKey={dim.key}
                    name={dim.label}
                    stroke={DIM_COLORS[dim.key]}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </>
        ) : null}
      </main>
    </div>
  );
}
