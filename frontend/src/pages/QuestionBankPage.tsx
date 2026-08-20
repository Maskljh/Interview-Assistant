import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError } from '../api/client';
import {
  createInterviewFromBank,
  type InputMode,
  type InterviewMode,
  type Persona,
} from '../api/interviews';
import {
  deleteQuestion,
  listQuestions,
  patchQuestion,
  type Question,
} from '../api/questions';
import { useAuth } from '../auth/AuthContext';
import { DIMENSION_LABELS, PERSONA_LABELS } from '../lib/labels';
import './InterviewPages.css';
import MobileTabBar from '../components/MobileTabBar';

const MODE_OPTIONS: { value: InterviewMode; label: string }[] = [
  { value: 'behavioral', label: '行为面试' },
  { value: 'technical', label: '技术面试' },
  { value: 'mixed', label: '综合' },
];

const INPUT_MODE_OPTIONS: { value: InputMode; label: string }[] = [
  { value: 'text', label: '文本' },
  { value: 'voice', label: '语音' },
];

const PERSONAS: Persona[] = ['standard', 'strict_tech', 'warm_hr', 'stress'];

function toggleSelected(ids: number[], id: number): number[] {
  const index = ids.indexOf(id);
  if (index >= 0) {
    return [...ids.slice(0, index), ...ids.slice(index + 1)];
  }
  return [...ids, id];
}

/** 按 source_session_id 分组，无来源的单独一组 */
function groupBySession(questions: Question[]) {
  const groups = new Map<number | null, Question[]>();
  for (const q of questions) {
    const key = q.source_session_id ?? null;
    const arr = groups.get(key) ?? [];
    arr.push(q);
    groups.set(key, arr);
  }
  // 有 session 的在前（按 session id 倒序），无 session 的在后
  const sorted = [...groups.entries()].sort((a, b) => {
    if (a[0] === null) return 1;
    if (b[0] === null) return -1;
    return b[0] - a[0];
  });
  return sorted;
}

export default function QuestionBankPage() {
  const { logout } = useAuth();
  const navigate = useNavigate();

  const [questions, setQuestions] = useState<Question[]>([]);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(false);

  const [starredOnly, setStarredOnly] = useState(false);
  const [jobTag, setJobTag] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [dimension, setDimension] = useState('');
  const [mode, setMode] = useState<InterviewMode>('mixed');
  const [inputMode, setInputMode] = useState<InputMode>('text');
  const [persona, setPersona] = useState<Persona>('standard');

  // 展开的题目 ID 集合
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());
  // 展开的分组 session ID 集合
  const [expandedGroups, setExpandedGroups] = useState<Set<number | null>>(new Set());

  const loadQuestions = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await listQuestions({
        ...(starredOnly ? { starred: true } : {}),
        ...(jobTag.trim() ? { job_tag: jobTag.trim() } : {}),
        ...(searchQuery.trim() ? { q: searchQuery.trim() } : {}),
        ...(dimension ? { dimension } : {}),
      });
      setQuestions(data);
      setSelectedIds((prev) =>
        prev.filter((id) => data.some((item) => item.id === id)),
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '加载题库失败');
    } finally {
      setLoading(false);
    }
  }, [starredOnly, jobTag, searchQuery, dimension]);

  useEffect(() => {
    void loadQuestions();
  }, [loadQuestions]);

  const groups = useMemo(() => groupBySession(questions), [questions]);

  function toggleExpand(id: number) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleGroup(sessionId: number | null) {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  }

  async function handleToggleStar(item: Question) {
    const next = !item.starred;
    try {
      const updated = await patchQuestion(item.id, { starred: next });
      setQuestions((prev) =>
        prev.map((q) => (q.id === item.id ? updated : q)),
      );
      if (starredOnly && !next) {
        setQuestions((prev) => prev.filter((q) => q.id !== item.id));
        setSelectedIds((prev) => prev.filter((id) => id !== item.id));
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '更新收藏失败');
    }
  }

  async function handleDelete(item: Question) {
    if (!window.confirm('确定删除这道题目吗？')) return;
    try {
      await deleteQuestion(item.id);
      setQuestions((prev) => prev.filter((q) => q.id !== item.id));
      setSelectedIds((prev) => prev.filter((id) => id !== item.id));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '删除失败');
    }
  }

  async function handleStartPractice() {
    if (selectedIds.length === 0) {
      setError('请至少选择一道题目');
      return;
    }
    setStarting(true);
    setError('');
    try {
      const interview = await createInterviewFromBank({
        question_ids: selectedIds,
        mode,
        input_mode: inputMode,
        persona,
      });
      navigate(`/interviews/${interview.id}/room`, { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '创建练习失败');
    } finally {
      setStarting(false);
    }
  }

  return (
    <div className="interview-page">
      <header className="interview-header">
        <Link className="interview-brand" to="/">
          面试助手
        </Link>
        <div className="interview-header-actions">
          <Link className="interview-header-link header-nav-link" to="/">
            面试列表
          </Link>
          <span className="interview-header-link header-nav-link" aria-current="page">
            题库
          </span>
          <Link className="interview-header-link header-nav-link" to="/trends">
            成长分析
          </Link>
          <button type="button" className="interview-header-link" onClick={logout}>
            退出
          </button>
        </div>
      </header>

      <main className="interview-main">
        <h1>题库</h1>
        <p className="interview-subtitle">按面试分组浏览，收藏、筛选并多选题目开始练习</p>

        <div className="question-bank-filters">
          <div className="interview-field">
            <label htmlFor="job-tag-filter">岗位标签</label>
            <input
              id="job-tag-filter"
              type="text"
              value={jobTag}
              onChange={(e) => setJobTag(e.target.value)}
              placeholder="按岗位标签筛选…"
            />
          </div>
          <div className="interview-field">
            <label htmlFor="search-q">搜索</label>
            <input
              id="search-q"
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="搜索题干…"
            />
          </div>
          <div className="interview-field">
            <label htmlFor="dimension-filter">维度</label>
            <select
              id="dimension-filter"
              value={dimension}
              onChange={(e) => setDimension(e.target.value)}
            >
              <option value="">全部维度</option>
              {Object.entries(DIMENSION_LABELS).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <label className="question-bank-checkbox-label">
            <input
              type="checkbox"
              checked={starredOnly}
              onChange={(e) => setStarredOnly(e.target.checked)}
            />
            仅收藏
          </label>
        </div>

        {error && <p className="interview-error">{error}</p>}

        {loading ? (
          <p className="interview-loading">加载中…</p>
        ) : questions.length === 0 ? (
          <div className="interview-empty">
            <p>题库暂无题目。完成面试后可将题目存入题库。</p>
          </div>
        ) : (
          <div className="question-bank-groups">
            {groups.map(([sessionId, items]) => {
              const groupExpanded = expandedGroups.has(sessionId);
              const sampleTag = items[0]?.job_tag;
              const sampleDate = items[0]?.created_at?.slice(0, 10);
              return (
                <div key={sessionId ?? 'none'} className="question-group">
                  <button
                    type="button"
                    className="question-group-header"
                    onClick={() => toggleGroup(sessionId)}
                  >
                    <span className="question-group-arrow">{groupExpanded ? '▾' : '▸'}</span>
                    <span className="question-group-title">
                      {sessionId ? `面试 #${sessionId}` : '独立题目'}
                    </span>
                    {sampleTag && <span className="mode-pill">{sampleTag}</span>}
                    {sampleDate && <span className="question-group-date">{sampleDate}</span>}
                    <span className="question-group-count">{items.length} 题</span>
                  </button>

                  {groupExpanded && (
                    <ul className="interview-list question-group-list">
                      {items.map((item) => {
                        const checked = selectedIds.includes(item.id);
                        const expanded = expandedIds.has(item.id);
                        return (
                          <li key={item.id} className="interview-list-item question-bank-row">
                            <label className="question-bank-select">
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() =>
                                  setSelectedIds((prev) => toggleSelected(prev, item.id))
                                }
                              />
                            </label>
                            <div className="interview-list-meta question-bank-content">
                              <button
                                type="button"
                                className="question-bank-text question-bank-expand-btn"
                                onClick={() => toggleExpand(item.id)}
                              >
                                <span className="question-bank-arrow">{expanded ? '▾' : '▸'}</span>
                                {item.question}
                              </button>
                              {item.dimension && (
                                <span className="mode-pill">
                                  {DIMENSION_LABELS[item.dimension] ?? item.dimension}
                                </span>
                              )}

                              {expanded && (
                                <div className="question-detail">
                                  {item.user_answer && (
                                    <div className="question-detail-section">
                                      <span className="question-detail-label">你的作答</span>
                                      <p className="question-detail-content question-detail-user">
                                        {item.user_answer}
                                      </p>
                                    </div>
                                  )}
                                  {item.answer && (
                                    <div className="question-detail-section">
                                      <span className="question-detail-label">参考答案</span>
                                      <p className="question-detail-content">
                                        {item.answer}
                                      </p>
                                    </div>
                                  )}
                                  {!item.user_answer && !item.answer && (
                                    <p className="question-detail-empty">暂无作答记录</p>
                                  )}
                                </div>
                              )}
                            </div>
                            <div className="interview-list-links">
                              <button
                                type="button"
                                className="interview-inline-link question-bank-star"
                                onClick={() => void handleToggleStar(item)}
                                aria-label={item.starred ? '取消收藏' : '收藏'}
                              >
                                {item.starred ? '★' : '☆'}
                              </button>
                              <button
                                type="button"
                                className="interview-inline-link"
                                onClick={() => void handleDelete(item)}
                              >
                                删除
                              </button>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <div className="question-bank-actions">
          <span className="question-bank-selected">
            已选 {selectedIds.length} 题
          </span>
          <div className="interview-field question-bank-mode">
            <label htmlFor="practice-mode">模式</label>
            <select
              id="practice-mode"
              value={mode}
              onChange={(e) => setMode(e.target.value as InterviewMode)}
            >
              {MODE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <div className="interview-field question-bank-mode">
            <label htmlFor="practice-input-mode">作答方式</label>
            <select
              id="practice-input-mode"
              value={inputMode}
              onChange={(e) => setInputMode(e.target.value as InputMode)}
            >
              {INPUT_MODE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <div className="interview-field question-bank-mode">
            <label htmlFor="practice-persona">面试官风格</label>
            <select
              id="practice-persona"
              value={persona}
              onChange={(e) => setPersona(e.target.value as Persona)}
            >
              {PERSONAS.map((value) => (
                <option key={value} value={value}>
                  {PERSONA_LABELS[value]}
                </option>
              ))}
            </select>
          </div>
          <button
            type="button"
            className="interview-submit"
            disabled={starting || selectedIds.length === 0}
            onClick={() => void handleStartPractice()}
          >
            {starting ? '创建中…' : '开始练习'}
          </button>
        </div>
      </main>
      <MobileTabBar />
    </div>
  );
}
