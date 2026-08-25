import { fetchJSON } from './client';

export interface UploadOut {
  key: string;
  url: string;
  expires_in: number;
}

export type UploadKind = 'resume' | 'jd';

/** 将简历/JD 原文件经后端代理上传到 OSS，返回同源可访问的 URL。 */
export async function uploadFile(
  kind: UploadKind,
  file: File,
): Promise<UploadOut> {
  const body = new FormData();
  body.append('kind', kind);
  body.append('file', file);
  return fetchJSON<UploadOut>('/api/uploads', {
    method: 'POST',
    body,
  });
}
