import { fetchJSON } from './client';

export type Emotion = 'smile' | 'neutral' | 'focus' | 'surprise' | 'frown';

export interface StressSegment {
  t_ms: number;
  v: number;
}

export interface BehaviorPayload {
  emotion_distribution: Partial<Record<Emotion, number>>;
  nod_count: number;
  stress_level: number;
  stress_segments: StressSegment[];
  face_detected_frames: number;
  duration_ms: number;
}

export type BehaviorResult =
  | (BehaviorPayload & { available: true })
  | { available: false };

export async function saveBehavior(
  id: number,
  payload: BehaviorPayload,
): Promise<void> {
  await fetchJSON<{ status: string }>(`/api/interviews/${id}/behavior`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function fetchBehavior(id: number): Promise<BehaviorResult> {
  const data = await fetchJSON<BehaviorPayload | { available: false }>(
    `/api/interviews/${id}/behavior`,
  );
  if ('available' in data && data.available === false) {
    return { available: false };
  }
  return { ...(data as BehaviorPayload), available: true };
}
