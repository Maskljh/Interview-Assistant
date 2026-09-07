/**
 * 集中 mock 数据模块。
 * 当前仅保留登录表单的本地 mock 校验（登录接口后端未提供）与常用岗位候选。
 * 其余业务数据（题库 / 简历 / 岗位 / 记录 / 成长 / 报告）均已接入后端接口。
 */

/** ---------- 认证 mock ---------- */

export const MOCK_DEMO_ACCOUNT = 'demo@mianzhi.cn';
export const MOCK_DEMO_PASSWORD = 'demo123456';
export const MOCK_DEMO_CODE = '123456';

const MOCK_USERS_KEY = 'mz-mock-users';

interface MockUserRecord {
  account: string;
  password: string;
  username: string;
}

function readMockUsers(): MockUserRecord[] {
  try {
    const raw = localStorage.getItem(MOCK_USERS_KEY);
    return raw ? (JSON.parse(raw) as MockUserRecord[]) : [];
  } catch {
    return [];
  }
}

function writeMockUsers(users: MockUserRecord[]) {
  localStorage.setItem(MOCK_USERS_KEY, JSON.stringify(users));
}

function findMockUser(account: string): MockUserRecord | undefined {
  const accountNorm = account.trim().toLowerCase();
  if (accountNorm === MOCK_DEMO_ACCOUNT) {
    return { account: MOCK_DEMO_ACCOUNT, password: MOCK_DEMO_PASSWORD, username: 'demo' };
  }
  return readMockUsers().find((u) => u.account.trim().toLowerCase() === accountNorm);
}

/** 校验账号密码（演示账号或本地注册账号）。 */
export function verifyMockPassword(account: string, password: string): boolean {
  const user = findMockUser(account);
  return Boolean(user && user.password === password);
}

/** 校验验证码（演示统一验证码）。 */
export function verifyMockCode(code: string): boolean {
  return code.trim() === MOCK_DEMO_CODE;
}

/** 注册账号：写入 localStorage，已存在返回 false。 */
export function registerMockUser(account: string, password: string, username?: string): boolean {
  const accountNorm = account.trim().toLowerCase();
  if (accountNorm === MOCK_DEMO_ACCOUNT || findMockUser(account)) return false;
  const users = readMockUsers();
  users.push({ account: accountNorm, password, username: username?.trim() || 'demo' });
  writeMockUsers(users);
  return true;
}

/** ---------- 岗位 mock ---------- */

/** 常用岗位候选。 */
export const commonInterviewJobs = ['产品经理', '运营专员', '数据分析师', '前端工程师'];

/** ---------- 记录 / 报告 mock（同步自黑客松 f2040f6 页面依赖） ---------- */

export interface MockRecord {
  title: string;
  time: string;
  score: number;
}

export const mockRecords: MockRecord[] = [
  { title: '产品经理', time: '2026.08.27　14:30', score: 86 },
  { title: '项目管理专员', time: '2026.08.24　10:00', score: 76 },
  { title: '数据分析师', time: '2026.08.19　19:30', score: 92 },
];

export interface MockReport {
  meta: string;
  score: number;
  summary: string;
  highlights: string;
  improvements: string;
  dimensions: { name: string; value: number }[];
  evidence: string;
  evidenceDetail: string;
  next: string;
}

export const mockReport: MockReport = {
  meta: '高级产品经理 · 增长方向　|　2026.08.14　|　30 分钟',
  score: 78,
  summary: '表达清晰，实验思维较强；需补足结论边界与风险识别。',
  highlights: '✓ 指标设计完整　 ✓ 能结合真实项目　 ✓ 回答结构清晰',
  improvements: '• 对照组与样本偏差说明不足　 • 缺少失败复盘的量化证据',
  dimensions: [
    { name: '岗位匹配度', value: 84 },
    { name: '业务能力', value: 76 },
    { name: '逻辑分析', value: 82 },
    { name: '表达沟通', value: 69 },
  ],
  evidence: '问题 03：增长实验的因果判断',
  evidenceDetail: '你提到"转化率提升 8%"，但未说明实验周期、分流方法和显著性判断。',
  next: '1. 用 STAR + 数据口径完成一次 3 分钟复述<br>2. 专项练习：实验设计与结论边界<br>3. 3 天后安排同岗位复测',
};
