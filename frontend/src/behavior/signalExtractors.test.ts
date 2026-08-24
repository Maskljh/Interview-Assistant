import { describe, expect, it } from 'vitest';
import {
  NodDetector,
  browRaiseRatio,
  classifyEmotion,
  computeStressLevel,
  distance,
  eyeAspectRatio,
  LANDMARKS,
  makePoint,
  mouthAspectRatio,
  pitchFromLandmarks,
  type Point,
} from './signalExtractors';

function face(overrides: Partial<Record<keyof typeof LANDMARKS, Point>> = {}): Point[] {
  const pts: Point[] = new Array(478).fill(null).map(() => makePoint(0.5, 0.5, 0));
  // neutral default: eye width 0.2, eye height 0.06, mouth width 0.4, mouth height 0.06
  pts[LANDMARKS.leftEyeOuter] = makePoint(0.4, 0.4, 0);
  pts[LANDMARKS.leftEyeInner] = makePoint(0.48, 0.4, 0);
  pts[LANDMARKS.leftEyeTop] = makePoint(0.44, 0.385, 0);
  pts[LANDMARKS.leftEyeBottom] = makePoint(0.44, 0.445, 0);
  pts[LANDMARKS.rightEyeOuter] = makePoint(0.6, 0.4, 0);
  pts[LANDMARKS.rightEyeInner] = makePoint(0.52, 0.4, 0);
  pts[LANDMARKS.rightEyeTop] = makePoint(0.56, 0.385, 0);
  pts[LANDMARKS.rightEyeBottom] = makePoint(0.56, 0.445, 0);
  pts[LANDMARKS.mouthLeft] = makePoint(0.4, 0.62, 0);
  pts[LANDMARKS.mouthRight] = makePoint(0.6, 0.62, 0);
  pts[LANDMARKS.mouthTop] = makePoint(0.5, 0.59, 0);
  pts[LANDMARKS.mouthBottom] = makePoint(0.5, 0.65, 0);
  pts[LANDMARKS.leftBrowInner] = makePoint(0.46, 0.33, 0);
  pts[LANDMARKS.rightBrowInner] = makePoint(0.54, 0.33, 0);
  pts[LANDMARKS.noseTip] = makePoint(0.5, 0.4, 0);
  for (const [k, v] of Object.entries(overrides) as [keyof typeof LANDMARKS, Point][]) {
    pts[LANDMARKS[k]] = v;
  }
  return pts;
}

describe('geometry helpers', () => {
  it('computes mouth aspect ratio (height/width)', () => {
    const neutral = face();
    // width 0.2, height 0.06 → 0.3
    expect(mouthAspectRatio(neutral)).toBeCloseTo(0.3, 2);
    const smile = face();
    smile[LANDMARKS.mouthBottom] = makePoint(0.5, 0.67, 0); // height 0.08
    expect(mouthAspectRatio(smile)).toBeCloseTo(0.4, 2);
  });

  it('computes eye aspect ratio (avg height/width)', () => {
    const neutral = face();
    // each eye: height 0.06, width 0.08 → 0.75
    expect(eyeAspectRatio(neutral)).toBeCloseTo(0.75, 2);
  });

  it('brow raise is positive when brow sits above eye top', () => {
    const raised = face();
    raised[LANDMARKS.leftBrowInner] = makePoint(0.46, 0.30, 0);
    raised[LANDMARKS.rightBrowInner] = makePoint(0.54, 0.30, 0);
    expect(browRaiseRatio(raised)).toBeGreaterThan(0);
  });

  it('pitch is near zero in neutral, increases when nose drops', () => {
    const neutral = face();
    expect(pitchFromLandmarks(neutral)).toBeCloseTo(0, 3);
    const dropped = face();
    dropped[LANDMARKS.noseTip] = makePoint(0.5, 0.62, 0);
    expect(pitchFromLandmarks(dropped)).toBeGreaterThan(0);
  });
});

describe('classifyEmotion', () => {
  it('classifies smile from open mouth', () => {
    expect(classifyEmotion(0.25, 0.3, 0)).toBe('smile');
  });
  it('classifies surprise from wide mouth', () => {
    expect(classifyEmotion(0.4, 0.3, 0)).toBe('surprise');
  });
  it('classifies surprise from raised brows', () => {
    expect(classifyEmotion(0.1, 0.3, 0.03)).toBe('surprise');
  });
  it('classifies frown from furrowed brows', () => {
    expect(classifyEmotion(0.1, 0.3, -0.03)).toBe('frown');
  });
  it('classifies focus from narrow eyes', () => {
    expect(classifyEmotion(0.1, 0.15, 0)).toBe('focus');
  });
  it('classifies neutral otherwise', () => {
    expect(classifyEmotion(0.1, 0.3, 0)).toBe('neutral');
  });
});

describe('NodDetector', () => {
  it('counts a single nod when pitch crosses threshold', () => {
    const d = new NodDetector(0.04, 500);
    expect(d.update({ t: 0, pitch: 0.01 })).toBe(0);
    expect(d.update({ t: 100, pitch: 0.05 })).toBe(1);
    expect(d.update({ t: 200, pitch: 0.08 })).toBe(1); // still held
    expect(d.update({ t: 300, pitch: 0.02 })).toBe(1); // released
  });

  it('does not double count within cooldown', () => {
    const d = new NodDetector(0.04, 500);
    d.update({ t: 0, pitch: 0.01 });
    d.update({ t: 100, pitch: 0.05 }); // 1
    d.update({ t: 150, pitch: 0.02 }); // release
    d.update({ t: 200, pitch: 0.06 }); // within cooldown → still 1
    expect(d.update({ t: 700, pitch: 0.01 })).toBe(1);
  });

  it('counts a second nod after cooldown expires', () => {
    const d = new NodDetector(0.04, 500);
    d.update({ t: 0, pitch: 0.01 });
    d.update({ t: 100, pitch: 0.05 }); // 1
    d.update({ t: 150, pitch: 0.01 }); // release
    d.update({ t: 900, pitch: 0.05 }); // 2 (past cooldown)
    expect(d.update({ t: 1000, pitch: 0.02 })).toBe(2);
  });
});

describe('computeStressLevel', () => {
  it('maps to 0 when all factors are calm', () => {
    expect(computeStressLevel({ blinkRatePerMin: 0, headMoveStd: 0, emotionSwitchRatePerMin: 0 })).toBe(0);
  });
  it('maps to 100 at maximum factors', () => {
    expect(computeStressLevel({ blinkRatePerMin: 40, headMoveStd: 0.05, emotionSwitchRatePerMin: 30 })).toBe(100);
  });
  it('clamps intermediate values into 0..100', () => {
    const v = computeStressLevel({ blinkRatePerMin: 80, headMoveStd: 0.1, emotionSwitchRatePerMin: 60 });
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(100);
  });
});

it('distance is euclidean', () => {
  expect(distance(makePoint(0, 0, 0), makePoint(3, 4, 0))).toBe(5);
});
