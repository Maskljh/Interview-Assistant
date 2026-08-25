import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ApiError, getToken } from '../api/client';
import { endInterview, getInterview, type Persona } from '../api/interviews';
import { synthesizeSpeech, transcribeAudio } from '../api/speech';
import { useAuth } from '../auth/AuthContext';
import {
  startVoiceRecording as startRecordingSession,
  type VoiceRecorder,
} from '../lib/voiceRecorder';
import { createVoicePlayer } from '../lib/voicePlayer';
import { COMPANY_STYLE_LABELS, DIFFICULTY_LABELS, PERSONA_LABELS } from '../lib/labels';
import { connectInterviewWS, type ServerMsg } from '../ws/interviewSocket';
import { useBehaviorAnalysis } from '../behavior/useBehaviorAnalysis';
import './InterviewPages.css';
import AppNav from '../components/AppNav';
import CameraPreview from '../components/CameraPreview';

// 面试总时长（固定 30 分钟；与创建页「面试时长 · 30 分钟」一致）。
const SESSION_TOTAL_MS = 30 * 60 * 1000;

interface Turn {
  id: number;
  role: 'interviewer' | 'candidate';
  content: string;
}
type VoicePhase = 'idle' | 'recording' | 'transcribing' | 'sending';

function formatRemaining(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

// firstNonEmptyLine 取 JD 首个非空行，超 20 字截断，作为岗位名的兜底展示。
function firstNonEmptyLine(text: string): string {
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l !== '');
  if (!line) return '未命名岗位';
  const runes = [...line];
  return runes.length <= 20 ? line : runes.slice(0, 20).join('') + '…';
}

export default function InterviewRoomPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const interviewId = Number(id);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(
    null,
  );
  const [thinking, setThinking] = useState(false);
  const [disconnected, setDisconnected] = useState(false);
  const [statusLine, setStatusLine] = useState('');
  const [ending, setEnding] = useState(false);
  const [error, setError] = useState('');
  const [persona, setPersona] = useState<Persona | null>(null);
  const [difficulty, setDifficulty] = useState<string | null>(null);
  const [companyStyle, setCompanyStyle] = useState<string | null>(null);
  const [jobTitle, setJobTitle] = useState<string>('');
  const [cameraEnabled, setCameraEnabled] = useState(false);
  const [loadingInterview, setLoadingInterview] = useState(true);
  const [voicePhase, setVoicePhase] = useState<VoicePhase>('idle');
  const [ttsMuted, setTtsMuted] = useState(false);
  const [reading, setReading] = useState(false);
  const [retryingASR, setRetryingASR] = useState(false);
  const [paused, setPaused] = useState(false);
  const [remainingMs, setRemainingMs] = useState(SESSION_TOTAL_MS);
  const turnIdRef = useRef(0);
  const socketRef = useRef<ReturnType<typeof connectInterviewWS> | null>(null);
  const doneRef = useRef(false);
  const voiceRecorderRef = useRef<VoiceRecorder | null>(null);
  const voicePlayerRef = useRef<ReturnType<typeof createVoicePlayer> | null>(null);
  const speechVersionRef = useRef(0);
  const ttsMutedRef = useRef(false);
  const currentQuestionRef = useRef('');
  const lastInterviewerMsgRef = useRef<string | null>(null);
  const recordStartRef = useRef<number | null>(null);
  const failedAudioRef = useRef<Blob | null>(null);
  const retryTimerRef = useRef<number | null>(null);
  const attemptRef = useRef(0);
  const voiceReadyRef = useRef(false);
  const voiceCancelRef = useRef(false);
  const voiceActiveRef = useRef(false);
  const mountedRef = useRef(true);
  const timerStartedRef = useRef(false);
  const timerDeadlineRef = useRef<number | null>(null);
  const timerIntervalRef = useRef<number | null>(null);
  const pausedRef = useRef(false);
  const pausedAtRef = useRef<number | null>(null);
  const accumulatedPausedMsRef = useRef(0);
  const endTriggeredRef = useRef(false);
  // 摄像头分析仅在「创建时勾选开启」时启用；面试全程为语音作答（input mode 恒为 voice）。
  const behaviorVoiceEnabled = cameraEnabled;
  const behavior = useBehaviorAnalysis({
    enabled: behaviorVoiceEnabled,
    sessionId: interviewId,
  });
  const behaviorStartRef = useRef<() => Promise<void>>(async () => {});
  const behaviorStopRef = useRef<() => Promise<void>>(async () => {});
  behaviorStartRef.current = behavior.start;
  behaviorStopRef.current = behavior.stop;
  useEffect(() => {
    if (behaviorVoiceEnabled) {
      void behaviorStartRef.current();
    } else {
      void behaviorStopRef.current();
    }
  }, [behaviorVoiceEnabled]);
  const [pendingCount, setPendingCount] = useState(0);
  const pendingAnswersRef = useRef<{ content: string; voiceDurationMs?: number }[]>([]);
  const appendTurn = useCallback((role: Turn['role'], content: string) => {
    turnIdRef.current += 1;
    setTurns((prev) => [...prev, { id: turnIdRef.current, role, content }]);
    if (role === 'interviewer') {
      lastInterviewerMsgRef.current = content;
    }
  }, []);
  const submitAnswer = useCallback(
    (content: string, voiceDurationMs?: number) => {
      appendTurn('candidate', content);
      const sent = socketRef.current?.sendAnswer(content, voiceDurationMs) ?? false;
      if (!sent) {
        pendingAnswersRef.current.push({ content, voiceDurationMs });
        setPendingCount(pendingAnswersRef.current.length);
      }
    },
    [appendTurn],
  );
  const playQuestion = useCallback(async (content: string) => {
    if (ttsMutedRef.current) return;
    const version = ++speechVersionRef.current;
    setStatusLine('正在朗读问题...');
    try {
      const blob = await synthesizeSpeech(content);
      if (version !== speechVersionRef.current) return;
      if (!voicePlayerRef.current) {
        voicePlayerRef.current = createVoicePlayer();
      }
      setReading(true);
      await voicePlayerRef.current.play(blob);
      if (version === speechVersionRef.current) {
        setStatusLine('');
        setReading(false);
      }
    } catch (err) {
      if (version !== speechVersionRef.current) return;
      setReading(false);
      setStatusLine(
        err instanceof ApiError && err.status === 502
          ? '语音服务暂不可用，请稍后重试'
          : '播放失败，请阅读文字',
      );
    }
  }, []);
  const toggleMute = useCallback(() => {
    const next = !ttsMutedRef.current;
    ttsMutedRef.current = next;
    setTtsMuted(next);
    if (next) {
      speechVersionRef.current += 1;
      voicePlayerRef.current?.stop();
      setReading(false);
      setStatusLine('');
    }
  }, []);
  const handleReplay = useCallback(() => {
    if (currentQuestionRef.current && !ttsMutedRef.current) {
      void playQuestion(currentQuestionRef.current);
    }
  }, [playQuestion]);

  // 倒计时到期的结束动作通过 ref 间接调用，避免 startTimer 与 handleForceEnd 的
  // 定义顺序问题；handleForceEnd 每次渲染都会更新该 ref。
  const forceEndRef = useRef<() => Promise<void>>(async () => {});

  // 面试倒计时：首次连接成功（收到 session_started）开始；暂停时冻结，
  // 恢复后基于原截止时间继续；归零自动结束本场。
  const startTimer = useCallback(() => {
    if (timerStartedRef.current || doneRef.current) return;
    timerStartedRef.current = true;
    accumulatedPausedMsRef.current = 0;
    timerDeadlineRef.current = Date.now() + SESSION_TOTAL_MS;
    timerIntervalRef.current = window.setInterval(() => {
      if (pausedRef.current || timerDeadlineRef.current == null) return;
      // 暂停期间的时间（accumulatedPausedMs）不计入消耗，恢复后剩余时间相应延长。
      const remaining = timerDeadlineRef.current - Date.now() + accumulatedPausedMsRef.current;
      setRemainingMs(remaining);
      if (remaining <= 0) {
        if (timerIntervalRef.current != null) {
          window.clearInterval(timerIntervalRef.current);
          timerIntervalRef.current = null;
        }
        if (!endTriggeredRef.current) {
          endTriggeredRef.current = true;
          void forceEndRef.current();
        }
      }
    }, 1000);
  }, []);

  // 暂停/恢复：冻结倒计时，暂停 AI 提问与 TTS 播报；恢复后按原截止时间继续。
  const togglePause = useCallback(() => {
    if (doneRef.current || ending) return;
    if (!pausedRef.current) {
      if (voiceActiveRef.current) return; // 录音中不允许暂停
      pausedRef.current = true;
      pausedAtRef.current = Date.now();
      setPaused(true);
      speechVersionRef.current += 1;
      voicePlayerRef.current?.stop();
      setReading(false);
      setStatusLine('');
    } else {
      pausedRef.current = false;
      if (pausedAtRef.current != null) {
        accumulatedPausedMsRef.current += Date.now() - pausedAtRef.current;
        pausedAtRef.current = null;
      }
      setPaused(false);
      setStatusLine('');
    }
  }, [ending]);

  const handleMessage = useCallback(
    async (msg: ServerMsg) => {
      if (msg.progress) {
        setProgress(msg.progress);
      }
      switch (msg.type) {
        case 'session_started':
          setDisconnected(false);
          setStatusLine('');
          setVoicePhase('idle');
          startTimer();
          break;
        case 'question':
        case 'follow_up':
          setThinking(false);
          setVoicePhase('idle');
          if (msg.content) {
            if (msg.content !== lastInterviewerMsgRef.current) {
              appendTurn('interviewer', msg.content);
            }
            currentQuestionRef.current = msg.content;
            // 语音模式（唯一模式）：静态形象 + TTS 播报
            if (!pausedRef.current) {
              void playQuestion(msg.content);
            }
          }
          break;
        case 'status':
          if (msg.content === 'thinking') {
            setThinking(true);
            setStatusLine('');
            setVoicePhase('idle');
          } else {
            setThinking(false);
            if (msg.content) {
              setStatusLine(msg.content);
            }
          }
          break;
        case 'done':
          doneRef.current = true;
          setThinking(false);
          setVoicePhase('idle');
          voicePlayerRef.current?.stop();
          await Promise.race([
            behaviorStopRef.current(),
            new Promise((resolve) => setTimeout(resolve, 3000)),
          ]);
          navigate(`/interviews/${interviewId}/report`, { replace: true });
          break;
      }
    },
    [appendTurn, interviewId, navigate, playQuestion, startTimer],
  );
  const RETRY_DELAYS = [1000, 2000, 4000, 8000, 8000];
  const connectWithRetry = useCallback(
    (attempt: number) => {
      if (!mountedRef.current) return;
      attemptRef.current = attempt;
      const token = getToken();
      if (!token || !Number.isFinite(interviewId)) {
        setError('未登录或登录已失效');
        return;
      }
      socketRef.current?.close();
      setDisconnected(false);
      setError('');
      socketRef.current = connectInterviewWS(interviewId, token, {
        onMessage: (msg) => {
          if (msg.type === 'session_started') {
            attemptRef.current = 0; // 重连成功，重置退避
            handleMessage(msg);
            const queue = pendingAnswersRef.current;
            if (queue.length > 0) {
              pendingAnswersRef.current = [];
              for (const item of queue) {
                socketRef.current?.sendAnswer(item.content, item.voiceDurationMs);
              }
              setPendingCount(0);
              setStatusLine('连接已恢复，暂存回答已发送');
            }
          } else {
            handleMessage(msg);
          }
        },
        onClose: () => {
          if (!mountedRef.current || doneRef.current) return;
          setThinking(false);
          setVoicePhase('idle');
          voicePlayerRef.current?.stop();
          if (attemptRef.current >= RETRY_DELAYS.length) {
            setDisconnected(true); // 退避耗尽，降级手动按钮
            return;
          }
          const delay = RETRY_DELAYS[attemptRef.current];
          attemptRef.current += 1;
          setStatusLine(`连接中断，正在重连（第 ${attemptRef.current} 次）…`);
          if (retryTimerRef.current != null) window.clearTimeout(retryTimerRef.current);
          retryTimerRef.current = window.setTimeout(
            () => connectWithRetry(attemptRef.current),
            delay,
          );
        },
      });
    },
    [handleMessage, interviewId],
  );
  const connect = useCallback(() => {
    attemptRef.current = 0;
    connectWithRetry(0);
  }, [connectWithRetry]);
  useEffect(() => {
    mountedRef.current = true;
    if (!Number.isFinite(interviewId)) {
      setError('无效的面试 ID');
      setLoadingInterview(false);
      return;
    }
    let cancelled = false;
    setLoadingInterview(true);
    setError('');
    async function loadAndConnect() {
      try {
        const data = await getInterview(interviewId);
        if (cancelled) return;
        // Voice-only product: every session plays in voice regardless of its
        // stored input_mode (historical 'text' sessions included).
        setPersona(data.persona);
        setDifficulty(data.difficulty);
        setCompanyStyle(data.company_style);
        setCameraEnabled(data.camera_enabled);
        setJobTitle(
          (data.job_title && data.job_title.trim())
            ? data.job_title.trim()
            : firstNonEmptyLine(data.job_jd),
        );
        doneRef.current = false;
        let lastInterviewerContent: string | null = null;
        if (data.turns.length > 0) {
          const initial: Turn[] = data.turns.map((t) => ({
            id: t.id,
            role: t.role === 'interviewer' ? 'interviewer' : 'candidate',
            content: t.content,
          }));
          setTurns(initial);
          turnIdRef.current = Math.max(0, ...data.turns.map((t) => t.id));
          const lastInterviewerTurn = [...initial]
            .reverse()
            .find((t) => t.role === 'interviewer');
          lastInterviewerContent = lastInterviewerTurn
            ? lastInterviewerTurn.content
            : null;
        }
        lastInterviewerMsgRef.current = lastInterviewerContent;
        connect();
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof ApiError ? err.message : '加载面试失败',
          );
        }
      } finally {
        if (!cancelled) {
          setLoadingInterview(false);
        }
      }
    }
    void loadAndConnect();
    return () => {
      cancelled = true;
      mountedRef.current = false;
      speechVersionRef.current += 1;
      voiceRecorderRef.current?.cancel();
      voiceRecorderRef.current = null;
      recordStartRef.current = null;
      voiceReadyRef.current = false;
      voiceCancelRef.current = false;
      voiceActiveRef.current = false;
      if (retryTimerRef.current != null) {
        window.clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      if (timerIntervalRef.current != null) {
        window.clearInterval(timerIntervalRef.current);
        timerIntervalRef.current = null;
      }
      timerStartedRef.current = false;
      voicePlayerRef.current?.stop();
      socketRef.current?.close();
      socketRef.current = null;
      void behaviorStopRef.current();
      pendingAnswersRef.current = [];
      setPendingCount(0);
    };
  }, [connect, interviewId]);
  useEffect(() => {
    if (user === null && !loadingInterview) {
      socketRef.current?.close();
      socketRef.current = null;
      if (retryTimerRef.current != null) {
        window.clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      navigate('/login');
    }
  }, [user, loadingInterview, navigate]);

  function handleSkipQuestion() {
    if (pausedRef.current || doneRef.current || thinking || ending || disconnected) return;
    const sent = socketRef.current?.sendSkipQuestion() ?? false;
    if (!sent) {
      setStatusLine('连接已断开，无法跳过问题');
      return;
    }
    speechVersionRef.current += 1;
    voicePlayerRef.current?.stop();
    setReading(false);
    setStatusLine('');
  }
  async function handleStartRecording() {
    failedAudioRef.current = null;
    if (voiceActiveRef.current) {
      return;
    }
    if (
      disconnected ||
      thinking ||
      ending ||
      paused ||
      voicePhase === 'transcribing' ||
      voicePhase === 'sending'
    ) {
      return;
    }
    voiceActiveRef.current = true;
    speechVersionRef.current += 1;
    voicePlayerRef.current?.stop();
    setError('');
    voiceCancelRef.current = false;
    voiceReadyRef.current = false;
    setVoicePhase('recording');
    setStatusLine('正在准备录音…');
    try {
      const recorder = await startRecordingSession();
      if (voiceCancelRef.current) {
        voiceActiveRef.current = false;
        recorder.cancel();
        voiceRecorderRef.current = null;
        setVoicePhase('idle');
        setStatusLine('录音未开始，请重试');
        return;
      }
      recordStartRef.current = Date.now(); // 计时点后移：录音真正开始
      voiceReadyRef.current = true;
      voiceRecorderRef.current = recorder;
      setStatusLine('正在录音，松开发送');
    } catch {
      voiceActiveRef.current = false;
      voiceCancelRef.current = false;
      setVoicePhase('idle');
      setStatusLine('无法访问麦克风，请检查浏览器权限');
    }
  }
  async function handleStopRecording() {
    const recorder = voiceRecorderRef.current;
    if (!recorder) {
      voiceCancelRef.current = true; // 麦克风未就绪已松手：就绪后释放
      return;
    }
    voiceRecorderRef.current = null;
    setVoicePhase('transcribing');
    setStatusLine('正在识别语音...');
    let audio: Blob | undefined;
    try {
      const durationMs = recordStartRef.current
        ? Date.now() - recordStartRef.current
        : undefined;
      recordStartRef.current = null;
      audio = await recorder.stop();
      const { text } = await transcribeAudio(audio);
      const trimmed = text.trim();
      if (!trimmed) {
        failedAudioRef.current = audio;
        setVoicePhase('idle');
        setStatusLine('未识别到内容，可重试识别或重新录音');
        return;
      }
      setVoicePhase('sending');
      setStatusLine('');
      submitAnswer(trimmed, durationMs);
    } catch (err) {
      if (audio) {
        failedAudioRef.current = audio;
      }
      setVoicePhase('idle');
      setStatusLine(
        err instanceof ApiError && err.status === 502
          ? '语音服务暂不可用，请稍后重试'
          : '识别失败，可重试识别或重新录音',
      );
    } finally {
      voiceActiveRef.current = false;
      voiceReadyRef.current = false;
    }
  }
  async function handleRetryASR() {
    const audio = failedAudioRef.current;
    if (!audio || retryingASR) return;
    setRetryingASR(true);
    setStatusLine('正在重新识别…');
    try {
      const { text } = await transcribeAudio(audio);
      const trimmed = text.trim();
      failedAudioRef.current = null;
      if (!trimmed) {
        setVoicePhase('idle');
        setStatusLine('仍未识别到内容，请重新录音');
        return;
      }
      setVoicePhase('sending');
      setStatusLine('');
      submitAnswer(trimmed);
    } catch (err) {
      setVoicePhase('idle');
      setStatusLine(
        err instanceof ApiError && err.status === 502
          ? '语音服务暂不可用，请稍后重试'
          : '重试识别失败，可重新录音',
      );
    } finally {
      setRetryingASR(false);
    }
  }
  async function handleForceEnd(silent = false) {
    if (ending || doneRef.current) return;
    if (!silent && !window.confirm('确定结束面试吗？结束后将生成评分报告，且无法继续回答。')) return;
    setEnding(true);
    setStatusLine('正在生成报告，请稍候…');
    setError('');
    speechVersionRef.current += 1;
    voicePlayerRef.current?.stop();
    voiceRecorderRef.current?.cancel();
    voiceRecorderRef.current = null;
    recordStartRef.current = null;
    voiceReadyRef.current = false;
    voiceCancelRef.current = false;
    voiceActiveRef.current = false;
    setVoicePhase('idle');
    try {
      await endInterview(interviewId);
      await Promise.race([
        behaviorStopRef.current(),
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ]);
      if (!doneRef.current) {
        doneRef.current = true;
        navigate(`/interviews/${interviewId}/report`, { replace: true });
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '结束面试失败');
    } finally {
      setEnding(false);
    }
  }
  forceEndRef.current = handleForceEnd;
  return (
    <div className="interview-page interview-page--immersive">
      <AppNav tab="create" confirmLeave variant="topbar">
        {/* 顶栏中部：岗位 + 模式标签（左侧），进度 + 剩余时间 + 录音状态（右侧） */}
        <span className="room-topbar-job">
          <span className="room-topbar-meta">{jobTitle || '未命名岗位'}</span>
          {persona && persona !== 'standard' && (
            <span className="mode-pill mode-pill--light">
              {PERSONA_LABELS[persona]}
            </span>
          )}
          {difficulty && difficulty !== 'medium' && (
            <span className="mode-pill mode-pill--light">
              {DIFFICULTY_LABELS[difficulty]}
            </span>
          )}
          {companyStyle && companyStyle !== 'general' && (
            <span className="mode-pill mode-pill--light">
              {COMPANY_STYLE_LABELS[companyStyle]}
            </span>
          )}
        </span>
        <span className="room-topbar-right">
          {progress && (
            <span className="room-topbar-progress">
              第 {progress.current} / {progress.total} 题
            </span>
          )}
          <span className="room-topbar-timer">
            剩余 {formatRemaining(remainingMs)}
          </span>
          <span className="room-rec-ok">● 录音正常</span>
        </span>
      </AppNav>
      <main className="interview-main interview-room">
        {loadingInterview ? (
          <p className="interview-loading">加载面试中…</p>
        ) : (
          <>
            {/* 左右两栏：摄像头预览 + 右侧双卡片 */}
            <div className="room-grid">
              <CameraPreview />
              <div className="room-grid-right">
                {/* 双卡：实时转写 + 当前问题与追问策略 */}
                <div className="room-cards room-cards--stacked">
                  <section className="room-card">
                    <h2 className="room-card-title">实时转写</h2>
                    <div className="interview-transcript interview-room-transcript">
                      {turns.length === 0 ? (
                        error && !loadingInterview ? (
                          <div className="interview-room-error">
                            <p className="interview-error">{error}</p>
                            <button
                              type="button"
                              className="interview-submit"
                              onClick={() => window.location.reload()}
                            >
                              重新加载
                            </button>
                            <Link className="interview-inline-link" to="/history">
                              返回列表
                            </Link>
                          </div>
                        ) : (
                          <p className="interview-loading">正在连接面试间…</p>
                        )
                      ) : (
                        (() => {
                          // 只展示最新一题：找到最后一道面试官题目，以及紧随其后的候选回答
                          let latestIdx = -1;
                          for (let i = turns.length - 1; i >= 0; i--) {
                            if (turns[i].role === 'interviewer') { latestIdx = i; break; }
                          }
                          if (latestIdx === -1) return null;
                          const visible = [turns[latestIdx]];
                          if (latestIdx + 1 < turns.length && turns[latestIdx + 1].role === 'candidate') {
                            visible.push(turns[latestIdx + 1]);
                          }
                          return visible.map((turn, i) => (
                            <article
                              key={turn.id}
                              className={`transcript-turn transcript-turn--animate${
                                turn.role === 'interviewer'
                                  ? ' transcript-turn--interviewer'
                                  : ''
                              }`}
                            >
                              <div className="transcript-turn-header">
                                <span className="transcript-role">
                                  {turn.role === 'interviewer' ? 'AI 面试官' : '我'}
                                </span>
                                {turn.role === 'interviewer' && i === 0 && (
                                  <span className="transcript-new-badge">新题目</span>
                                )}
                              </div>
                              <p className="transcript-content">{turn.content}</p>
                            </article>
                          ));
                        })()
                      )}
                      {thinking && (
                        <p className="interview-room-thinking">面试官思考中…</p>
                      )}
                    </div>
                  </section>

                  <section className="room-card">
                    <div className="room-card-head">
                      <h2 className="room-card-title">当前问题</h2>
                      {progress && (
                        <span className="room-card-count">
                          {progress.current} / {progress.total}
                        </span>
                      )}
                    </div>
                    {currentQuestionRef.current ? (
                      <>
                        <p className="room-question-text">{currentQuestionRef.current}</p>
                        <p className="room-question-hint">
                          Agent 将基于你的答案继续追问：指标口径、样本偏差、结论边界。
                        </p>
                      </>
                    ) : (
                      <p className="interview-loading">等待面试官提问…</p>
                    )}
                    <p className="room-question-status">
                      面试状态：
                      {paused ? '已暂停' : thinking ? '思考中' : reading ? '播报中' : '倾听中'}
                    </p>
                  </section>
                </div>
              </div>
            </div>

            {turns.length > 0 && error && <p className="interview-error">{error}</p>}
            {pendingCount > 0 && (
              <p className="interview-room-status interview-room-pending">
                未连接，回答已暂存（{pendingCount} 条），重连后自动发送
              </p>
            )}
            {statusLine && <p className="interview-room-status">{statusLine}</p>}
            {behavior.status === 'loading-model' && (
              <p className="interview-room-status">正在加载摄像头分析…</p>
            )}
            {behavior.status === 'running' && (
              <p className="interview-room-status">
                <span
                  className={`behavior-light behavior-light--${
                    behavior.liveStress == null
                      ? 'ok'
                      : behavior.liveStress < 40
                        ? 'ok'
                        : behavior.liveStress < 70
                          ? 'mid'
                          : 'high'
                  }`}
                />
                摄像头分析中…
              </p>
            )}

            {disconnected && (
              <div className="interview-room-disconnect">
                <p>连接已断开。</p>
                <button type="button" className="interview-submit" onClick={connect}>
                  重新连接
                </button>
              </div>
            )}
            <div className="interview-room-form">
              {/* 左侧：按住说话 + 识别状态 + TTS 控制 */}
              <div className="voice-room-controls">
                <button
                  type="button"
                  className={`voice-record-button${
                    voicePhase === 'recording'
                      ? ' voice-record-button--recording'
                      : ''
                  }`}
                  onPointerDown={(e) => {
                    e.preventDefault();
                    e.currentTarget.setPointerCapture(e.pointerId);
                    void handleStartRecording();
                  }}
                  onPointerUp={() => void handleStopRecording()}
                  onPointerCancel={() => void handleStopRecording()}
                  onKeyDown={(e) => {
                    if (
                      (e.key === ' ' || e.key === 'Enter') &&
                      !e.repeat
                    ) {
                      e.preventDefault();
                      void handleStartRecording();
                    }
                  }}
                  onKeyUp={(e) => {
                    if (e.key === ' ' || e.key === 'Enter') {
                      void handleStopRecording();
                    }
                  }}
                  disabled={
                    thinking ||
                    disconnected ||
                    ending ||
                    paused ||
                    voicePhase === 'transcribing' ||
                    voicePhase === 'sending'
                  }
                  aria-pressed={voicePhase === 'recording'}
                >
                  {voicePhase === 'recording' ? '松开发送' : '按住说话'}
                </button>
                {voicePhase === 'transcribing' && (
                  <span className="voice-room-phase">正在识别…</span>
                )}
                {voicePhase === 'sending' && (
                  <span className="voice-room-phase">正在发送…</span>
                )}
                {failedAudioRef.current && voicePhase === 'idle' && (
                  <div className="voice-room-retry">
                    <button
                      type="button"
                      className="interview-inline-link"
                      onClick={() => void handleRetryASR()}
                      disabled={retryingASR}
                    >
                      {retryingASR ? '重试中…' : '重试识别'}
                    </button>
                    <button
                      type="button"
                      className="interview-inline-link"
                      onClick={() => {
                        failedAudioRef.current = null;
                        setStatusLine('');
                      }}
                    >
                      放弃重录
                    </button>
                  </div>
                )}
                <div className="voice-room-tts-controls">
                  <button
                    type="button"
                    className={`voice-room-tts-btn${
                      ttsMuted ? ' is-active' : ''
                    }`}
                    onClick={toggleMute}
                    disabled={paused}
                  >
                    {ttsMuted ? '取消静音' : '静音'}
                  </button>
                  <button
                    type="button"
                    className="voice-room-tts-btn"
                    onClick={handleReplay}
                    disabled={!currentQuestionRef.current || ttsMuted || paused}
                  >
                    重播
                  </button>
                </div>
              </div>
              {/* 右侧：暂停 / 结束本场 / 跳过问题（按 Figma 置于右下角） */}
              <div className="interview-room-actions">
                <button
                  type="button"
                  className="interview-room-action"
                  onClick={togglePause}
                  disabled={ending || voicePhase === 'transcribing' || voicePhase === 'sending'}
                >
                  {paused ? '继续' : '暂停'}
                </button>
                <button
                  type="button"
                  className="interview-room-end"
                  onClick={() => void handleForceEnd()}
                  disabled={ending}
                >
                  {ending ? '结束中…' : '结束本场'}
                </button>
                <button
                  type="button"
                  className="interview-room-action"
                  onClick={handleSkipQuestion}
                  disabled={
                    paused ||
                    thinking ||
                    ending ||
                    disconnected ||
                    voicePhase === 'recording' ||
                    voicePhase === 'transcribing' ||
                    voicePhase === 'sending'
                  }
                >
                  跳过问题
                </button>
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
