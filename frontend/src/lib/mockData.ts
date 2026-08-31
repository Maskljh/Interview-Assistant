/**
 * 集中 mock 数据模块。
 * 后端暂未就绪的数据一律从这里取；后续后端可用后逐项切换到真实 API。
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

/** 重置密码：成功返回 true，账号不存在返回 false。 */
export function resetMockPassword(account: string, password: string): boolean {
  if (account.trim().toLowerCase() === MOCK_DEMO_ACCOUNT) return false;
  const users = readMockUsers();
  const idx = users.findIndex((u) => u.account.trim().toLowerCase() === account.trim().toLowerCase());
  if (idx < 0) return false;
  users[idx].password = password;
  writeMockUsers(users);
  return true;
}

/** ---------- 岗位 mock ---------- */

/** 常用岗位候选。 */
export const commonInterviewJobs = ['产品经理', '运营专员', '数据分析师', '前端工程师'];

/** ---------- 题库 mock ---------- */

export interface MockQuestion {
  id: number;
  bank: string;
  content: string;
  tags: string[];
}

/** 演示题库（8 道）。顺序与设计稿 #manage 默认展示一致：产品经理基础题库在前。 */
export const mockQuestions: MockQuestion[] = [
  { id: 1, bank: '产品经理基础题库', content: '你如何理解用户需求与业务目标之间的平衡？', tags: ['需求分析'] },
  { id: 2, bank: '产品经理基础题库', content: '请说明一次你推动产品方案落地时遇到的挑战。', tags: ['项目推进'] },
  { id: 3, bank: '产品经理基础题库', content: '当数据表现不及预期时，你会如何定位问题？', tags: ['数据分析'] },
  { id: 4, bank: '产品经理基础题库', content: '你会如何判断一个功能是否值得优先投入开发？', tags: ['优先级判断'] },
  { id: 5, bank: '岗位适配题库', content: '请分享一次你通过数据发现问题并提出解决方案的案例。', tags: ['数据分析'] },
  { id: 6, bank: '岗位适配题库', content: '如果面试岗位的业务方向发生变化，你会怎样快速补齐认知？', tags: ['岗位理解'] },
  { id: 7, bank: '通用能力题库', content: '请介绍一次你推动跨团队协作并达成目标的经历。', tags: ['沟通协作'] },
  { id: 8, bank: '通用能力题库', content: '面对优先级冲突时，你通常如何判断和推进？', tags: ['项目管理'] },
];

/** WPS 云文档题库（演示）。 */
export interface MockWpsQuestionFile {
  id: string;
  name: string;
  date: string;
  contents: string[];
}

export const mockWpsQuestionFiles: MockWpsQuestionFile[] = [
  {
    id: 'pm-bank',
    name: '产品经理通用题库.docx',
    date: '2026.08.20',
    contents: [
      '你如何理解用户需求与业务目标之间的平衡？',
      '请说明一次你推动产品方案落地时遇到的挑战。',
      '当数据表现不及预期时，你会如何定位问题？',
      '你会如何判断一个功能是否值得优先投入开发？',
    ],
  },
  {
    id: 'behavior-bank',
    name: '行为面试题库.docx',
    date: '2026.08.13',
    contents: [
      '请介绍一次你推动跨团队协作并达成目标的经历。',
      '面对优先级冲突时，你通常如何判断和推进？',
    ],
  },
  {
    id: 'role-bank',
    name: '岗位适配题库.docx',
    date: '2026.08.08',
    contents: [
      '请分享一次你通过数据发现问题并提出解决方案的案例。',
      '如果面试岗位的业务方向发生变化，你会怎样快速补齐认知？',
    ],
  },
];

import type { ResumeFile } from '../api/resumes';

/** ---------- 简历 mock ---------- */

/** 本地演示简历。 */
export const mockResumeFiles: ResumeFile[] = [
  {
    id: 1,
    name: '产品经理简历.pdf',
    file_url: '',
    size_bytes: 185_432,
    updated_at: '2026.08.27',
  },
];

/** WPS 云文档简历（演示）。 */
export interface MockWpsResumeFile {
  id: string;
  name: string;
  date: string;
}

export const mockWpsResumeFiles: MockWpsResumeFile[] = [
  { id: 'wps-resume-1', name: '罗杰豪-东华大学-硕士.pdf', date: '2026.08.13' },
  { id: 'wps-resume-2', name: '罗杰豪-产品经理简历.pdf', date: '2026.08.26' },
];

/** ---------- 岗位信息 mock ---------- */

export interface MockJobInfoItem {
  id: string;
  name: string;
  content: string;
  date: string;
}

export const mockJobInfoItems: MockJobInfoItem[] = [
  {
    id: 'job-info-project-manager',
    name: '项目管理专员/主管',
    content: `工作地点【填写具体城市/地址】
薪资8k-25k（根据经验定级，可面议）

岗位职责
1. 负责公司各类项目全流程管理，涵盖立项、计划排期、进度管控、资源协调、落地交付及复盘沉淀，保障项目按期、保质完成。
2. 拆解项目目标，制定里程碑节点，跟进日常进度，及时排查、预警并解决项目进度、质量、风险问题。
3. 统筹跨部门协作，对接业务、研发、运营等团队，协调资源、打通沟通壁垒，提升项目推进效率。
4. 负责项目资料归档、进度汇报、需求对接，完成项目复盘，优化项目流程与执行标准。

任职要求
1. 大专及以上学历，1-3年项目管理经验，互联网、政企、运营类项目经验优先，优秀应届生可培养。
2. 熟悉项目管理流程，会使用项目排期、台账、办公工具，能独立推进、管控项目，有PMP证书优先。
3. 逻辑清晰，沟通协调能力强，抗压性好，多任务处理能力强，结果导向，对项目落地负责。

薪资福利
1. 薪酬：底薪+项目绩效+年终奖+项目提成，能力优先，薪资可上浮；
2. 基础保障：五险一金、带薪年假、法定节假日、定期体检；
3. 日常福利：节日福利、生日福利、团队团建、下午茶、各类专项奖励；
4. 成长晋升：系统化培训、师徒带教、透明晋升通道，稳定成长、空间充足；
5. 团队氛围：扁平化管理、年轻团队、沟通高效、无复杂内耗。

岗位优势
核心业务岗，全程参与公司重点项目，业务接触面广，实操经验积累快，晋升公平不唯资历，适合长期深耕项目管理方向`,
    date: '2026.08.27',
  },
  {
    id: 'job-info-operations',
    name: '运营专员',
    content: '负责活动策划、内容运营与数据复盘，持续优化用户增长和留存转化。',
    date: '2026.08.26',
  },
  {
    id: 'job-info-data',
    name: '数据分析师',
    content: '负责指标体系建设、数据建模和专项分析，为业务决策提供清晰可靠的洞察。',
    date: '2026.08.25',
  },
  {
    id: 'job-info-frontend',
    name: '前端工程师',
    content: '负责 Web 应用开发与性能优化，和产品、设计协作交付稳定易用的用户体验。',
    date: '2026.08.24',
  },
];

/** ---------- 记录 / 成长 / 报告 / 房间 mock ---------- */

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

export interface MockGrowth {
  metrics: { label: string; value: string; note: string }[];
  bars: number[];
  dimensions: { name: string; value: number }[];
  tip: string;
}

export const mockGrowth: MockGrowth = {
  metrics: [
    { label: '综合表现', value: '86', note: '较上月 +8' },
    { label: '累计练习', value: '12', note: '本周 3 次' },
    { label: '完成目标', value: '75%', note: '距目标还差 2 次' },
  ],
  bars: [35, 54, 43, 70, 82, 97, 110],
  dimensions: [
    { name: '表达与沟通', value: 88 },
    { name: '逻辑分析', value: 82 },
    { name: '岗位理解', value: 76 },
    { name: '应变能力', value: 71 },
  ],
  tip: '优先补强「应变能力」：尝试进行 2 次追问型模拟，并在复盘中记录每次回答的结构。',
};

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
    { name: '业务理解', value: 84 },
    { name: '数据分析', value: 76 },
    { name: '表达结构', value: 82 },
    { name: '追问应对', value: 69 },
    { name: '风险意识', value: 61 },
  ],
  evidence: '问题 03：增长实验的因果判断',
  evidenceDetail: '你提到"转化率提升 8%"，但未说明实验周期、分流方法和显著性判断。',
  next: '1. 用 STAR + 数据口径完成一次 3 分钟复述<br>2. 专项练习：实验设计与结论边界<br>3. 3 天后安排同岗位复测',
};

export interface MockRoom {
  questionIndex: string;
  questionTitle: string;
  questionContent: string;
  transcript: string;
  status: string;
}

export const mockRoom: MockRoom = {
  questionIndex: '03 / 06',
  questionTitle: '增长实验的因果判断',
  questionContent: '你如何判断一个增长实验真正有效？请结合最近一个项目，说明目标、指标、实验设计和结果。',
  transcript: 'AI 面试官　·　00:11',
  status: '面试状态：倾听中',
};
