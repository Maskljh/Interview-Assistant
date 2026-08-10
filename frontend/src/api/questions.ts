import { fetchJSON } from './client';

export interface Question {
  id: number;
  question: string;
  answer: string | null;
  source: string;
  source_session_id: number | null;
  job_tag: string | null;
  starred: boolean;
  created_at: string;
}

export interface ListQuestionsParams {
  starred?: boolean;
  job_tag?: string;
  q?: string;
}

export async function listQuestions(
  params?: ListQuestionsParams,
): Promise<Question[]> {
  const search = new URLSearchParams();
  if (params?.starred) {
    search.set('starred', '1');
  }
  if (params?.job_tag) {
    search.set('job_tag', params.job_tag);
  }
  if (params?.q) {
    search.set('q', params.q);
  }
  const qs = search.toString();
  return fetchJSON<Question[]>(`/api/questions${qs ? `?${qs}` : ''}`);
}

export async function importQuestionsFromSession(
  sessionId: number,
): Promise<{ imported: number }> {
  return fetchJSON<{ imported: number }>(
    `/api/questions/from-session/${sessionId}`,
    { method: 'POST' },
  );
}

export async function patchQuestion(
  id: number,
  body: { starred: boolean },
): Promise<Question> {
  return fetchJSON<Question>(`/api/questions/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

export async function deleteQuestion(id: number): Promise<void> {
  await fetchJSON<{ ok: boolean }>(`/api/questions/${id}`, {
    method: 'DELETE',
  });
}
