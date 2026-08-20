import { fetchJSON } from './client';
import type { InterviewMode } from './interviews';

export type TrendsSource = 'regular' | 'bank';

export interface TrendsSummary {
  total_sessions: number;
  avg_score: number;
  max_score: number;
  min_score: number;
  first_score: number;
  latest_score: number;
  delta: number;
}

export interface TrendsPoint {
  date: string;
  session_id: number;
  job_tag: string;
  mode: InterviewMode;
  source: TrendsSource;
  total: number;
  expression: number;
  logic: number;
  content: number;
  job_match: number;
}

export interface TrendsData {
  summary: TrendsSummary;
  points: TrendsPoint[];
  job_tags: string[];
}

export async function fetchTrends(params?: {
  job_tag?: string;
  mode?: InterviewMode;
  source?: TrendsSource;
}): Promise<TrendsData> {
  const search = new URLSearchParams();
  if (params?.job_tag) {
    search.set('job_tag', params.job_tag);
  }
  if (params?.mode) {
    search.set('mode', params.mode);
  }
  if (params?.source) {
    search.set('source', params.source);
  }
  const qs = search.toString();
  return fetchJSON<TrendsData>(`/api/analytics/trends${qs ? `?${qs}` : ''}`);
}
