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
