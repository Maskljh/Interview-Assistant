import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSearchParams } from 'react-router-dom';
import { ApiError, getApiBase, getToken } from '../api/client';
import {
  deleteQuestion,
  deleteQuestions,
  listQuestions,
  patchQuestion,
  type Question,
} from '../api/questions';
import { extractResumeText } from '../lib/resumeParse';
import {
  deleteResume,
  listResumes,
  renameResume,
  uploadResume,
  type ResumeFile,
} from '../api/resumes';
import {
  createJobInfo,
  deleteJobInfo,
  listJobInfo,
  updateJobInfo,
  type JobInfoItem,
} from '../api/jobinfo';
import './InterviewPages.css';
import TopBar from '../components/TopBar';
import { recognizeImage } from '../api/ocr';
import ConfirmModal from '../components/ConfirmModal';
import QuestionImportModal from '../components/QuestionImportModal';
import homeGlow from '../assets/design/homeGlow.svg';
import homeLogo from '../assets/design/homeLogo.png';

type ManageTab = 'question' | 'resume' | 'job';

/** 题目归一：后端 Question 与 mock 题目统一成可渲染结构。 */
interface DisplayQuestion {
  id: number;
  bank: string;
  content: string;
  tags: string[];
  created: string;
}

function toDisplayQuestion(q: Question): DisplayQuestion {
  return {
    id: q.id,
    bank: q.job_tag || '未命名题库',
    content: q.question,
    tags: q.dimension ? [q.dimension] : [],
    created: q.created_at,
  };
}

const SORT_LABELS: Record<string, string> = {
  'created-desc': '添加时间：从新到旧',
  'created-asc': '添加时间：从旧到新',
};

/** 主页面：面试信息管理（题库 / 简历 / 岗位信息 3 tab）。 */
export default function ManagePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTabParam = searchParams.get('tab');
  // tab 状态持久化到 URL 查询参数（/manage?tab=job 等），刷新后停留在当前 tab。
  const activeTab: ManageTab =
    activeTabParam === 'question' || activeTabParam === 'job' || activeTabParam === 'resume'
      ? activeTabParam
      : 'resume';
  const setActiveTab = (tab: ManageTab) => {
    setSearchParams({ tab }, { replace: true });
  };
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const compute = () => {
      // v2.0：顶栏（64px）占满整宽，画布从视口宽度计算、高度扣除顶栏
      const workspaceWidth = Math.max(window.innerWidth, 1);
      const scale = Math.min(workspaceWidth / 938, (window.innerHeight - 64) / 692);
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

  return (
    <div id="design-root" ref={rootRef}>
      <section className="manage screen">
        <section className="home-page management-page">
          <TopBar active="manage" />
          <div className="home-main management-main">
            <img className="home-glow" src={homeGlow} alt="" />
            <header className="home-banner management-banner">
              <img src={homeLogo} alt="面知" />
              <div>
                <small className="management-kicker">CASEROOM</small>
                <h1>面试信息管理</h1>
                <p>管理简历、岗位信息与题库，为每次模拟提供定制化方案。</p>
              </div>
            </header>
            <section className="management-card">
              <div className="management-layout">
                <div className="management-tabs" role="tablist" aria-label="面试信息管理分类">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={activeTab === 'resume'}
                    className={activeTab === 'resume' ? 'active' : ''}
                    onClick={() => setActiveTab('resume')}
                  >
                    简历管理
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={activeTab === 'job'}
                    className={activeTab === 'job' ? 'active' : ''}
                    onClick={() => setActiveTab('job')}
                  >
                    岗位信息管理
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={activeTab === 'question'}
                    className={activeTab === 'question' ? 'active' : ''}
                    onClick={() => setActiveTab('question')}
                  >
                    题库管理
                  </button>
                </div>
                {activeTab === 'question' ? (
                  <QuestionBankPanel />
                ) : activeTab === 'resume' ? (
                  <ResumeManagementPanel />
                ) : (
                  <JobInfoManagementPanel />
                )}
              </div>
            </section>
          </div>
        </section>
      </section>
    </div>
  );
}

/** ────────── 题库管理面板 ────────── */
function QuestionBankPanel() {
  // 对话框宿主：挂到 #design-root（缩放画布外），fixed 定位相对视口、尺寸不被 --home-fit 缩放
  const portalHost =
    typeof document !== 'undefined' ? document.getElementById('design-root') : null;
  const [questions, setQuestions] = useState<DisplayQuestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // 筛选
  const [search, setSearch] = useState('');
  const [bankFilter, setBankFilter] = useState('all');
  const [tagFilter, setTagFilter] = useState('all');
  const [sort, setSort] = useState('created-desc');
  const [openDropdown, setOpenDropdown] = useState<string | null>(null);
  // 选择与批量删除
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  // 编辑 / 添加
  const [editTarget, setEditTarget] = useState<DisplayQuestion | null>(null);
  const [addBank, setAddBank] = useState<string | null>(null);
  const [editContent, setEditContent] = useState('');
  const [editTag, setEditTag] = useState('');
  const [saving, setSaving] = useState(false);
  // 删除
  const [deleteTarget, setDeleteTarget] = useState<DisplayQuestion | null>(null);
  const [deleteBank, setDeleteBank] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  // 导入
  const [importOpen, setImportOpen] = useState(false);
  // 重命名题库
  const [renamingBank, setRenamingBank] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [bankError, setBankError] = useState('');

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const items = await listQuestions();
      setQuestions(items.map(toDisplayQuestion));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '题库加载失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const banks = useMemo(() => {
    const seen = new Set<string>();
    const list: string[] = [];
    for (const q of questions) {
      if (!seen.has(q.bank)) {
        seen.add(q.bank);
        list.push(q.bank);
      }
    }
    return list;
  }, [questions]);

  const tags = useMemo(() => {
    const seen = new Set<string>();
    const list: string[] = [];
    for (const q of questions) {
      for (const t of q.tags) {
        if (!seen.has(t)) {
          seen.add(t);
          list.push(t);
        }
      }
    }
    return list;
  }, [questions]);

  const visible = useMemo(() => {
    let items = questions.filter((q) => {
      if (bankFilter !== 'all' && q.bank !== bankFilter) return false;
      if (tagFilter !== 'all' && !q.tags.includes(tagFilter)) return false;
      if (search.trim() && !q.content.toLowerCase().includes(search.trim().toLowerCase())) return false;
      return true;
    });
    if (sort === 'created-asc') {
      items = [...items].reverse();
    }
    return items;
  }, [questions, bankFilter, tagFilter, search, sort]);

  const groups = useMemo(() => {
    const map = new Map<string, DisplayQuestion[]>();
    for (const q of visible) {
      const list = map.get(q.bank) ?? [];
      list.push(q);
      map.set(q.bank, list);
    }
    return Array.from(map.entries());
  }, [visible]);

  function toggleSelect(id: number) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleBatchDelete() {
    if (selectedIds.size === 0) return;
    setDeleting(true);
    setError('');
    try {
      await deleteQuestions(Array.from(selectedIds));
      setSelectedIds(new Set());
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '批量删除失败');
    } finally {
      setDeleting(false);
    }
  }

  function openAdd(bank: string) {
    setAddBank(bank);
    setEditTarget(null);
    setEditContent('');
    setEditTag('');
  }

  function openEdit(q: DisplayQuestion) {
    setEditTarget(q);
    setAddBank(null);
    setEditContent(q.content);
    setEditTag(q.tags[0] ?? '');
  }

  async function handleSaveEdit() {
    const content = editContent.trim();
    if (!content) return;
    setSaving(true);
    setError('');
    try {
      if (editTarget) {
        await patchQuestion(editTarget.id, {
          question: content,
          ...(editTag ? { dimension: editTag } : {}),
        });
      } else if (addBank) {
        await patchQuestion(-1, { question: content, job_tag: addBank });
      }
      setEditTarget(null);
      setAddBank(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteQuestion() {
    if (!deleteTarget) return;
    setDeleting(true);
    setError('');
    try {
      await deleteQuestion(deleteTarget.id);
      setDeleteTarget(null);
      setSelectedIds((prev) => {
        const next = new Set(prev);
        next.delete(deleteTarget.id);
        return next;
      });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '删除失败');
    } finally {
      setDeleting(false);
    }
  }

  async function handleRenameBank(oldName: string, newName: string) {
    const target = newName.trim();
    if (!target || target === oldName) {
      setRenamingBank(null);
      return;
    }
    setSaving(true);
    setError('');
    try {
      const ids = questions.filter((q) => q.bank === oldName).map((q) => q.id);
      for (const id of ids) {
        await patchQuestion(id, { job_tag: target });
      }
      setRenamingBank(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '重命名失败');
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteBank() {
    if (!deleteBank) return;
    setDeleting(true);
    setError('');
    try {
      const ids = questions.filter((q) => q.bank === deleteBank).map((q) => q.id);
      await deleteQuestions(ids);
      setDeleteBank(null);
      setSelectedIds(new Set());
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '删除题库失败');
    } finally {
      setDeleting(false);
    }
  }

  function renderDropdown(
    key: string,
    label: string,
    value: string,
    options: [string, string][],
  ) {
    const selected = options.find(([v]) => v === value)?.[1] ?? options[0][1];
    return (
      <div className="question-custom-select">
        <span>{label}</span>
        <button
          type="button"
          aria-expanded={openDropdown === key}
          onClick={() => setOpenDropdown(openDropdown === key ? null : key)}
        >
          {selected}
          <i>▽</i>
        </button>
        {openDropdown === key && (
          <div className="question-dropdown-menu" role="listbox">
            {options.map(([v, l]) => (
              <button
                type="button"
                key={v}
                className={v === value ? 'selected' : ''}
                onClick={() => {
                  if (key === 'bank') setBankFilter(v);
                  if (key === 'tag') setTagFilter(v);
                  if (key === 'sort') setSort(v);
                  setOpenDropdown(null);
                }}
              >
                {l}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <section className="question-bank-page" role="tabpanel">
      <div className="question-tools">
        <label className="question-search">
          <span>搜索</span>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="输入关键词搜索"
          />
        </label>
        <div className="question-filters">
          {renderDropdown('bank', '题库', bankFilter, [
            ['all', '全部题库'],
            ...banks.map((b) => [b, b] as [string, string]),
          ])}
          {renderDropdown('tag', '标签', tagFilter, [
            ['all', '全部标签'],
            ...tags.map((t) => [t, t] as [string, string]),
          ])}
          {renderDropdown('sort', '排序', sort, [
            ['created-desc', SORT_LABELS['created-desc']],
            ['created-asc', SORT_LABELS['created-asc']],
          ])}
          {selectedIds.size > 0 && (
            <button
              className="question-batch-delete"
              type="button"
              onClick={() => void handleBatchDelete()}
              disabled={deleting}
            >
              批量删除（{selectedIds.size}）
            </button>
          )}
        </div>
        <button className="management-action" type="button" onClick={() => setImportOpen(true)}>
          导入题库
        </button>
      </div>
      {error && <p className="dialog-error" role="alert">{error}</p>}
      <div className="question-list">
        {loading ? (
          <div className="question-empty">
            <span>加载题库中…</span>
          </div>
        ) : visible.length === 0 ? (
          <div className="question-empty">
            <span>还没有匹配的题目</span>
            <small>可点击右上角「导入题库」添加题目</small>
          </div>
        ) : (
          groups.map(([bank, list]) => (
            <section className="question-bank-group" key={bank}>
              <header className="question-bank-group-head">
                {renamingBank === bank ? (
                  <input
                    className="question-bank-name-editing"
                    value={renameDraft}
                    autoFocus
                    onChange={(e) => setRenameDraft(e.target.value)}
                    onBlur={() => void handleRenameBank(bank, renameDraft)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        void handleRenameBank(bank, renameDraft);
                      }
                      if (e.key === 'Escape') setRenamingBank(null);
                    }}
                    aria-label="修改题库名称"
                  />
                ) : (
                  <strong
                    data-question-bank-name={bank}
                    onDoubleClick={() => {
                      setRenamingBank(bank);
                      setRenameDraft(bank);
                    }}
                    title="双击重命名"
                  >
                    {bank}
                  </strong>
                )}
                <span>{list.length} 道题</span>
                <div className="question-bank-actions">
                  <button
                    className="question-bank-add"
                    type="button"
                    onClick={() => openAdd(bank)}
                  >
                    添加题目
                  </button>
                  <button
                    className="question-bank-delete"
                    type="button"
                    onClick={() => setDeleteBank(bank)}
                  >
                    删除题库
                  </button>
                </div>
              </header>
              <div className="question-table" role="table">
                <div className="question-row question-table-head" role="row">
                  <span />
                  <span>序号</span>
                  <span>题目内容</span>
                  <span>所属标签</span>
                  <span>操作</span>
                </div>
                {list.map((item, index) => (
                  <div className="question-row" role="row" key={item.id}>
                    <label className="question-select-row">
                      <input
                        type="checkbox"
                        checked={selectedIds.has(item.id)}
                        onChange={() => toggleSelect(item.id)}
                        aria-label={`选择第 ${index + 1} 道题`}
                      />
                    </label>
                    <span>{index + 1}</span>
                    <strong>{item.content}</strong>
                    <span className="question-tags">
                      {item.tags.map((t) => (
                        <i key={t}>{t}</i>
                      ))}
                    </span>
                    <span className="question-row-actions">
                      <button type="button" onClick={() => openEdit(item)}>
                        编辑
                      </button>
                      <button type="button" onClick={() => setDeleteTarget(item)}>
                        删除
                      </button>
                    </span>
                  </div>
                ))}
              </div>
            </section>
          ))
        )}
      </div>

      {/* 导入题库 */}
      <QuestionImportModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={() => void load()}
        existingQuestions={questions.map((q) => q.content)}
      />

      {/* 添加 / 编辑题目：设计稿 question-add-dialog */}
      {(editTarget !== null || addBank !== null) &&
        portalHost &&
        createPortal(
        <div className="question-dialog-backdrop">
          <section
            className="question-add-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={editTarget ? '编辑题目' : '添加题目'}
          >
            <header className="question-add-dialog-head">
              <div>
                <h2>{editTarget ? '编辑题目' : '添加题目'}</h2>
                <p>
                  {editTarget
                    ? `所属题库：${editTarget.bank || '未命名题库'}`
                    : `添加至「${addBank ?? ''}」`}
                </p>
              </div>
              <button
                type="button"
                aria-label="关闭"
                onClick={() => {
                  setEditTarget(null);
                  setAddBank(null);
                  setBankError('');
                }}
              >
                ×
              </button>
            </header>
            <div className="question-add-dialog-rule" />
            <div className="question-add-dialog-body">
              <label>
                题目内容
                <textarea
                  value={editContent}
                  onChange={(e) => setEditContent(e.target.value)}
                  placeholder="请输入题目内容"
                />
              </label>
              <div className="question-tag-field">
                <span>
                  所属标签 <i>可选</i>
                </span>
                <div className="question-tag-picker">
                  {tags.map((tag) => (
                    <label key={tag}>
                      <input
                        type="checkbox"
                        checked={editTag === tag}
                        onChange={(e) => setEditTag(e.target.checked ? tag : '')}
                      />
                      <span>{tag}</span>
                    </label>
                  ))}
                </div>
                <input
                  className="question-custom-tag"
                  value={editTag}
                  onChange={(e) => setEditTag(e.target.value)}
                  placeholder="输入自定义标签，多个标签用空格或逗号分隔"
                />
              </div>
              {bankError && (
                <p className="dialog-error" role="alert">
                  {bankError}
                </p>
              )}
              <div className="question-add-dialog-actions">
                <button
                  type="button"
                  className="dialog-cancel"
                  onClick={() => {
                    setEditTarget(null);
                    setAddBank(null);
                    setBankError('');
                  }}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="management-action"
                  onClick={() => void handleSaveEdit()}
                  disabled={saving || !editContent.trim()}
                >
                  {editTarget ? '确认修改' : '确认添加'}
                </button>
              </div>
            </div>
          </section>
        </div>,
        portalHost,
      )}

      {/* 删除单题确认：设计稿 question-delete-dialog */}
      {deleteTarget !== null &&
        portalHost &&
        createPortal(
        <div className="question-dialog-backdrop">
          <section
            className="question-add-dialog question-delete-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="确认删除"
          >
            <header className="question-add-dialog-head">
              <div>
                <h2>确认删除</h2>
                <p>删除后将无法恢复这道题目</p>
              </div>
              <button type="button" aria-label="关闭" onClick={() => setDeleteTarget(null)}>
                ×
              </button>
            </header>
            <div className="question-add-dialog-rule" />
            <div className="question-delete-dialog-body">
              <p>此操作不可撤销，请确认是否继续。</p>
              <div className="question-add-dialog-actions">
                <button type="button" className="dialog-cancel" onClick={() => setDeleteTarget(null)}>
                  取消
                </button>
                <button
                  type="button"
                  className="question-delete-confirm"
                  onClick={() => void handleDeleteQuestion()}
                  disabled={deleting}
                >
                  确认删除
                </button>
              </div>
            </div>
          </section>
        </div>,
        portalHost,
      )}

      {/* 删除题库确认：设计稿 question-delete-dialog */}
      {deleteBank !== null &&
        portalHost &&
        createPortal(
        <div className="question-dialog-backdrop">
          <section
            className="question-add-dialog question-delete-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="确认删除"
          >
            <header className="question-add-dialog-head">
              <div>
                <h2>确认删除</h2>
                <p>将删除「{deleteBank}」及其全部题目</p>
              </div>
              <button type="button" aria-label="关闭" onClick={() => setDeleteBank(null)}>
                ×
              </button>
            </header>
            <div className="question-add-dialog-rule" />
            <div className="question-delete-dialog-body">
              <p>此操作不可撤销，请确认是否继续。</p>
              <div className="question-add-dialog-actions">
                <button type="button" className="dialog-cancel" onClick={() => setDeleteBank(null)}>
                  取消
                </button>
                <button
                  type="button"
                  className="question-delete-confirm"
                  onClick={() => void handleDeleteBank()}
                  disabled={deleting}
                >
                  确认删除
                </button>
              </div>
            </div>
          </section>
        </div>,
        portalHost,
      )}
    </section>
  );
}

/** 懒加载 pdfjs：只在真正渲染 PDF 预览时加载，减小首屏体积、规避测试环境 DOMMatrix 缺失。 */
async function loadPdfjs() {
  const pdfjs = await import('pdfjs-dist');
  const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  return pdfjs;
}

function isPdfName(name: string): boolean {
  return /\.pdf$/i.test(name);
}

/**
 * 内嵌简历预览：点击某条简历后，右侧面板直接渲染该简历的真实预览。
 * - PDF：pdfjs 逐页渲染为图片（还原真实排版），加载失败回退到 resume_text 文本；
 * - docx/txt/md 等：直接展示解析后的 resume_text 文本。
 */
function ResumeInlinePreview({ resume }: { resume: ResumeFile }) {
  const [pages, setPages] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [pdfFailed, setPdfFailed] = useState(false);
  const cancelRef = useRef(false);
  const isPdf = isPdfName(resume.file_url || resume.name);

  useEffect(() => {
    cancelRef.current = false;
    setPages([]);
    setError('');
    setPdfFailed(false);
    if (!isPdf) return;

    const renderPdf = async (data: ArrayBuffer) => {
      const { getDocument } = await loadPdfjs();
      const pdf = await getDocument({ data }).promise;
      const rendered: string[] = [];
      for (let i = 1; i <= pdf.numPages; i += 1) {
        if (cancelRef.current) break;
        const page = await pdf.getPage(i);
        const base = page.getViewport({ scale: 1 });
        // 按设备像素比放大渲染，避免高分屏上预览模糊；上限 2 防止超大 canvas。
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const scale = (560 / base.width) * dpr;
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        const ctx = canvas.getContext('2d');
        if (!ctx) continue;
        await page.render({ canvasContext: ctx, viewport, canvas }).promise;
        rendered.push(canvas.toDataURL('image/png'));
      }
      if (!cancelRef.current) setPages(rendered);
      await pdf.cleanup().catch(() => {});
    };

    setLoading(true);
    (async () => {
      try {
        const fileUrl = resume.file_url;
        if (fileUrl) {
          const full = fileUrl.startsWith('http')
            ? fileUrl
            : `${getApiBase()}${fileUrl}`;
          const token = getToken();
          const res = await fetch(full, {
            headers: token ? { Authorization: `Bearer ${token}` } : {},
          });
          if (!res.ok) throw new Error(`fetch ${res.status}`);
          await renderPdf(await res.arrayBuffer());
        }
      } catch {
        if (!cancelRef.current) {
          // PDF 加载/渲染失败时回退到文本预览（简历库 resume_text 仍可用）。
          if ((resume.resume_text || '').trim()) setPdfFailed(true);
          else setError('无法加载简历文件，请稍后重试');
        }
      } finally {
        if (!cancelRef.current) setLoading(false);
      }
    })();

    return () => {
      cancelRef.current = true;
    };
  }, [resume.id, resume.file_url, resume.name, isPdf]);

  // 非 PDF：直接展示解析文本。
  if (!isPdf) {
    const text = (resume.resume_text || '').trim();
    return (
      <div className="resume-inline-preview">
        {text ? (
          <pre className="resume-inline-text">{text}</pre>
        ) : (
          <span className="resume-inline-empty">该简历没有可预览的文本内容</span>
        )}
      </div>
    );
  }

  return (
    <div className="resume-inline-preview">
      {loading && <span className="resume-inline-loading">正在加载简历…</span>}
      {error && <span className="resume-inline-error">{error}</span>}
      {!loading && !error && !pdfFailed && pages.length === 0 && (
        <span className="resume-inline-empty">PDF 中没有可渲染的页面</span>
      )}
      {!loading && !error && !pdfFailed && pages.map((src, i) => (
        <img
          key={src.slice(0, 32) + String(i)}
          src={src}
          alt={`简历第 ${i + 1} 页`}
          className="resume-inline-page"
        />
      ))}
      {!loading && !error && pdfFailed && (resume.resume_text || '').trim() && (
        <>
          <span className="resume-inline-note">PDF 预览失败，已展示文本内容</span>
          <pre className="resume-inline-text">{resume.resume_text}</pre>
        </>
      )}
      {!loading && !error && pdfFailed && !(resume.resume_text || '').trim() && (
        <span className="resume-inline-empty">该简历没有可预览的文本内容</span>
      )}
    </div>
  );
}

/** ────────── 简历管理面板 ────────── */
function ResumeManagementPanel() {
  const [resumes, setResumes] = useState<ResumeFile[]>([]);
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // 进入面板时从后端加载简历库（含 file_url/resume_text），失败则回退到演示数据
  useEffect(() => {
    let cancelled = false;
    listResumes()
      .then((items) => {
        if (cancelled) return;
        setResumes(items);
      })
      .catch(() => {
        // 后端不可用时保留 mock 演示数据，不阻塞面板
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const visible = useMemo(
    () =>
      resumes.filter((r) =>
        r.name.toLowerCase().includes(search.trim().toLowerCase()),
      ),
    [resumes, search],
  );
  const selected = resumes.find((r) => r.id === selectedId) ?? null;

  async function handleUpload(file: File) {
    if (!file) return;
    if (resumes.length >= 5) {
      setError('最多上传 5 份简历');
      return;
    }
    setUploading(true);
    setError('');
    try {
      const text = await extractResumeText(file);
      // 通过后端简历库接口上传（写库 + OSS），返回带真实 id 的记录，刷新后仍可加载
      const saved = await uploadResume(file, text);
      setResumes((prev) => [saved, ...prev]);
      setSelectedId(saved.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : '简历解析失败');
    } finally {
      setUploading(false);
    }
  }

  async function handleRename(id: number) {
    const name = renameDraft.trim();
    if (!name) return;
    try {
      await renameResume(id, name);
      setResumes((prev) => prev.map((r) => (r.id === id ? { ...r, name } : r)));
      setRenamingId(null);
    } catch {
      setError('重命名失败');
    }
  }

  return (
    <section className="resume-management-panel" role="tabpanel">
      <aside className="resume-management-list">
        <div className="resume-management-tools">
          <label>
            <span>搜索</span>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索简历名称"
            />
          </label>
          <button
            type="button"
            className="management-action"
            onClick={() => fileInputRef.current?.click()}
            disabled={resumes.length >= 5 || uploading}
            title={resumes.length >= 5 ? '最多上传 5 份简历' : ''}
          >
            {uploading ? '上传中…' : '上传简历'}
          </button>
          <input
            ref={fileInputRef}
            id="manage-resume-file-input"
            type="file"
            accept=".pdf,.doc,.docx,.txt,.md,application/pdf"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) void handleUpload(file);
            }}
          />
        </div>
        <div className="resume-management-items" data-manage-resume-list>
          {visible.length === 0 ? (
            <div className="resume-management-empty">
              {resumes.length === 0 ? (
                <>
                  <span>还没有上传简历</span>
                  <small>上传后会显示在这里，供开始模拟面试时选择</small>
                </>
              ) : (
                <span>没有匹配的简历</span>
              )}
            </div>
          ) : (
            visible.map((file) => (
              <article
                key={file.id}
                className={file.id === selected?.id ? 'active' : ''}
                onClick={() => setSelectedId(file.id)}
                data-manage-resume-select={file.id}
              >
                <span className="resume-management-mark">PDF</span>
                <div>
                  {renamingId === file.id ? (
                    <input
                      value={renameDraft}
                      autoFocus
                      onChange={(e) => setRenameDraft(e.target.value)}
                      onBlur={() => handleRename(file.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleRename(file.id);
                        if (e.key === 'Escape') setRenamingId(null);
                      }}
                      aria-label="重命名简历"
                    />
                  ) : (
                    <strong>{file.name}</strong>
                  )}
                  <small>{file.updated_at}</small>
                </div>
                <nav>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setRenamingId(file.id);
                      setRenameDraft(file.name);
                    }}
                  >
                    重命名
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setDeleteId(file.id);
                    }}
                  >
                    删除
                  </button>
                </nav>
              </article>
            ))
          )}
        </div>
      </aside>
      <section className="resume-management-preview">
        <div className="resume-preview-head">
          <span>简历预览</span>
          {selected && <small>{selected.name}</small>}
        </div>
        {selected ? (
          <ResumeInlinePreview resume={selected} />
        ) : (
          <div className="resume-preview-empty">
            <span>选择简历进行预览</span>
          </div>
        )}
      </section>
      {error && <p className="dialog-error" role="alert">{error}</p>}

      <ConfirmModal
        open={deleteId !== null}
        title="删除简历"
        description="此操作不可撤销"
        body={`确认删除「${resumes.find((r) => r.id === deleteId)?.name ?? ''}」吗？`}
        onConfirm={async () => {
          if (deleteId == null) return;
          try {
            await deleteResume(deleteId);
            setResumes((prev) => prev.filter((r) => r.id !== deleteId));
            if (selectedId === deleteId) setSelectedId(null);
          } catch {
            setError('删除失败');
          } finally {
            setDeleteId(null);
          }
        }}
        onCancel={() => setDeleteId(null)}
      />

    </section>
  );
}

/** ────────── 岗位信息管理面板 ────────── */
function JobInfoManagementPanel() {
  const [items, setItems] = useState<JobInfoItem[]>([]);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState('created-desc');
  const [sortOpen, setSortOpen] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [editName, setEditName] = useState('');
  const [editContent, setEditContent] = useState('');
  // 上传图片 OCR 识别状态（设计稿 job-info-upload-dialog 的“上传图片”按钮）
  const [uploadRecognizing, setUploadRecognizing] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const jobImageInputRef = useRef<HTMLInputElement | null>(null);
  // 对话框宿主：挂到 #design-root（缩放画布外），fixed 定位相对视口、尺寸不被 --home-fit 缩放
  const portalHost =
    typeof document !== 'undefined' ? document.getElementById('design-root') : null;

  // 进入面板时从后端加载岗位信息库；失败时保持空态，不阻塞面板
  useEffect(() => {
    let cancelled = false;
    listJobInfo()
      .then((data) => {
        if (!cancelled) setItems(data);
      })
      .catch(() => {
        // 后端不可用时保持空态
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /** 上传岗位信息图片：OCR 识别后填入岗位内容。 */
  async function handleJobImage(file: File) {
    setUploadError('');
    setUploadRecognizing(true);
    try {
      const { text } = await recognizeImage(file);
      if (!text.trim()) {
        setUploadError('未识别到文字，请尝试更清晰的图片');
        return;
      }
      setEditContent(text);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : '图片识别失败';
      const rawMsg = err instanceof ApiError ? err.rawMessage : '';
      if (msg.includes('改用文本粘贴') || rawMsg.includes('unavailable')) {
        setUploadError('图片识别失败，请改用文本粘贴');
      } else {
        setUploadError(msg);
      }
    } finally {
      setUploadRecognizing(false);
    }
  }

  const visible = useMemo(() => {
    const list = items.filter((item) =>
      `${item.name} ${item.content}`.toLowerCase().includes(search.trim().toLowerCase()),
    );
    return sort === 'created-asc' ? [...list].reverse() : list;
  }, [items, search, sort]);

  function openEdit(id: number | null) {
    if (id) {
      const item = items.find((i) => i.id === id);
      if (item) {
        setEditName(item.name);
        setEditContent(item.content);
      }
    } else {
      setEditName('');
      setEditContent('');
    }
    setEditId(id);
  }

  async function handleSave() {
    const name = editName.trim();
    if (!name) return;
    try {
      if (editId != null) {
        // 更新：写入后端，成功后同步本地列表
        await updateJobInfo(editId, name, editContent.trim());
        setItems((prev) =>
          prev.map((i) => (i.id === editId ? { ...i, name, content: editContent.trim() } : i)),
        );
      } else {
        // 新建：写库并返回带真实 id 的记录，刷新后仍可加载
        const saved = await createJobInfo(name, editContent.trim());
        setItems((prev) => [saved, ...prev]);
      }
      setEditId(null);
      setUploadOpen(false);
      setUploadError('');
    } catch {
      setUploadError('保存失败，请稍后重试');
    }
  }

  return (
    <section className="job-info-management-panel" role="tabpanel">
      <div className="job-info-management-tools">
        <label>
          <span>搜索</span>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索岗位信息"
          />
        </label>
        <div className="question-custom-select job-info-sort">
          <span>排序</span>
          <button
            type="button"
            aria-expanded={sortOpen}
            onClick={() => setSortOpen((v) => !v)}
          >
            {sort === 'created-asc' ? '创建时间：从旧到新' : '创建时间：从新到旧'}
            <i>▽</i>
          </button>
          {sortOpen && (
            <div className="question-dropdown-menu" role="listbox">
              <button
                type="button"
                className={sort === 'created-desc' ? 'selected' : ''}
                onClick={() => {
                  setSort('created-desc');
                  setSortOpen(false);
                }}
              >
                创建时间：从新到旧
              </button>
              <button
                type="button"
                className={sort === 'created-asc' ? 'selected' : ''}
                onClick={() => {
                  setSort('created-asc');
                  setSortOpen(false);
                }}
              >
                创建时间：从旧到新
              </button>
            </div>
          )}
        </div>
        <button
          className="management-action"
          type="button"
          onClick={() => {
            setEditName('');
            setEditContent('');
            setUploadError('');
            setUploadOpen(true);
          }}
        >
          上传岗位信息
        </button>
      </div>
      {visible.length === 0 ? (
        <div className="job-info-management-empty">
          {items.length === 0 ? (
            <>
              <span>还没有上传岗位信息</span>
              <small>上传后会显示在这里，供开始模拟面试时选择</small>
            </>
          ) : (
            <span>没有匹配的岗位信息</span>
          )}
        </div>
      ) : (
        <div className="job-info-management-grid">
          {visible.map((item) => (
            <article key={item.id}>
              <header>
                <strong>{item.name}</strong>
                <nav>
                  <button type="button" onClick={() => openEdit(item.id)}>
                    修改
                  </button>
                  <button type="button" onClick={() => setDeleteId(item.id)}>
                    删除
                  </button>
                </nav>
              </header>
              <p>{item.content}</p>
            </article>
          ))}
        </div>
      )}

      {/* 修改岗位信息：设计稿 job-info-edit-dialog */}
      {editId !== null &&
        portalHost &&
        createPortal(
        <div className="question-dialog-backdrop">
          <section
            className="question-add-dialog job-info-edit-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="修改岗位信息"
          >
            <header className="question-add-dialog-head">
              <div>
                <h2>修改岗位信息</h2>
                <p>更新后会同步到开始面试页</p>
              </div>
              <button
                type="button"
                aria-label="关闭"
                onClick={() => setEditId(null)}
              >
                ×
              </button>
            </header>
            <div className="question-add-dialog-rule" />
            <div className="question-add-dialog-body">
              <label>
                岗位名称
                <input
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  placeholder="例如：产品经理"
                />
              </label>
              <label>
                岗位内容
                <textarea
                  value={editContent}
                  onChange={(e) => setEditContent(e.target.value)}
                  placeholder="请输入岗位信息"
                />
              </label>
              <div className="question-add-dialog-actions">
                <button
                  type="button"
                  className="dialog-cancel"
                  onClick={() => setEditId(null)}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="management-action"
                  onClick={handleSave}
                  disabled={!editName.trim()}
                >
                  保存修改
                </button>
              </div>
            </div>
          </section>
        </div>,
        portalHost,
      )}

      {/* 上传岗位信息：设计稿 job-info-upload-dialog */}
      {uploadOpen &&
        portalHost &&
        createPortal(
        <div className="question-dialog-backdrop">
          <section
            className="question-add-dialog job-info-edit-dialog job-info-upload-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="上传岗位信息"
          >
            <header className="question-add-dialog-head">
              <div>
                <h2>上传岗位信息</h2>
                <p>可直接填写，或上传本地图片自动识别</p>
              </div>
              <button
                type="button"
                aria-label="关闭"
                onClick={() => setUploadOpen(false)}
              >
                ×
              </button>
            </header>
            <div className="question-add-dialog-rule" />
            <div className="question-add-dialog-body">
              <label className="job-info-upload-name">
                岗位名称
                <button
                  type="button"
                  onClick={() => jobImageInputRef.current?.click()}
                  disabled={uploadRecognizing}
                >
                  {uploadRecognizing ? '识别中…' : '上传图片'}
                </button>
                <input
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  placeholder="例如：产品经理"
                />
              </label>
              <label>
                岗位内容
                <textarea
                  value={editContent}
                  onChange={(e) => setEditContent(e.target.value)}
                  placeholder="请输入岗位信息"
                />
              </label>
              <input
                ref={jobImageInputRef}
                type="file"
                accept=".jpg,.jpeg,.png"
                hidden
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (file) void handleJobImage(file);
                }}
              />
              {uploadError && (
                <p className="dialog-error" role="alert">
                  {uploadError}
                </p>
              )}
              <div className="question-add-dialog-actions">
                <button
                  type="button"
                  className="management-action"
                  onClick={handleSave}
                  disabled={!editName.trim()}
                >
                  确认
                </button>
              </div>
            </div>
          </section>
        </div>,
        portalHost,
      )}

      <ConfirmModal
        open={deleteId !== null}
        title="删除岗位信息"
        description="此操作不可撤销"
        body={`确认删除「${items.find((i) => i.id === deleteId)?.name ?? ''}」吗？`}
        danger
        onConfirm={async () => {
          if (deleteId == null) return;
          try {
            await deleteJobInfo(deleteId);
            setItems((prev) => prev.filter((i) => i.id !== deleteId));
            setUploadError('');
          } catch {
            setUploadError('删除失败，请稍后重试');
          } finally {
            setDeleteId(null);
          }
        }}
        onCancel={() => setDeleteId(null)}
      />
    </section>
  );
}
