import { type ChangeEvent, type FormEvent, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError } from '../api/client';
import {
  createInterview,
  startInterview,
  type InputMode,
  type InterviewMode,
  type Persona,
} from '../api/interviews';
import { fetchProfile, type Profile } from '../api/profile';
import { fetchPreCheck, type PreCheckOut } from '../api/precheck';
import { useAuth } from '../auth/AuthContext';
import { APP_NAME, MODE_LABELS, PERSONA_LABELS } from '../lib/labels';
import { extractResumeText } from '../lib/resumeParse';
import './InterviewPages.css';
import MobileTabBar from '../components/MobileTabBar';

const MODES: InterviewMode[] = ['behavioral', 'technical', 'mixed'];

const PERSONAS: Persona[] = ['standard', 'strict_tech', 'warm_hr', 'stress'];

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
  const [persona, setPersona] = useState<Persona>('standard');
  const [profile, setProfile] = useState<Profile | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [precheck, setPrecheck] = useState<PreCheckOut | null>(null);
  const [prechecking, setPrechecking] = useState(false);
  const [precheckError, setPrecheckError] = useState('');
  const [precheckStale, setPrecheckStale] = useState(false);

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
      setPrecheckStale(true);
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
    setPrecheckStale(true);
  }

  async function handlePrecheck() {
    setPrecheckError('');
    const trimmedJd = jobJd.trim();
    if (!trimmedJd) {
      setPrecheckError('请先填写职位描述');
      return;
    }
    setPrechecking(true);
    try {
      const result = await fetchPreCheck(trimmedJd, resumeText.trim());
      setPrecheck(result);
      setPrecheckStale(false);
    } catch (err) {
      setPrecheckError(err instanceof ApiError ? err.message : '匹配度检测失败');
    } finally {
      setPrechecking(false);
    }
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
        persona,
        ...(trimmedResume ? { resume_text: trimmedResume } : {}),
        ...(precheck && !precheckStale ? { precheck_gaps: precheck.gaps } : {}),
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
              onChange={(e) => {
                setJobJd(e.target.value);
                setPrecheckStale(true);
              }}
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

          <div className="interview-field">
            <label htmlFor="precheck">匹配度检测（可选）</label>
            <button
              type="button"
              className="interview-file-clear"
              onClick={handlePrecheck}
              disabled={prechecking || loading}
            >
              {prechecking ? '正在检测…' : '检测简历与职位匹配度'}
            </button>
            {precheckError && <p className="interview-error">{precheckError}</p>}
          </div>

          {precheck && (
            <div className="precheck-card">
              {precheckStale && (
                <p className="precheck-stale">JD/简历已修改，建议重新检测。</p>
              )}
              <p>
                匹配度 <strong>{precheck.match_score}</strong> / 100
              </p>
              {precheck.gaps.length > 0 && (
                <div>
                  <p className="precheck-section-label">差距</p>
                  <ul>
                    {precheck.gaps.map((g, i) => (
                      <li key={i}>{g}</li>
                    ))}
                  </ul>
                </div>
              )}
              {precheck.suggestions.length > 0 && (
                <div>
                  <p className="precheck-section-label">建议</p>
                  <ul>
                    {precheck.suggestions.map((s, i) => (
                      <li key={i}>{s}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          <div className="interview-field">
            <label htmlFor="persona">面试官风格</label>
            <select
              id="persona"
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
            className="interview-submit"
            type="submit"
            disabled={loading || resumeParsing}
          >
            {loading ? '正在开始面试…' : '开始面试'}
          </button>
        </form>
      </main>
      <MobileTabBar />
    </div>
  );
}
