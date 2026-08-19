import { useEffect, useRef } from 'react';
import type { LivestreamSign } from '../api/livestream';

declare global {
  interface Window {
    IVH?: {
      init(opts: { sign: string; virtualmanProjectId: string; element: HTMLElement }): void;
      createSession(opts?: Record<string, unknown>): Promise<{ sessionId: string }>;
      startSession(): Promise<void>;
      closeSession(): Promise<void>;
      on(event: string, cb: (...args: unknown[]) => void): void;
    };
  }
}

interface LivestreamPersonaProps {
  sign: LivestreamSign;
  /** 题目全文，显示在视频下方作为字幕 */
  question?: string;
  /** 是否正在口播（显示「正在提问…」标签） */
  speaking?: boolean;
  muted?: boolean;
  onReady?: () => void;
  /** SDK 初始化/运行失败时通知父组件（触发 V14 降级） */
  onError?: () => void;
  onToggleMute?: () => void;
  onReplay?: () => void;
  onSkip?: () => void;
}

export default function LivestreamPersona({
  sign,
  question,
  speaking = false,
  muted = false,
  onReady,
  onError,
  onToggleMute,
  onReplay,
  onSkip,
}: LivestreamPersonaProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const readyRef = useRef(false);

  // 初始化 IVH SDK：init → createSession → startSession
  useEffect(() => {
    if (!sign || readyRef.current) return;
    const IVH = window.IVH;
    if (!IVH || !containerRef.current) return;
    let cancelled = false;
    const handleError = () => {
      if (cancelled) return;
      onError?.();
    };
    const start = async () => {
      IVH.init({
        sign: sign.signature,
        virtualmanProjectId: sign.virtualmanProjectId,
        element: containerRef.current!,
      });
      if (typeof IVH.on === 'function') {
        IVH.on('error', handleError);
      }
      await IVH.createSession({ userId: sign.userId });
      if (cancelled) return;
      await IVH.startSession();
      if (cancelled) return;
      readyRef.current = true;
      onReady?.();
    }
    void start().catch(() => {
      // 建流失败：通知父组件降级（onReady 未触发）
      handleError();
    });
    return () => {
      cancelled = true;
      void IVH.closeSession().catch(() => {});
    };
  }, [sign, onReady, onError]);

  return (
    <div className="video-persona video-persona--live" aria-label="实时面试官">
      <div className="video-persona-screen">
        <div ref={containerRef} className="video-persona-ivh" style={{ width: '100%', height: '100%' }} />
        {speaking && <span className="video-persona-label">正在提问…</span>}
        <div className="video-persona-controls">
          <button type="button" className="video-persona-btn" onClick={onToggleMute}>
            {muted ? '取消静音' : '静音'}
          </button>
          <button type="button" className="video-persona-btn" onClick={onReplay} disabled={!question}>
            重播
          </button>
          <button type="button" className="video-persona-btn" onClick={onSkip} disabled={!speaking}>
            跳过
          </button>
        </div>
      </div>
      {question && <p className="video-persona-subtitle">{question}</p>}
    </div>
  );
}
