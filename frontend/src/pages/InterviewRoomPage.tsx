import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
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
          navigate(`/interviews/${interviewId}/report`, { replace: true });
          break;
      }
    },
    [appendTurn, interviewId, navigate, playQuestion],
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
          <Link className="interview-header-link" to={`/interviews/${id}`}>
            详情
          </Link>
          <Link className="interview-header-link" to="/trends">
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
