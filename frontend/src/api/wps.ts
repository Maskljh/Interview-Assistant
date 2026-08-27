import { fetchJSON } from './client';

/** WPS 云文档中的简历候选文件。 */
export interface WpsCloudFile {
  id: string;
  name: string;
  drive_id: string;
  link_url: string | null;
  mtime: number;
}

export interface WpsCloudFileListResponse {
  items: WpsCloudFile[];
  /** 非空表示搜索失败（权限未开通、token scope 不足、网络异常等），items 为空。 */
  error?: string;
}

/** 获取当前用户 WPS 云文档中的简历候选文件；传 keyword 时叠加文件搜索。 */
export async function listCloudFiles(
  keyword = '',
): Promise<WpsCloudFileListResponse> {
  const q = keyword.trim();
  const path = q
    ? `/api/wps/cloud-files?keyword=${encodeURIComponent(q)}`
    : '/api/wps/cloud-files';
  return fetchJSON<WpsCloudFileListResponse>(path);
}

export interface WpsCloudImportResult {
  name: string;
  base64: string;
  mime_type: string;
  size: number;
}

/** 导入云文档文件：后端下载并以 base64 返回，前端复用现有解析逻辑提取简历文本。 */
export async function importCloudFile(
  file: WpsCloudFile,
): Promise<WpsCloudImportResult> {
  return fetchJSON<WpsCloudImportResult>('/api/wps/cloud-files/import', {
    method: 'POST',
    body: JSON.stringify({
      file_id: file.id,
      drive_id: file.drive_id,
      name: file.name,
    }),
  });
}
