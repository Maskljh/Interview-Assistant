import { fetchJSON } from './client';
import type { InterviewMode } from './interviews';

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
}): Promise<TrendsData> {
  const search = new URLSearchParams();
  if (params?.job_tag) {
    search.set('job_tag', params.job_tag);
  }
  if (params?.mode) {
    search.set('mode', params.mode);
  }
  const qs = search.toString();
  return fetchJSON<TrendsData>(`/api/analytics/trends${qs ? `?${qs}` : ''}`);
}
