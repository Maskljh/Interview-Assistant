import { useCallback, useRef, useState } from 'react';
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

  const stop = useCallback(async () => {
    if (!runningRef.current) {
      setStatus('idle');
      return;
    }
    const agg = aggRef.current;
    cleanup();
    setStatus('idle');
    setLiveStress(null);
    if (!agg) return;
    const payload: BehaviorPayload = agg.build();
    if (payload.face_detected_frames < 2) return; // not enough data
    try {
      await saveBehavior(opts.sessionId, payload);
    } catch {
      // silent: never block navigation/report
    }
  }, [cleanup, opts.sessionId]);

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
      cameraRef.current = camera;
      setCameraStream(camera.stream);
      const detector =
        opts.detectorLoader != null
          ? await opts.detectorLoader()
          : await loadFaceLandmarkDetector();
      detectorRef.current = detector;
      await detector.load();
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
