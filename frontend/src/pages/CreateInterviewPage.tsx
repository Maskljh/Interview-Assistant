import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError } from '../api/client';
import {
  createInterview,
  createInterviewFromBank,
  startInterview,
} from '../api/interviews';
import { recognizeImage } from '../api/ocr';
import { listQuestions, type Question } from '../api/questions';
import { extractResumeText } from '../lib/resumeParse';
import { uploadFile } from '../api/uploads';
import { listResumes, type ResumeFile } from '../api/resumes';
import { listCloudFiles, importCloudFile, type WpsCloudFile } from '../api/wps';
import './InterviewPages.css';
import AppNav from '../components/AppNav';
import Dialog from '../components/Dialog';
import ResumePreviewModal from '../components/ResumePreviewModal';

/** 从 JD 文本提取岗位名：取第一个非空行，截断到 12 字。 */
function jobTitleFromJd(jd: string): string {
  const firstLine = jd
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!firstLine) return '';
  const normalized = firstLine.replace(/^[#*\-•\s]+/, '').replace(/[：:].*$/, '').trim();
  return normalized.slice(0, 12);
}

/** 格式化云文档修改时间（Unix 秒 → YYYY.MM.DD）。 */
function formatCloudMtime(mtime: number): string {
  if (!mtime) return '未知时间';
  const d = new Date(mtime * 1000);
  if (Number.isNaN(d.getTime())) return '未知时间';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}.${m}.${day}`;
}

/** 把后端返回的 base64 内容还原为 File，供前端复用 extractResumeText 解析。 */
function base64ToFile(base64: string, name: string, mimeType: string): File {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new File([bytes], name, { type: mimeType });
}

/**
 * 开始面试（准备页）—— 按新版 Figma「01 开始面试-初始化状态」(node 148:104) 还原。
 * 单页「面试间准备」：面试岗位 / 个人简历 / 岗位信息 / 选择题库 四卡片 + 底部开始按钮。
 * 复用现有后端接口：JD 上传/OCR、简历上传/简历库、题库选择、createInterview(from-bank)。
 */
export default function CreateInterviewPage() {
  const navigate = useNavigate();
  // ── 面试岗位 / 岗位信息（JD）──
  const [jobJd, setJobJd] = useState('');
  const [jdFileName, setJdFileName] = useState('');
  const [jdFileUrl, setJdFileUrl] = useState('');
  const [jdUploading, setJdUploading] = useState(false);
  const [jdProgress, setJdProgress] = useState(0);
  const [jdOcrName, setJdOcrName] = useState('');
  const [jdOcrRecognizing, setJdOcrRecognizing] = useState(false);
  const [jdError, setJdError] = useState('');
  const [jdDragging, setJdDragging] = useState(false);
  // ── 个人简历 ──
  const [resumeText, setResumeText] = useState('');
  const [resumeFileName, setResumeFileName] = useState('');
  const [resumeFileUrl, setResumeFileUrl] = useState('');
  const [resumeUploading, setResumeUploading] = useState(false);
  const [resumeProgress, setResumeProgress] = useState(0);
  const [resumeParsing, setResumeParsing] = useState(false);
  const [resumeError, setResumeError] = useState('');
  const [resumeDragging, setResumeDragging] = useState(false);
  // ── 选择题库 ──
  const [bankQuestions, setBankQuestions] = useState<Question[]>([]);
  const [bankLoading, setBankLoading] = useState(false);
  const [bankError, setBankError] = useState('');
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  // 题库勾选上限与推荐范围（需求确认：硬上限 10，推荐 5~8）。
  const MAX_BANK_QUESTIONS = 10;
  const BANK_RECOMMEND_MIN = 5;
  const BANK_RECOMMEND_MAX = 8;
  // 已选题目详情（用于卡片内列表展示）
  const selectedQuestions = useMemo(
    () =>
      selectedIds
        .map((id) => bankQuestions.find((q) => q.id === id))
        .filter((q): q is Question => Boolean(q)),
    [selectedIds, bankQuestions],
  );
  // 单项目提示：勾选的题目都来自同一个 job_tag 时，提示 AI 会补充简历其他项目/经历的题目。
  const selectedJobTags = useMemo(
    () => Array.from(new Set(selectedQuestions.map((q) => q.job_tag).filter(Boolean))),
    [selectedQuestions],
  );
  const singleProjectHint = selectedIds.length > 0 && selectedJobTags.length === 1;

  // ── 通用 ──
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  // 模态编辑态：resume=简历导入、resumeChoose=简历来源选择、resumePick=从简历库挑选、
  // wpsCloud=从 WPS 云文档选择、jd=岗位 JD 编辑、bank=选择题库
  const [modal, setModal] = useState<
    'resume' | 'resumeChoose' | 'resumePick' | 'wpsCloud' | 'jd' | 'bank' | null
  >(null);
  const [libraryResumes, setLibraryResumes] = useState<ResumeFile[]>([]);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [libraryError, setLibraryError] = useState('');
  // ── 从 WPS 云文档选择 ──
  const [cloudFiles, setCloudFiles] = useState<WpsCloudFile[]>([]);
  const [cloudLoading, setCloudLoading] = useState(false);
  const [cloudError, setCloudError] = useState('');
  const [cloudKeyword, setCloudKeyword] = useState('');
  const [cloudImporting, setCloudImporting] = useState(false);
  // ── 简历预览 ──
  const [previewTitle, setPreviewTitle] = useState('');
  const [previewText, setPreviewText] = useState('');
  const [previewFile, setPreviewFile] = useState<File | null>(null);
  const [previewFileUrl, setPreviewFileUrl] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  // ── 整体缩放壳：固定 1440 设计稿内容区（1222×900）等比缩放，任何分辨率下比例与原型一致 ──
  // 设计稿为 1440×900，去掉左侧 218 侧边栏后内容区 1222×900；等比缩放到可用区域并居中。
  const shellRef = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const el = shellRef.current;
    if (!el) return;
    const compute = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      setScale(Math.min(w / 1222, h / 900));
    };
    compute();
    // jsdom 等非浏览器环境没有 ResizeObserver，做存在性守卫以便测试可运行
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(compute) : null;
    ro?.observe(el);
    window.addEventListener('resize', compute);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', compute);
    };
  }, []);

  /** 解析并上传简历；成功返回 true，失败返回 false（错误信息写入 resumeError）。 */
  async function handleResumeFile(file: File): Promise<boolean> {
    if (!file) return false;

    const allowed = ['.txt', '.md', '.pdf', '.docx', 'text/plain', 'application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
    const ext = file.name.toLowerCase().match(/\.[^.]+$/)?.[0] ?? '';
    if (!allowed.includes(ext) && !file.type.startsWith('text/')) {
      setResumeError('不支持的文件类型，请上传 .txt、.md、.pdf 或 .docx 文件');
      return false;
    }
    if (file.size > 10 * 1024 * 1024) {
      setResumeError('文件不能超过 10MB');
      return false;
    }

    setResumeError('');
    setResumeParsing(true);
    setResumeUploading(true);
    setResumeProgress(0);
    setResumeFileUrl('');
    try {
      const text = await extractResumeText(file);
      setResumeText(text);
      setResumeFileName(file.name);
      // 上传原文件到 OSS 存档；失败不阻断（文本仍可用）
      try {
        const upload = await uploadFile('resume', file);
        setResumeFileUrl(upload.url);
        setResumeProgress(100);
      } catch (uploadErr) {
        setResumeError(
          uploadErr instanceof Error
            ? `简历文件上传失败：${uploadErr.message}（文本已解析可用）`
            : '简历文件上传失败（文本已解析可用）',
        );
      }
      return true;
    } catch (err) {
      setResumeText('');
      setResumeFileName('');
      setResumeFileUrl('');
      setResumeError(err instanceof Error ? err.message : '简历解析失败');
      return false;
    } finally {
      setResumeParsing(false);
      setResumeUploading(false);
    }
  }

  function clearResume() {
    setResumeText('');
    setResumeFileName('');
    setResumeFileUrl('');
  }

  /** 打开「从简历库挑选」弹窗并加载简历列表。 */
  async function openResumePick() {
    setModal('resumePick');
    setLibraryError('');
    setLibraryLoading(true);
    setLibraryResumes([]);
    try {
      const items = await listResumes();
      setLibraryResumes(items);
    } catch {
      setLibraryError('简历库加载失败');
    } finally {
      setLibraryLoading(false);
    }
  }

  /** 从简历库选中一份：用它已有的文本与文件 URL 生成本次面试的简历。 */
  function pickResume(item: ResumeFile) {
    setResumeText(item.resume_text ?? '');
    setResumeFileName(item.name);
    setResumeFileUrl(item.file_url);
    setModal(null);
    setResumeError('');
  }

  /** 打开「从 WPS 云文档选择」弹窗：不预取文件，提示用户输入关键词搜索。 */
  function openWpsCloud() {
    setModal('wpsCloud');
    setCloudError('');
    setCloudKeyword('');
    setCloudLoading(false);
    setCloudFiles([]);
  }

  /** 按关键词搜索云文档简历候选文件。 */
  async function searchCloudFiles() {
    setCloudError('');
    setCloudLoading(true);
    try {
      const data = await listCloudFiles(cloudKeyword);
      if (data.error) {
        // 搜索失败（权限未开通等）：展示真实原因，避免误判为「未找到匹配」。
        setCloudFiles([]);
        setCloudError(data.error);
      } else {
        setCloudFiles(data.items);
        setCloudError('');
      }
    } catch {
      setCloudError('云文档搜索失败，请稍后重试');
    } finally {
      setCloudLoading(false);
    }
  }

  /** 预览简历库中的简历：PDF 用文件渲染，其他展示解析文本。 */
  function previewLibraryResume(item: ResumeFile) {
    setPreviewTitle(item.name);
    setPreviewText(item.resume_text ?? '');
    setPreviewFile(null);
    setPreviewFileUrl(item.file_url || null);
    setPreviewOpen(true);
  }

  /** 预览云文档简历：先导入拿文件内容，PDF 渲染页面，其他解析文本展示。 */
  async function previewCloudFile(item: WpsCloudFile) {
    setCloudError('');
    setCloudImporting(true);
    try {
      const result = await importCloudFile(item);
      const file = base64ToFile(result.base64, result.name, result.mime_type);
      if (/^\.pdf$/i.test(result.name.slice(result.name.lastIndexOf('.')))) {
        setPreviewTitle(result.name);
        setPreviewText('');
        setPreviewFile(file);
        setPreviewFileUrl(null);
        setPreviewOpen(true);
      } else {
        const text = await extractResumeText(file);
        setPreviewTitle(result.name);
        setPreviewText(text);
        setPreviewFile(null);
        setPreviewFileUrl(null);
        setPreviewOpen(true);
      }
    } catch (err) {
      setCloudError(
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : '预览失败，请稍后重试',
      );
    } finally {
      setCloudImporting(false);
    }
  }

  /** 选中云文档文件：后端下载转 base64，前端复用解析逻辑提取简历文本。 */
  async function pickCloudFile(item: WpsCloudFile) {
    setCloudImporting(true);
    setCloudError('');
    try {
      const result = await importCloudFile(item);
      const file = base64ToFile(result.base64, result.name, result.mime_type);
      setResumeError('');
      setResumeParsing(true);
      const text = await extractResumeText(file);
      setResumeText(text);
      setResumeFileName(result.name);
      setResumeFileUrl('');
      setModal(null);
    } catch (err) {
      setCloudError(
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : '云文档简历导入失败，请重试',
      );
    } finally {
      setCloudImporting(false);
      setResumeParsing(false);
    }
  }

  /** 统一处理 JD 上传：图片走 OCR，其他走文本解析；成功把内容填入职位描述框。 */
  async function handleJdDrop(file: File): Promise<boolean> {
    if (!file) return false;

    const isImage = file.type.startsWith('image/');
    const isDoc =
      file.type === 'text/plain' ||
      file.type === 'application/pdf' ||
      file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      /\.(txt|md|pdf|docx)$/i.test(file.name);

    if (!isImage && !isDoc) {
      setJdError('不支持的文件类型，请上传 .txt、.md、.pdf、.docx 或图片');
      return false;
    }

    if (file.size > 10 * 1024 * 1024) {
      setJdError('文件不能超过 10MB');
      return false;
    }

    setJdError('');
    if (isImage) {
      setJdOcrRecognizing(true);
      setJdOcrName(file.name);
      try {
        const { text } = await recognizeImage(file);
        if (!text.trim()) {
          setJdOcrName('');
          setJdError('未识别到文字，请尝试更清晰的图片');
          return false;
        }
        setJobJd(text);
        return true;
      } catch (err) {
        setJdOcrName('');
        const msg = err instanceof ApiError ? err.rawMessage : '';
        const ux = err instanceof ApiError ? err.message : '图片识别失败';
        if (msg.includes('unavailable') || ux.includes('改用文本粘贴')) {
          setJdError('图片识别失败，请改用文本粘贴');
        } else {
          setJdError(ux);
        }
        return false;
      } finally {
        setJdOcrRecognizing(false);
      }
    }

    // 文档文件：解析文本
    setJdUploading(true);
    setJdProgress(0);
    setJdFileUrl('');
    try {
      const text = await extractResumeText(file);
      setJobJd(text);
      setJdFileName(file.name);
      try {
        const upload = await uploadFile('jd', file);
        setJdFileUrl(upload.url);
        setJdProgress(100);
      } catch (uploadErr) {
        setJdError(
          uploadErr instanceof Error
            ? `JD 文件上传失败：${uploadErr.message}（文本已填入可用）`
            : 'JD 文件上传失败（文本已填入可用）',
        );
      }
      return true;
    } catch (err) {
      setJdFileName('');
      setJdFileUrl('');
      setJdError(err instanceof Error ? err.message : 'JD 文件解析失败');
      return false;
    } finally {
      setJdUploading(false);
    }
  }

  function clearJd() {
    setJobJd('');
    setJdFileName('');
    setJdFileUrl('');
    setJdError('');
  }

  /** 打开「选择题库」弹窗并加载题库列表。 */
  async function openBankPicker() {
    setModal('bank');
    setBankError('');
    setBankLoading(true);
    setBankQuestions([]);
    try {
      const items = await listQuestions();
      setBankQuestions(items);
    } catch {
      setBankError('题库加载失败');
    } finally {
      setBankLoading(false);
    }
  }

  function toggleQuestion(id: number) {
    if (!selectedIds.includes(id) && selectedIds.length >= MAX_BANK_QUESTIONS) {
      setBankError(`最多选择 ${MAX_BANK_QUESTIONS} 题，请先取消部分已选题目`);
      return;
    }
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  /** 从已选列表移除一道题。 */
  function removeQuestion(id: number) {
    setSelectedIds((prev) => prev.filter((x) => x !== id));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    const trimmedJd = jobJd.trim();
    if (!trimmedJd) {
      setError('请填写岗位信息');
      return;
    }
    if (!resumeText.trim()) {
      setError('请上传或填写简历');
      return;
    }
    setLoading(true);
    try {
      const trimmedResume = resumeText.trim();
      if (selectedIds.length > 0) {
        // 题库练习：用选中的题目创建面试，同时携带岗位信息与简历参与定制。
        const created = await createInterviewFromBank({
          question_ids: selectedIds,
          mode: 'mixed',
          input_mode: 'voice',
          job_jd: trimmedJd,
          ...(trimmedResume ? { resume_text: trimmedResume } : {}),
          ...(resumeFileUrl ? { resume_file_url: resumeFileUrl } : {}),
          ...(jdFileUrl ? { jd_file_url: jdFileUrl } : {}),
        });
        await startInterview(created.id);
        navigate(`/interviews/${created.id}/room`, { replace: true });
        return;
      }
      const created = await createInterview({
        job_jd: trimmedJd,
        mode: 'mixed',
        input_mode: 'voice',
        ...(trimmedResume ? { resume_text: trimmedResume } : {}),
        ...(resumeFileUrl ? { resume_file_url: resumeFileUrl } : {}),
        ...(jdFileUrl ? { jd_file_url: jdFileUrl } : {}),
      });
      await startInterview(created.id);
      navigate(`/interviews/${created.id}/room`, { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '创建面试失败');
    } finally {
      setLoading(false);
    }
  }

  const jobTitle = jobTitleFromJd(jobJd);

  return (
    <div className="interview-page">
      <AppNav tab="create" />
      <div className="prep-scale-shell" ref={shellRef}>
        <div className="prep-scale-stage" style={{ transform: `scale(${scale})` }}>
          <main className="interview-main interview-main--wide interview-prep-new">
        {/* 顶部品牌区：左 logo + 右两行 slogan */}
        <div className="prep-new-brand">
          <img className="prep-new-logo" src="/logo.png" alt="面知" />
          <div className="prep-new-brand-text">
            <p className="prep-new-slogan">面知，把每一场模拟变成下一次可验证的进步</p>
            <p className="prep-new-slogan-sub">面试可定制、历史可复盘、进步可感知</p>
          </div>
        </div>

        {/* ── 面试间准备 容器 ── */}
        <div className="prep-new-panel">
          <h1 className="prep-new-title">面试间准备</h1>
          <div className="prep-new-accent" aria-hidden="true" />
          <p className="prep-new-subtitle">
            选择面试岗位开始面试，上传简历、岗位信息并选择意向题库后可进一步进行定制化面试
          </p>

          {/* 面试岗位行：标题 + 米色占位条（点击打开岗位信息） */}
          <div className="prep-new-job">
            <div className="prep-new-job-title">
              <h2 className="prep-new-card-title">面试岗位</h2>
            </div>
            <button
              type="button"
              className="prep-new-job-field"
              onClick={() => setModal('jd')}
              aria-label="选择面试岗位"
            >
              {jobTitle ? (
                <span className="prep-new-job-text">{jobTitle}</span>
              ) : (
                <span className="prep-new-job-text">点击选择 ▽</span>
              )}
            </button>
          </div>

          {/* 左列：个人简历 + 岗位信息；右列：选择题库 */}
          <div className="prep-new-cols">
            <div className="prep-new-col-left">
              {/* 个人简历 */}
              <section className="prep-new-card prep-new-card--resume">
                <h2 className="prep-new-card-title">个人简历</h2>
                <div className="prep-new-resume-right">
                  {resumeFileName && (
                    <span className="prep-new-resume-file" title={resumeFileName}>
                      {resumeFileName}
                    </span>
                  )}
                  <button
                    type="button"
                    className="prep-new-btn prep-new-btn--upload"
                    onClick={() => setModal('resumeChoose')}
                  >
                    {resumeFileName ? '替换' : '上传'}
                  </button>
                </div>
              </section>

              {/* 岗位信息 */}
              <section className="prep-new-card prep-new-card--jd">
                <div className="prep-new-card-head">
                  <h2 className="prep-new-card-title">岗位信息</h2>
                  <div className="prep-new-card-actions">
                    <button
                      type="button"
                      className="prep-new-btn prep-new-btn--select"
                      onClick={() => setModal('jd')}
                    >
                      选择
                    </button>
                    <button
                      type="button"
                      className="prep-new-btn prep-new-btn--save"
                      onClick={() => setModal('jd')}
                    >
                      保存
                    </button>
                  </div>
                </div>
                <div className="prep-new-jd-area">
                  {jobJd.trim() ? (
                    <p className="prep-new-jd-text">{jobJd.trim()}</p>
                  ) : (
                    <p className="prep-new-jd-empty">
                      暂无岗位信息，请输入后点击保存或从系统中选择
                    </p>
                  )}
                </div>
              </section>
            </div>

            {/* 右列：选择题库 */}
            <section className="prep-new-card prep-new-card--bank">
              <div className="prep-new-card-head">
                <h2 className="prep-new-card-title">选择题库</h2>
                <div className="prep-new-card-actions">
                  {selectedIds.length > 0 && (
                    <span className="prep-new-bank-count">
                      共 {selectedIds.length} 题 · 建议 {BANK_RECOMMEND_MIN}~{BANK_RECOMMEND_MAX} 题
                    </span>
                  )}
                  <button
                    type="button"
                    className="prep-new-btn prep-new-btn--import"
                    onClick={() => void openBankPicker()}
                  >
                    导入
                  </button>
                </div>
              </div>
              <div className="prep-new-bank-area">
                {selectedIds.length > 0 ? (
                  <>
                  <div className="prep-new-bank-list">
                    {selectedQuestions.map((q, i) => (
                      <div key={q.id} className="prep-new-bank-item">
                        <span className="prep-new-bank-no">{String(i + 1).padStart(2, '0')}</span>
                        <span className="prep-new-bank-q">{q.question}</span>
                        <button
                          type="button"
                          className="prep-new-bank-del"
                          onClick={() => removeQuestion(q.id)}
                          aria-label={`删除第 ${i + 1} 题`}
                        >
                          删除
                        </button>
                      </div>
                    ))}
                  </div>
                  {singleProjectHint && (
                    <p className="prep-new-bank-hint">
                      所选题目都来自同一项目，AI 将补充简历中其他项目/经历的题目。
                    </p>
                  )}
                  </>
                ) : (
                  <p className="prep-new-bank-empty">暂无题目，请导入</p>
                )}
              </div>
            </section>
          </div>

          {/* 开始模拟面试按钮 */}
          <form className="prep-new-form" onSubmit={handleSubmit}>
            {error && <p className="interview-error">{error}</p>}
            <button
              type="submit"
              className="prep-new-start"
              disabled={loading || resumeParsing}
            >
              {loading ? '正在开始面试…' : '开始模拟面试'}
            </button>
          </form>
        </div>

        {/* ─── 简历来源选择 Modal：自己上传 / 从简历库挑选 ─── */}
        <Dialog
          open={modal === 'resumeChoose'}
          title="导入简历"
          onClose={() => {
            setModal(null);
            setResumeError('');
          }}
          width={420}
        >
          <div className="resume-choose-options">
            <button
              type="button"
              className="resume-choose-option"
              onClick={() => setModal('resume')}
            >
              <span className="resume-choose-option-title">自己上传</span>
              <span className="resume-choose-option-desc">
                从本地上传一份新的简历文件
              </span>
            </button>
            <button
              type="button"
              className="resume-choose-option"
              onClick={() => void openResumePick()}
            >
              <span className="resume-choose-option-title">从简历库挑选</span>
              <span className="resume-choose-option-desc">
                在已上传的简历库中选择一份使用
              </span>
            </button>
            <button
              type="button"
              className="resume-choose-option"
              onClick={() => void openWpsCloud()}
            >
              <span className="resume-choose-option-title">从 WPS 云文档选择</span>
              <span className="resume-choose-option-desc">
                从你的 WPS 云文档中选择简历文件
              </span>
            </button>
          </div>
        </Dialog>

        {/* ─── 从简历库挑选 Modal ─── */}
        <Dialog
          open={modal === 'resumePick'}
          title="从简历库挑选"
          onClose={() => {
            setModal(null);
            setLibraryError('');
          }}
          width={520}
        >
          <div className="resume-pick-list">
            {libraryLoading ? (
              <p className="interview-loading">加载简历库…</p>
            ) : libraryError ? (
              <p className="dialog-error">{libraryError}</p>
            ) : libraryResumes.length === 0 ? (
              <p className="interview-loading">简历库为空，可先通过「用户管理」上传简历。</p>
            ) : (
              libraryResumes.map((item) => (
                <div key={item.id} className="resume-pick-item">
                  <button
                    type="button"
                    className="resume-pick-body"
                    onClick={() => pickResume(item)}
                  >
                    <span className="resume-pick-name">{item.name}</span>
                    <span className="resume-pick-meta">
                      {item.resume_text ? '已解析' : '无文本'} · {item.updated_at}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="resume-pick-preview"
                    onClick={() => previewLibraryResume(item)}
                    aria-label="预览简历"
                    title="预览简历"
                  >
                    预览
                  </button>
                </div>
              ))
            )}
          </div>
        </Dialog>

        {/* ─── 从 WPS 云文档选择 Modal ─── */}
        <Dialog
          open={modal === 'wpsCloud'}
          title="从 WPS 云文档选择"
          onClose={() => {
            setModal(null);
            setCloudError('');
          }}
          width={560}
        >
          <div className="wps-cloud-search">
            <input
              type="text"
              value={cloudKeyword}
              onChange={(e) => setCloudKeyword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !cloudLoading && !cloudImporting) {
                  void searchCloudFiles();
                }
              }}
              placeholder="搜索云文档中的简历…"
              aria-label="搜索云文档简历"
            />
            <button
              type="button"
              className="wps-cloud-search-btn"
              onClick={() => void searchCloudFiles()}
              disabled={cloudLoading || cloudImporting}
            >
              {cloudLoading ? '搜索中…' : '搜索'}
            </button>
          </div>
          <div className="resume-pick-list">
            {cloudLoading ? (
              <p className="interview-loading">加载云文档…</p>
            ) : cloudError ? (
              <p className="dialog-error">{cloudError}</p>
            ) : cloudFiles.length === 0 ? (
              <p className="interview-loading">
                {cloudKeyword.trim()
                  ? '未找到匹配的简历文件，可换个关键词试试。'
                  : '输入关键词搜索云文档中的简历文件，例如：罗杰豪、简历'}
              </p>
            ) : (
              cloudFiles.map((item) => (
                <div key={item.id} className="resume-pick-item">
                  <button
                    type="button"
                    className="resume-pick-body"
                    onClick={() => void pickCloudFile(item)}
                    disabled={cloudImporting}
                  >
                    <span className="resume-pick-name">{item.name}</span>
                    <span className="resume-pick-meta">
                      {cloudImporting ? '导入中…' : formatCloudMtime(item.mtime)}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="resume-pick-preview"
                    onClick={() => void previewCloudFile(item)}
                    disabled={cloudImporting}
                    aria-label="预览文件"
                    title="预览文件"
                  >
                    预览
                  </button>
                </div>
              ))
            )}
          </div>
        </Dialog>

        {/* ─── 简历导入 Modal（拖拽上传） ─── */}
        <Dialog
          open={modal === 'resume'}
          title={resumeFileName ? '替换简历' : '导入简历'}
          onClose={() => {
            setModal(null);
            setResumeError('');
          }}
          footer={
            <>
              <button type="button" className="btn btn--secondary" onClick={() => setModal(null)}>
                取消
              </button>
              {resumeFileName && (
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => {
                    clearResume();
                    setModal(null);
                    setResumeError('');
                  }}
                  disabled={resumeParsing || loading}
                >
                  清除简历
                </button>
              )}
            </>
          }
        >
          <div className="dialog-field">
            <div
              className={`dropzone${resumeDragging ? ' is-dragging' : ''}${resumeParsing || resumeUploading ? ' is-busy' : ''}`}
              onDragOver={(e) => {
                e.preventDefault();
                setResumeDragging(true);
              }}
              onDragLeave={() => setResumeDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setResumeDragging(false);
                const file = e.dataTransfer.files?.[0];
                if (!file) return;
                void handleResumeFile(file).then((ok) => {
                  if (ok) setModal(null);
                });
              }}
              onClick={() => {
                if (!resumeParsing && !resumeUploading) {
                  document.getElementById('resume-file-input')?.click();
                }
              }}
              role="button"
              tabIndex={0}
              aria-label="上传简历"
              onKeyDown={(e) => {
                if ((e.key === 'Enter' || e.key === ' ') && !resumeParsing && !resumeUploading) {
                  document.getElementById('resume-file-input')?.click();
                }
              }}
            >
              <input
                id="resume-file-input"
                type="file"
                accept=".txt,.md,.pdf,.docx,text/plain,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (!file) return;
                  void handleResumeFile(file).then((ok) => {
                    if (ok) setModal(null);
                  });
                }}
                disabled={resumeParsing || loading}
                hidden
              />
              {resumeParsing || resumeUploading ? (
                <div className="dropzone-busy">
                  <span className="dropzone-spinner" aria-hidden="true" />
                  <p>
                    {resumeParsing
                      ? '正在解析简历…'
                      : `正在上传原文件… ${resumeProgress}%`}
                  </p>
                </div>
              ) : (
                <>
                  <div className="dropzone-icon" aria-hidden="true">↑</div>
                  <p className="dropzone-title">
                    {resumeFileName ? '拖拽新简历到这里' : '拖拽简历到这里，或点击选择文件'}
                  </p>
                  <p className="dropzone-hint">支持 .txt、.md、.pdf、.docx，不超过 10MB</p>
                </>
              )}
            </div>
            {resumeFileName && !resumeParsing && !resumeUploading && (
              <p className="dialog-success">已导入：{resumeFileName}</p>
            )}
            {resumeError && <p className="dialog-error" role="alert">{resumeError}</p>}
          </div>
        </Dialog>

        {/* ─── 岗位信息 / 面试岗位 Modal（拖拽上传，支持文件+图片OCR） ─── */}
        <Dialog
          open={modal === 'jd'}
          title={jdFileName || jobJd ? '编辑岗位信息' : '导入岗位信息'}
          onClose={() => {
            setModal(null);
            setJdError('');
          }}
          width={560}
          footer={
            <>
              {(jobJd || jdFileName) && (
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => {
                    clearJd();
                    setJdError('');
                  }}
                  disabled={jdUploading || jdOcrRecognizing || loading}
                >
                  清空
                </button>
              )}
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => {
                  setModal(null);
                  setJdError('');
                }}
              >
                完成
              </button>
            </>
          }
        >
          <div className="dialog-field">
            <div
              className={`dropzone${jdDragging ? ' is-dragging' : ''}${jdUploading || jdOcrRecognizing ? ' is-busy' : ''}`}
              onDragOver={(e) => {
                e.preventDefault();
                setJdDragging(true);
              }}
              onDragLeave={() => setJdDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setJdDragging(false);
                const file = e.dataTransfer.files?.[0];
                if (!file) return;
                void handleJdDrop(file);
              }}
              onClick={() => {
                if (!jdUploading && !jdOcrRecognizing) {
                  document.getElementById('jd-file-input')?.click();
                }
              }}
              role="button"
              tabIndex={0}
              aria-label="上传岗位 JD"
              onKeyDown={(e) => {
                if ((e.key === 'Enter' || e.key === ' ') && !jdUploading && !jdOcrRecognizing) {
                  document.getElementById('jd-file-input')?.click();
                }
              }}
            >
              <input
                id="jd-file-input"
                type="file"
                accept=".txt,.md,.pdf,.docx,image/jpeg,image/png,image/webp,text/plain,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (!file) return;
                  void handleJdDrop(file);
                }}
                disabled={jdUploading || jdOcrRecognizing || loading}
                hidden
              />
              {jdUploading || jdOcrRecognizing ? (
                <div className="dropzone-busy">
                  <span className="dropzone-spinner" aria-hidden="true" />
                  <p>
                    {jdOcrRecognizing
                      ? `正在识别图片中的文字（${jdOcrName}）…`
                      : `正在解析文件… ${jdProgress}%`}
                  </p>
                </div>
              ) : (
                <>
                  <div className="dropzone-icon" aria-hidden="true">↑</div>
                  <p className="dropzone-title">
                    {jdFileName ? '拖拽新文件到这里' : '拖拽文件或图片到这里，或点击选择'}
                  </p>
                  <p className="dropzone-hint">支持 .txt、.md、.pdf、.docx 或图片（自动 OCR），不超过 10MB</p>
                </>
              )}
            </div>
            {jdError && <p className="dialog-error" role="alert">{jdError}</p>}

            <label htmlFor="job-jd" className="dialog-field-label">岗位信息</label>
            <textarea
              id="job-jd"
              aria-label="岗位 JD"
              required
              value={jobJd}
              onChange={(e) => {
                setJobJd(e.target.value);
              }}
              placeholder="上传文件后内容会自动填入，也可以直接粘贴或编辑…"
            />
          </div>
        </Dialog>

        {/* ─── 选择题库 Modal ─── */}
        <Dialog
          open={modal === 'bank'}
          title="选择题库"
          onClose={() => {
            setModal(null);
            setBankError('');
          }}
          width={560}
          footer={
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => {
                setModal(null);
                setBankError('');
              }}
            >
              完成
            </button>
          }
        >
          <div className="bank-pick-list">
            {bankLoading ? (
              <p className="interview-loading">加载题库…</p>
            ) : bankError ? (
              <p className="dialog-error">{bankError}</p>
            ) : bankQuestions.length === 0 ? (
              <p className="interview-loading">题库暂无题目，可先在「面试信息管理」中导入。</p>
            ) : (
              bankQuestions.map((q) => {
                const selected = selectedIds.includes(q.id);
                return (
                  <button
                    key={q.id}
                    type="button"
                    className={`bank-pick-item${selected ? ' is-selected' : ''}`}
                    onClick={() => toggleQuestion(q.id)}
                  >
                    <span className="bank-pick-check" aria-hidden="true">
                      {selected ? '✓' : ''}
                    </span>
                    <span className="bank-pick-question">{q.question}</span>
                  </button>
                );
              })
            )}
          </div>
        </Dialog>

        {/* ─── 简历预览弹窗（PDF 渲染 / 文本展示） ─── */}
        <ResumePreviewModal
          open={previewOpen}
          title={previewTitle}
          text={previewText}
          file={previewFile}
          fileUrl={previewFileUrl}
          onClose={() => setPreviewOpen(false)}
        />
          </main>
        </div>
      </div>
    </div>
  );
}
