import { fetchJSON } from './client';

export interface PreCheckOut {
  match_score: number;
  gaps: string[];
  suggestions: string[];
}

export async function fetchPreCheck(
  jobJd: string,
  resumeText: string,
): Promise<PreCheckOut> {
  return fetchJSON<PreCheckOut>('/api/precheck', {
    method: 'POST',
    body: JSON.stringify({ job_jd: jobJd, resume_text: resumeText }),
  });
}
