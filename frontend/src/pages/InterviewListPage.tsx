import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError } from '../api/client';
import {
  deleteInterview,
  listInterviews,
  startInterview,
  type InterviewListItem,
} from '../api/interviews';
import { STATUS_LABELS } from '../lib/labels';
import './InterviewPages.css';
import DesignSidebar from '../components/DesignSidebar';
import ConfirmModal from '../components/ConfirmModal';
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
  // mock 演示行：删除后本地移除（id 为负数）
  const [mockRows, setMockRows] = useState(() => mockRecords.map(mockToRow));
  const [usingMock, setUsingMock] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<{ id: number; title: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [startingId, setStartingId] = useState<number | null>(null);

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

  async function confirmDelete() {
    if (!deleteTarget) return;
    // mock 演示行（负数 id）：仅从本地列表移除，不调后端
    if (deleteTarget.id < 0) {
      setMockRows((prev) => prev.filter((r) => r.id !== deleteTarget.id));
      setDeleteTarget(null);
      return;
    }
    setDeleting(true);
    setError('');
    try {
      await deleteInterview(deleteTarget.id);
      setInterviews((prev) => prev.filter((i) => i.id !== deleteTarget.id));
      setDeleteTarget(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '删除失败');
    } finally {
      setDeleting(false);
    }
  }

  // draft 会话题目未生成：先调 startInterview 生成题目，再进入面试室
  async function handleStart(id: number) {
    setStartingId(id);
    setError('');
    try {
      await startInterview(id);
      navigate(`/interviews/${id}/room`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '开始面试失败');
      setStartingId(null);
    }
  }

  function openReport(id: number) {
    navigate(`/interviews/${id}/report`);
  }

  return (
    <div id="design-root" ref={rootRef}>
      <section className="records screen">
        <section className="workspace-page">
          <DesignSidebar active="records" />
          <main className="workspace-main">
            <section className="dash">
              <h1>面试记录</h1>
              <p>沉淀每一次模拟面试，回看表现与复盘建议</p>
              <div className="dash-metrics">
                <b>
                  累计模拟
                  <strong>{metrics.total}</strong>
                  <small>次</small>
                </b>
                <b>
                  最近表现
                  <strong>{metrics.recent ?? '—'}</strong>
                  <small>分</small>
                </b>
                <b>
                  本周练习
                  <strong>{metrics.week}</strong>
                  <small>次</small>
                </b>
              </div>
              {error && <p className="interview-error" role="alert">{error}</p>}
              <article className="record-list">
                <h2>历史记录</h2>
                {loading ? (
                  <p className="interview-loading">加载中…</p>
                ) : rows.length === 0 ? (
                  <p className="record-empty">还没有面试记录，开始你的第一场练习吧。</p>
                ) : (
                  rows.map((r) => (
                    <p key={r.id}>
                      <b title={r.title}>{r.title}</b>
                      <span>{r.time}</span>
                      <i>{r.status}</i>
                      <strong>{r.score ?? '—'}</strong>
                      <span className="record-actions">
                        <button type="button" onClick={() => openReport(r.id)}>
                          查看复盘
                        </button>
                        <button
                          type="button"
                          className="record-delete"
                          onClick={() =>
                            setDeleteTarget({ id: r.id, title: r.title })
                          }
                        >
                          删除
                        </button>
                        {!usingMock && r.statusKey === 'draft' && (
                          <button
                            type="button"
                            onClick={() => void handleStart(r.id)}
                            disabled={startingId === r.id}
                          >
                            {startingId === r.id ? '准备中…' : '开始面试'}
                          </button>
                        )}
                      </span>
                    </p>
                  ))
                )}
              </article>
            </section>
          </main>
        </section>
      </section>

      <ConfirmModal
        open={deleteTarget !== null}
        title="删除面试记录"
        description={
          deleteTarget
            ? `确定删除「${deleteTarget.title}」吗？删除后该场面试的对话、报告与行为数据将一并清除，且不可恢复。`
            : ''
        }
        confirmLabel="删除该场面试"
        loading={deleting}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
