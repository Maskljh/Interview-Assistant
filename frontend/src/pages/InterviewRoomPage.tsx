import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ApiError, getToken } from '../api/client';
import { endInterview } from '../api/interviews';
import { useAuth } from '../auth/AuthContext';
import { APP_NAME } from '../lib/labels';
import { connectInterviewWS, type ServerMsg } from '../ws/interviewSocket';
import './InterviewPages.css';

interface Turn {
  id: number;
  role: 'interviewer' | 'candidate';
  content: string;
}

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

  const turnIdRef = useRef(0);
  const socketRef = useRef<ReturnType<typeof connectInterviewWS> | null>(null);
  const doneRef = useRef(false);

  const appendTurn = useCallback((role: Turn['role'], content: string) => {
    turnIdRef.current += 1;
    setTurns((prev) => [...prev, { id: turnIdRef.current, role, content }]);
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
          break;
        case 'question':
        case 'follow_up':
          setThinking(false);
          if (msg.content) {
            appendTurn('interviewer', msg.content);
          }
          break;
        case 'status':
          if (msg.content === 'thinking') {
            setThinking(true);
            setStatusLine('');
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
          navigate(`/interviews/${interviewId}/report`, { replace: true });
          break;
      }
    },
    [appendTurn, interviewId, navigate],
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
        }
      },
    });
  }, [handleMessage, interviewId]);

  useEffect(() => {
    if (!Number.isFinite(interviewId)) {
      setError('无效的面试 ID');
      return;
    }

    doneRef.current = false;
    connect();

    return () => {
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [connect, interviewId]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = answer.trim();
    if (!trimmed || thinking || disconnected) return;

    appendTurn('candidate', trimmed);
    setAnswer('');
    socketRef.current?.sendAnswer(trimmed);
  }

  async function handleForceEnd() {
    if (ending || doneRef.current) return;
    setEnding(true);
    setError('');
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
                  turn.role === 'interviewer' ? ' transcript-turn--interviewer' : ''
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
          <div className="interview-field">
            <label htmlFor="answer">你的回答</label>
            <textarea
              id="answer"
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              placeholder="在此输入回答…"
              disabled={thinking || disconnected || ending}
            />
          </div>
          <div className="interview-room-actions">
            <button
              className="interview-submit"
              type="submit"
              disabled={thinking || disconnected || ending || !answer.trim()}
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
      </main>
    </div>
  );
}
