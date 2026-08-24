import { type ChangeEvent, type FormEvent, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError } from '../api/client';
import {
  createInterview,
  createInterviewFromBank,
  startInterview,
  type CompanyStyle,
  type Difficulty,
  type InputMode,
  type InterviewMode,
  type Persona,
} from '../api/interviews';
import { fetchFocusedQuestions } from '../api/questions';
import { recognizeImage } from '../api/ocr';
import { fetchProfile, type Profile } from '../api/profile';
import { fetchPreCheck, type PreCheckOut } from '../api/precheck';
import {
  COMPANY_STYLE_LABELS,
  DIFFICULTY_LABELS,
  DIMENSION_LABELS,
  MODE_LABELS,
  PERSONA_LABELS,
} from '../lib/labels';
import { extractResumeText } from '../lib/resumeParse';
import { signUpload } from '../api/uploads';
import { uploadToOSS } from '../lib/ossUpload';
import './InterviewPages.css';
import AppNav from '../components/AppNav';

const MODES: InterviewMode[] = ['behavioral', 'technical', 'mixed'];

const PERSONAS: Persona[] = ['standard', 'strict_tech', 'warm_hr', 'stress'];

const DIFFICULTIES: Difficulty[] = ['easy', 'medium', 'hard'];

const COMPANY_STYLES: CompanyStyle[] = ['general', 'foreign', 'bigtech', 'stateowned', 'startup'];

const INPUT_MODES: { value: InputMode; label: string }[] = [
  { value: 'text', label: '文本' },
  { value: 'voice', label: '语音' },
];

export default function CreateInterviewPage() {
  const navigate = useNavigate();
  const [jobJd, setJobJd] = useState('');
  const [jdFileName, setJdFileName] = useState('');
  const [jdFileUrl, setJdFileUrl] = useState('');
  const [jdUploading, setJdUploading] = useState(false);
  const [jdProgress, setJdProgress] = useState(0);
  const [jdOcrName, setJdOcrName] = useState('');
  const [jdOcrRecognizing, setJdOcrRecognizing] = useState(false);
  const [resumeText, setResumeText] = useState('');
  const [resumeFileName, setResumeFileName] = useState('');
  const [resumeFileUrl, setResumeFileUrl] = useState('');
  const [resumeUploading, setResumeUploading] = useState(false);
  const [resumeProgress, setResumeProgress] = useState(0);
  const [resumeParsing, setResumeParsing] = useState(false);
  const [mode, setMode] = useState<InterviewMode>('mixed');
  const [inputMode, setInputMode] = useState<InputMode>('text');
  const [persona, setPersona] = useState<Persona>('standard');
  const [difficulty, setDifficulty] = useState<Difficulty>('medium');
  const [companyStyle, setCompanyStyle] = useState<CompanyStyle>('general');
  const [cameraEnabled, setCameraEnabled] = useState(false);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [precheck, setPrecheck] = useState<PreCheckOut | null>(null);
  const [prechecking, setPrechecking] = useState(false);
  const [precheckError, setPrecheckError] = useState('');
  const [precheckStale, setPrecheckStale] = useState(false);
  const [focusedStarting, setFocusedStarting] = useState(false);

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
      setResumeFileUrl('');
      return;
    }

    setError('');
    setResumeParsing(true);
    setResumeUploading(true);
    setResumeProgress(0);
    setResumeFileUrl('');
    try {
      const text = await extractResumeText(file);
      setResumeText(text);
      setResumeFileName(file.name);
      setPrecheckStale(true);
      // 上传原文件到 OSS 存档；失败不阻断（文本仍可用）
      try {
        const sign = await signUpload('resume', file);
        await uploadToOSS(sign.put_url, file, (pct) => setResumeProgress(pct));
        setResumeFileUrl(sign.object_url);
      } catch (uploadErr) {
        setError(
          uploadErr instanceof Error
            ? `简历文件上传失败：${uploadErr.message}（文本已解析可用）`
            : '简历文件上传失败（文本已解析可用）',
        );
      }
    } catch (err) {
      setResumeText('');
      setResumeFileName('');
      setResumeFileUrl('');
      setError(err instanceof Error ? err.message : '简历解析失败');
      e.target.value = '';
    } finally {
      setResumeParsing(false);
      setResumeUploading(false);
    }
  }

  async function handleJdFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) {
      setJdFileName('');
      setJdFileUrl('');
      return;
    }
    setError('');
    setJdUploading(true);
    setJdProgress(0);
    setJdFileUrl('');
    try {
      const text = await extractResumeText(file);
      setJobJd(text);
      setJdFileName(file.name);
      setPrecheckStale(true);
      try {
        const sign = await signUpload('jd', file);
        await uploadToOSS(sign.put_url, file, (pct) => setJdProgress(pct));
        setJdFileUrl(sign.object_url);
      } catch (uploadErr) {
        setError(
          uploadErr instanceof Error
            ? `JD 文件上传失败：${uploadErr.message}（文本已填入可用）`
            : 'JD 文件上传失败（文本已填入可用）',
        );
      }
    } catch (err) {
      setJdFileName('');
      setJdFileUrl('');
      setError(err instanceof Error ? err.message : 'JD 文件解析失败');
      e.target.value = '';
    } finally {
      setJdUploading(false);
    }
  }

  async function handleJdImage(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      setError('图片不能超过 5MB');
      // Clear the input value so re-selecting the same oversized file re-fires change.
      e.target.value = '';
      return;
    }
    setError('');
    setJdOcrRecognizing(true);
    setJdOcrName(file.name);
    try {
      const { text } = await recognizeImage(file);
      if (!text.trim()) {
        setJdOcrName('');
        setError('未识别到文字，请尝试更清晰的图片');
        return;
      }
      setJobJd(text);
      setPrecheckStale(true);
    } catch (err) {
      setJdOcrName('');
      const msg = err instanceof ApiError ? err.rawMessage : '';
      const ux = err instanceof ApiError ? err.message : '图片识别失败';
      if (msg.includes('unavailable') || ux.includes('改用文本粘贴')) {
        setError('图片识别失败，请改用文本粘贴');
      } else {
        setError(ux);
      }
    } finally {
      setJdOcrRecognizing(false);
      e.target.value = '';
    }
  }

  function clearResume() {
    setResumeText('');
    setResumeFileName('');
    setResumeFileUrl('');
    setPrecheckStale(true);
  }

  function clearJd() {
    setJobJd('');
    setJdFileName('');
    setJdFileUrl('');
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

  async function handleFocusedPractice() {
    if (!profile) return;
    setError('');
    setFocusedStarting(true);
    try {
      const items = await fetchFocusedQuestions(profile.weak_dimensions);
      if (items.length === 0) {
        setError('题库中没有该薄弱维度的题目，建议先导入');
        return;
      }
      const created = await createInterviewFromBank({
        question_ids: items.map((q) => q.id),
        mode,
        input_mode: inputMode,
        persona,
        difficulty,
        company_style: companyStyle,
        camera_enabled: cameraEnabled,
      });
      navigate(`/interviews/${created.id}/room`, { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '专项练习创建失败');
    } finally {
      setFocusedStarting(false);
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
        difficulty,
        company_style: companyStyle,
        camera_enabled: cameraEnabled,
        ...(trimmedResume ? { resume_text: trimmedResume } : {}),
        ...(resumeFileUrl ? { resume_file_url: resumeFileUrl } : {}),
        ...(jdFileUrl ? { jd_file_url: jdFileUrl } : {}),
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
      <AppNav tab="create" />
      <main className="interview-main">
        <Link className="interview-back-link" to="/">
          ← 全部面试
        </Link>
        <h1>新建面试</h1>
        <p className="interview-subtitle">粘贴职位描述，可选上传简历，并选择练习模式。</p>

        {profile && (
          <div className="profile-card">
            {profile.weak_dimensions.length > 0 ? (
              <>
                <p>
                  针对性出题已开启：根据你最近 {profile.based_on_sessions} 场面试，薄弱点是
                  {profile.weak_dimensions
                    .map((d) => DIMENSION_LABELS[d] ?? d)
                    .map((label) => `【${label}】`)
                    .join('、')}
                </p>
                <button
                  type="button"
                  className="interview-file-clear"
                  onClick={handleFocusedPractice}
                  disabled={focusedStarting || loading}
                >
                  {focusedStarting ? '正在组卷…' : '针对薄弱点开始练习'}
                </button>
              </>
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
            <div className="interview-file-row">
              <input
                id="jd-file"
                type="file"
                accept=".txt,.md,.pdf,.docx,text/plain,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                onChange={handleJdFile}
                disabled={jdUploading || loading}
              />
              {jdFileName && (
                <div className="interview-file-meta">
                  <span className="interview-file-name">
                    已读取：{jdFileName}
                    {jobJd ? `（约 ${jobJd.length} 字）` : ''}
                  </span>
                  <button
                    type="button"
                    className="interview-file-clear"
                    onClick={clearJd}
                    disabled={jdUploading || loading}
                  >
                    清除
                  </button>
                </div>
              )}
              {jdUploading && (
                <span className="interview-file-progress">
                  上传中… {jdProgress}%
                </span>
              )}
            </div>
            <div className="interview-file-row">
              <label className="interview-file-label" htmlFor="jd-image">
                或上传 JD 图片
              </label>
              <input
                id="jd-image"
                type="file"
                accept="image/jpeg,image/png,image/webp"
                onChange={handleJdImage}
                disabled={jdOcrRecognizing || loading}
              />
              {jdOcrRecognizing && (
                <span className="interview-file-progress">OCR 识别中…</span>
              )}
              {jdOcrName && !jdOcrRecognizing && (
                <span className="interview-file-name">
                  已读取：{jdOcrName}
                  {jobJd ? `（约 ${jobJd.length} 字）` : ''}
                </span>
              )}
            </div>
            <p className="interview-field-hint">可粘贴 JD，或上传 .txt、.md、.pdf、.docx 文件。</p>
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
            {resumeUploading && !resumeParsing && (
              <p className="interview-loading">正在上传原文件… {resumeProgress}%</p>
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

          <div className="interview-field">
            <label htmlFor="difficulty">面试难度</label>
            <select
              id="difficulty"
              value={difficulty}
              onChange={(e) => setDifficulty(e.target.value as Difficulty)}
            >
              {DIFFICULTIES.map((value) => (
                <option key={value} value={value}>
                  {DIFFICULTY_LABELS[value]}
                </option>
              ))}
            </select>
          </div>

          <div className="interview-field">
            <label htmlFor="companyStyle">企业风格</label>
            <select
              id="companyStyle"
              value={companyStyle}
              onChange={(e) => setCompanyStyle(e.target.value as CompanyStyle)}
            >
              {COMPANY_STYLES.map((value) => (
                <option key={value} value={value}>
                  {COMPANY_STYLE_LABELS[value]}
                </option>
              ))}
            </select>
          </div>

          <div className="interview-field">
            <label className="interview-check-row" htmlFor="camera-enabled">
              <input
                id="camera-enabled"
                type="checkbox"
                checked={cameraEnabled}
                onChange={(e) => setCameraEnabled(e.target.checked)}
              />
              开启摄像头分析（可选）
            </label>
            <p className="interview-field-hint">
              面试中采集表情/行为信号（情绪、紧张度、点头），仅在本地分析，不上传画面。
            </p>
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
