import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ApiError, getToken } from '../api/client';
import { endInterview, getInterview, type InputMode } from '../api/interviews';
import { synthesizeSpeech, transcribeAudio } from '../api/speech';
import { useAuth } from '../auth/AuthContext';
import {
  startVoiceRecording as startRecordingSession,
  type VoiceRecorder,
} from '../lib/voiceRecorder';
import { createVoicePlayer } from '../lib/voicePlayer';
import { APP_NAME } from '../lib/labels';
import { connectInterviewWS, type ServerMsg } from '../ws/interviewSocket';
import './InterviewPages.css';

interface Turn {
  id: number;
  role: 'interviewer' | 'candidate';
  content: string;
}

type VoicePhase = 'idle' | 'recording' | 'transcribing' | 'sending';

export default function InterviewRoomPage() {
  const { logout } = useAuth();
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
  const [loadingInterview, setLoadingInterview] = useState(true);
  const [voicePhase, setVoicePhase] = useState<VoicePhase>('idle');
  const [ttsMuted, setTtsMuted] = useState(false);
  const [reading, setReading] = useState(false);

  const turnIdRef = useRef(0);
  const socketRef = useRef<ReturnType<typeof connectInterviewWS> | null>(null);
  const doneRef = useRef(false);
  const inputModeRef = useRef<InputMode>('text');
  const voiceRecorderRef = useRef<VoiceRecorder | null>(null);
  const voicePlayerRef = useRef<ReturnType<typeof createVoicePlayer> | null>(null);
  const speechVersionRef = useRef(0);
  const ttsMutedRef = useRef(false);
  const currentQuestionRef = useRef('');

  const appendTurn = useCallback((role: Turn['role'], content: string) => {
    turnIdRef.current += 1;
    setTurns((prev) => [...prev, { id: turnIdRef.current, role, content }]);
  }, []);

  const submitAnswer = useCallback(
    (content: string) => {
      appendTurn('candidate', content);
      setAnswer('');
      socketRef.current?.sendAnswer(content);
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
            appendTurn('interviewer', msg.content);
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

  const connect = useCallback(() => {
    const token = getToken();
    if (!token || !Number.isFinite(interviewId)) {
      setError('未登录或登录已失效');
      return;
    }

    socketRef.current?.close();
    setDisconnected(false);
    setError('');

    socketRef.current = connectInterviewWS(interviewId, token, {
      onMessage: handleMessage,
      onClose: () => {
        if (!doneRef.current) {
          setDisconnected(true);
          setThinking(false);
          setVoicePhase('idle');
          voicePlayerRef.current?.stop();
        }
      },
    });
  }, [handleMessage, interviewId]);

  useEffect(() => {
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
        doneRef.current = false;
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
      speechVersionRef.current += 1;
      voiceRecorderRef.current?.cancel();
      voiceRecorderRef.current = null;
      voicePlayerRef.current?.stop();
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [connect, interviewId]);

  async function handleStartRecording() {
    if (
      disconnected ||
      thinking ||
      ending ||
      voicePhase === 'recording' ||
      voicePhase === 'transcribing' ||
      voicePhase === 'sending'
    ) {
      return;
    }
    speechVersionRef.current += 1;
    voicePlayerRef.current?.stop();
    setError('');
    setStatusLine('');
    try {
      const recorder = await startRecordingSession();
      voiceRecorderRef.current?.cancel();
      voiceRecorderRef.current = recorder;
      setVoicePhase('recording');
      setStatusLine('正在录音，松开发送');
    } catch {
      setVoicePhase('idle');
      setStatusLine('无法访问麦克风，请使用文字作答');
    }
  }

  async function handleStopRecording() {
    const recorder = voiceRecorderRef.current;
    if (!recorder) return;
    voiceRecorderRef.current = null;
    setVoicePhase('transcribing');
    setStatusLine('正在识别语音...');
    try {
      const audio = await recorder.stop();
      const { text } = await transcribeAudio(audio);
      const trimmed = text.trim();
      if (!trimmed) {
        setVoicePhase('idle');
        setStatusLine('未识别到内容，请重录');
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
          : '识别失败，请重录',
      );
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = answer.trim();
    if (
      !trimmed ||
      thinking ||
      disconnected ||
      ending ||
      (inputModeRef.current === 'voice' &&
        (voicePhase === 'transcribing' || voicePhase === 'sending'))
    ) {
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
    setError('');
    speechVersionRef.current += 1;
    voicePlayerRef.current?.stop();
    voiceRecorderRef.current?.cancel();
    voiceRecorderRef.current = null;
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
                  <div className="voice-room-tts-controls">
                    <button
                      type="button"
                      className={`voice-room-tts-btn${ttsMuted ? ' is-active' : ''}`}
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
                </div>
              )}

              <div className="interview-field">
                <label htmlFor="answer">
                  {inputMode === 'voice' ? '文字作答（备选）' : '你的回答'}
                </label>
                <textarea
                  id="answer"
                  value={answer}
                  onChange={(e) => setAnswer(e.target.value)}
                  placeholder={
                    inputMode === 'voice'
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
                    voiceBusy
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
    </div>
  );
}
