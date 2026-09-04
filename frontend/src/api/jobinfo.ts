import { fetchJSON } from './client';

/** 岗位信息（JD 收藏库）记录。 */
export interface JobInfoItem {
  id: number;
  name: string;
  content: string;
  created_at: string;
}

export interface JobInfoListResponse {
  items: JobInfoItem[];
}

/** 获取当前用户的岗位信息列表（按更新时间倒序）。 */
export async function listJobInfo(): Promise<JobInfoItem[]> {
  const data = await fetchJSON<JobInfoListResponse>('/api/job-info');
  return data.items;
}

/** 新建岗位信息。 */
export async function createJobInfo(
  name: string,
  content: string,
): Promise<JobInfoItem> {
  return fetchJSON<JobInfoItem>('/api/job-info', {
    method: 'POST',
    body: JSON.stringify({ name, content }),
  });
}

/** 更新岗位名称与内容。 */
export async function updateJobInfo(
  id: number,
  name: string,
  content: string,
): Promise<void> {
  await fetchJSON<{ status: string }>(`/api/job-info/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ name, content }),
  });
}

/** 删除岗位信息。 */
export async function deleteJobInfo(id: number): Promise<void> {
  await fetchJSON<{ status: string }>(`/api/job-info/${id}`, {
    method: 'DELETE',
  });
}
