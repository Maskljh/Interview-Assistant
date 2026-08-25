import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import WelcomePage from './WelcomePage';
import { AuthProvider } from '../auth/AuthContext';

vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => false } }));

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return {
    ...actual,
    getToken: vi.fn(() => null),
  };
});

function renderPage() {
  return render(
    <MemoryRouter>
      <AuthProvider>
        <WelcomePage />
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('WelcomePage（新版首页欢迎页）', () => {
  it('渲染 Header、Hero 标题、副文案、开始按钮与 Footer', () => {
    renderPage();
    // Header
    expect(screen.getByText('面知')).toBeTruthy();
    // Hero 大标题（两行）
    expect(screen.getByRole('heading', { name: /面知，把每一场模拟/ })).toBeTruthy();
    // 副文案
    expect(screen.getByText('面试可定制、历史可复盘、进步可感知')).toBeTruthy();
    // 主按钮
    expect(screen.getByRole('link', { name: /开始模拟面试/ })).toHaveProperty(
      'href',
      expect.stringContaining('/interviews/new'),
    );
    // Footer
    expect(screen.getByText('面知：求职者全流程模拟面试助手')).toBeTruthy();
  });

  it('未登录时 Header 显示登录', () => {
    renderPage();
    expect(screen.getByRole('link', { name: '登录' })).toHaveProperty(
      'href',
      expect.stringContaining('/login'),
    );
  });
});
