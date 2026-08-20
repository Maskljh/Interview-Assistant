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

export interface LivestreamSign {
  appkey: string;
  timestamp: string;
  signature: string;
  virtualmanProjectId: string;
  userId: string;
}

export interface LivestreamSession {
  sessionId: string;
  streamURL: string;
}

export async function createLivestreamSession(): Promise<LivestreamSession> {
  const token = getToken();
  const res = await fetch(`${getApiBase()}/api/livestream/sessions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: '{}',
  });
  if (!res.ok) throw await readError(res);
  return (await res.json()) as LivestreamSession;
}

export async function speakLivestream(sessionId: string, text: string): Promise<void> {
  const token = getToken();
  const res = await fetch(
    `${getApiBase()}/api/livestream/sessions/${encodeURIComponent(sessionId)}/speak`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ text }),
    },
  );
  if (!res.ok) throw await readError(res);
}

export async function closeLivestream(sessionId: string): Promise<void> {
  const token = getToken();
  const res = await fetch(
    `${getApiBase()}/api/livestream/sessions/${encodeURIComponent(sessionId)}/close`,
    {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    },
  );
  if (!res.ok) throw await readError(res);
}

export async function getLivestreamSign(): Promise<LivestreamSign> {
  const token = getToken();
  const res = await fetch(`${getApiBase()}/api/livestream/sign`, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (!res.ok) throw await readError(res);
  return (await res.json()) as LivestreamSign;
}
