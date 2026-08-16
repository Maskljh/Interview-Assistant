import type { InterviewMode, InterviewStatus } from '../api/interviews';

export const APP_NAME = '模拟面试助手';

export const MODE_LABELS: Record<InterviewMode, string> = {
  behavioral: '行为面试',
  technical: '技术面试',
  mixed: '综合面试',
};

export const STATUS_LABELS: Record<InterviewStatus, string> = {
  draft: '草稿',
  ready: '待开始',
  in_progress: '进行中',
  completed: '已完成',
  failed: '失败',
};

export function formatDateZh(iso: string): string {
  return new Date(iso).toLocaleString('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}
