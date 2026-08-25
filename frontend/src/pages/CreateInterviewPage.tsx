import { type FormEvent, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError } from '../api/client';
import {
  createInterview,
  startInterview,
  type CompanyStyle,
  type Difficulty,
  type InterviewMode,
  type Persona,
} from '../api/interviews';
import { recognizeImage } from '../api/ocr';
import {
  DIFFICULTY_LABELS,
  MODE_LABELS,
  PERSONA_LABELS,
} from '../lib/labels';
import { extractResumeText } from '../lib/resumeParse';
import { uploadFile } from '../api/uploads';
import { listResumes, type ResumeFile } from '../api/resumes';
import './InterviewPages.css';
import AppNav from '../components/AppNav';
import Dialog from '../components/Dialog';

const MODES: InterviewMode[] = ['behavioral', 'technical', 'mixed'];

const PERSONAS: Persona[] = ['standard', 'strict_tech', 'warm_hr', 'stress'];

const DIFFICULTIES: Difficulty[] = ['easy', 'medium', 'hard'];

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

export default function CreateInterviewPage() {
  const navigate = useNavigate();
  const [jobJd, setJobJd] = useState('');
  const [jdFileName, setJdFileName] = useState('');
  const [jdFileUrl, setJdFileUrl] = useState('');
  const [jdUploading, setJdUploading] = useState(false);
  const [jdProgress, setJdProgress] = useState(0);
  const [jdOcrName, setJdOcrName] = useState('');
  const [jdOcrRecognizing, setJdOcrRecognizing] = useState(false);
  const [jdError, setJdError] = useState('');
  const [jdDragging, setJdDragging] = useState(false);
  const [resumeText, setResumeText] = useState('');
  const [resumeFileName, setResumeFileName] = useState('');
  const [resumeFileUrl, setResumeFileUrl] = useState('');
  const [resumeUploading, setResumeUploading] = useState(false);
  const [resumeProgress, setResumeProgress] = useState(0);
  const [resumeParsing, setResumeParsing] = useState(false);
  const [resumeError, setResumeError] = useState('');
  const [resumeDragging, setResumeDragging] = useState(false);
  const [mode, setMode] = useState<InterviewMode>('mixed');
  const [persona, setPersona] = useState<Persona>('standard');
  const [difficulty, setDifficulty] = useState<Difficulty>('medium');
  const [companyStyle] = useState<CompanyStyle>('general');
  const [cameraEnabled, setCameraEnabled] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  // 模态编辑态：resume=简历导入、resumeChoose=简历来源选择、resumePick=从简历库挑选、
  // jd=岗位JD编辑、plan=计划项选择（mode/persona/difficulty/camera）
  const [modal, setModal] = useState<
    | 'resume'
    | 'resumeChoose'
    | 'resumePick'
    | 'jd'
    | 'mode'
    | 'persona'
    | 'difficulty'
    | 'camera'
    | null
  >(null);
  const [libraryResumes, setLibraryResumes] = useState<ResumeFile[]>([]);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [libraryError, setLibraryError] = useState('');

  /** 解析并上传简历；成功返回 true，失败返回 false（错误信息写入 resumeError）。 */
  async function handleResumeFile(file: File): Promise<boolean> {    if (!file) return false;

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

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    const trimmedJd = jobJd.trim();
    if (!trimmedJd) {
      setError('请填写职位描述');
      return;
    }
    setLoading(true);
    try {
      const trimmedResume = resumeText.trim();
      const created = await createInterview({
        job_jd: trimmedJd,
        mode,
        input_mode: 'voice',
        persona,
        difficulty,
        company_style: companyStyle,
        camera_enabled: cameraEnabled,
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
      <main className="interview-main interview-create">
        <h1>开始一场更像真实面试的练习</h1>
        <p className="interview-subtitle">
          导入资料后，Agent 会基于目标岗位、JD 与历史表现规划题目和追问。
        </p>

        {/* 训练准备进度 */}
        <div className="prep-steps">
          <span>01 资料准备</span>
          <span>02 面试计划</span>
          <span>03 授权确认</span>
          <span>04 开始面试</span>
        </div>

        <div className="prep-grid">
          {/* 左侧：资料与岗位配置 */}
          <section className="prep-card">
            <div className="prep-card-head">
              <h2>资料与目标岗位</h2>
              <p>用于题目生成与动态追问，仅用于本次训练和历史复盘。</p>
            </div>

            {/* 我的简历 */}
            <div className="prep-row">
              <div className="prep-row-main">
                <span className="prep-row-label">我的简历</span>
                <span className="prep-row-value">
                  {resumeFileName ? `已导入：${resumeFileName}` : '未导入'}
                </span>
              </div>
              <button
                type="button"
                className="prep-row-link"
                onClick={() => setModal('resumeChoose')}
              >
                {resumeFileName ? '替换' : '导入'}
              </button>
            </div>

            {/* 目标岗位 */}
            <div className="prep-row">
              <div className="prep-row-main">
                <span className="prep-row-label">目标岗位</span>
                <span className="prep-row-value">{jobTitle || '未设置'}</span>
              </div>
              <button
                type="button"
                className="prep-row-link"
                onClick={() => setModal('jd')}
              >
                编辑
              </button>
            </div>

            {/* 岗位 JD */}
            <div className="prep-row">
              <div className="prep-row-main">
                <span className="prep-row-label">岗位 JD</span>
                <span className="prep-row-value">
                  {jdFileName ? `已导入：${jdFileName}` : jobJd ? `已粘贴（约 ${jobJd.length} 字）` : '未导入'}
                </span>
              </div>
              <button
                type="button"
                className="prep-row-link"
                data-testid="jd-import-btn"
                onClick={() => setModal('jd')}
              >
                {jdFileName || jobJd ? '替换' : '导入'}
              </button>
            </div>

          </section>

          {/* 右侧：本场面试计划 */}
          <section className="prep-card prep-card--plan">
            <div className="prep-card-head">
              <h2>本场面试计划</h2>
            </div>

            <div className="prep-plan-rows">
              <button
                type="button"
                className="prep-plan-row"
                onClick={() => setModal('mode')}
              >
                <span>面试时长</span>
                <span className="prep-plan-value">30 分钟</span>
              </button>

              <button
                type="button"
                className="prep-plan-row"
                onClick={() => setModal('persona')}
              >
                <span>面试风格</span>
                <span className="prep-plan-value">{PERSONA_LABELS[persona]}</span>
              </button>

              <button
                type="button"
                className="prep-plan-row"
                onClick={() => setModal('difficulty')}
              >
                <span>题目难度</span>
                <span className="prep-plan-value">{DIFFICULTY_LABELS[difficulty]}</span>
              </button>

              <button
                type="button"
                className="prep-plan-row"
                onClick={() => setModal('camera')}
              >
                <span>视频行为分析</span>
                <span className="prep-plan-value">{cameraEnabled ? '已开启' : '未开启'}</span>
              </button>
            </div>

            <form className="prep-plan-form" onSubmit={handleSubmit}>
              <button
                className="prep-start-btn"
                type="submit"
                disabled={loading || resumeParsing}
              >
                {loading ? '正在开始面试…' : '开始模拟面试 →'}
              </button>
              {error && <p className="interview-error">{error}</p>}
            </form>
          </section>
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
                <button
                  key={item.id}
                  type="button"
                  className="resume-pick-item"
                  onClick={() => pickResume(item)}
                >
                  <span className="resume-pick-name">{item.name}</span>
                  <span className="resume-pick-meta">
                    {item.resume_text ? '已解析' : '无文本'} · {item.updated_at}
                  </span>
                </button>
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

        {/* ─── 岗位 JD 编辑 Modal（拖拽上传，支持文件+图片OCR） ─── */}
        <Dialog
          open={modal === 'jd'}
          title={jdFileName || jobJd ? '编辑岗位 JD' : '导入岗位 JD'}
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

            <label htmlFor="job-jd" className="dialog-field-label">职位描述</label>
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

        {/* ─── 计划选择 Modals ─── */}
        <Dialog
          open={modal === 'mode'}
          title="选择面试类型"
          onClose={() => setModal(null)}
          footer={
            <button type="button" className="btn btn--primary" onClick={() => setModal(null)}>
              确定
            </button>
          }
        >
          <div className="choice-grid">
            {MODES.map((value) => (
              <button
                key={value}
                type="button"
                className={`choice-pill${mode === value ? ' is-selected' : ''}`}
                onClick={() => setMode(value)}
              >
                {MODE_LABELS[value]}
              </button>
            ))}
          </div>
        </Dialog>

        <Dialog
          open={modal === 'persona'}
          title="选择面试风格"
          onClose={() => setModal(null)}
          footer={
            <button type="button" className="btn btn--primary" onClick={() => setModal(null)}>
              确定
            </button>
          }
        >
          <div className="choice-grid">
            {PERSONAS.map((value) => (
              <button
                key={value}
                type="button"
                className={`choice-pill${persona === value ? ' is-selected' : ''}`}
                onClick={() => setPersona(value)}
              >
                {PERSONA_LABELS[value]}
              </button>
            ))}
          </div>
        </Dialog>

        <Dialog
          open={modal === 'difficulty'}
          title="选择题目难度"
          onClose={() => setModal(null)}
          footer={
            <button type="button" className="btn btn--primary" onClick={() => setModal(null)}>
              确定
            </button>
          }
        >
          <div className="choice-grid">
            {DIFFICULTIES.map((value) => (
              <button
                key={value}
                type="button"
                className={`choice-pill${difficulty === value ? ' is-selected' : ''}`}
                onClick={() => setDifficulty(value)}
              >
                {DIFFICULTY_LABELS[value]}
              </button>
            ))}
          </div>
        </Dialog>

        <Dialog
          open={modal === 'camera'}
          title="视频行为分析"
          onClose={() => setModal(null)}
          footer={
            <button type="button" className="btn btn--primary" onClick={() => setModal(null)}>
              确定
            </button>
          }
        >
          <div className="dialog-field">
            <label className="interview-check-row" htmlFor="camera-enabled">
              <input
                id="camera-enabled"
                type="checkbox"
                checked={cameraEnabled}
                onChange={(e) => setCameraEnabled(e.target.checked)}
              />
              开启摄像头分析
            </label>
            <p className="interview-field-hint">
              面试中采集表情/行为信号，仅在本地分析，不上传画面。
            </p>
          </div>
        </Dialog>
      </main>
    </div>
  );
}
