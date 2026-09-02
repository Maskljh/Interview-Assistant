import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import HubPage from './HubPage';
import { AuthProvider } from '../auth/AuthContext';
import { listInterviews } from '../api/interviews';

vi.mock('../api/interviews', () => ({
  listInterviews: vi.fn(async () => [
    {
      id: 1,
      mode: 'mixed',
      persona: 'standard',
      difficulty: 'medium',
      company_style: 'startup',
      job_title: '前端工程师',
      status: 'draft',
      created_at: '2026-09-01T10:00:00Z',
      score: null,
    },
    {
      id: 2,
      mode: 'mixed',
      persona: 'standard',
      difficulty: 'medium',
      company_style: 'startup',
      job_title: '产品经理',
      status: 'completed',
      created_at: '2026-08-30T10:00:00Z',
      score: 86,
    },
  ]),
}));

function renderPage() {
  return render(
    <MemoryRouter>
      <AuthProvider>
        <HubPage />
      </AuthProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('HubPage 工作台首页（v2.0 设计稿 #hub）', () => {
  it('渲染品牌 hero、开始模拟面试按钮与历史卷宗区', async () => {
    renderPage();
    // 品牌标语
    expect(screen.getByText(/面知，把每一场模拟/)).toBeTruthy();
    expect(screen.getByText(/面试可定制、历史可复盘、进步可感知/)).toBeTruthy();
    // 开始模拟面试按钮
    expect(screen.getByRole('button', { name: /开始模拟面试/ })).toBeTruthy();
    // 历史卷宗区标题
    expect(screen.getByText('历史面试记录')).toBeTruthy();
    expect(screen.getByText('INTERVIEW HISTORY / ARCHIVED SESSIONS')).toBeTruthy();
    // 更多按钮
    expect(screen.getByRole('button', { name: /更多/ })).toBeTruthy();
  });

  it('后端记录填充卷宗卡片（岗位；不显示状态与分数）', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/前端工程师/)).toBeTruthy();
      expect(screen.getByText(/产品经理/)).toBeTruthy();
    });
    // 设计稿一致：卷宗卡不显示状态/分数，仅岗位与日期
    expect(screen.queryByText('86')).toBeNull();
    expect(screen.queryByText('草稿')).toBeNull();
    expect(screen.getAllByText(/案件卷宗 \//).length).toBeGreaterThan(0);
  });

  it('后端无记录时显示空态提示', async () => {
    vi.mocked(listInterviews).mockResolvedValueOnce([]);
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/还没有历史面试记录/)).toBeTruthy();
    });
  });
});
