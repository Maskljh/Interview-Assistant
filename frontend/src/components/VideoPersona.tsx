import { useEffect, useRef } from 'react';

export type VideoPersonaState = 'generating' | 'playing' | 'ended';

interface VideoPersonaProps {
  state: VideoPersonaState;
  videoUrl?: string | null;
  /** 题目全文，显示在视频下方作为字幕 */
  question?: string;
  muted?: boolean;
  onVideoEnded?: () => void;
  onToggleMute?: () => void;
  onSkip?: () => void;
}

export default function VideoPersona({
  state,
  videoUrl,
  question,
  muted = false,
  onVideoEnded,
  onToggleMute,
  onSkip,
}: VideoPersonaProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // 静音切换只影响音量，不暂停视频（取消静音可继续听）
  useEffect(() => {
    const el = videoRef.current;
    if (el) el.muted = muted;
  }, [muted]);

  if (state === 'generating') {
    return (
      <div className="video-persona video-persona--generating" aria-label="面试官正在生成问题">
        <div className="video-persona-screen">
          <img className="video-persona-waiting" src="/persona-default.png" alt="" />
          <span className="video-persona-label">正在生成问题…</span>
        </div>
      </div>
    );
  }

  return (
    <div className={`video-persona video-persona--${state}`} aria-label="面试官视频">
      <div className="video-persona-screen">
        <video
          ref={videoRef}
          className="video-persona-video"
          src={videoUrl ?? undefined}
          autoPlay
          playsInline
          muted={muted}
          onEnded={onVideoEnded}
        />
        <div className="video-persona-controls">
          <button type="button" className="video-persona-btn" onClick={onToggleMute}>
            {muted ? '取消静音' : '静音'}
          </button>
          <button type="button" className="video-persona-btn" onClick={onSkip}>
            跳过
          </button>
        </div>
      </div>
      {question && <p className="video-persona-subtitle">{question}</p>}
    </div>
  );
}
