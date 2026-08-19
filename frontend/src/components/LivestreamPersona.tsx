import { useEffect, useRef } from 'react';

interface LivestreamPersonaProps {
  streamURL: string;
  /** 题目全文，显示在视频下方作为字幕 */
  question?: string;
  /** 是否正在口播（显示「正在提问…」标签） */
  speaking?: boolean;
  muted?: boolean;
  onToggleMute?: () => void;
  onReplay?: () => void;
  onSkip?: () => void;
}

export default function LivestreamPersona({
  streamURL,
  question,
  speaking = false,
  muted = false,
  onToggleMute,
  onReplay,
  onSkip,
}: LivestreamPersonaProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // 静音切换只影响音量，不暂停视频
  useEffect(() => {
    const el = videoRef.current;
    if (el) el.muted = muted;
  }, [muted]);

  return (
    <div className="video-persona video-persona--live" aria-label="实时面试官">
      <div className="video-persona-screen">
        <video
          ref={videoRef}
          className="video-persona-video"
          src={streamURL}
          autoPlay
          playsInline
          muted={muted}
          loop
        />
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
