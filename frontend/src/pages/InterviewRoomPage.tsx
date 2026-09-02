import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ApiError, getToken } from '../api/client';
import { endInterview, getInterview } from '../api/interviews';
import { synthesizeSpeech, transcribeAudio } from '../api/speech';
import { useAuth } from '../auth/AuthContext';
import {
  startVoiceRecording as startRecordingSession,
  type VoiceRecorder,
} from '../lib/voiceRecorder';
import { createVoicePlayer } from '../lib/voicePlayer';
import {
  AvatarSpeechStopped,
  createAvatarController,
  type AvatarController,
} from '../lib/avatar/avatarController';
import { connectInterviewWS, type ServerMsg } from '../ws/interviewSocket';
import { useBehaviorAnalysis } from '../behavior/useBehaviorAnalysis';
import './InterviewPages.css';
import './InterviewRoomPage.css';
import CameraPreview from '../components/CameraPreview';
import InterviewerAvatar from '../components/InterviewerAvatar';
import ConfirmModal from '../components/ConfirmModal';
import TopBar from '../components/TopBar';

// TTS 单次合成长度上限（后端 maxTTSTextRunes=300）。超长问题拆成多段顺序朗读。
const TTS_MAX_RUNES = 300;

// 数字人面试官开关的本地持久化 key（默认开启，'0' 表示用户主动关闭）。
const AVATAR_PREF_KEY = 'mianzhi.interviewer-avatar.enabled';

function readAvatarPref(): boolean {
  try {
    return localStorage.getItem(AVATAR_PREF_KEY) !== '0';
  } catch {
    return true;
  }
}

/** 把超长文本按句切成不超过 max 字符的段，尽量在断句处切，避免朗读被截断。 */
function splitTextForTTS(text: string, max = TTS_MAX_RUNES): string[] {
  const sentences = text.split(/(?<=[。！？；\n])/);
  const segments: string[] = [];
  let current = '';
  const runes = (s: string) => Array.from(s).length;
  for (const s of sentences) {
    const chunk = s.trim();
    if (!chunk) continue;
    if (runes(current + chunk) <= max) {
      current += chunk;
      continue;
    }
    if (current) segments.push(current);
    if (runes(chunk) > max) {
      // 单个句子仍超长：硬切
      let rest = chunk;
      while (runes(rest) > max) {
        const arr = Array.from(rest);
        segments.push(arr.slice(0, max).join(''));
        rest = arr.slice(max).join('');
      }
      current = rest;
    } else {
      current = chunk;
    }
  }
  if (current) segments.push(current);
  return segments.length > 0 ? segments : [text];
}

interface Turn {
  id: number;
  role: 'interviewer' | 'candidate';
  content: string;
}
type VoicePhase = 'idle' | 'recording' | 'transcribing' | 'sending';

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
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
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [disconnected, setDisconnected] = useState(false);
  // 致命错误（会话不可进入/不存在）：停止自动重连，展示明确提示而非无限重试。
  const [fatalError, setFatalError] = useState('');
  const [statusLine, setStatusLine] = useState('');
  const [ending, setEnding] = useState(false);
  const [error, setError] = useState('');
  const [, setPersona] = useState<string | null>(null);
  const [, setDifficulty] = useState<string | null>(null);
  const [, setCompanyStyle] = useState<string | null>(null);
  const [jobTitle, setJobTitle] = useState<string>('');
  const [loadingInterview, setLoadingInterview] = useState(true);
  const [voicePhase, setVoicePhase] = useState<VoicePhase>('idle');
  const [ttsMuted, setTtsMuted] = useState(false);
  const [reading, setReading] = useState(false);
  const [retryingASR, setRetryingASR] = useState(false);
  const [paused, setPaused] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  // 面试材料栏（左栏便签）数据：简历名 / 岗位信息摘要 / 题目数
  const [materials, setMaterials] = useState<{ resume: string; jd: string; questions: number }>({
    resume: '未选择简历',
    jd: '未导入岗位信息',
    questions: 0,
  });
  // 数字人面试官：默认开启，localStorage 记忆用户选择。
  const [avatarEnabled, setAvatarEnabled] = useState<boolean>(readAvatarPref);
  const avatarEnabledRef = useRef(avatarEnabled);
  const avatarRef = useRef<AvatarController | null>(null);
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
  const fatalErrorRef = useRef(false);
  const voiceReadyRef = useRef(false);
  const voiceCancelRef = useRef(false);
  const voiceActiveRef = useRef(false);
  const mountedRef = useRef(true);
  const timerStartedRef = useRef(false);
  const timerStartedAtRef = useRef<number | null>(null);
  const timerIntervalRef = useRef<number | null>(null);
  const pausedRef = useRef(false);
  const pausedAtRef = useRef<number | null>(null);
  const accumulatedPausedMsRef = useRef(0);
  // 行为分析为产品必开能力：摄像头无条件开启，全程分析面试者行为（行为数据仅作报告辅助参考，不计入评分）。
  // 摄像头预览与行为分析复用同一路流，避免重复打开摄像头。
  const behavior = useBehaviorAnalysis({
    enabled: true,
    sessionId: interviewId,
  });
  if (!avatarRef.current) {
    avatarRef.current = createAvatarController();
  }
  const behaviorStartRef = useRef<() => Promise<void>>(async () => {});
  const behaviorStopRef = useRef<() => Promise<void>>(async () => {});
  behaviorStartRef.current = behavior.start;
  behaviorStopRef.current = behavior.stop;
  useEffect(() => {
    void behaviorStartRef.current();
  }, []);
  // ── 设计稿 938×692 画布缩放：--home-fit / --home-canvas-width 驱动 ──
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const compute = () => {
      const workspaceWidth = Math.max(window.innerWidth, 1);
      const workspaceHeight = Math.max(window.innerHeight - 64, 1);
const scale = Math.min(workspaceWidth / 938, workspaceHeight / 692);
      const fit = Math.max(scale, 0.2);
      root.style.setProperty('--home-fit', fit.toFixed(4));
      root.style.setProperty('--home-canvas-width', `${(workspaceWidth / fit).toFixed(2)}px`);
    };
    compute();
    // jsdom 等非浏览器环境没有 ResizeObserver，做存在性守卫以便测试可运行
    const ro =
      typeof ResizeObserver !== 'undefined' ? new ResizeObserver(compute) : null;
    ro?.observe(root);
    window.addEventListener('resize', compute);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', compute);
    };
  }, []);
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
  // 统一的语音停止：数字人与纯语音两条播放路径一起停。
  const stopVoice = useCallback(() => {
    const player = voicePlayerRef.current;
    if (player) player.stop();
    avatarRef.current?.stop();
  }, []);
  // 播放单段音频：数字人开启且可用时由数字人发声（带口型同步），
  // 否则回落现有 voicePlayer 纯语音路径。
  const playSegment = useCallback(async (blob: Blob): Promise<void> => {
    if (avatarEnabledRef.current && avatarRef.current) {
      const result = await avatarRef.current.speak(blob);
      if (result === 'avatar') return;
    }
    await voicePlayerRef.current?.play(blob);
  }, []);
  const playQuestion = useCallback(
    async (content: string) => {
      if (ttsMutedRef.current) return;
      const version = ++speechVersionRef.current;
      try {
        if (!voicePlayerRef.current) {
          voicePlayerRef.current = createVoicePlayer();
        }
        setReading(true);
        // 超长文本分段合成并顺序播放，保证整段都能被朗读。
        for (const seg of splitTextForTTS(content)) {
          if (version !== speechVersionRef.current) return;
          const blob = await synthesizeSpeech(seg);
          if (version !== speechVersionRef.current) return;
          await playSegment(blob);
        }
        if (version === speechVersionRef.current) {
          setStatusLine('');
          setReading(false);
        }
      } catch (err) {
        if (err instanceof AvatarSpeechStopped) {
          // 语音被主动停止（静音/暂停/切换数字人开关等）：静默收尾。
          setReading(false);
          setStatusLine('');
          return;
        }
        if (version !== speechVersionRef.current) return;
        setReading(false);
        setStatusLine(
          err instanceof ApiError && err.status === 502
            ? '语音服务暂不可用，请稍后重试'
            : '播放失败，请阅读文字',
        );
      }
    },
    [playSegment],
  );
  const toggleAvatar = useCallback(() => {
    const next = !avatarEnabledRef.current;
    avatarEnabledRef.current = next;
    setAvatarEnabled(next);
    try {
      localStorage.setItem(AVATAR_PREF_KEY, next ? '1' : '0');
    } catch {
      // 持久化失败不影响本次会话
    }
    avatarRef.current?.setRenderingEnabled(next);
    if (!next) {
      speechVersionRef.current += 1;
      stopVoice();
      setReading(false);
      setStatusLine('');
    }
  }, [stopVoice]);
  const toggleMute = useCallback(() => {
    const next = !ttsMutedRef.current;
    ttsMutedRef.current = next;
    setTtsMuted(next);
    if (next) {
      speechVersionRef.current += 1;
      stopVoice();
      setReading(false);
      setStatusLine('');
    }
  }, []);
  const handleReplay = useCallback(() => {
    if (currentQuestionRef.current && !ttsMutedRef.current) {
      void playQuestion(currentQuestionRef.current);
    }
  }, [playQuestion]);

  // 已用时间计时器：首次连接成功（收到 session_started）开始；暂停时冻结，
  // 恢复后继续累计。仅做展示参考，不设强制结束。
  const startTimer = useCallback(() => {
    if (timerStartedRef.current || doneRef.current) return;
    timerStartedRef.current = true;
    timerStartedAtRef.current = Date.now();
    accumulatedPausedMsRef.current = 0;
    timerIntervalRef.current = window.setInterval(() => {
      if (pausedRef.current || timerStartedAtRef.current == null) return;
      // 已用时间 = 从现在到开始时刻，扣除暂停累计时长。
      const elapsed = Date.now() - timerStartedAtRef.current - accumulatedPausedMsRef.current;
      setElapsedMs(Math.max(0, elapsed));
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
      stopVoice();
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
        case 'closing':
          // 自然完成：播报简短结束语，播完（或静音）后进入报告页。
          doneRef.current = true;
          setThinking(false);
          setVoicePhase('idle');
          if (msg.content) {
            appendTurn('interviewer', msg.content);
            if (!ttsMutedRef.current) {
              setStatusLine('正在收尾…');
              await playQuestion(msg.content);
              setStatusLine('');
            }
          }
          await Promise.race([
            behaviorStopRef.current(),
            new Promise((resolve) => setTimeout(resolve, 3000)),
          ]);
          navigate(`/interviews/${interviewId}/report`, { replace: true });
          break;
        case 'error':
          // 致命错误（会话已结束/不存在等）：不再自动重连，给出明确提示。
          fatalErrorRef.current = true;
          setFatalError(
            msg.code === 'invalid_state'
              ? '该场面试已结束或当前状态不可进入，无法继续。'
              : msg.code === 'not_found'
                ? '面试不存在或已被删除。'
                : msg.content || '连接发生错误，请稍后重试',
          );
          setDisconnected(true);
          setThinking(false);
          setVoicePhase('idle');
          setStatusLine('');
          break;
        case 'done':
          doneRef.current = true;
          setThinking(false);
          setVoicePhase('idle');
          stopVoice();
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
      fatalErrorRef.current = false;
      setFatalError('');
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
          if (fatalErrorRef.current) {
            // 致命错误后连接关闭：不再重连，保持错误提示，避免无限重试。
            setDisconnected(true);
            setThinking(false);
            setVoicePhase('idle');
            stopVoice();
            return;
          }
          setThinking(false);
          setVoicePhase('idle');
          stopVoice();
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
        setJobTitle(
          (data.job_title && data.job_title.trim())
            ? data.job_title.trim()
            : firstNonEmptyLine(data.job_jd),
        );
        // 左栏面试材料便签：简历名（file_url 提取文件名）/ 岗位信息摘要 / 题目数
        setMaterials({
          resume: data.resume_text
            ? (data.resume_file_url
                ? decodeURIComponent(
                    (data.resume_file_url.split('key=')[1] || data.resume_file_url)
                      .split('&')[0]
                      .split('/').pop() || '已上传简历',
                  ).slice(-40)
                : '已上传简历')
            : '未选择简历',
          jd: data.job_jd ? firstNonEmptyLine(data.job_jd).slice(0, 16) : '未导入岗位信息',
          // 面试题集便签只统计从题库载入的题目（kind='bank'），
          // 不含开场自我介绍与 AI 生成的简历补全题。
          questions: data.questions.filter((q) => q.kind === 'bank').length,
        });
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
        if (!cancelled && !(err instanceof ApiError && err.status === 401)) {
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
      stopVoice();
      avatarRef.current?.dispose();
      avatarRef.current = null;
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
    stopVoice();
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
    stopVoice();
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
  async function handleForceEnd() {
    if (ending || doneRef.current) return;
    setEnding(true);
    setStatusLine('正在生成报告，请稍候…');
    setError('');
    speechVersionRef.current += 1;
    stopVoice();
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

  return (
    <div id="design-root" ref={rootRef}>
      <section className="interview screen">
        <section className="workspace-page">
          <TopBar active="hub" />
          <main className="workspace-main">
            <section className="room-card intel-room interview-room">
              <header className="room-case-head">
                <div>
                  <small>LIVE INTERVIEW</small>
                  <h2>面试间</h2>
                </div>
                <div className="room-actions">
                  <button
                    type="button"
                    className="room-back"
                    onClick={() => navigate('/history')}
                  >
                    返回
                  </button>
                </div>
              </header>

              <div className="room-grid">
                {/* 左栏：面试材料便签 */}
                <aside className="interview-materials">
                  <small>INTERVIEW MATERIALS</small>
                  <h3>面试材料</h3>
                  <article className="material-note">
                    <p>
                      <small>目标岗位</small>
                      <strong>{jobTitle || '未设置岗位'}</strong>
                    </p>
                    <p>
                      <small>个人简历</small>
                      <strong>{materials.resume}</strong>
                    </p>
                    <p>
                      <small>岗位信息</small>
                      <strong>{materials.jd}</strong>
                    </p>
                    <p>
                      <small>面试题集</small>
                      <strong>
                        {materials.questions > 0
                          ? `已载入 ${materials.questions} 道题`
                          : '未载入题目'}
                      </strong>
                    </p>
                  </article>
                  <footer>本场问询将依据已归档材料生成追问。</footer>
                </aside>

                {/* 中栏：视频听证 */}
                <section className="video-hearing">
                  <div className="video-status">
                    <i />
                    <span>录制中</span>
                    <time>{formatElapsed(elapsedMs)}</time>
                    <div className="video-status-actions">
                      {voicePhase === 'transcribing' && (
                        <span className="voice-room-phase">正在识别…</span>
                      )}
                      {voicePhase === 'sending' && (
                        <span className="voice-room-phase">正在发送…</span>
                      )}
                      <button
                        type="button"
                        className="voice-room-tts-btn"
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
                      <button
                        type="button"
                        className={`video-avatar-btn${avatarEnabled ? ' is-on' : ''}`}
                        onClick={toggleAvatar}
                      >
                        数字人 {avatarEnabled ? '开' : '关'}
                      </button>
                      <button
                        type="button"
                        className={`video-record-btn${
                          voicePhase === 'recording' ? ' is-recording' : ''
                        }`}
                        onPointerDown={(e) => {
                          e.preventDefault();
                          e.currentTarget.setPointerCapture(e.pointerId);
                          void handleStartRecording();
                        }}
                        onPointerUp={() => void handleStopRecording()}
                        onPointerCancel={() => void handleStopRecording()}
                        onKeyDown={(e) => {
                          if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
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
                          Boolean(fatalError) ||
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
                      {failedAudioRef.current && voicePhase === 'idle' && (
                        <span className="voice-room-retry">
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
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="video-grid">
                    <article className="video-frame">
                      <header>
                        <span>面试官窗口</span>
                        <em>
                          <b>音视频正常</b>
                          <i>LIVE</i>
                        </em>
                      </header>
                      <div className="video-frame-body">
                        {loadingInterview ? (
                          <p className="interview-loading">加载面试中…</p>
                        ) : (
                          <InterviewerAvatar
                            controller={avatarRef.current}
                            enabled={avatarEnabled}
                            onToggle={toggleAvatar}
                          />
                        )}
                      </div>
                      <footer>面试官</footer>
                    </article>
                    <article className="video-frame">
                      <header>
                        <span>候选人窗口</span>
                        <em>
                          <span className="cam-status-icons">
                            <svg viewBox="0 0 16 12" width="15" height="11" aria-label="音频正常">
                              <path
                                d="M1.5 4.5v3M4.5 2.5v7M7.5 0.8v10.4M10.5 2.5v7M13.5 4.5v3"
                                stroke="currentColor"
                                stroke-width="1.6"
                                stroke-linecap="round"
                                fill="none"
                              />
                            </svg>
                            <svg viewBox="0 0 16 12" width="15" height="11" aria-label="摄像头已开启">
                              <rect
                                x="0.8"
                                y="1.6"
                                width="9.6"
                                height="8.8"
                                rx="1.6"
                                stroke="currentColor"
                                stroke-width="1.4"
                                fill="none"
                              />
                              <path
                                d="M10.4 4.9 15.2 2.4v7.2l-4.8-2.5"
                                stroke="currentColor"
                                stroke-width="1.4"
                                fill="none"
                                stroke-linejoin="round"
                              />
                            </svg>
                          </span>
                          <i>LIVE</i>
                        </em>
                      </header>
                      <div className="video-frame-body">
                        <CameraPreview
                          stream={behavior.cameraStream}
                          opening={behavior.status === 'loading-model'}
                          error={
                            behavior.status === 'failed'
                              ? '无法访问摄像头，请检查浏览器权限'
                              : ''
                          }
                        />
                      </div>
                      <footer>候选人</footer>
                    </article>
                  </div>

                  <article className="live-question">
                    <small>
                      QUESTION {progress ? progress.current : ''}
                      {progress ? ` / ${progress.total}` : ''}
                    </small>
                    <p>{currentQuestionRef.current || '等待面试官提问…'}</p>
                    <footer>
                      {paused
                        ? '已暂停'
                        : thinking
                          ? '面试官思考中…'
                          : reading
                            ? '正在播报…'
                            : '正在记录回答'}{' '}
                      · {formatElapsed(elapsedMs)}
                    </footer>
                  </article>
                </section>

                {/* 右栏：实时点评 */}
                <aside className="live-feedback">
                  <header>
                    <small>REAL-TIME REVIEW</small>
                    <h3>实时点评</h3>
                  </header>

                  {turns.length === 0 ? (
                    <div className="feedback-list">
                      {error && !loadingInterview ? (
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
                      )}
                    </div>
                  ) : (
                    <div className="feedback-list">
                      {turns
                        .slice(-4)
                        .map((turn) => (
                          <article
                            key={turn.id}
                            className={`feedback-item${
                              thinking && turn.id === turns[turns.length - 1].id
                                ? ' pending'
                                : ''
                            }`}
                          >
                            <strong>
                              {turn.role === 'interviewer' ? '面试官提问' : '我的回答'}
                            </strong>
                            <p>
                              {turn.content.length > 46
                                ? `${turn.content.slice(0, 46)}…`
                                : turn.content}
                            </p>
                            <time>
                              {turn.role === 'interviewer' ? 'AI' : '我'} ·{' '}
                              {formatElapsed(elapsedMs)}
                            </time>
                          </article>
                        ))
                        .reverse()}
                    </div>
                  )}

                  <div className="feedback-actions">
                    <button
                      type="button"
                      onClick={togglePause}
                      disabled={
                        Boolean(fatalError) ||
                        ending ||
                        voicePhase === 'transcribing' ||
                        voicePhase === 'sending'
                      }
                    >
                      {paused ? '继续' : '暂停'}
                    </button>
                    <button
                      type="button"
                      onClick={handleSkipQuestion}
                      disabled={
                        Boolean(fatalError) ||
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
                    <button
                      type="button"
                      className="end"
                      onClick={() => setConfirmEnd(true)}
                      disabled={Boolean(fatalError) || ending}
                    >
                      {ending ? '结束中…' : '结束并生成报告'}
                    </button>
                  </div>
                </aside>
              </div>

              {/* 状态提示区：断线 / 致命错误 / 行为分析 / 暂存回答 */}
              <div className="interview-room-status">
                {turns.length > 0 && error && (
                  <p className="interview-error">{error}</p>
                )}
                {pendingCount > 0 && (
                  <p className="interview-room-status interview-room-pending">
                    未连接，回答已暂存（{pendingCount} 条），重连后自动发送
                  </p>
                )}
                {statusLine && (
                  <p className="interview-room-status">{statusLine}</p>
                )}

                {fatalError && (
                  <div className="ir-disconnect">
                    <p>{fatalError}</p>
                    <div className="ir-disconnect-actions">
                      <Link className="interview-inline-link" to="/history">
                        ← 返回列表
                      </Link>
                      <Link
                        className="interview-inline-link"
                        to={`/interviews/${interviewId}`}
                      >
                        查看详情
                      </Link>
                    </div>
                  </div>
                )}
                {!fatalError && disconnected && (
                  <div className="ir-disconnect">
                    <p>连接已断开。</p>
                    <button type="button" className="interview-submit" onClick={connect}>
                      重新连接
                    </button>
                  </div>
                )}
              </div>
            </section>
          </main>
        </section>
      </section>
      <ConfirmModal
        open={confirmEnd}
        title="结束面试"
        description="结束后将生成本场评分报告，无法继续回答"
        body=""
        danger={false}
        confirmLabel="结束面试"
        cancelLabel="取消"
        loading={ending}
        onConfirm={() => void handleForceEnd()}
        onCancel={() => setConfirmEnd(false)}
      />
    </div>
  );

}
