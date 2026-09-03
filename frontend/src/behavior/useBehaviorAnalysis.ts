import { useCallback, useEffect, useRef, useState } from 'react';
import { saveBehavior, type BehaviorPayload } from '../api/behavior';
import { BehaviorAggregator, type FrameSignal } from './aggregator';
import {
  browRaiseRatio,
  classifyEmotion,
  eyeAspectRatio,
  mouthAspectRatio,
  pitchFromLandmarks,
} from './signalExtractors';
import type { CameraFeed } from './cameraFeed';
import { startCameraFeed } from './cameraFeed';
import type { LandmarkDetector } from './FaceLandmarkDetector';
import { loadFaceLandmarkDetector } from './FaceLandmarkDetector';

export type BehaviorStatus = 'idle' | 'loading-model' | 'running' | 'failed';

export interface UseBehaviorOptions {
  enabled: boolean;
  sessionId: number;
  cameraFeed?: () => Promise<CameraFeed>;
  detectorLoader?: () => Promise<LandmarkDetector>;
  raf?: (cb: FrameRequestCallback) => number;
  cancelRaf?: (id: number) => void;
  now?: () => number;
}

export interface BehaviorAnalysis {
  status: BehaviorStatus;
  liveStress: number | null;
  /** 当前正在用于行为分析的摄像头流，供预览画面复用，避免同一页重复打开摄像头。 */
  cameraStream: MediaStream | null;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function useBehaviorAnalysis(opts: UseBehaviorOptions): BehaviorAnalysis {
  const [status, setStatus] = useState<BehaviorStatus>('idle');
  const [liveStress, setLiveStress] = useState<number | null>(null);
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  const runningRef = useRef(false);
  const cameraRef = useRef<CameraFeed | null>(null);
  const detectorRef = useRef<LandmarkDetector | null>(null);
  const aggRef = useRef<BehaviorAggregator | null>(null);
  const rafIdRef = useRef<number | null>(null);
  const lastLiveRef = useRef(0);
  // 始终指向最新的 cleanup，供卸载 effect 只读调用（不随渲染重建而重新触发）
  const cleanupRef = useRef<() => void>(() => {});

  const getRaf = () => opts.raf ?? ((cb) => requestAnimationFrame(cb));
  const getCancelRaf = () => opts.cancelRaf ?? ((id) => cancelAnimationFrame(id));
  const getNow = () => opts.now ?? (() => Date.now());

  const cleanup = useCallback(() => {
    const cancel = getCancelRaf();
    if (rafIdRef.current != null) {
      cancel(rafIdRef.current);
      rafIdRef.current = null;
    }
    cameraRef.current?.stop();
    cameraRef.current = null;
    detectorRef.current?.dispose();
    detectorRef.current = null;
    aggRef.current = null;
    runningRef.current = false;
    setCameraStream(null);
  }, [getCancelRaf]);
  cleanupRef.current = cleanup;

  const stop = useCallback(async () => {
    const wasRunning = runningRef.current;
    const agg = aggRef.current;
    // 无论是否在运行都执行 cleanup：cleanup 幂等且 null 安全，
    // 确保任何结束路径（含异常/重复 stop）都能释放摄像头轨道。
    cleanup();
    setStatus('idle');
    setLiveStress(null);
    if (!wasRunning || !agg) return;
    const payload: BehaviorPayload = agg.build();
    if (payload.face_detected_frames < 2) return; // not enough data
    try {
      await saveBehavior(opts.sessionId, payload);
    } catch {
      // silent: never block navigation/report
    }
  }, [cleanup, opts.sessionId]);

  // 组件卸载兜底：无论父组件是否调用了 stop()，离开页面时都释放摄像头。
  // 通过 ref 读最新 cleanup，避免因 cleanup 引用变化导致每次渲染都触发清理。
  useEffect(() => {
    return () => cleanupRef.current();
  }, []);

  const start = useCallback(async () => {
    if (!opts.enabled || runningRef.current) return;
    runningRef.current = true;
    lastLiveRef.current = 0;
    setStatus('loading-model');
    aggRef.current = new BehaviorAggregator();
    const now = getNow();
    try {
      const camera =
        opts.cameraFeed != null
          ? await opts.cameraFeed()
          : await startCameraFeed();
      // 摄像头打开的异步期间若 stop() 已被调用（面试结束），runningRef 会被置 false。
      // 此时必须立即释放刚打开的摄像头轨道，否则摄像头在结束流程之后才打开并泄漏。
      if (!runningRef.current) {
        for (const track of camera.stream.getTracks()) track.stop();
        setCameraStream(null);
        return;
      }
      cameraRef.current = camera;
      setCameraStream(camera.stream);
      const detector =
        opts.detectorLoader != null
          ? await opts.detectorLoader()
          : await loadFaceLandmarkDetector();
      // 模型加载同样是异步的，若期间被 stop，需释放已开的摄像头
      if (!runningRef.current) {
        for (const track of camera.stream.getTracks()) track.stop();
        cameraRef.current = null;
        setCameraStream(null);
        detector.dispose();
        return;
      }
      detectorRef.current = detector;
      await detector.load();
      if (!runningRef.current) {
        for (const track of camera.stream.getTracks()) track.stop();
        cameraRef.current = null;
        setCameraStream(null);
        detector.dispose();
        return;
      }
      setStatus('running');

      const loop = () => {
        if (!runningRef.current) return;
        const t = now();
        void detector
          .detect(camera.video)
          .then((pts) => {
            if (!runningRef.current || !pts || !aggRef.current) {
              return;
            }
            const mar = mouthAspectRatio(pts);
            const ear = eyeAspectRatio(pts);
            const browRaise = browRaiseRatio(pts);
            const pitch = pitchFromLandmarks(pts);
            const frame: FrameSignal = {
              t,
              emotion: classifyEmotion(mar, ear, browRaise),
              ear,
              pitch,
              browRaise,
            };
            aggRef.current.push(frame);
            if (t - lastLiveRef.current >= 1000) {
              lastLiveRef.current = t;
              setLiveStress(aggRef.current.build().stress_level);
            }
          })
          .catch((err) => {
            console.warn('[behavior] detect failed', err);
            cleanup();
            setStatus('failed');
          });
        rafIdRef.current = getRaf()(loop);
      };
      loop();
    } catch {
      cleanup();
      setStatus('failed');
    }
  }, [opts.enabled, opts.cameraFeed, opts.detectorLoader, getRaf, getNow, cleanup]);

  return { status, liveStress, cameraStream, start, stop };
}
