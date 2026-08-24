import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { makePoint, type Point } from './signalExtractors';

// Keep a stable fake point array for detect() results.
function fakeLandmarks(): Point[] {
  const pts: Point[] = new Array(478).fill(null).map(() => makePoint(0.5, 0.5, 0));
  // neutral face (see signalExtractors.test.ts for the same layout)
  pts[33] = makePoint(0.4, 0.4, 0);
  pts[133] = makePoint(0.48, 0.4, 0);
  pts[159] = makePoint(0.44, 0.385, 0);
  pts[145] = makePoint(0.44, 0.445, 0);
  pts[362] = makePoint(0.6, 0.4, 0);
  pts[263] = makePoint(0.52, 0.4, 0);
  pts[386] = makePoint(0.56, 0.385, 0);
  pts[374] = makePoint(0.56, 0.445, 0);
  pts[61] = makePoint(0.4, 0.62, 0);
  pts[291] = makePoint(0.6, 0.62, 0);
  pts[13] = makePoint(0.5, 0.59, 0);
  pts[14] = makePoint(0.5, 0.65, 0);
  pts[105] = makePoint(0.46, 0.33, 0);
  pts[334] = makePoint(0.54, 0.33, 0);
  pts[1] = makePoint(0.5, 0.52, 0);
  return pts;
}

vi.mock('../api/behavior', () => ({
  saveBehavior: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./cameraFeed', () => ({
  startCameraFeed: vi.fn(),
}));

vi.mock('./FaceLandmarkDetector', () => ({
  loadFaceLandmarkDetector: vi.fn(),
}));

import { saveBehavior } from '../api/behavior';
import { startCameraFeed } from './cameraFeed';
import { loadFaceLandmarkDetector } from './FaceLandmarkDetector';
import { useBehaviorAnalysis } from './useBehaviorAnalysis';

describe('useBehaviorAnalysis', () => {
  let frames: number;
  let time: number;

  beforeEach(() => {
    frames = 0;
    time = 0;
    vi.clearAllMocks();
    const video = { videoWidth: 640, videoHeight: 480 } as HTMLVideoElement;
    const stream = { getTracks: () => [{ stop: vi.fn() }] } as unknown as MediaStream;
    vi.mocked(startCameraFeed).mockResolvedValue({ video, stream, stop: vi.fn() } as never);
    const detector = {
      load: vi.fn().mockResolvedValue(undefined),
      detect: vi.fn().mockResolvedValue(fakeLandmarks()),
      dispose: vi.fn(),
    };
    vi.mocked(loadFaceLandmarkDetector).mockResolvedValue(detector as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does nothing when disabled', async () => {
    const { result } = renderHook(() =>
      useBehaviorAnalysis({ enabled: false, sessionId: 1 }),
    );
    await act(async () => {
      await result.current.start();
    });
    expect(startCameraFeed).not.toHaveBeenCalled();
    expect(result.current.status).toBe('idle');
  });

  it('starts running and saves aggregate on stop', async () => {
    const { result } = renderHook(() =>
      useBehaviorAnalysis({
        enabled: true,
        sessionId: 7,
        // fire the rAF loop 3 times to accumulate >= 2 frames (save guard)
        raf: (cb) => {
          if (frames < 3) {
            frames += 1;
            cb(0);
          }
          return frames;
        },
        cancelRaf: vi.fn(),
        now: () => {
          time += 100;
          return time;
        },
      }),
    );
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.status).toBe('running');
    await act(async () => {
      await result.current.stop();
    });
    expect(saveBehavior).toHaveBeenCalledTimes(1);
    const payload = vi.mocked(saveBehavior).mock.calls[0][1];
    expect(payload.face_detected_frames).toBeGreaterThanOrEqual(2);
  });

  it('goes failed when camera access is denied', async () => {
    vi.mocked(startCameraFeed).mockRejectedValueOnce(new Error('NotAllowedError'));
    const { result } = renderHook(() =>
      useBehaviorAnalysis({ enabled: true, sessionId: 1 }),
    );
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.status).toBe('failed');
  });

  it('goes failed when model loading fails', async () => {
    const detector = {
      load: vi.fn().mockRejectedValue(new Error('model load failed')),
      detect: vi.fn(),
      dispose: vi.fn(),
    };
    vi.mocked(loadFaceLandmarkDetector).mockResolvedValue(detector as never);
    const { result } = renderHook(() =>
      useBehaviorAnalysis({ enabled: true, sessionId: 1 }),
    );
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.status).toBe('failed');
  });

  it('stays idle when disabled (degradation no-op)', async () => {
    const { result } = renderHook(() =>
      useBehaviorAnalysis({ enabled: false, sessionId: 1 }),
    );
    await act(async () => {
      await result.current.start();
    });
    expect(startCameraFeed).not.toHaveBeenCalled();
    expect(result.current.status).toBe('idle');
  });

  it('swallows save errors without throwing', async () => {
    vi.mocked(saveBehavior).mockRejectedValueOnce(new Error('network'));
    const { result } = renderHook(() =>
      useBehaviorAnalysis({
        enabled: true,
        sessionId: 1,
        raf: (cb) => {
          if (frames < 3) {
            frames += 1;
            cb(0);
          }
          return frames;
        },
        cancelRaf: vi.fn(),
        now: () => {
          time += 100;
          return time;
        },
      }),
    );
    await act(async () => {
      await result.current.start();
    });
    await act(async () => {
      await result.current.stop();
    });
    expect(result.current.status).toBe('idle');
  });
});
