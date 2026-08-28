import { useEffect, useRef } from 'react';

interface CameraPreviewProps {
  /** 显示在预览画面上的标题（如「摄像头预览」） */
  title?: string;
  /**
   * 当前正在用于行为分析的摄像头流。
   * 预览直接复用这一路流，避免与行为分析各开一路 getUserMedia 造成重复占用摄像头。
   */
  stream?: MediaStream | null;
  /** 摄像头流正在打开中（行为分析加载阶段） */
  opening?: boolean;
  /** 摄像头打开失败的错误文案 */
  error?: string;
}

/**
 * 实时面试页左侧的摄像头预览：复用行为分析的同一路摄像头流进行展示。
 * 组件不自行打开摄像头（摄像头由行为分析统一管理），卸载时只需断开引用。
 */
export default function CameraPreview({
  title = '摄像头预览',
  stream = null,
  opening = false,
  error = '',
}: CameraPreviewProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (stream) {
      video.srcObject = stream;
      video.play().catch(() => {});
    } else {
      video.srcObject = null;
    }
  }, [stream]);

  return (
    <section className="room-camera">
      <h2 className="room-card-title">{title}</h2>
      <div className="room-camera-frame">
        <video ref={videoRef} className="room-camera-video" muted playsInline aria-label="摄像头预览" />
        {!stream && !error && (
          <p className="room-camera-placeholder">
            {opening ? '正在打开摄像头…' : '摄像头未开启'}
          </p>
        )}
        {error && <p className="room-camera-error">{error}</p>}
      </div>
    </section>
  );
}
