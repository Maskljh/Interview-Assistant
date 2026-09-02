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
import './prep-page.css';
import TopBar from '../components/TopBar';
import QuestionImportModal from '../components/QuestionImportModal';
import { createPortal } from 'react-dom';
import { commonInterviewJobs, mockJobInfoItems } from '../lib/mockData';

/** 从云文档导入的简历大小上限（与后端 maxImportBytes 一致）。 */
const MAX_CLOUD_IMPORT_BYTES = 10 * 1024 * 1024;

/** 列表已带 size 且超过上限时，前端直接拦截，避免无谓下载。 */
function cloudFileTooLarge(item: WpsCloudFile): boolean {
  return typeof item.size === 'number' && item.size > MAX_CLOUD_IMPORT_BYTES;
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
  const type = mimeType || 'application/octet-stream';
  return new File([bytes], name, { type });
}

/**
 * 问询人消息打字动画：active 时逐字显示（prep-typing 光标），否则直接显示全文。
 * 尊重 prefers-reduced-motion；jsdom 等无 matchMedia 的环境直接显示全文，保证测试稳定。
 */
function TypingText({ text, active }: { text: string; active: boolean }) {
  // jsdom 等测试环境 matchMedia 未实现：视为 reduced，直接显示全文保证测试稳定
  const reduced =
    typeof window === 'undefined' ||
    typeof window.matchMedia !== 'function' ||
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const [shown, setShown] = useState(active && !reduced ? '' : text);
  const completed = useRef(!active || reduced);

  useEffect(() => {
    if (!active || reduced) {
      setShown(text);
      completed.current = true;
      return;
    }
    if (completed.current) return;
    setShown('');
    let index = 0;
    const timer = window.setInterval(() => {
      index += 1;
      setShown(text.slice(0, index));
      if (index >= text.length) {
        window.clearInterval(timer);
        completed.current = true;
      }
    }, 42);
    return () => window.clearInterval(timer);
  }, [text, active, reduced]);

  const typing = active && !completed.current;
  return (
    <span className={typing ? 'prep-typing' : undefined}>
      {typing ? shown : text}
    </span>
  );
}

export default function CreateInterviewPage() {
  const navigate = useNavigate();
  // ── 面试岗位（设计稿：prep 对话流弹窗选择）──
  const [jobTitle, setJobTitle] = useState('');
  const [jobDraft, setJobDraft] = useState('');
  const [commonJobs, setCommonJobs] = useState<string[]>(commonInterviewJobs);
  // 岗位信息（JD）：设计稿 home 岗位卡内联编辑 + 导入选择器
  const [jobJd, setJobJd] = useState('');
  const [jdError, setJdError] = useState('');
  // 上传岗位信息图片 OCR 识别中（home-job-info-picker 头部按钮态）
  const [jobInfoRecognizing, setJobInfoRecognizing] = useState(false);
  // 当前选中的岗位信息（home-job-info-picker 高亮态）
  const [selectedJobInfoId, setSelectedJobInfoId] = useState('');
  // ── 个人简历 ──
  const [resumeText, setResumeText] = useState('');
  const [resumeFileName, setResumeFileName] = useState('');
  const [resumeFileUrl, setResumeFileUrl] = useState('');
  const [resumeParsing, setResumeParsing] = useState(false);
  const [resumeError, setResumeError] = useState('');
  // ── 选择题库 ──
  const [bankQuestions, setBankQuestions] = useState<Question[]>([]);
  const [bankLoading, setBankLoading] = useState(false);
  const [bankError, setBankError] = useState('');
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  // 已选题目详情（用于右侧资料板列表展示）
  const selectedQuestions = useMemo(
    () =>
      selectedIds
        .map((id) => bankQuestions.find((q) => q.id === id))
        .filter((q): q is Question => Boolean(q)),
    [selectedIds, bankQuestions],
  );
  // 题库列表：按 job_tag 分组（与「面试信息管理」题库 tab 的 bank 口径一致）
  const bankGroups = useMemo(() => {
    const map = new Map<string, Question[]>();
    for (const q of bankQuestions) {
      const bank = q.job_tag || '未命名题库';
      const list = map.get(bank) ?? [];
      list.push(q);
      map.set(bank, list);
    }
    return Array.from(map.entries());
  }, [bankQuestions]);
  // 新建题库（设计稿：选择题库弹窗头部按钮 → 导入题库对话框）
  const [importOpen, setImportOpen] = useState(false);

  // ── 通用 ──
  const [error, setError] = useState('');
  // 提交阶段：creating=正在创建会话；generating=正在生成题目（LLM 可能耗时较长，需明确提示）
  const [phase, setPhase] = useState<'creating' | 'generating' | null>(null);
  // 模态编辑态（设计稿 home 对话框）：job=选择岗位、resumePick=选择简历、
  // resumeImportMethod=上传简历、wpsCloud=从 WPS 云文档选择、jd=导入岗位信息、bank=选择题库
  const [modal, setModal] = useState<
    'job' | 'resumePick' | 'resumeImportMethod' | 'wpsCloud' | 'jd' | 'bank' | null
  >(null);
  // 对话引导流：是否需要上传个人简历/岗位信息/题集（设计稿 prep-answer-options）
  const [prepUploadChoice, setPrepUploadChoice] = useState<'yes' | 'no' | null>(null);
  const [libraryResumes, setLibraryResumes] = useState<ResumeFile[]>([]);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [libraryError, setLibraryError] = useState('');
  // ── 从 WPS 云文档选择 ──
  const [cloudFiles, setCloudFiles] = useState<WpsCloudFile[]>([]);
  const [cloudLoading, setCloudLoading] = useState(false);
  const [cloudError, setCloudError] = useState('');
  const [cloudKeyword, setCloudKeyword] = useState('');
  const [cloudImporting, setCloudImporting] = useState(false);
  // ── 设计稿 938×692 画布缩放：--home-fit / --home-canvas-width 驱动 ──
  const rootRef = useRef<HTMLDivElement | null>(null);
  const cloudSearchTimerRef = useRef<number | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const compute = () => {
      // 设计稿 updateHomeFit：顶栏占 64px，画布基准 938×692
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
    setResumeFileUrl('');
    try {
      const text = await extractResumeText(file);
      setResumeText(text);
      setResumeFileName(file.name);
      // 上传原文件到 OSS 存档；失败不阻断（文本仍可用）
      try {
        const upload = await uploadFile('resume', file);
        setResumeFileUrl(upload.url);
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
    }
  }

  /** 打开「从简历库挑选」弹窗并加载简历列表。 */
  async function openResumePick() {
    setModal('resumePick');
    setLibraryError('');
    setLibraryLoading(true);
    setLibraryResumes([]);
    try {
      const items = await listResumes();
      setLibraryResumes(Array.isArray(items) ? items : []);
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

  /** 打开「从 WPS 云文档选择」弹窗：默认浏览各盘根目录的简历文件，也可输入关键词搜索。 */
  async function openWpsCloud() {
    setModal('wpsCloud');
    setCloudError('');
    setCloudKeyword('');
    setCloudLoading(true);
    setCloudFiles([]);
    try {
      const data = await listCloudFiles('');
      if (data.error) {
        setCloudFiles([]);
        setCloudError(data.error);
      } else {
        setCloudFiles(data.items);
        setCloudError('');
      }
    } catch (err) {
      setCloudError(
        err instanceof ApiError ? err.message : '云文档加载失败，请稍后重试',
      );
    } finally {
      setCloudLoading(false);
    }
  }

  /** 按关键词搜索云文档简历候选文件；keyword 缺省时用当前输入框值。 */
  async function searchCloudFiles(keyword: string = cloudKeyword) {
    setCloudError('');
    setCloudLoading(true);
    try {
      const data = await listCloudFiles(keyword);
      if (data.error) {
        // 搜索失败（权限未开通等）：展示真实原因，避免误判为「未找到匹配」。
        setCloudFiles([]);
        setCloudError(data.error);
      } else {
        setCloudFiles(data.items);
        setCloudError('');
      }
    } catch (err) {
      setCloudError(
        err instanceof ApiError ? err.message : '云文档加载失败，请稍后重试',
      );
    } finally {
      setCloudLoading(false);
    }
  }

  /** 选中云文档文件：后端下载转 base64，前端复用解析逻辑提取简历文本。 */
  async function pickCloudFile(item: WpsCloudFile) {
    if (cloudFileTooLarge(item)) {
      setCloudError(`「${item.name}」超过 10MB，无法导入`);
      return;
    }
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
      // 上传原文件到 OSS，让详情页「查看简历原文件」可用；失败不阻断（文本已可用）。
      try {
        const upload = await uploadFile('resume', file);
        setResumeFileUrl(upload.url);
      } catch (uploadErr) {
        console.warn('[wps] upload cloud resume failed', uploadErr);
      }
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

  /** 上传岗位信息图片（home-job-info-picker 头部按钮）：OCR 识别后填入岗位信息。 */
  async function handleJobInfoImage(file: File) {
    if (file.size > 10 * 1024 * 1024) {
      setJdError('文件不能超过 10MB');
      return;
    }
    setJdError('');
    setJobInfoRecognizing(true);
    try {
      const { text } = await recognizeImage(file);
      if (!text.trim()) {
        setJdError('未识别到文字，请尝试更清晰的图片');
        return;
      }
      setJobJd(text);
      setModal(null);
    } catch (err) {
      const raw = err instanceof ApiError ? err.rawMessage : '';
      const ux = err instanceof ApiError ? err.message : '图片识别失败';
      if (raw.includes('unavailable') || ux.includes('改用文本粘贴')) {
        setJdError('图片识别失败，请改用文本粘贴');
      } else {
        setJdError(ux);
      }
    } finally {
      setJobInfoRecognizing(false);
    }
  }

  /** 加载题库题目列表（选择题库弹窗 / 新建题库导入完成后刷新共用）。 */
  async function loadBankQuestions() {
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

  /** 打开「选择题库」弹窗并加载题库列表。 */
  function openBankPicker() {
    setModal('bank');
    void loadBankQuestions();
  }

  /** 选中整个题库（设计稿 home-bank-picker：按题库整组选择）。 */
  function pickBank(bank: string) {
    setSelectedIds(
      bankQuestions
        .filter((q) => (q.job_tag || '未命名题库') === bank)
        .map((q) => q.id),
    );
    setBankError('');
    setModal(null);
  }

  /** 从已选列表移除一道题。 */
  function removeQuestion(id: number) {
    setSelectedIds((prev) => prev.filter((x) => x !== id));
  }

  /** 选择/录入面试岗位（对话流弹窗确定）。 */
  function chooseJob(title: string) {
    const value = title.trim();
    if (!value) return;
    setJobTitle(value);
    setJobDraft(value);
    setError('');
    if (!commonJobs.includes(value)) setCommonJobs((prev) => [value, ...prev]);
    setModal(null);
  }

  function removeCommonJob(job: string) {
    setCommonJobs((prev) => prev.filter((j) => j !== job));
  }

  /** 重置对话（设计稿 prep-reset）：清空岗位与全部归档。 */
  function handlePrepReset() {
    setJobTitle('');
    setJobDraft('');
    setJobJd('');
    setSelectedJobInfoId('');
    setResumeText('');
    setResumeFileName('');
    setResumeFileUrl('');
    setResumeError('');
    setSelectedIds([]);
    setPrepUploadChoice(null);
    setError('');
    setModal(null);
  }

  /** 创建面试并进入面试间（开始面试按钮与表单共用）。 */
  async function startInterviewFlow() {
    setError('');
    const title = jobTitle.trim();
    if (!title) {
      setError('请选择面试岗位');
      return;
    }
    const trimmedJd = jobJd.trim();
    // 岗位信息兜底：未填 JD 时用岗位名作为 JD 内容，保证后端可生成。
    const effectiveJd = trimmedJd || `岗位名称：${title}`;
    setPhase('creating');
    try {
      const trimmedResume = resumeText.trim();
      if (selectedIds.length > 0) {
        // 题库练习：用选中的题目创建面试，同时携带岗位信息与简历参与定制。
        const created = await createInterviewFromBank({
          question_ids: selectedIds,
          mode: 'mixed',
          input_mode: 'voice',
          job_jd: effectiveJd,
          ...(trimmedResume ? { resume_text: trimmedResume } : {}),
          ...(resumeFileUrl ? { resume_file_url: resumeFileUrl } : {}),
        });
        setPhase('generating');
        await startInterview(created.id);
        navigate(`/interviews/${created.id}/room`, { replace: true });
        return;
      }
      const created = await createInterview({
        job_jd: effectiveJd,
        mode: 'mixed',
        input_mode: 'voice',
        ...(trimmedResume ? { resume_text: trimmedResume } : {}),
        ...(resumeFileUrl ? { resume_file_url: resumeFileUrl } : {}),
      });
      setPhase('generating');
      await startInterview(created.id);
      navigate(`/interviews/${created.id}/room`, { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '创建面试失败');
    } finally {
      setPhase(null);
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    await startInterviewFlow();
  }

  // ── 对话流（设计稿 prep-dialogue）──
  // 岗位未选时第一轮问询人消息打字；选岗后转为静态，新增问询轮次各自打字。
  const jobTurnTyping = !jobTitle;
  const uploadTurnTyping = Boolean(jobTitle) && !prepUploadChoice;
  const uploadReplyTyping = Boolean(jobTitle) && prepUploadChoice === 'yes';
  const readyTurnTyping = prepUploadChoice === 'no';
  // 右侧资料板（设计稿 prep-right / INTERVIEW MATERIALS）
  const materials: { label: string; title: string; detail?: string; list?: string[] }[] = [];
  if (jobTitle) {
    materials.push({
      label: '目标岗位',
      title: jobTitle,
      detail: '本轮问讯将围绕该岗位的职责与判断展开。',
    });
  }
  if (resumeFileName) {
    materials.push({ label: '个人简历', title: resumeFileName });
  }
  if (jobJd.trim()) {
    const selected = mockJobInfoItems.find((item) => item.id === selectedJobInfoId);
    materials.push({
      label: '岗位信息',
      title: selected ? selected.name : '已录入岗位情报',
      detail: jobJd.trim(),
    });
  }
  if (selectedQuestions.length > 0) {
    materials.push({
      label: '面试题集',
      title: selectedQuestions[0].job_tag || '未命名题库',
      list: selectedQuestions.map((q) => q.question),
    });
  }

  return (
    <div id="design-root" ref={rootRef}>
      <section className="home screen">
        <section className="home-page prep-page">
          <TopBar active="hub" />
          <main className="home-main prep-main">
            <section className="prep-chat">
              <header className="room-case-head">
                <div>
                  <small className="prep-kicker">PRE-INTERVIEW</small>
                  <h2>面试材料准备</h2>
                </div>
                <button
                  type="button"
                  className="prep-back"
                  onClick={() => navigate('/welcome', { replace: true })}
                >
                  返回首页
                </button>
              </header>

              <section className="prep-dialogue" aria-label="问询人引导对话">
                <button
                  type="button"
                  className="prep-reset"
                  aria-label="重置对话"
                  title="重置对话"
                  onClick={handlePrepReset}
                >
                  ↻
                </button>

                {/* 第一轮：选择岗位 */}
                <article className="prep-turn">
                  <b className="prep-avatar" aria-label="问询人">
                    ⌕
                  </b>
                  <div className="prep-bubble">
                    <small>面知</small>
                    <p>
                      <TypingText text="请选择本次面试岗位" active={jobTurnTyping} />
                    </p>
                    <button
                      type="button"
                      className="prep-choice"
                      onClick={() => {
                        setJobDraft(jobTitle);
                        setModal('job');
                      }}
                    >
                      <b>面试岗位</b>
                      <span>{jobTitle || '选择本次面试岗位'}</span>
                    </button>
                  </div>
                </article>

                {/* 用户回复岗位 */}
                {jobTitle && (
                  <article className="prep-turn prep-turn-user">
                    <div className="prep-bubble">
                      <p>本次面试岗位为“{jobTitle}”</p>
                    </div>
                    <b className="prep-avatar-user" aria-label="用户头像" />
                  </article>
                )}

                {/* 第二轮：是否需要上传 */}
                {jobTitle && (
                  <article className="prep-turn">
                    <b className="prep-avatar" aria-label="问询人">
                      ⌕
                    </b>
                    <div className="prep-bubble">
                      <small>面知</small>
                      <p>
                        <TypingText
                          text="是否需要上传个人简历、面试岗位信息或面试题集？"
                          active={uploadTurnTyping}
                        />
                      </p>
                      <div className="prep-answer-options">
                        <button type="button" onClick={() => setPrepUploadChoice('yes')}>
                          需要上传
                        </button>
                        <button type="button" onClick={() => setPrepUploadChoice('no')}>
                          暂不需要
                        </button>
                      </div>
                    </div>
                  </article>
                )}

                {/* 用户回复上传选择 */}
                {prepUploadChoice && (
                  <article className="prep-turn prep-turn-user">
                    <div className="prep-bubble">
                      <p>{prepUploadChoice === 'yes' ? '需要上传' : '暂不需要'}</p>
                    </div>
                    <b className="prep-avatar-user" aria-label="用户头像" />
                  </article>
                )}

                {/* 第三轮 yes：选择要上传的面试信息 */}
                {prepUploadChoice === 'yes' && (
                  <article className="prep-turn">
                    <b className="prep-avatar" aria-label="问询人">
                      ⌕
                    </b>
                    <div className="prep-bubble">
                      <small>面知</small>
                      <p>
                        <TypingText text="请选择需要上传的面试信息" active={uploadReplyTyping} />
                      </p>
                      <div className="prep-import-options">
                        <button type="button" onClick={() => void openResumePick()}>
                          <b>个人简历</b>
                          <span>{resumeFileName || '选择或上传简历'}</span>
                        </button>
                        <button type="button" onClick={() => setModal('jd')}>
                          <b>岗位信息</b>
                          <span>
                            {jobJd.trim()
                              ? mockJobInfoItems.find((i) => i.id === selectedJobInfoId)?.name || '已导入岗位信息'
                              : '选择或上传岗位信息'}
                          </span>
                        </button>
                        <button type="button" onClick={() => void openBankPicker()}>
                          <b>面试题集</b>
                          <span>
                            {selectedQuestions.length > 0
                              ? selectedQuestions[0].job_tag || '未命名题库'
                              : '选择或导入题集'}
                          </span>
                        </button>
                      </div>
                    </div>
                  </article>
                )}

                {/* 第三轮 no：就绪提示 */}
                {prepUploadChoice === 'no' && (
                  <article className="prep-turn">
                    <b className="prep-avatar" aria-label="问询人">
                      ⌕
                    </b>
                    <div className="prep-bubble prep-ready">
                      <small>面知</small>
                      <p>
                        <TypingText
                          text="好的，面试间已准备就绪，请点击右侧按钮开启面试。"
                          active={readyTurnTyping}
                        />
                      </p>
                    </div>
                  </article>
                )}
              </section>

              {/* 右侧资料板（设计稿 prep-right 便签归档） */}
              <aside className="prep-right">
                <h2 className="prep-materials-title">INTERVIEW MATERIALS</h2>
                {materials.length === 0 ? (
                  <article className="prep-empty-note">
                    文件板等待资料归档
                    <br />
                    从左侧补充后将在这里显示
                  </article>
                ) : (
                  materials.map((note) => (
                    <article
                      key={note.label}
                      className="prep-note"
                      data-prep-material={
                        note.label === '岗位信息'
                          ? 'job'
                          : note.label === '面试题集'
                            ? 'questions'
                            : undefined
                      }
                    >
                      <small>{note.label}</small>
                      <strong>{note.title}</strong>
                      {note.list ? (
                        <ol>
                          {note.list.map((item) => (
                            <li key={item}>
                              <span>{item}</span>
                            </li>
                          ))}
                        </ol>
                      ) : note.detail ? (
                        <p>{note.detail}</p>
                      ) : null}
                    </article>
                  ))
                )}
                {error && error !== '请选择面试岗位' && (
                  <p className="interview-error" role="alert">
                    {error}
                  </p>
                )}
                {error === '请选择面试岗位' && (
                  <p className="interview-error" role="alert">
                    请先在左侧选择面试岗位
                  </p>
                )}
                <button
                  type="button"
                  className="prep-note-start"
                  disabled={phase !== null || resumeParsing}
                  onClick={() => void startInterviewFlow()}
                >
                  {phase === 'generating'
                    ? '正在生成题目…'
                    : phase === 'creating'
                      ? '正在创建面试…'
                      : '开始面试'}
                </button>
                {phase === 'generating' && (
                  <p className="start-hint">
                    正在根据岗位信息与简历生成面试题目，通常需要十几秒到一分钟，请耐心等待…
                  </p>
                )}
              </aside>

              <input
                id="resume-file-input"
                type="file"
                accept=".txt,.md,.pdf,.docx,text/plain,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                hidden
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (file) void handleResumeFile(file);
                }}
              />
              <input
                id="job-info-file-input"
                type="file"
                accept=".jpg,.jpeg,.png"
                hidden
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (file) void handleJobInfoImage(file);
                }}
              />
            </section>
          </main>
        </section>
      </section>

      {/* ─── 对话框宿主：挂到 #design-root（缩放画布外），fixed 定位相对视口 ─── */}
      {(() => {
        const portalHost =
          typeof document !== 'undefined' ? document.getElementById('design-root') : null;
        if (!portalHost) return null;
        return createPortal(
          <>
            {/* 选择面试岗位：设计稿 home-job-picker-dialog（prep 对话流弹窗） */}
            {modal === 'job' && (
              <div className="question-dialog-backdrop">
                <section
                  className="question-add-dialog home-job-picker-dialog"
                  role="dialog"
                  aria-modal="true"
                  aria-label="选择面试岗位"
                >
                  <header className="question-add-dialog-head">
                    <div>
                      <h2>选择面试岗位</h2>
                      <p>输入目标岗位，或从常用岗位中直接选择</p>
                    </div>
                    <button
                      type="button"
                      aria-label="关闭"
                      onClick={() => setModal(null)}
                    >
                      ×
                    </button>
                  </header>
                  <div className="question-add-dialog-rule" />
                  <div className="home-job-picker-body">
                    <div className="prep-job-dropdown">
                      <div>
                        <input
                          value={jobDraft}
                          onChange={(e) => setJobDraft(e.target.value)}
                          placeholder="输入面试岗位"
                          aria-label="输入面试岗位"
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              chooseJob(jobDraft);
                              setPrepUploadChoice(null);
                            }
                          }}
                        />
                        <button
                          type="button"
                          onClick={() => {
                            chooseJob(jobDraft);
                            setPrepUploadChoice(null);
                          }}
                        >
                          确定
                        </button>
                      </div>
                      <p>常用岗位</p>
                      <section>
                        {commonJobs.map((job) => (
                          <span className="prep-job-tag" key={job}>
                            <button
                              type="button"
                              onClick={() => {
                                chooseJob(job);
                                setPrepUploadChoice(null);
                              }}
                            >
                              {job}
                            </button>
                            <button
                              type="button"
                              onClick={() => removeCommonJob(job)}
                              aria-label={`删除${job}`}
                            >
                              ×
                            </button>
                          </span>
                        ))}
                      </section>
                    </div>
                  </div>
                </section>
              </div>
            )}

            {/* 选择简历：设计稿 home-resume-picker-dialog */}
            {modal === 'resumePick' && (
              <div className="question-dialog-backdrop">
                <section
                  className="question-add-dialog home-resume-picker-dialog"
                  role="dialog"
                  aria-modal="true"
                  aria-label="选择简历"
                >
                  <header className="question-add-dialog-head">
                    <div>
                      <h2>选择简历</h2>
                      <p>从已有的简历里选择或新建导入简历</p>
                    </div>
                    <div className="home-resume-picker-head-actions">
                      <button
                        type="button"
                        className="home-resume-picker-create"
                        disabled={libraryResumes.length >= 5}
                        title={libraryResumes.length >= 5 ? '最多上传 5 份简历' : ''}
                        onClick={() => setModal('resumeImportMethod')}
                      >
                        上传简历
                      </button>
                      <button
                        type="button"
                        aria-label="关闭"
                        onClick={() => {
                          setModal(null);
                          setResumeError('');
                        }}
                      >
                        ×
                      </button>
                    </div>
                  </header>
                  <div className="question-add-dialog-rule" />
                  <div className="home-resume-picker-body">
                    {libraryLoading ? (
                      <p className="interview-loading">加载简历库…</p>
                    ) : libraryError ? (
                      <p className="dialog-error">{libraryError}</p>
                    ) : libraryResumes.length === 0 ? (
                      <div className="home-resume-picker-empty">
                        <p>还没有添加简历</p>
                        <small>添加后可在模拟面试时选择使用</small>
                      </div>
                    ) : (
                      <div className="home-resume-picker-list">
                        {libraryResumes.map((item) => {
                          const active = item.name === resumeFileName;
                          return (
                            <button
                              key={item.id}
                              type="button"
                              className={active ? 'active' : ''}
                              onClick={() => pickResume(item)}
                            >
                              <span className="resume-file-mark">PDF</span>
                              <span>
                                <strong>{item.name}</strong>
                                <small>{item.updated_at}</small>
                              </span>
                              <i>{active ? '已选择' : '选择'}</i>
                            </button>
                          );
                        })}
                      </div>
                    )}
                    {libraryResumes.length >= 5 && (
                      <p className="resume-upload-limit">最多上传 5 份简历</p>
                    )}
                  </div>
                </section>
              </div>
            )}

            {/* 上传简历：设计稿 resume-import-method-dialog */}
            {modal === 'resumeImportMethod' && (
              <div className="question-dialog-backdrop">
                <section
                  className="question-add-dialog resume-import-method-dialog"
                  role="dialog"
                  aria-modal="true"
                  aria-label="上传简历"
                >
                  <header className="question-add-dialog-head">
                    <div>
                      <h2>上传简历</h2>
                      <p>选择简历的导入方式</p>
                    </div>
                    <button
                      type="button"
                      aria-label="关闭"
                      onClick={() => setModal('resumePick')}
                    >
                      ×
                    </button>
                  </header>
                  <div className="question-add-dialog-rule" />
                  <div className="resume-import-method-body">
                    <button
                      type="button"
                      onClick={() => {
                        setModal(null);
                        requestAnimationFrame(() => {
                          document.getElementById('resume-file-input')?.click();
                        });
                      }}
                    >
                      <strong>本地上传</strong>
                      <small>从电脑选择 PDF、DOC 或 DOCX 文件</small>
                    </button>
                    <button type="button" onClick={() => void openWpsCloud()}>
                      <strong>WPS 云文档上传</strong>
                      <small>从 WPS 云文档中选择简历文件</small>
                    </button>
                  </div>
                </section>
              </div>
            )}

            {/* 从 WPS 云文档选择：设计稿 wps-picker-dialog */}
            {modal === 'wpsCloud' && (
              <div className="question-dialog-backdrop">
                <section
                  className="question-add-dialog wps-picker-dialog"
                  role="dialog"
                  aria-modal="true"
                  aria-label="从 WPS 云文档选择"
                >
                  <header className="question-add-dialog-head">
                    <div>
                      <h2>从 WPS 云文档选择</h2>
                    </div>
                    <button
                      type="button"
                      aria-label="关闭"
                      onClick={() => {
                        setModal(null);
                        setCloudError('');
                        if (cloudSearchTimerRef.current != null) {
                          window.clearTimeout(cloudSearchTimerRef.current);
                          cloudSearchTimerRef.current = null;
                        }
                      }}
                    >
                      ×
                    </button>
                  </header>
                  <div className="question-add-dialog-rule" />
                  <div className="wps-picker-body">
                    <div className="wps-picker-search">
                      <input
                        type="text"
                        value={cloudKeyword}
                        onChange={(e) => {
                          const v = e.target.value;
                          setCloudKeyword(v);
                          if (cloudSearchTimerRef.current != null) {
                            window.clearTimeout(cloudSearchTimerRef.current);
                            cloudSearchTimerRef.current = null;
                          }
                          cloudSearchTimerRef.current = window.setTimeout(() => {
                            cloudSearchTimerRef.current = null;
                            void searchCloudFiles(v);
                          }, 300);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !cloudLoading && !cloudImporting) {
                            if (cloudSearchTimerRef.current != null) {
                              window.clearTimeout(cloudSearchTimerRef.current);
                              cloudSearchTimerRef.current = null;
                            }
                            void searchCloudFiles();
                          }
                        }}
                        placeholder="输入文件名搜索"
                        aria-label="搜索云文档"
                      />
                      <button
                        type="button"
                        className="management-action"
                        onClick={() => void searchCloudFiles()}
                        disabled={cloudLoading || cloudImporting}
                      >
                        {cloudLoading ? '搜索中…' : '搜索'}
                      </button>
                    </div>
                    <p className="wps-picker-tip">选择文件后将直接添加至简历管理</p>
                    <div className="wps-picker-list">
                      {cloudImporting ? (
                        <div className="wps-picker-empty">正在导入所选文件…</div>
                      ) : cloudLoading ? (
                        <div className="wps-picker-empty">正在加载云文档…</div>
                      ) : cloudError ? (
                        <div className="wps-picker-empty">{cloudError}</div>
                      ) : cloudFiles.length === 0 ? (
                        <div className="wps-picker-empty">
                          {cloudKeyword.trim()
                            ? '未找到匹配的简历文件，可换个关键词试试。'
                            : '未找到云文档简历文件。'}
                        </div>
                      ) : (
                        cloudFiles.map((item) => {
                          const tooLarge = cloudFileTooLarge(item);
                          return (
                            <article
                              key={item.id}
                              className="wps-file-item"
                              onClick={() => {
                                if (!tooLarge) void pickCloudFile(item);
                              }}
                            >
                              <div>
                                <strong>{item.name}</strong>
                                <span className="wps-file-mtime">
                                  <small>
                                    {tooLarge
                                      ? '超过 10MB，无法导入'
                                      : formatCloudMtime(item.mtime)}
                                  </small>
                                </span>
                              </div>
                              <button type="button" disabled={tooLarge}>
                                选择
                              </button>
                            </article>
                          );
                        })
                      )}
                    </div>
                  </div>
                </section>
              </div>
            )}

            {/* 导入岗位信息：设计稿 home-job-info-picker-dialog */}
            {modal === 'jd' && (
              <div className="question-dialog-backdrop">
                <section
                  className="question-add-dialog home-job-info-picker-dialog"
                  role="dialog"
                  aria-modal="true"
                  aria-label="导入岗位信息"
                >
                  <header className="question-add-dialog-head">
                    <div>
                      <h2>导入岗位信息</h2>
                      <p>从已有的岗位信息里选择或新建导入岗位信息</p>
                    </div>
                    <div className="home-resume-picker-head-actions">
                      <button
                        type="button"
                        className="home-resume-picker-create"
                        disabled={jobInfoRecognizing}
                        onClick={() =>
                          document.getElementById('job-info-file-input')?.click()
                        }
                      >
                        {jobInfoRecognizing ? '识别中…' : '上传岗位信息图片'}
                      </button>
                      <button
                        type="button"
                        aria-label="关闭"
                        onClick={() => {
                          setModal(null);
                          setJdError('');
                        }}
                      >
                        ×
                      </button>
                    </div>
                  </header>
                  <div className="question-add-dialog-rule" />
                  <div className="home-resume-picker-body">
                    {mockJobInfoItems.length ? (
                      <div className="home-job-info-picker-list">
                        {mockJobInfoItems.map((item) => {
                          const active = item.id === selectedJobInfoId;
                          return (
                            <button
                              key={item.id}
                              type="button"
                              className={active ? 'active' : ''}
                              onClick={() => {
                                setSelectedJobInfoId(item.id);
                                setJobJd(
                                  `岗位名称：${item.name}\n${item.content}`,
                                );
                                setModal(null);
                              }}
                            >
                              <span className="job-info-file-mark">岗</span>
                              <span>
                                <strong>{item.name}</strong>
                                <small>{item.content}</small>
                              </span>
                              <i>{active ? '已选择' : '导入'}</i>
                            </button>
                          );
                        })}
                      </div>
                    ) : (
                      <div className="home-resume-picker-empty">
                        <p>还没有岗位信息</p>
                        <small>上传岗位信息图片后可在此选择使用</small>
                      </div>
                    )}
                    {jdError && (
                      <p className="home-job-info-picker-error" role="alert">
                        {jdError}
                      </p>
                    )}
                  </div>
                </section>
              </div>
            )}

            {/* 选择题库：设计稿 home-bank-picker-dialog */}
            {modal === 'bank' && (
              <div className="question-dialog-backdrop">
                <section
                  className="question-add-dialog home-bank-picker-dialog"
                  role="dialog"
                  aria-modal="true"
                  aria-label="从题库管理选择"
                >
                  <header className="question-add-dialog-head">
                    <div>
                      <h2>选择题库</h2>
                      <p>从已有的题库里选择或新建导入题库</p>
                    </div>
                    <div className="home-bank-picker-head-actions">
                      <button
                        type="button"
                        className="home-bank-picker-create"
                        onClick={() => {
                          setModal(null);
                          setImportOpen(true);
                        }}
                      >
                        新建题库
                      </button>
                      <button
                        type="button"
                        aria-label="关闭"
                        onClick={() => {
                          setModal(null);
                          setBankError('');
                        }}
                      >
                        ×
                      </button>
                    </div>
                  </header>
                  <div className="question-add-dialog-rule" />
                  <div className="home-bank-picker-body">
                    {bankLoading ? (
                      <p className="interview-loading">加载题库…</p>
                    ) : bankError ? (
                      <p className="dialog-error">{bankError}</p>
                    ) : bankGroups.length === 0 ? (
                      <div className="home-bank-picker-empty">
                        <p>还没有上传题库</p>
                        <small>新建题库后可用于开始模拟面试</small>
                      </div>
                    ) : (
                      <div className="home-bank-picker-list">
                        {bankGroups.map(([bank, list]) => (
                          <button
                            key={bank}
                            type="button"
                            onClick={() => pickBank(bank)}
                          >
                            <span>
                              <strong>{bank}</strong>
                              <small>{list.length} 道题目</small>
                            </span>
                            <i>选择</i>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </section>
              </div>
            )}
          </>,
          portalHost,
        );
      })()}

      {/* 新建题库：设计稿 question-import-dialog（导入完成后回到选择题库弹窗） */}
      <QuestionImportModal
        open={importOpen}
        onClose={() => {
          setImportOpen(false);
          setModal('bank');
        }}
        onImported={() => {
          setImportOpen(false);
          setModal('bank');
          void loadBankQuestions();
        }}
        existingQuestions={bankQuestions.map((q) => q.question)}
      />
    </div>
  );
}
