import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import AppNav, { type NavTab } from './AppNav';
import { AuthProvider } from '../auth/AuthContext';

vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => false } }));

// pdfjs-dist requires DOMMatrix at import time in Node; mock the resume parser
vi.mock('../lib/resumeParse', () => ({
  extractResumeText: vi.fn(async () => 'mocked resume text'),
}));

// UserModal 挂载时拉取简历库，测试里 mock 掉 API
vi.mock('../api/resumes', () => ({
  listResumes: vi.fn(async () => []),
  uploadResume: vi.fn(async () => ({ id: 1 })),
  renameResume: vi.fn(async () => {}),
  deleteResume: vi.fn(async () => {}),
}));

function LocationProbe() {
  const { pathname } = useLocation();
  return <div data-testid="location">{pathname}</div>;
}

function renderNav(
  props: { tab: NavTab; confirmLeave?: boolean; variant?: 'sidebar' | 'topbar' },
  options: { initialEntries?: string[] } = {},
) {
  return render(
    <MemoryRouter initialEntries={options.initialEntries ?? ['/']}>
      <AuthProvider>
        <AppNav {...props} />
        <LocationProbe />
      </AuthProvider>
    </MemoryRouter>,
  );
}

const originalConfirm = window.confirm;
afterEach(() => {
  window.confirm = originalConfirm;
});

function mockConfirm(value: boolean) {
  const spy = vi.fn(() => value);
  window.confirm = spy as unknown as typeof window.confirm;
  return spy;
}

describe('AppNav 侧边导航', () => {
  it('渲染品牌和全部五个导航项，当前项为 span', () => {
    const { container } = renderNav({ tab: 'home' });
    const sidebar = container.querySelector('.app-sidebar')!;
    expect(sidebar.querySelector('.app-sidebar-brand')?.textContent).toBe('面知');
    const links = [...sidebar.querySelectorAll('a.app-sidebar-item')].map(
      (a) => a.textContent,
    );
    // 当前页「首页」为 span，其余四项为链接
    expect(links).toEqual(['开始练习', '题库', '历史记录', '成长看板']);
    const current = sidebar.querySelector('span.app-sidebar-item[aria-current="page"]');
    expect(current?.textContent).toBe('首页');
  });

  it('显示当前导航项为 aria-current span 而非链接', () => {
    const { container } = renderNav({ tab: 'questions' });
    const sidebar = container.querySelector('.app-sidebar')!;
    const current = sidebar.querySelector('span.app-sidebar-item[aria-current="page"]');
    expect(current?.textContent).toBe('题库');
    expect(sidebar.querySelector('a[href="/questions"]')).toBeNull();
  });

  it('移动端 tabbar 渲染全部五个项，active 来自 tab prop', () => {
    const { container } = renderNav({ tab: 'create' });
    const tabbar = container.querySelector('nav.mobile-tabbar')!;
    expect(tabbar.querySelectorAll('a').length).toBe(5);
    const active = tabbar.querySelector('.is-active');
    expect(active?.textContent).toBe('开始练习');
  });

  it('confirmLeave 且用户取消时阻止侧边导航跳转', () => {
    const confirmSpy = mockConfirm(false);
    const { container } = renderNav({ tab: 'home', confirmLeave: true });
    const trendsLink = container.querySelector('a[href="/trends"]')!;
    fireEvent.click(trendsLink);
    expect(confirmSpy).toHaveBeenCalled();
    expect(screen.getByTestId('location').textContent).toBe('/');
  });

  it('confirmLeave 且用户确认后跳转', () => {
    mockConfirm(true);
    const { container } = renderNav({ tab: 'home', confirmLeave: true });
    const trendsLink = container.querySelector('a[href="/trends"]')!;
    fireEvent.click(trendsLink);
    expect(screen.getByTestId('location').textContent).toBe('/trends');
  });

  it('未设置 confirmLeave 时不弹确认框', () => {
    const confirmSpy = mockConfirm(false);
    const { container } = renderNav({ tab: 'home' });
    const trendsLink = container.querySelector('a[href="/trends"]')!;
    fireEvent.click(trendsLink);
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(screen.getByTestId('location').textContent).toBe('/trends');
  });

  it('topbar 变体渲染顶部横条（实时面试沉浸式页）', () => {
    const { container } = renderNav({ tab: 'create', variant: 'topbar' });
    const header = container.querySelector('.interview-header')!;
    expect(header.querySelector('.interview-brand')?.textContent).toBe('面知');
    expect(container.querySelector('.app-sidebar')).toBeNull();
    // 移动端 tabbar 仍渲染
    expect(container.querySelector('nav.mobile-tabbar')).toBeTruthy();
  });

  it('侧边导航底部显示用户名（点击可打开用户弹窗）', () => {
    // 预置登录用户，让 AuthProvider 读到
    localStorage.setItem('auth_token', 'test-token');
    localStorage.setItem(
      'auth_user',
      JSON.stringify({ id: 1, email: 'user@example.com', username: '用户0001' }),
    );
    const { container } = renderNav({ tab: 'home' });
    const btn = container.querySelector('.app-sidebar-user-btn')!;
    expect(btn.querySelector('.app-sidebar-user')?.textContent).toBe('用户0001');
    expect(btn.querySelector('.app-sidebar-avatar')?.textContent).toBe('用');
    // 侧边栏不再有退出登录按钮
    expect(container.querySelector('.app-sidebar-logout')).toBeNull();
    localStorage.clear();
  });

  it('点击侧边栏用户区弹出用户管理弹窗', () => {
    localStorage.setItem('auth_token', 'test-token');
    localStorage.setItem(
      'auth_user',
      JSON.stringify({ id: 1, email: 'user@example.com', username: '用户0001' }),
    );
    const { container } = renderNav({ tab: 'home' });
    fireEvent.click(container.querySelector('.app-sidebar-user-btn')!);
    expect(screen.getByText('用户管理')).toBeTruthy();
    localStorage.clear();
  });
});
