import { ApiError, fetchJSON, getApiBase, getToken, toUserMessage } from './client';

export interface Question {
  id: number;
  question: string;
  answer: string | null;
  user_answer: string | null;
  source: string;
  source_session_id: number | null;
  job_tag: string | null;
  dimension: string | null;
  reference: string | null;
  starred: boolean;
  created_at: string;
}

export interface ListQuestionsParams {
  starred?: boolean;
  job_tag?: string;
  q?: string;
  dimension?: string;
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
  if (params?.dimension) {
    search.set('dimension', params.dimension);
  }
  const qs = search.toString();
  return fetchJSON<Question[]>(`/api/questions${qs ? `?${qs}` : ''}`);
}

export async function fetchFocusedQuestions(
  dimensions: string[],
  limitPerDim = 5,
): Promise<Question[]> {
  const data = await fetchJSON<{ items: Question[] }>(
    '/api/questions/question-bank/focused',
    {
      method: 'POST',
      body: JSON.stringify({ dimensions, limit_per_dimension: limitPerDim }),
    },
  );
  return data.items;
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

export async function deleteQuestions(ids: number[]): Promise<void> {
  await fetchJSON<{ deleted: number }>('/api/questions/batch-delete', {
    method: 'POST',
    body: JSON.stringify({ ids }),
  });
}

export interface ImportItem {
  question: string;
  answer?: string;
  reference?: string;
}

export interface ImportParseResult {
  items: ImportItem[];
  raw: string;
  ocr_text: string;
}

export async function parseImportText(text: string): Promise<ImportParseResult> {
  return fetchJSON<ImportParseResult>('/api/questions/import/parse', {
    method: 'POST',
    body: JSON.stringify({ text }),
  });
}

export async function parseImportImage(file: File): Promise<ImportParseResult> {
  // multipart：fetchJSON 会默认加 JSON Content-Type，图片必须走原生 fetch
  const token = getToken();
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(`${getApiBase()}/api/questions/import/parse`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    body: form,
  });
  if (!res.ok) {
    let message = res.statusText || 'Request failed';
    try {
      const data = (await res.json()) as unknown;
      if (data && typeof data === 'object' && 'error' in data) {
        message = String((data as { error: unknown }).error);
      }
    } catch {
      // keep status text
    }
    throw new ApiError(res.status, toUserMessage(res.status, message), message);
  }
  return (await res.json()) as ImportParseResult;
}

export async function confirmImport(
  items: ImportItem[],
  jobTag?: string,
): Promise<{ imported: number; skipped: number }> {
  return fetchJSON<{ imported: number; skipped: number }>('/api/questions/import/confirm', {
    method: 'POST',
    body: JSON.stringify({ items, job_tag: jobTag ?? '' }),
  });
}
