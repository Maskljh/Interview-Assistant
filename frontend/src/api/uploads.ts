import { fetchJSON } from './client';

export interface SignUploadOut {
  key: string;
  put_url: string;
  object_url: string;
  expires_in: number;
}

export type UploadKind = 'resume' | 'jd';

/** 向后端申请 OSS 直传签名（PUT URL）。 */
export async function signUpload(
  kind: UploadKind,
  file: File,
): Promise<SignUploadOut> {
  return fetchJSON<SignUploadOut>('/api/uploads/sign', {
    method: 'POST',
    body: JSON.stringify({
      kind,
      filename: file.name,
      content_type: file.type || 'application/octet-stream',
      size: file.size,
    }),
  });
}
