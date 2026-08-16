import { type ChangeEvent, type FormEvent, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError } from '../api/client';
import {
  createInterview,
  startInterview,
  type InputMode,
  type InterviewMode,
} from '../api/interviews';
import { fetchProfile, type Profile } from '../api/profile';
import { useAuth } from '../auth/AuthContext';
import { APP_NAME, MODE_LABELS } from '../lib/labels';
import { extractResumeText } from '../lib/resumeParse';
import './InterviewPages.css';

const MODES: InterviewMode[] = ['behavioral', 'technical', 'mixed'];

const DIMENSION_LABELS: Record<string, string> = {
  expression: '表达能力',
  logic: '逻辑结构',
  content: '内容质量',
  job_match: '岗位匹配',
};

const INPUT_MODES: { value: InputMode; label: string }[] = [
  { value: 'text', label: '文本' },
  { value: 'voice', label: '语音' },
];

export default function CreateInterviewPage() {
  const { logout } = useAuth();
  const navigate = useNavigate();
  const [jobJd, setJobJd] = useState('');
  const [resumeText, setResumeText] = useState('');
  const [resumeFileName, setResumeFileName] = useState('');
  const [resumeParsing, setResumeParsing] = useState(false);
  const [mode, setMode] = useState<InterviewMode>('mixed');
  const [inputMode, setInputMode] = useState<InputMode>('text');
  const [profile, setProfile] = useState<Profile | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchProfile()
      .then((p) => {
        if (!cancelled) setProfile(p);
      })
      .catch(() => {
        /* silent fallback: hide card on error */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleResumeFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) {
      setResumeText('');
      setResumeFileName('');
      return;
    }

    setError('');
    setResumeParsing(true);
    try {
      const text = await extractResumeText(file);
      setResumeText(text);
      setResumeFileName(file.name);
    } catch (err) {
      setResumeText('');
      setResumeFileName('');
      setError(err instanceof Error ? err.message : '简历解析失败');
      e.target.value = '';
    } finally {
      setResumeParsing(false);
    }
  }

  function clearResume() {
    setResumeText('');
    setResumeFileName('');
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
        input_mode: inputMode,
        ...(trimmedResume ? { resume_text: trimmedResume } : {}),
      });
      await startInterview(created.id);
      navigate(`/interviews/${created.id}/room`, { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '创建面试失败');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="interview-page">
      <header className="interview-header">
        <Link className="interview-brand" to="/">
          {APP_NAME}
        </Link>
        <div className="interview-header-actions">
          <Link className="interview-header-link" to="/questions">
            题库
          </Link>
          <Link className="interview-header-link" to="/trends">
            成长分析
          </Link>
          <Link className="interview-header-link" to="/">
            返回列表
          </Link>
          <button type="button" className="interview-header-link" onClick={logout}>
            退出登录
          </button>
        </div>
      </header>
      <main className="interview-main">
        <h1>新建面试</h1>
        <p className="interview-subtitle">粘贴职位描述，可选上传简历，并选择练习模式。</p>

        {profile && (
          <div className="profile-card">
            {profile.weak_dimensions.length > 0 ? (
              <p>
                针对性出题已开启：根据你最近 {profile.based_on_sessions} 场面试，薄弱点是
                {profile.weak_dimensions
                  .map((d) => DIMENSION_LABELS[d] ?? d)
                  .map((label) => `【${label}】`)
                  .join('、')}
              </p>
            ) : (
              <p>暂无历史画像，将按通用方式出题</p>
            )}
          </div>
        )}

        <form className="interview-form" onSubmit={handleSubmit}>
          {error && <p className="interview-error">{error}</p>}

          <div className="interview-field">
            <label htmlFor="job-jd">职位描述</label>
            <textarea
              id="job-jd"
              required
              value={jobJd}
              onChange={(e) => setJobJd(e.target.value)}
              placeholder="请粘贴岗位 JD…"
            />
          </div>

          <div className="interview-field">
            <label htmlFor="resume">简历（可选）</label>
            <div className="interview-file-row">
              <input
                id="resume"
                type="file"
                accept=".txt,.md,.pdf,.docx,text/plain,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                onChange={handleResumeFile}
                disabled={resumeParsing || loading}
              />
              {resumeFileName && (
                <div className="interview-file-meta">
                  <span className="interview-file-name">
                    已解析：{resumeFileName}
                    {resumeText ? `（约 ${resumeText.length} 字）` : ''}
                  </span>
                  <button
                    type="button"
                    className="interview-file-clear"
                    onClick={clearResume}
                    disabled={resumeParsing || loading}
                  >
                    清除
                  </button>
                </div>
              )}
            </div>
            <p className="interview-field-hint">
              支持 .txt、.md、.pdf、.docx；扫描版 PDF 可能无法提取文字。
            </p>
            {resumeParsing && (
              <p className="interview-loading">正在解析简历…</p>
            )}
          </div>

          <div className="interview-field">
            <label htmlFor="mode">面试类型</label>
            <select
              id="mode"
              value={mode}
              onChange={(e) => setMode(e.target.value as InterviewMode)}
            >
              {MODES.map((value) => (
                <option key={value} value={value}>
                  {MODE_LABELS[value]}
                </option>
              ))}
            </select>
          </div>

          <div className="interview-field">
            <label htmlFor="input-mode">作答方式</label>
            <select
              id="input-mode"
              value={inputMode}
              onChange={(e) => setInputMode(e.target.value as InputMode)}
            >
              {INPUT_MODES.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          <button
            className="interview-submit"
            type="submit"
            disabled={loading || resumeParsing}
          >
            {loading ? '正在开始面试…' : '开始面试'}
          </button>
        </form>
      </main>
    </div>
  );
}
