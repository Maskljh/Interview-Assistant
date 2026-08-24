import { ApiError, getApiBase, getToken, toUserMessage } from './client';

export async function recognizeImage(file: File): Promise<{ text: string }> {
  // multipart：原生 fetch，避免 fetchJSON 默认 JSON Content-Type
  const token = getToken();
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(`${getApiBase()}/api/ocr/recognize`, {
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
  return (await res.json()) as { text: string };
}
