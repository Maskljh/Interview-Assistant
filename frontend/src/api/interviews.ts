import { fetchJSON } from './client';

export type InterviewMode = 'behavioral' | 'technical' | 'mixed';

export type InterviewStatus =
  | 'draft'
  | 'ready'
  | 'in_progress'
  | 'completed'
  | 'failed';

export type InputMode = 'text' | 'voice';

export type Persona = 'standard' | 'strict_tech' | 'warm_hr' | 'stress';

export interface InterviewListItem {
  id: number;
  mode: InterviewMode;
  persona: Persona;
  status: InterviewStatus;
  created_at: string;
  score: number | null;
}

export interface InterviewTurn {
  id: number;
  seq: number;
  role: string;
  kind: string;
  content: string;
  created_at: string;
}

export interface InterviewQuestion {
  id: number;
  seq: number;
  question: string;
  intent: string | null;
  asked: boolean;
}

export interface Interview {
  id: number;
  job_jd: string;
  resume_text: string | null;
  mode: InterviewMode;
  input_mode: InputMode;
  persona: Persona;
  status: InterviewStatus;
  score: number | null;
  feedback_json: unknown;
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
  questions: InterviewQuestion[];
  turns: InterviewTurn[];
}

export interface CreateInterviewInput {
  job_jd: string;
  resume_text?: string;
  precheck_gaps?: string[];
  mode: InterviewMode;
  input_mode?: InputMode;
  persona?: Persona;
}

export async function createInterview(
  input: CreateInterviewInput,
): Promise<Interview> {
  return fetchJSON<Interview>('/api/interviews', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function listInterviews(): Promise<InterviewListItem[]> {
  return fetchJSON<InterviewListItem[]>('/api/interviews');
}

export async function getInterview(id: number): Promise<Interview> {
  return fetchJSON<Interview>(`/api/interviews/${id}`);
}

export async function startInterview(id: number): Promise<Interview> {
  return fetchJSON<Interview>(`/api/interviews/${id}/start`, {
    method: 'POST',
  });
}

export interface InterviewFeedback {
  total_score: number;
  dimensions: {
    expression: number;
    logic: number;
    content: number;
    job_match: number;
  };
  strengths: string[];
  weaknesses: string[];
  suggestions: string[];
  model_version: string;
}

export type ReportResult =
  | { available: true; feedback: InterviewFeedback }
  | { available: false };

function parseReportResponse(
  data: InterviewFeedback | { available: false },
): ReportResult {
  if ('available' in data && data.available === false) {
    return { available: false };
  }
  return { available: true, feedback: data as InterviewFeedback };
}

export async function endInterview(id: number): Promise<void> {
  await fetchJSON<{ status: string }>(`/api/interviews/${id}/end`, {
    method: 'POST',
  });
}

export async function getReport(id: number): Promise<ReportResult> {
  const data = await fetchJSON<InterviewFeedback | { available: false }>(
    `/api/interviews/${id}/report`,
  );
  return parseReportResponse(data);
}

export async function retryReport(id: number): Promise<ReportResult> {
  const data = await fetchJSON<InterviewFeedback | { available: false }>(
    `/api/interviews/${id}/report/retry`,
    { method: 'POST' },
  );
  return parseReportResponse(data);
}

export interface CreateFromBankInput {
  question_ids: number[];
  precheck_gaps?: string[];
  mode: InterviewMode;
  input_mode?: InputMode;
  persona?: Persona;
}

export async function createInterviewFromBank(
  input: CreateFromBankInput,
): Promise<Interview> {
  return fetchJSON<Interview>('/api/interviews/from-bank', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}
