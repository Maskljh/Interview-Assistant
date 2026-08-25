import { useEffect, useRef, useState } from 'react';

interface CameraPreviewProps {
  /** 显示在预览画面上的标题（如「摄像头预览」） */
  title?: string;
}

/**
 * 实时面试页左侧的摄像头预览：直接展示本机摄像头画面。
 * 组件卸载时释放摄像头，避免占用麦克风/摄像头资源。
 */
export default function CameraPreview({ title = '摄像头预览' }: CameraPreviewProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [active, setActive] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    let stream: MediaStream | null = null;

    async function start() {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError('当前浏览器不支持摄像头');
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
        if (cancelled) {
          for (const track of stream.getTracks()) track.stop();
          return;
        }
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => {});
        }
        setActive(true);
      } catch {
        if (!cancelled) setError('无法访问摄像头，请检查浏览器权限');
      }
    }

    void start();
    return () => {
      cancelled = true;
      if (videoRef.current) {
        videoRef.current.srcObject = null;
      }
      if (stream) {
        for (const track of stream.getTracks()) track.stop();
      }
    };
  }, []);

  return (
    <section className="room-camera">
      <h2 className="room-card-title">{title}</h2>
      <div className="room-camera-frame">
        <video ref={videoRef} className="room-camera-video" muted playsInline aria-label="摄像头预览" />
        {!active && !error && <p className="room-camera-placeholder">正在打开摄像头…</p>}
        {error && <p className="room-camera-error">{error}</p>}
      </div>
    </section>
  );
}
