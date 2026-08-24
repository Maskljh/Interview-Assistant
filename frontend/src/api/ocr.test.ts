import { afterEach, describe, expect, it, vi } from 'vitest';
import { recognizeImage } from './ocr';
import { ApiError } from './client';

vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => false } }));

vi.mock('./client', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return {
    ...actual,
    getApiBase: () => 'http://test.local',
    getToken: () => 'test-token',
    toUserMessage: (_status: number, raw: string) => raw,
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('recognizeImage', () => {
  it('POSTs multipart and returns text on 200', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = init?.body as FormData;
      expect(body.get('file')).toBeInstanceOf(File);
      return {
        ok: true,
        status: 200,
        json: async () => ({ text: '识别出的 JD 文本' }),
      } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    const file = new File(['x'], 'jd.png', { type: 'image/png' });
    const res = await recognizeImage(file);
    expect(res.text).toBe('识别出的 JD 文本');
    const url = fetchMock.mock.calls[0][0];
    expect(String(url)).toContain('/api/ocr/recognize');
  });

  it('throws ApiError with raw message on failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 502,
      statusText: 'Bad Gateway',
      json: async () => ({ error: 'image recognition unavailable, please use text input' }),
    } as Response)));

    const file = new File(['x'], 'jd.png', { type: 'image/png' });
    await expect(recognizeImage(file)).rejects.toThrow(ApiError);
  });
});
