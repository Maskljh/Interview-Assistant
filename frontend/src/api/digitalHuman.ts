import { ApiError, getApiBase, getToken, toUserMessage } from './client';

async function readError(res: Response): Promise<ApiError> {
  let message = res.statusText || 'Request failed';
  try {
    const data = (await res.json()) as unknown;
    if (data && typeof data === 'object' && 'error' in data) {
      message = String((data as { error: unknown }).error);
    }
  } catch {
    // Keep the status text when the response is not JSON.
  }
  return new ApiError(res.status, toUserMessage(res.status, message), message);
}

export interface VideoTaskResult {
  status: 'pending' | 'processing' | 'completed' | 'failed';
  videoURL?: string;
}

export async function submitVideo(text: string): Promise<{ taskId: string }> {
  const token = getToken();
  const res = await fetch(`${getApiBase()}/api/digital-human/videos`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    throw await readError(res);
  }
  return (await res.json()) as { taskId: string };
}

export async function getVideoTask(taskId: string): Promise<VideoTaskResult> {
  const token = getToken();
  const res = await fetch(
    `${getApiBase()}/api/digital-human/videos/${encodeURIComponent(taskId)}`,
    { headers: token ? { Authorization: `Bearer ${token}` } : undefined },
  );
  if (!res.ok) {
    throw await readError(res);
  }
  return (await res.json()) as VideoTaskResult;
}
