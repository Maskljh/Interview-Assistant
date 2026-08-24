export interface Point {
  x: number;
  y: number;
  z: number;
}

export function makePoint(x: number, y: number, z = 0): Point {
  return { x, y, z };
}

export const LANDMARKS = {
  leftEyeOuter: 33,
  leftEyeInner: 133,
  leftEyeTop: 159,
  leftEyeBottom: 145,
  rightEyeOuter: 362,
  rightEyeInner: 263,
  rightEyeTop: 386,
  rightEyeBottom: 374,
  mouthLeft: 61,
  mouthRight: 291,
  mouthTop: 13,
  mouthBottom: 14,
  noseTip: 1,
  leftBrowInner: 105,
  rightBrowInner: 334,
} as const;

export function distance(a: Point, b: Point): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export function mouthAspectRatio(pts: Point[]): number {
  const w = distance(pts[LANDMARKS.mouthLeft], pts[LANDMARKS.mouthRight]);
  const h = distance(pts[LANDMARKS.mouthTop], pts[LANDMARKS.mouthBottom]);
  return w === 0 ? 0 : h / w;
}

export function eyeAspectRatio(pts: Point[]): number {
  const lh = distance(pts[LANDMARKS.leftEyeTop], pts[LANDMARKS.leftEyeBottom]);
  const lw = distance(pts[LANDMARKS.leftEyeOuter], pts[LANDMARKS.leftEyeInner]);
  const rh = distance(pts[LANDMARKS.rightEyeTop], pts[LANDMARKS.rightEyeBottom]);
  const rw = distance(pts[LANDMARKS.rightEyeOuter], pts[LANDMARKS.rightEyeInner]);
  const l = lw === 0 ? 0 : lh / lw;
  const r = rw === 0 ? 0 : rh / rw;
  return (l + r) / 2;
}

export function browRaiseRatio(pts: Point[]): number {
  const leftBrow = pts[LANDMARKS.leftBrowInner];
  const rightBrow = pts[LANDMARKS.rightBrowInner];
  const leftEyeTop = pts[LANDMARKS.leftEyeTop];
  const rightEyeTop = pts[LANDMARKS.rightEyeTop];
  return (leftEyeTop.y - leftBrow.y + (rightEyeTop.y - rightBrow.y)) / 2;
}

export function pitchFromLandmarks(pts: Point[]): number {
  const leftEye = pts[LANDMARKS.leftEyeOuter];
  const rightEye = pts[LANDMARKS.rightEyeOuter];
  const eyeMidY = (leftEye.y + rightEye.y) / 2;
  const eyeWidth = distance(leftEye, rightEye);
  const nose = pts[LANDMARKS.noseTip];
  if (eyeWidth === 0) return 0;
  return (nose.y - eyeMidY) / eyeWidth;
}

export type Emotion = 'smile' | 'neutral' | 'focus' | 'surprise' | 'frown';

export function classifyEmotion(
  mar: number,
  ear: number,
  browRaise: number,
): Emotion {
  if (mar > 0.35) return 'surprise';
  if (mar > 0.22) return 'smile';
  if (browRaise > 0.015) return 'surprise';
  if (browRaise < -0.01) return 'frown';
  if (ear < 0.18) return 'focus';
  return 'neutral';
}

export interface TimedPitch {
  t: number;
  pitch: number;
}

export class NodDetector {
  count = 0;
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private nodding = false;
  private cooldownUntil = -Infinity;

  constructor(threshold = 0.04, cooldownMs = 500) {
    this.threshold = threshold;
    this.cooldownMs = cooldownMs;
  }

  update(sample: TimedPitch): number {
    if (sample.t < this.cooldownUntil) {
      if (sample.pitch < this.threshold * 0.5) this.nodding = false;
      return this.count;
    }
    if (!this.nodding && sample.pitch >= this.threshold) {
      this.nodding = true;
      this.count += 1;
      this.cooldownUntil = sample.t + this.cooldownMs;
    } else if (this.nodding && sample.pitch < this.threshold * 0.5) {
      this.nodding = false;
    }
    return this.count;
  }
}

export interface StressFactors {
  blinkRatePerMin: number;
  headMoveStd: number;
  emotionSwitchRatePerMin: number;
}

export function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

export function computeStressLevel(f: StressFactors): number {
  const blink = clamp01(f.blinkRatePerMin / 40);
  const move = clamp01(f.headMoveStd / 0.05);
  const switchRate = clamp01(f.emotionSwitchRatePerMin / 30);
  const raw = 0.45 * blink + 0.35 * move + 0.2 * switchRate;
  return Math.round(clamp01(raw) * 100);
}
