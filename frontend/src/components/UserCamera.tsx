import { useEffect, useRef, useState } from 'react';

/** 本地摄像头小窗：仅视频轨、不上传；拒绝/无摄像头时静默隐藏。 */
export default function UserCamera() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    if (!navigator.mediaDevices?.getUserMedia) return;
    let cancelled = false;
    async function start() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) videoRef.current.srcObject = stream;
        setEnabled(true);
      } catch {
        // 拒绝授权 / 无摄像头 → 静默降级，不打扰面试
      }
    }
    void start();
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, []);

  if (!enabled) return null;

  return (
    <div className="video-persona-cam">
      <video ref={videoRef} autoPlay muted playsInline aria-label="你的摄像头画面" />
      <button
        type="button"
        className="video-persona-cam-off"
        onClick={() => {
          streamRef.current?.getTracks().forEach((t) => t.stop());
          streamRef.current = null;
          setEnabled(false);
        }}
      >
        关闭摄像头
      </button>
    </div>
  );
}
