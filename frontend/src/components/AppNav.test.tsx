import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import AppNav, { type NavTab } from './AppNav';
import { AuthProvider } from '../auth/AuthContext';


// pdfjs-dist requires DOMMatrix at import time in Node; mock the resume parser
vi.mock('../lib/resumeParse', () => ({
  extractResumeText: vi.fn(async () => 'mocked resume text'),
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
  localStorage.clear();
});

function mockConfirm(value: boolean) {
const spy = vi.fn(() => value);
  window.confirm = spy as unknown as typeof window.confirm;
  return spy;
}

describe('AppNav 侧边导航', () => {
  it('渲染品牌和全部四个导航项，当前项为可点击链接', () => {
    const { container } = renderNav({ tab: 'create' });
    const sidebar = container.querySelector('.app-sidebar')!;
    expect(sidebar.querySelector('.app-sidebar-brand')?.textContent).toBe('面知');
    const links = [...sidebar.querySelectorAll('a.app-sidebar-item')].map(
      (a) => a.textContent,
    );
    // 全部四项均为链接，当前页「开始面试」高亮
    expect(links).toEqual(['开始面试', '面试信息管理', '面试记录', '成长看板']);
    const current = sidebar.querySelector('a.app-sidebar-item.is-active[aria-current="page"]');
    expect(current?.textContent).toBe('开始面试');
    expect(current?.getAttribute('href')).toBe('/interviews/new');
  });

  it('当前导航项为高亮链接且可点击', () => {
    const { container } = renderNav({ tab: 'questions' });
    const sidebar = container.querySelector('.app-sidebar')!;
    const current = sidebar.querySelector('a.app-sidebar-item.is-active[aria-current="page"]');
    expect(current?.textContent).toBe('面试信息管理');
    expect(current?.getAttribute('href')).toBe('/questions');
  });

  it('confirmLeave 且用户取消时阻止侧边导航跳转', () => {
    const confirmSpy = mockConfirm(false);
    const { container } = renderNav({ tab: 'create', confirmLeave: true });
    const trendsLink = container.querySelector('a[href="/trends"]')!;
    fireEvent.click(trendsLink);
    expect(confirmSpy).toHaveBeenCalled();
    expect(screen.getByTestId('location').textContent).toBe('/');
  });

  it('confirmLeave 且用户确认后跳转', () => {
    mockConfirm(true);
    const { container } = renderNav({ tab: 'create', confirmLeave: true });
    const trendsLink = container.querySelector('a[href="/trends"]')!;
    fireEvent.click(trendsLink);
    expect(screen.getByTestId('location').textContent).toBe('/trends');
  });

  it('未设置 confirmLeave 时不弹确认框', () => {
    const confirmSpy = mockConfirm(false);
    const { container } = renderNav({ tab: 'create' });
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
  });

  it('侧边导航底部显示用户名与用户ID，并渲染退出按钮', () => {
    // 预置登录用户，让 AuthProvider 读到
    localStorage.setItem('auth_token', 'test-token');
    localStorage.setItem(
      'auth_user',
      JSON.stringify({ id: 1, email: 'user@example.com', username: '用户0001' }),
    );
    const { container } = renderNav({ tab: 'create' });
    const area = container.querySelector('.app-sidebar-user-area')!;
    expect(area.querySelector('.app-sidebar-username')?.textContent).toBe('用户0001');
    expect(area.querySelector('.app-sidebar-useid')?.textContent).toBe('MZ-00000001');
    expect(area.querySelector('.app-sidebar-avatar')?.textContent).toBe('用');
    expect(area.querySelector('.app-sidebar-logout')?.textContent).toBe('退出');
  });

  it('有 WPS 头像时侧边栏渲染真实头像图片', () => {
    localStorage.setItem('auth_token', 'test-token');
    localStorage.setItem(
      'auth_user',
      JSON.stringify({ id: 2, email: 'a@b.com', nickname: '陈舒然', avatar_url: 'https://example.com/avatar.png' }),
    );
    const { container } = renderNav({ tab: 'create' });
    const area = container.querySelector('.app-sidebar-user-area')!;
    expect(area.querySelector('.app-sidebar-username')?.textContent).toBe('陈舒然');
    const img = area.querySelector('.app-sidebar-avatar-img');
    expect(img).toBeTruthy();
    expect(img?.getAttribute('src')).toBe('https://example.com/avatar.png');
  });

  it('导航项链接指向正确路由', () => {
    const { container } = renderNav({ tab: 'create' });
    const sidebar = container.querySelector('.app-sidebar')!;
    expect(sidebar.querySelector('a[href="/interviews/new"]')?.textContent).toBe('开始面试');
    expect(sidebar.querySelector('a[href="/questions"]')?.textContent).toBe('面试信息管理');
    expect(sidebar.querySelector('a[href="/history"]')?.textContent).toBe('面试记录');
    expect(sidebar.querySelector('a[href="/trends"]')?.textContent).toBe('成长看板');
  });
});
