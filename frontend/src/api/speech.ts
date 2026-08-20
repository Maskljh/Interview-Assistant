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

export async function transcribeAudio(blob: Blob): Promise<{ text: string }> {
  const token = getToken();
  const form = new FormData();
  form.append('audio', blob, 'answer.pcm');
  form.append('format', 'pcm');

  const res = await fetch(`${getApiBase()}/api/speech/asr`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    body: form,
  });
  if (!res.ok) {
    throw await readError(res);
  }
  return (await res.json()) as { text: string };
}

export async function synthesizeSpeech(text: string): Promise<Blob> {
  const token = getToken();
  const res = await fetch(`${getApiBase()}/api/speech/tts`, {
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
  return res.blob();
}
