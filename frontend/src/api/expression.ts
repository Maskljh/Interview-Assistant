import { fetchJSON } from './client';

export interface ExpressionResult {
  available: boolean;
  voice_answers: number;
  total_duration_ms: number;
  speech_rate_cpm: number | null;
  fillers: { word: string; count: number }[];
  avg_answer_chars: number;
  avg_sentence_chars: number;
}

export async function fetchExpression(id: number): Promise<ExpressionResult> {
  return fetchJSON<ExpressionResult>(`/api/interviews/${id}/expression`);
}
