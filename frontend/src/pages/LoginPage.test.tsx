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
          <Route path="/interviews/new" element={<HomeStub />} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe('LoginPage（设计稿账号密码 / 验证码 / WPS 登录）', () => {
  it('默认渲染账号密码登录形态（品牌区 + 表单 + WPS 入口）', () => {
    renderPage();
    expect(screen.getByText('面知')).toBeTruthy();
    expect(screen.getByRole('heading', { name: '欢迎回来' })).toBeTruthy();
    expect(screen.getByText('账号密码登录')).toBeTruthy();
    expect(screen.getByText('验证码登录')).toBeTruthy();
    // 账号 / 密码输入框
    expect(screen.getByPlaceholderText('请输入手机号或邮箱')).toBeTruthy();
    expect(screen.getByPlaceholderText('请输入密码')).toBeTruthy();
    // WPS 入口与注册入口
    expect(screen.getByRole('button', { name: '使用 WPS 账号登录' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '立即注册' })).toBeTruthy();
  });

  it('账号密码 mock 登录成功后进入「面试间准备」', async () => {
    renderPage();
    fireEvent.change(screen.getByPlaceholderText('请输入手机号或邮箱'), {
      target: { value: 'demo@mianzhi.cn' },
    });
    fireEvent.change(screen.getByPlaceholderText('请输入密码'), {
      target: { value: 'demo123456' },
    });
    fireEvent.click(screen.getByRole('button', { name: '登录' }));
    await waitFor(() => {
      expect(screen.getByText('主页内容（demo@mianzhi.cn）')).toBeTruthy();
    });
  });

  it('密码错误时提示演示账号信息且停留在登录页', async () => {
    renderPage();
    fireEvent.change(screen.getByPlaceholderText('请输入手机号或邮箱'), {
      target: { value: 'demo@mianzhi.cn' },
    });
    fireEvent.change(screen.getByPlaceholderText('请输入密码'), {
      target: { value: 'wrong-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: '登录' }));
    expect(await screen.findByText(/账号或密码错误/)).toBeTruthy();
    expect(screen.getByRole('heading', { name: '欢迎回来' })).toBeTruthy();
  });

  it('验证码登录：切换形态后输入演示验证码可登录', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: '验证码登录' }));
    fireEvent.change(screen.getByPlaceholderText('请输入手机号或邮箱'), {
      target: { value: 'demo@mianzhi.cn' },
    });
    fireEvent.change(screen.getByPlaceholderText('请输入验证码'), {
      target: { value: '123456' },
    });
    fireEvent.click(screen.getByRole('button', { name: '登录' }));
    await waitFor(() => {
      expect(screen.getByText('主页内容（demo@mianzhi.cn）')).toBeTruthy();
    });
  });

  it('点击 WPS 按钮请求授权地址并跳转', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: '使用 WPS 账号登录' }));
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
    expect(screen.getByRole('heading', { name: '欢迎回来' })).toBeTruthy();
  });

  it('注册两步流程：填写信息后输入验证码完成注册', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: '立即注册' }));
    // 第一步：用户名 / 账号 / 密码
    fireEvent.change(screen.getByPlaceholderText('请输入用户名，后续可在设置中修改'), {
      target: { value: '新同学' },
    });
    fireEvent.change(screen.getByPlaceholderText('请输入手机号或邮箱'), {
      target: { value: 'newuser@mianzhi.cn' },
    });
    fireEvent.change(screen.getByPlaceholderText('至少 8 位，包含字母和数字'), {
      target: { value: 'newpass123' },
    });
    fireEvent.click(screen.getByRole('button', { name: '下一步' }));
    // 第二步：6 位验证码
    await waitFor(() => {
      expect(screen.getByText('完成注册')).toBeTruthy();
    });
    for (let i = 1; i <= 6; i += 1) {
      fireEvent.change(screen.getByLabelText(`验证码第 ${i} 位`), {
        target: { value: String(i) },
      });
    }
    fireEvent.click(screen.getByRole('button', { name: '完成注册' }));
    await waitFor(() => {
      expect(screen.getByText('主页内容（newuser@mianzhi.cn）')).toBeTruthy();
    });
  });

  it('忘记密码两步流程：验证后重置密码成功', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: '忘记密码？' }));
    fireEvent.change(screen.getByPlaceholderText('请输入注册时的手机号或邮箱'), {
      target: { value: 'demo@mianzhi.cn' },
    });
    fireEvent.change(screen.getByPlaceholderText('请输入 6 位验证码'), {
      target: { value: '123456' },
    });
    fireEvent.click(screen.getByRole('button', { name: '确认' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '确认重置密码' })).toBeTruthy();
    });
    fireEvent.change(screen.getByPlaceholderText('至少 8 位，包含字母和数字'), {
      target: { value: 'newpass123' },
    });
    fireEvent.change(screen.getByPlaceholderText('请再次输入新密码'), {
      target: { value: 'newpass123' },
    });
    fireEvent.click(screen.getByRole('button', { name: '确认重置密码' }));
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: '欢迎回来' })).toBeTruthy();
    });
  });
});
