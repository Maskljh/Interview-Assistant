import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import WelcomePage from './WelcomePage';
import { AuthProvider } from '../auth/AuthContext';
import * as client from '../api/client';


vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return {
    ...actual,
    getToken: vi.fn(() => null),
  };
});

const USER_KEY = 'auth_user';

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <AuthProvider>
        <Routes>
          <Route path="/" element={<WelcomePage />} />
          <Route path="/interviews/new" element={<div>创建面试页</div>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  localStorage.clear();
  vi.mocked(client.getToken).mockReturnValue(null);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('WelcomePage（新版首页欢迎页）', () => {
  it('渲染 Header、Hero 标题、副文案、开始按钮与 Footer', () => {
    renderPage();
    // Header
    expect(screen.getByText('面知')).toBeTruthy();
    // Hero 大标题（两行）
    expect(screen.getByRole('heading', { name: /面知，把每一场模拟/ })).toBeTruthy();
    // 副文案
    expect(screen.getByText('面试可定制、历史可复盘、进步可感知')).toBeTruthy();
    // Footer
    expect(screen.getByText('面知：求职者全流程模拟面试助手')).toBeTruthy();
  });

  it('未登录时：右上角与开始模拟面试都指向登录页', () => {
    renderPage();
    expect(screen.getByRole('link', { name: '登录' })).toHaveProperty(
      'href',
      expect.stringContaining('/login'),
    );
    expect(screen.getByRole('link', { name: /开始模拟面试/ })).toHaveProperty(
      'href',
      expect.stringContaining('/login'),
    );
  });

  it('已登录时：直接重定向到创建面试页', () => {
    vi.mocked(client.getToken).mockReturnValue('test-token');
    localStorage.setItem(USER_KEY, JSON.stringify({ id: 1, email: 'a@b.com', username: '张三' }));

    renderPage();
    expect(screen.getByText('创建面试页')).toBeTruthy();
    // 欢迎页内容不应出现
    expect(screen.queryByText('开始模拟面试')).toBeNull();
  });
});
