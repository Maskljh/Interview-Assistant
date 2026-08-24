import {
  NodDetector,
  computeStressLevel,
  type Emotion,
  type StressFactors,
} from './signalExtractors';
import type { BehaviorPayload } from '../api/behavior';

export interface FrameSignal {
  t: number;
  emotion: Emotion;
  ear: number;
  pitch: number;
  browRaise: number;
}

export interface AggregateOptions {
  segmentIntervalMs?: number;
}

const DEFAULT_SEGMENT_INTERVAL_MS = 15000;

export class BehaviorAggregator {
  private frames: FrameSignal[] = [];
  private readonly nodDetector = new NodDetector(0.04, 500);
  private readonly segmentIntervalMs: number;
  private segmentStart = 0;
  private segmentFrames: FrameSignal[] = [];
  private segments: { t_ms: number; v: number }[] = [];

  constructor(opts: AggregateOptions = {}) {
    this.segmentIntervalMs = opts.segmentIntervalMs ?? DEFAULT_SEGMENT_INTERVAL_MS;
  }

  push(frame: FrameSignal): void {
    if (this.frames.length === 0) {
      this.segmentStart = frame.t;
    }
    this.frames.push(frame);
    this.segmentFrames.push(frame);
    this.nodDetector.update({ t: frame.t, pitch: frame.pitch });
    if (frame.t - this.segmentStart >= this.segmentIntervalMs) {
      this.segments.push({ t_ms: this.segmentStart, v: stressOf(this.segmentFrames) });
      this.segmentFrames = [];
      this.segmentStart = frame.t;
    }
  }

  // build() is side-effect-free: it never mutates segment state, so it can be
  // called repeatedly (e.g. for live stress updates in useBehaviorAnalysis).
  build(): BehaviorPayload {
    const distribution: Partial<Record<Emotion, number>> = {};
    for (const f of this.frames) {
      distribution[f.emotion] = (distribution[f.emotion] ?? 0) + 1;
    }
    const segments = [...this.segments];
    if (this.segmentFrames.length > 0) {
      segments.push({ t_ms: this.segmentStart, v: stressOf(this.segmentFrames) });
    }
    return {
      emotion_distribution: distribution,
      nod_count: this.nodDetector.count,
      stress_level: stressOf(this.frames),
      stress_segments: segments,
      face_detected_frames: this.frames.length,
      duration_ms: this.durationMs,
    };
  }

  get durationMs(): number {
    if (this.frames.length === 0) return 0;
    return this.frames[this.frames.length - 1].t - this.frames[0].t;
  }
}

function stressOf(frames: FrameSignal[]): number {
  if (frames.length < 2) return 0;
  let blinks = 0;
  let prevEar = frames[0].ear;
  for (let i = 1; i < frames.length; i++) {
    // a blink: EAR collapses below threshold then recovers
    if (prevEar >= 0.18 && frames[i].ear < 0.12) blinks++;
    prevEar = frames[i].ear;
  }
  const elapsedMin = (frames[frames.length - 1].t - frames[0].t) / 60000 || 1;
  const blinkRatePerMin = blinks / elapsedMin;

  const pitches = frames.map((f) => f.pitch);
  const mean = pitches.reduce((a, b) => a + b, 0) / pitches.length;
  const variance =
    pitches.reduce((a, b) => a + (b - mean) * (b - mean), 0) / pitches.length;
  const headMoveStd = Math.sqrt(variance);

  let switches = 0;
  for (let i = 1; i < frames.length; i++) {
    if (frames[i].emotion !== frames[i - 1].emotion) switches++;
  }
  const emotionSwitchRatePerMin = switches / elapsedMin;

  const factors: StressFactors = { blinkRatePerMin, headMoveStd, emotionSwitchRatePerMin };
  return computeStressLevel(factors);
}
