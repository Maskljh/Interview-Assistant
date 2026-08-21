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

// Single source of truth for persona labels is backend llm.PersonaLabels.
export const PERSONA_LABELS: Record<string, string> = {
  standard: '标准',
  strict_tech: '严厉技术面',
  warm_hr: '温和 HR 面',
  stress: '压力面',
};

// Single source of truth for difficulty labels is backend llm.DifficultyLabels.
export const DIFFICULTY_LABELS: Record<string, string> = {
  easy: '容易',
  medium: '中等',
  hard: '困难',
};

// Single source of truth for company style labels is backend llm.CompanyStyleLabels.
export const COMPANY_STYLE_LABELS: Record<string, string> = {
  general: '通用',
  foreign: '外企',
  bigtech: '大厂',
  stateowned: '国企',
  startup: '创业公司',
};

// Single source of truth for dimension labels is backend llm.DimensionLabels.
export const DIMENSION_LABELS: Record<string, string> = {
  expression: '表达能力',
  logic: '逻辑结构',
  content: '内容质量',
  job_match: '岗位匹配',
};
