import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import AppNav, { type NavTab } from './AppNav';
import { AuthProvider } from '../auth/AuthContext';

vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => false } }));

function LocationProbe() {
  const { pathname } = useLocation();
  return <div data-testid="location">{pathname}</div>;
}

function renderNav(
  props: { tab: NavTab; confirmLeave?: boolean },
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

describe('AppNav', () => {
  it('renders brand and all four tabs in header, current tab as span', () => {
    const { container } = renderNav({ tab: 'interviews' });
    const header = container.querySelector('.interview-header')!;
    const links = [...header.querySelectorAll('a.interview-header-link')].map((a) => a.textContent);
    // 当前页「面试」为 span，其余三个为链接
    expect(links).toEqual(['题库', '成长分析', '新建']);
    const current = header.querySelector('span.interview-header-link[aria-current="page"]');
    expect(current?.textContent).toBe('面试');
    expect(header.textContent).toContain('模拟面试助手');
  });

  it('shows current tab as an aria-current span, not a link', () => {
    const { container } = renderNav({ tab: 'questions' });
    const header = container.querySelector('.interview-header')!;
    const current = header.querySelector('span.interview-header-link[aria-current="page"]');
    expect(current?.textContent).toBe('题库');
    expect(header.querySelector('a[href="/questions"]')).toBeNull();
  });

  it('always renders all four tab-bar items, active from the tab prop', () => {
    const { container } = renderNav({ tab: 'create' });
    const tabbar = container.querySelector('nav.mobile-tabbar')!;
    expect(tabbar.querySelectorAll('a').length).toBe(4);
    const active = tabbar.querySelector('.is-active');
    expect(active?.textContent).toBe('新建');
  });

  it('blocks header navigation when confirmLeave and the user cancels', () => {
    const confirmSpy = mockConfirm(false);
    const { container } = renderNav({ tab: 'interviews', confirmLeave: true });
    const trendsLink = container.querySelector('a[href="/trends"]')!;
    fireEvent.click(trendsLink);
    expect(confirmSpy).toHaveBeenCalled();
    expect(screen.getByTestId('location').textContent).toBe('/');
  });

  it('navigates after confirm when confirmLeave is set', () => {
    mockConfirm(true);
    const { container } = renderNav({ tab: 'interviews', confirmLeave: true });
    const trendsLink = container.querySelector('a[href="/trends"]')!;
    fireEvent.click(trendsLink);
    expect(screen.getByTestId('location').textContent).toBe('/trends');
  });

  it('does not confirm when confirmLeave is unset', () => {
    const confirmSpy = mockConfirm(false);
    const { container } = renderNav({ tab: 'interviews' });
    const trendsLink = container.querySelector('a[href="/trends"]')!;
    fireEvent.click(trendsLink);
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(screen.getByTestId('location').textContent).toBe('/trends');
  });
});
