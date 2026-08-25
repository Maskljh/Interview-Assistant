import { fetchJSON } from './client';

export interface ResumeFile {
  id: number;
  name: string;
  file_url: string;
  size_bytes: number;
  resume_text?: string;
  updated_at: string;
}

export interface ResumeListResponse {
  items: ResumeFile[];
}

/** 获取当前用户的简历库列表（按更新时间倒序）。 */
export async function listResumes(): Promise<ResumeFile[]> {
  const data = await fetchJSON<ResumeListResponse>('/api/resumes');
  return data.items;
}

/** 上传简历：文件 + 已解析的简历文本（由前端解析后随表单提交）。 */
export async function uploadResume(file: File, text: string): Promise<ResumeFile> {
  const body = new FormData();
  body.append('file', file);
  body.append('text', text);
  return fetchJSON<ResumeFile>('/api/resumes', {
    method: 'POST',
    body,
  });
}

/** 重命名简历。 */
export async function renameResume(id: number, name: string): Promise<void> {
  await fetchJSON<{ status: string }>(`/api/resumes/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ name }),
  });
}

/** 删除简历。 */
export async function deleteResume(id: number): Promise<void> {
  await fetchJSON<{ status: string }>(`/api/resumes/${id}`, {
    method: 'DELETE',
  });
}
