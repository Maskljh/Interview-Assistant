import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import LoginPage from './LoginPage';
import { AuthProvider, useAuth } from '../auth/AuthContext';

// 让登录调用真实 Context 的 loginWithWPS（走 mock 的 authApi）。
vi.mock('../api/auth', () => ({
  authorizeWPS: vi.fn(async () => ({ url: 'https://openapi.wps.cn/oauth2/auth?state=xyz' })),
  exchangeWPS: vi.fn(async () => ({
    token: 'jwt-token',
    user: { id: 739, email: 'wps_openid-abc@wps.local', username: '罗杰豪' },
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

function renderPage(initialEntry = '/login') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
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

describe('LoginPage（WPS OAuth 登录）', () => {
  it('渲染品牌区与 WPS 授权按钮', () => {
    renderPage();
    expect(screen.getByText('面知')).toBeTruthy();
    expect(screen.getByRole('heading', { name: /把每一场模拟面试/ })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '使用 WPS 账号登录' })).toBeTruthy();
    expect(screen.getByText('授权后即可继续你的模拟面试训练')).toBeTruthy();
    expect(screen.getByRole('button', { name: '使用 WPS 账号授权登录' })).toBeTruthy();
    expect(screen.getByText('授权仅用于关联你的资料、训练记录与云文档')).toBeTruthy();
    // 不再有邮箱/密码表单
    expect(screen.queryByLabelText('邮箱')).toBeNull();
    expect(screen.queryByLabelText('密码')).toBeNull();
  });

  it('点击授权按钮后请求后端并跳转 WPS 授权页', async () => {
    renderPage();
    fireEvent.submit(screen.getByRole('button', { name: '使用 WPS 账号授权登录' }).closest('form')!);

    await waitFor(() => {
      expect(authApi.authorizeWPS).toHaveBeenCalledTimes(1);
    });
    const { url } = await vi.mocked(authApi.authorizeWPS).mock.results[0]!.value;
    expect(url).toBe('https://openapi.wps.cn/oauth2/auth?state=xyz');
  });

  it('带 oauth_code 回调时自动登录并跳转主页', async () => {
    renderPage('/login?oauth_code=temp-code-1');
    await waitFor(() => {
      expect(screen.getByText('主页内容（wps_openid-abc@wps.local）')).toBeTruthy();
    });
  });

  it('带 error 参数时展示错误信息', () => {
    renderPage('/login?error=state%20%E6%A0%A1%E9%AA%8C%E4%B8%8D%E9%80%9A%E8%BF%87');
    expect(screen.getByText('state 校验不通过')).toBeTruthy();
  });

  it('exchange 失败时展示错误且停留在登录页', async () => {
    const { ApiError } = await import('../api/client');
    vi.mocked(authApi.exchangeWPS).mockRejectedValueOnce(
      new ApiError(400, '登录凭证无效或已过期', '登录凭证无效或已过期'),
    );

    renderPage('/login?oauth_code=expired-code');
    await waitFor(() => {
      expect(screen.getByText('登录凭证无效或已过期')).toBeTruthy();
    });
    expect(screen.getByRole('heading', { name: '使用 WPS 账号登录' })).toBeTruthy();
  });
});
