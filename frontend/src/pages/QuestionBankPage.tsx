import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError } from '../api/client';
import {
  deleteQuestion,
  listQuestions,
  patchQuestion,
  type Question,
} from '../api/questions';
import { DIMENSION_LABELS } from '../lib/labels';
import './InterviewPages.css';
import AppNav from '../components/AppNav';
import ConfirmModal from '../components/ConfirmModal';
import QuestionImportModal from '../components/QuestionImportModal';
import Dialog from '../components/Dialog';

/** 本周开始的时间戳（周一 00:00） */
function startOfWeek(now = new Date()): number {
  const d = new Date(now);
  const day = (d.getDay() + 6) % 7; // 周一到周日
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - day);
  return d.getTime();
}

export default function QuestionBankPage() {
  const [questions, setQuestions] = useState<Question[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<Question | null>(null);
  const [deleting, setDeleting] = useState(false);

  // 筛选
  const [activeTag, setActiveTag] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');

  // 导入 / 编辑弹窗
  const [importOpen, setImportOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<Question | null>(null);
  const [saving, setSaving] = useState(false);

  const loadQuestions = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await listQuestions();
      setQuestions(data);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '加载题库失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadQuestions();
  }, [loadQuestions]);

  // 标签列表：从题目维度去重生成
  const tags = useMemo(() => {
    const set = new Set<string>();
    for (const q of questions) {
      if (q.dimension) set.add(q.dimension);
    }
    return [...set].sort();
  }, [questions]);

  // 概览：总数 + 本周新增
  const totalCount = questions.length;
  const weekStart = useMemo(() => startOfWeek(), []);
  const weekNew = useMemo(
    () => questions.filter((q) => new Date(q.created_at).getTime() >= weekStart).length,
    [questions, weekStart],
  );

  // 过滤后的题目列表
  const filtered = useMemo(() => {
    let list = questions;
    if (activeTag !== 'all') {
      list = list.filter((q) => q.dimension === activeTag);
    }
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      list = list.filter((item) => item.question.toLowerCase().includes(q));
    }
    return list;
  }, [questions, activeTag, searchQuery]);

  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await deleteQuestion(deleteTarget.id);
      setQuestions((prev) => prev.filter((q) => q.id !== deleteTarget.id));
      setDeleteTarget(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '删除失败');
    } finally {
      setDeleting(false);
    }
  }

  async function handleSaveEdit() {
    if (!editTarget) return;
    const question = editTarget.question.trim();
    if (!question) {
      setError('题干不能为空');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const updated = await patchQuestion(editTarget.id, {
        question: editTarget.question,
        answer: editTarget.answer ?? '',
        job_tag: editTarget.job_tag ?? '',
        dimension: editTarget.dimension ?? '',
      });
      setQuestions((prev) => prev.map((q) => (q.id === updated.id ? updated : q)));
      setEditTarget(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="interview-page">
      <AppNav tab="questions" />
      <main className="interview-main interview-main--wide">
        <div className="question-bank-head">
          <div>
            <h1>面试信息管理</h1>
            <p className="interview-subtitle">
              导入、维护你的专属问题；也可以在面试中让 AI 自主动态提问。
            </p>
          </div>
          <button
            type="button"
            className="question-bank-new-btn"
            onClick={() => setImportOpen(true)}
          >
            ＋ 新建题目
          </button>
        </div>

        {error && <p className="interview-error">{error}</p>}

        {/* 概览卡 */}
        <div className="question-bank-overview">
          <div className="question-bank-overview-card">
            <span className="question-bank-overview-num">{totalCount}</span>
            <span className="question-bank-overview-label">题库题目总数</span>
          </div>
          <div className="question-bank-overview-card">
            <span className="question-bank-overview-num question-bank-overview-num--blue">
              {weekNew}
            </span>
            <span className="question-bank-overview-label">本周新增题目</span>
          </div>
        </div>

        {/* 标签胶囊筛选 + 搜索 */}
        <div className="question-bank-filter-row">
          <div className="question-bank-tags">
            <button
              type="button"
              className={`question-bank-tag${activeTag === 'all' ? ' is-active' : ''}`}
              onClick={() => setActiveTag('all')}
            >
              全部 {totalCount}
            </button>
            {tags.map((tag) => (
              <button
                key={tag}
                type="button"
                className={`question-bank-tag${activeTag === tag ? ' is-active' : ''}`}
                onClick={() => setActiveTag(tag)}
              >
                {DIMENSION_LABELS[tag] ?? tag}
              </button>
            ))}
          </div>
          <div className="question-bank-search">
            <span className="question-bank-search-icon" aria-hidden="true">⌕</span>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="搜索题目关键词"
            />
          </div>
        </div>

        {/* 题目列表 */}
        <div className="question-bank-list-head">
          <h2>题目列表</h2>
          <span className="question-bank-sort">最近添加↓</span>
        </div>

        {loading ? (
          <p className="interview-loading">加载中…</p>
        ) : filtered.length === 0 ? (
          <div className="interview-empty">
            <p>
              {questions.length === 0
                ? '题库暂无题目。完成面试后可将题目存入题库。'
                : '没有匹配的题目，换个关键词或筛选条件试试。'}
            </p>
          </div>
        ) : (
          <ul className="question-bank-flat-list">
            {filtered.map((item, index) => (
              <li key={item.id} className="question-bank-flat-row">
                <span className="question-bank-no">
                  {String(index + 1).padStart(2, '0')}
                </span>
                <div className="question-bank-row-main">
                  <p className="question-bank-row-question">{item.question}</p>
                  <div className="question-bank-row-tags">
                    {item.dimension && (
                      <span className="question-bank-row-tag">
                        {DIMENSION_LABELS[item.dimension] ?? item.dimension}
                      </span>
                    )}
                    {item.job_tag && (
                      <span className="question-bank-row-tag">{item.job_tag}</span>
                    )}
                  </div>
                </div>
                <span className="question-bank-usage">
                  {item.usage_count > 0 ? `已使用 ${item.usage_count} 次` : '未使用'}
                </span>
                <div className="question-bank-row-actions">
                  <button
                    type="button"
                    className="question-bank-edit-btn"
                    onClick={() => setEditTarget(item)}
                  >
                    编辑
                  </button>
                  <button
                    type="button"
                    className="question-bank-delete-btn"
                    onClick={() => setDeleteTarget(item)}
                  >
                    删除
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

        <QuestionImportModal
          open={importOpen}
          onClose={() => setImportOpen(false)}
          onImported={() => void loadQuestions()}
        />
      </main>

      <ConfirmModal
        open={deleteTarget !== null}
        title="删除题目"
        description={
          deleteTarget
            ? `确定删除这道题目吗？\n「${deleteTarget.question.slice(0, 50)}」`
            : ''
        }
        confirmLabel="删除这道题目"
        loading={deleting}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleteTarget(null)}
      />

      {/* 编辑题目弹窗 */}
      <Dialog
        open={editTarget !== null}
        title="编辑题目"
        onClose={() => setEditTarget(null)}
        width={560}
        footer={
          <>
            <button type="button" className="btn btn--secondary" onClick={() => setEditTarget(null)}>
              取消
            </button>
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => void handleSaveEdit()}
              disabled={saving}
            >
              {saving ? '保存中…' : '保存'}
            </button>
          </>
        }
      >
        {editTarget && (
          <div className="dialog-field">
            <label htmlFor="edit-question">题干</label>
            <textarea
              id="edit-question"
              value={editTarget.question}
              onChange={(e) => setEditTarget({ ...editTarget, question: e.target.value })}
              placeholder="输入题目…"
            />
            <label htmlFor="edit-answer">参考答案</label>
            <textarea
              id="edit-answer"
              value={editTarget.answer ?? ''}
              onChange={(e) => setEditTarget({ ...editTarget, answer: e.target.value })}
              placeholder="参考答案（可选）…"
            />
            <label htmlFor="edit-job-tag">岗位标签</label>
            <input
              id="edit-job-tag"
              type="text"
              value={editTarget.job_tag ?? ''}
              onChange={(e) => setEditTarget({ ...editTarget, job_tag: e.target.value })}
              placeholder="如：前端开发工程师"
            />
            <label htmlFor="edit-dimension">维度</label>
            <select
              id="edit-dimension"
              value={editTarget.dimension ?? ''}
              onChange={(e) => setEditTarget({ ...editTarget, dimension: e.target.value })}
            >
              <option value="">无</option>
              {Object.entries(DIMENSION_LABELS).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </div>
        )}
      </Dialog>
    </div>
  );
}
