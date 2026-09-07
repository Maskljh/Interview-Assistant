import { fetchJSON } from './client';

/** 从后端返回的单道生成题目。 */
export interface GeneratedProjectQuestion {
  question: string;
  dimension: string;
}

/** 项目元信息（展示用）。 */
export interface ProjectMeta {
  name: string;
  description: string;
  language: string;
  topics: string[];
  stars: number;
}

/** /api/projects/analyze 响应。 */
export interface AnalyzeGitHubResult {
  project: ProjectMeta;
  questions: GeneratedProjectQuestion[];
}

/**
 * 分析 GitHub 项目，返回项目信息 + AI 生成的面试题。
 * @param githubUrl 完整的 GitHub 仓库链接，如 https://github.com/user/repo
 */
export async function analyzeGitHubProject(
  githubUrl: string,
  jobTitle?: string,
): Promise<AnalyzeGitHubResult> {
  return fetchJSON<AnalyzeGitHubResult>('/api/projects/analyze', {
    method: 'POST',
    body: JSON.stringify({ github_url: githubUrl, job_title: jobTitle ?? '' }),
  });
}
