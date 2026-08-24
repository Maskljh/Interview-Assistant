import { describe, expect, it } from 'vitest';
import { BehaviorAggregator, type FrameSignal } from './aggregator';
import type { Emotion } from './signalExtractors';

function frame(t: number, emotion: Emotion, pitch = 0.01): FrameSignal {
  return { t, emotion, ear: 0.3, pitch, browRaise: 0 };
}

describe('BehaviorAggregator', () => {
  it('counts emotion frames into a distribution', () => {
    const agg = new BehaviorAggregator();
    agg.push(frame(0, 'smile'));
    agg.push(frame(100, 'smile'));
    agg.push(frame(200, 'neutral'));
    const out = agg.build();
    expect(out.emotion_distribution).toEqual({ smile: 2, neutral: 1 });
  });

  it('counts nods from pitch crossings', () => {
    const agg = new BehaviorAggregator({ segmentIntervalMs: 1000 });
    const seq: [number, number][] = [
      [0, 0.01], [100, 0.01], [300, 0.05], [400, 0.01],
      [900, 0.05], [1000, 0.01],
    ];
    for (const [t, pitch] of seq) agg.push(frame(t, 'neutral', pitch));
    const out = agg.build();
    expect(out.nod_count).toBe(2);
  });

  it('produces stress segments at the configured interval', () => {
    const agg = new BehaviorAggregator({ segmentIntervalMs: 1000 });
    for (let t = 0; t <= 2500; t += 100) {
      agg.push(frame(t, 'neutral', 0.01));
    }
    const out = agg.build();
    // segments at t = 0, 1000, 2000 → 3 segments
    expect(out.stress_segments.length).toBe(3);
    expect(out.stress_segments[0].t_ms).toBe(0);
    expect(out.stress_segments[1].t_ms).toBe(1000);
  });

  it('computes duration and frame count', () => {
    const agg = new BehaviorAggregator();
    agg.push(frame(100, 'neutral'));
    agg.push(frame(200, 'neutral'));
    agg.push(frame(300, 'neutral'));
    const out = agg.build();
    expect(out.duration_ms).toBe(200);
    expect(out.face_detected_frames).toBe(3);
  });

  it('build is safe to call after empty input', () => {
    const out = new BehaviorAggregator().build();
    expect(out.emotion_distribution).toEqual({});
    expect(out.nod_count).toBe(0);
    expect(out.stress_segments).toEqual([]);
  });
});
