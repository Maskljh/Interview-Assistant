import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import LoginPage from './LoginPage';
import { AuthProvider, useAuth } from '../auth/AuthContext';

// 让登录调用真实 Context 的 login（走 mock 的 authApi），而非 guest 模式
vi.mock('../api/auth', () => ({
  login: vi.fn(async () => ({
    token: 'jwt-token',
    user: { id: 739, email: 'ocr-e2e-test@example.com' },
  })),
}));

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return {
    ...actual,
    getToken: vi.fn(() => null),
  };
});

import * as authApi from '../api/auth';

function HomeStub() {
  const { user } = useAuth();
  return <div>主页内容（{user?.email}）</div>;
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/login']}>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/" element={<HomeStub />} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('LoginPage（Figma 独立登录页）', () => {
  it('渲染品牌区与登录卡的所有元素', () => {
    renderPage();
    expect(screen.getByText('面知')).toBeTruthy();
    expect(screen.getByRole('heading', { name: /把每一场模拟面试/ })).toBeTruthy();
    expect(screen.getByText(/从资料准备、动态追问/)).toBeTruthy();
    expect(screen.getByRole('heading', { name: '使用 WPS 账号登录' })).toBeTruthy();
    expect(screen.getByText('授权后即可继续你的模拟面试训练')).toBeTruthy();
    expect(screen.getByLabelText('邮箱')).toBeTruthy();
    expect(screen.getByLabelText('密码')).toBeTruthy();
    expect(screen.getByRole('button', { name: '使用 WPS 账号授权登录' })).toBeTruthy();
    expect(screen.getByText('授权仅用于关联你的资料、训练记录与云文档')).toBeTruthy();
  });

  it('默认填充测试账号，提交后调用真实登录并跳转主页', async () => {
    renderPage();
    expect((screen.getByLabelText('邮箱') as HTMLInputElement).value).toBe(
      'ocr-e2e-test@example.com',
    );
    expect((screen.getByLabelText('密码') as HTMLInputElement).value).toBe('test123456');

    fireEvent.submit(screen.getByRole('button', { name: '使用 WPS 账号授权登录' }).closest('form')!);

    await waitFor(() => {
      expect(screen.getByText('主页内容（ocr-e2e-test@example.com）')).toBeTruthy();
    });
  });

  it('登录失败时展示错误信息且停留在登录页', async () => {
    const { ApiError } = await import('../api/client');
    vi.mocked(authApi.login).mockRejectedValueOnce(
      new ApiError(401, '邮箱或密码错误', 'invalid credentials'),
    );

    renderPage();
    fireEvent.submit(screen.getByRole('button', { name: '使用 WPS 账号授权登录' }).closest('form')!);

    await waitFor(() => {
      expect(screen.getByText('邮箱或密码错误')).toBeTruthy();
    });
    expect(screen.getByRole('heading', { name: '使用 WPS 账号登录' })).toBeTruthy();
  });
});
