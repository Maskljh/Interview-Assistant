import { type ChangeEvent, type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ApiError, getToken } from '../api/client';
import { endInterview, getInterview, type InputMode, type Persona } from '../api/interviews';
import { synthesizeSpeech, transcribeAudio } from '../api/speech';
import { useAuth } from '../auth/AuthContext';
import {
  startVoiceRecording as startRecordingSession,
  type VoiceRecorder,
} from '../lib/voiceRecorder';
import { createVoicePlayer } from '../lib/voicePlayer';
import { APP_NAME, PERSONA_LABELS } from '../lib/labels';
import { connectInterviewWS, type ServerMsg } from '../ws/interviewSocket';
import './InterviewPages.css';
import MobileTabBar from '../components/MobileTabBar';
import VirtualPersona from '../components/VirtualPersona';
import VideoPersona from '../components/VideoPersona';
import UserCamera from '../components/UserCamera';
import LivestreamPersona from '../components/LivestreamPersona';
import {
  closeLivestream,
  createLivestreamSession,
  getLivestreamSign,
  speakLivestream,
  type LivestreamSession,
  type LivestreamSign,
} from '../api/livestream';
import { getVideoTask, submitVideo } from '../api/digitalHuman';

interface Turn {
  id: number;
  role: 'interviewer' | 'candidate';
  content: string;
}

type VoicePhase = 'idle' | 'recording' | 'transcribing' | 'sending';

export default function InterviewRoomPage() {
  const { logout, user } = useAuth();
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
  const [answer, setAnswer] = useState('');
  const [ending, setEnding] = useState(false);
  const [error, setError] = useState('');
  const [inputMode, setInputMode] = useState<InputMode | null>(null);
  const [persona, setPersona] = useState<Persona | null>(null);
  const [loadingInterview, setLoadingInterview] = useState(true);
  const [voicePhase, setVoicePhase] = useState<VoicePhase>('idle');
  const [ttsMuted, setTtsMuted] = useState(false);
  const [reading, setReading] = useState(false);
  const [retryingASR, setRetryingASR] = useState(false);
  const [textModeOverride, setTextModeOverride] = useState(false);
  const [personaState, setPersonaState] = useState<'idle' | 'speaking' | 'listening'>('idle');
  const [avatarUrl, setAvatarUrl] = useState<string | null>(() =>
    localStorage.getItem('virtual_persona_avatar'),
  );
  const [videoState, setVideoState] = useState<'none' | 'generating' | 'playing' | 'ended'>('none');
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [liveSign, setLiveSign] = useState<LivestreamSign | null>(null);
  const [liveReady, setLiveReady] = useState(false);
  const [liveSpeaking, setLiveSpeaking] = useState(false);

  const turnIdRef = useRef(0);
  const socketRef = useRef<ReturnType<typeof connectInterviewWS> | null>(null);
  const doneRef = useRef(false);
  const inputModeRef = useRef<InputMode>('text');
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
  const videoUnavailableRef = useRef(false);
  const liveAvailableRef = useRef(false);
  const liveSessionRef = useRef<LivestreamSession | null>(null);
  const liveSpeakTimerRef = useRef<number | null>(null);

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
      setAnswer('');
      socketRef.current?.sendAnswer(content, voiceDurationMs);
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
          ? '语音服务暂不可用，请使用文字作答'
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

  const handleSkipPlayback = useCallback(() => {
    speechVersionRef.current += 1;
    voicePlayerRef.current?.stop();
    setReading(false);
    setStatusLine('');
  }, []);

  const clearLiveSpeakTimer = useCallback(() => {
    if (liveSpeakTimerRef.current != null) {
      window.clearTimeout(liveSpeakTimerRef.current);
      liveSpeakTimerRef.current = null;
    }
  }, []);

  // 实时流无单题结束事件：按文本长度估算口播时长（约 4 字/秒），到时清除口播状态
  const estimateSpeakMs = (text: string) =>
    Math.min(30000, Math.max(3000, Math.ceil(text.length / 4) * 1000));

  // 就绪门控回调必须稳定：避免每次渲染生成新函数导致 LivestreamPersona 的 effect 重跑（会关/重开 SDK 会话）
  const handleLiveReady = useCallback(() => setLiveReady(true), []);

  // 每题 speak 前建一个腾讯后端「驱动会话」再 speak（SDK 会话由前端创建，后端拿不到其 sessionId）；
  // 该会话由 liveSessionRef 持有，卸载/结束面试时统一 close 清理。
  const handleLiveSpeak = useCallback(
    (content: string) => {
      if (!liveReady) return; // 就绪门控：SDK 未就绪时口播无效，字幕仍在，可重播
      clearLiveSpeakTimer();
      setLiveSpeaking(true);
      void (async () => {
        try {
          const session = await createLivestreamSession();
          liveSessionRef.current = session;
          await speakLivestream(session.sessionId, content);
        } catch {
          // 失败：字幕仍在，可重播
        }
      })();
      liveSpeakTimerRef.current = window.setTimeout(() => {
        setLiveSpeaking(false);
      }, estimateSpeakMs(content));
    },
    [clearLiveSpeakTimer, liveReady],
  );

  const handleLiveReplay = useCallback(() => {
    const content = currentQuestionRef.current;
    if (content) void handleLiveSpeak(content);
  }, [handleLiveSpeak]);

  const handleLiveSkip = useCallback(() => {
    clearLiveSpeakTimer();
    setLiveSpeaking(false);
  }, [clearLiveSpeakTimer]);

  async function pollVideoTask(taskId: string, version: number): Promise<string | null> {
    for (let i = 0; i < VIDEO_MAX_POLL_ATTEMPTS; i++) {
      await new Promise((r) => setTimeout(r, VIDEO_POLL_INTERVAL_MS));
      if (version !== speechVersionRef.current) return null;
      const res = await getVideoTask(taskId);
      if (version !== speechVersionRef.current) return null;
      if (res.status === 'completed' && res.videoURL) return res.videoURL;
      if (res.status === 'failed') return null;
    }
    return null; // 超时
  }

  const playQuestionVideo = useCallback(
    async (content: string) => {
      if (ttsMutedRef.current) return;
      const version = ++speechVersionRef.current;
      setVideoState('generating');
      setVideoUrl(null);
      setStatusLine('正在生成问题…');
      try {
        const { taskId } = await submitVideo(content);
        if (version !== speechVersionRef.current) return;
        const url = await pollVideoTask(taskId, version);
        if (version !== speechVersionRef.current) return;
        if (url) {
          setVideoUrl(url);
          setVideoState('playing');
          setStatusLine('');
          return;
        }
      } catch (err) {
        if (version !== speechVersionRef.current) return;
        if (err instanceof ApiError && err.status === 503) {
          videoUnavailableRef.current = true; // 本场数字人不可用，后续直接 TTS
        }
      }
      // 失败/超时 → 降级 TTS 播报（V13 行为）
      setVideoState('none');
      setVideoUrl(null);
      void playQuestion(content);
    },
    [playQuestion],
  );

  const handleVideoEnded = useCallback(() => {
    // 播完停在最后一帧（videoState='ended'），字幕保留
    setVideoState('ended');
    setStatusLine('');
  }, []);

  const handleVideoSkip = useCallback(() => {
    speechVersionRef.current += 1; // 取消进行中的轮询
    setVideoState('none');
    setVideoUrl(null);
    setStatusLine('');
  }, []);

  const handleVideoToggleMute = useCallback(() => {
    const next = !ttsMutedRef.current;
    ttsMutedRef.current = next;
    setTtsMuted(next);
    setStatusLine(next ? '已静音' : '');
  }, []);

  const handleMessage = useCallback(
    (msg: ServerMsg) => {
      if (msg.progress) {
        setProgress(msg.progress);
      }

      switch (msg.type) {
        case 'session_started':
          setDisconnected(false);
          setStatusLine('');
          setVoicePhase('idle');
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
            if (inputModeRef.current === 'voice') {
              if (liveAvailableRef.current) {
                void handleLiveSpeak(msg.content);
              } else if (videoUnavailableRef.current) {
                void playQuestion(msg.content);
              } else {
                void playQuestionVideo(msg.content);
              }
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
          navigate(`/interviews/${interviewId}/report`, { replace: true });
          break;
      }
    },
    [appendTurn, interviewId, navigate, playQuestion, playQuestionVideo, handleLiveSpeak],
  );

  const RETRY_DELAYS = [1000, 2000, 4000, 8000, 8000];
  const VIDEO_POLL_INTERVAL_MS = 3000;
  const VIDEO_MAX_POLL_ATTEMPTS = 40; // 3s × 40 = 120s 上限

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
          }
          handleMessage(msg);
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
        inputModeRef.current = data.input_mode;
        setInputMode(data.input_mode);
        setPersona(data.persona);
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
        // 实时视频面试：进入即取 sign；失败 → liveAvailable=false，回退 V14 流程
        if (data.input_mode === 'voice') {
          try {
            const sign = await getLivestreamSign();
            if (cancelled) return;
            liveAvailableRef.current = true;
            setLiveSign(sign);
          } catch {
            liveAvailableRef.current = false;
          }
        }
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
      clearLiveSpeakTimer();
      const session = liveSessionRef.current;
      liveSessionRef.current = null;
      liveAvailableRef.current = false;
      setLiveSign(null);
      setLiveReady(false);
      if (session) void closeLivestream(session.sessionId).catch(() => {});
      voicePlayerRef.current?.stop();
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [connect, interviewId]);

  const effectiveInputMode: InputMode =
    inputMode === 'voice' && !textModeOverride ? 'voice' : 'text';

  useEffect(() => {
    inputModeRef.current = effectiveInputMode;
  }, [effectiveInputMode]);

  useEffect(() => {
    if (effectiveInputMode === 'text') {
      clearLiveSpeakTimer();
      setLiveSpeaking(false);
      if (videoState !== 'none') {
        speechVersionRef.current += 1;
        setVideoState('none');
        setVideoUrl(null);
        setStatusLine('');
      }
    }
  }, [effectiveInputMode, videoState, clearLiveSpeakTimer]);

  useEffect(() => {
    if (videoState !== 'none') return; // 视频模式由 VideoPersona 接管渲染
    if (reading) setPersonaState('speaking');
    else if (thinking) setPersonaState('listening');
    else setPersonaState('idle');
  }, [videoState, reading, thinking]);

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

  function handleAvatarChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setStatusLine('请选择图片文件');
      return;
    }
    if (file.size > 300 * 1024) {
      setStatusLine('头像需小于 300KB');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      localStorage.setItem('virtual_persona_avatar', url);
      setAvatarUrl(url);
      setStatusLine('头像已更新');
    };
    reader.readAsDataURL(file);
    e.target.value = '';
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
      setStatusLine('无法访问麦克风，请使用文字作答');
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
          ? '语音服务暂不可用，请使用文字作答'
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
          ? '语音服务暂不可用，请使用文字作答'
          : '重试识别失败，可重新录音',
      );
    } finally {
      setRetryingASR(false);
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = answer.trim();
    if (!trimmed || thinking || disconnected || ending) {
      return;
    }
    if (
      inputModeRef.current === 'voice' &&
      (voicePhase === 'transcribing' || voicePhase === 'sending')
    ) {
      setStatusLine('正在识别语音，请稍候');
      return;
    }
    if (inputModeRef.current === 'voice') {
      setVoicePhase('sending');
    }
    submitAnswer(trimmed);
  }

  async function handleForceEnd() {
    if (ending || doneRef.current) return;
    setEnding(true);
    setStatusLine('正在生成报告，请稍候…');
    setError('');
    speechVersionRef.current += 1;
    clearLiveSpeakTimer();
    const session = liveSessionRef.current;
    liveSessionRef.current = null;
    liveAvailableRef.current = false;
    setLiveSign(null);
    setLiveReady(false);
    if (session) void closeLivestream(session.sessionId).catch(() => {});
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

  const voiceBusy = voicePhase === 'transcribing' || voicePhase === 'sending';

  return (
    <div className="interview-page">
      <header className="interview-header">
        <Link className="interview-brand" to="/">
          {APP_NAME}
        </Link>
        <div className="interview-header-actions">
          <Link className="interview-header-link header-nav-link" to="/">
            返回列表
          </Link>
          <Link className="interview-header-link header-nav-link" to={`/interviews/${id}`}>
            详情
          </Link>
          <Link className="interview-header-link header-nav-link" to="/trends">
            成长分析
          </Link>
          <button type="button" className="interview-header-link" onClick={logout}>
            退出登录
          </button>
        </div>
      </header>
      <main className="interview-main interview-room">
        {loadingInterview ? (
          <p className="interview-loading">加载面试中…</p>
        ) : (
          <>
            <div className="interview-room-header">
              <h1>面试进行中</h1>
              {persona && persona !== 'standard' && (
                <span className="mode-pill">{PERSONA_LABELS[persona]}</span>
              )}
              {progress && (
                <span className="interview-room-progress">
                  第 {progress.current} / {progress.total} 题
                </span>
              )}
            </div>

            {effectiveInputMode === 'voice' && (
              <div className="video-persona-stage">
                {liveSign ? (
                  <LivestreamPersona
                    sign={liveSign}
                    question={currentQuestionRef.current ?? ''}
                    speaking={liveSpeaking}
                    muted={ttsMuted}
                    onReady={handleLiveReady}
                    onToggleMute={handleVideoToggleMute}
                    onReplay={handleLiveReplay}
                    onSkip={handleLiveSkip}
                  />
                ) : videoState !== 'none' ? (
                  <VideoPersona
                    state={videoState}
                    videoUrl={videoUrl}
                    question={currentQuestionRef.current ?? ''}
                    muted={ttsMuted}
                    onVideoEnded={handleVideoEnded}
                    onToggleMute={handleVideoToggleMute}
                    onSkip={handleVideoSkip}
                  />
                ) : (
                  <VirtualPersona state={personaState} avatarUrl={avatarUrl} />
                )}
                <UserCamera />
                <label className="virtual-persona-avatar-btn">
                  换头像
                  <input type="file" accept="image/*" onChange={handleAvatarChange} hidden />
                </label>
              </div>
            )}

            {error && <p className="interview-error">{error}</p>}
            {statusLine && <p className="interview-room-status">{statusLine}</p>}

            <div className="interview-transcript interview-room-transcript">
              {turns.length === 0 ? (
                <p className="interview-loading">正在连接面试间…</p>
              ) : (
                turns.map((turn) => (
                  <article
                    key={turn.id}
                    className={`transcript-turn${
                      turn.role === 'interviewer'
                        ? ' transcript-turn--interviewer'
                        : ''
                    }`}
                  >
                    <div className="transcript-turn-header">
                      <span className="transcript-role">
                        {turn.role === 'interviewer' ? '面试官' : '我'}
                      </span>
                    </div>
                    <p className="transcript-content">{turn.content}</p>
                  </article>
                ))
              )}
              {thinking && (
                <p className="interview-room-thinking">面试官思考中…</p>
              )}
            </div>

            {disconnected && (
              <div className="interview-room-disconnect">
                <p>连接已断开。</p>
                <button type="button" className="interview-submit" onClick={connect}>
                  重新连接
                </button>
              </div>
            )}

            <form className="interview-room-form" onSubmit={handleSubmit}>
              {inputMode === 'voice' && (
                <div className="voice-room-controls">
                  {effectiveInputMode === 'voice' ? (
                    <>
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
                          voicePhase === 'transcribing' ||
                          voicePhase === 'sending' ||
                          videoState === 'generating' ||
                          videoState === 'playing'
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
                      {videoState === 'none' && !liveSign && (
                        <div className="voice-room-tts-controls">
                          <button
                            type="button"
                            className={`voice-room-tts-btn${
                              ttsMuted ? ' is-active' : ''
                            }`}
                            onClick={toggleMute}
                          >
                            {ttsMuted ? '取消静音' : '静音'}
                          </button>
                          <button
                            type="button"
                            className="voice-room-tts-btn"
                            onClick={handleReplay}
                            disabled={!currentQuestionRef.current || ttsMuted}
                          >
                            重播
                          </button>
                          <button
                            type="button"
                            className="voice-room-tts-btn"
                            onClick={handleSkipPlayback}
                            disabled={!reading}
                          >
                            跳过
                          </button>
                        </div>
                      )}
                      <button
                        type="button"
                        className="interview-inline-link"
                        onClick={() => {
                          setTextModeOverride(true);
                          setStatusLine('已切换为文字作答，本场生效');
                        }}
                      >
                        切换为文字作答
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="interview-inline-link"
                      onClick={() => {
                        setTextModeOverride(false);
                        setStatusLine('已切回语音作答');
                      }}
                    >
                      切回语音作答
                    </button>
                  )}
                </div>
              )}

              <div className="interview-field">
                <label htmlFor="answer">
                  {effectiveInputMode === 'voice' ? '文字作答（备选）' : '你的回答'}
                </label>
                <textarea
                  id="answer"
                  value={answer}
                  onChange={(e) => setAnswer(e.target.value)}
                  placeholder={
                    effectiveInputMode === 'voice'
                      ? '输入文字作为备选…'
                      : '在此输入回答…'
                  }
                  disabled={thinking || disconnected || ending}
                />
              </div>
              <div className="interview-room-actions">
                <button
                  className="interview-submit"
                  type="submit"
                  disabled={
                    thinking ||
                    disconnected ||
                    ending ||
                    !answer.trim() ||
                    (inputModeRef.current === 'voice' && voiceBusy)
                  }
                >
                  发送回答
                </button>
                <button
                  type="button"
                  className="interview-room-end"
                  onClick={handleForceEnd}
                  disabled={ending}
                >
                  {ending ? '结束中…' : '结束面试'}
                </button>
              </div>
            </form>
          </>
        )}
      </main>
      <MobileTabBar />
    </div>
  );
}
