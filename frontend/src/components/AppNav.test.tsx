import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import AppNav, { type NavAction, type NavTab } from './AppNav';
import { AuthProvider } from '../auth/AuthContext';

vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => false } }));

function LocationProbe() {
  const { pathname } = useLocation();
  return <div data-testid="location">{pathname}</div>;
}

function renderNav(props: { tab: NavTab; actions?: NavAction[]; confirmLeave?: boolean }) {
  return render(
    <MemoryRouter initialEntries={['/']}>
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
  it('renders brand and only non-current global tabs in header', () => {
    const { container } = renderNav({ tab: 'interviews' });
    const header = container.querySelector('.interview-header')!;
    const links = [...header.querySelectorAll('a.interview-header-link')].map((a) => a.textContent);
    expect(links).toEqual(['题库', '成长分析']);
    expect(header.textContent).toContain('模拟面试助手');
  });

  it('shows current global tab as an aria-current span, not a link', () => {
    const { container } = renderNav({ tab: 'questions' });
    const header = container.querySelector('.interview-header')!;
    const current = header.querySelector('span.interview-header-link[aria-current="page"]');
    expect(current?.textContent).toBe('题库');
    expect(header.querySelector('a[href="/questions"]')).toBeNull();
  });

  it('renders page actions, with cta variant using the cta class', () => {
    const { container } = renderNav({
      tab: 'interviews',
      actions: [{ to: '/interviews/new', label: '新建面试', variant: 'cta' }],
    });
    const header = container.querySelector('.interview-header')!;
    const cta = header.querySelector('a.interview-header-cta');
    expect(cta?.textContent).toBe('新建面试');
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
