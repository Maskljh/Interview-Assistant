import type { MouseEvent } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { APP_NAME } from '../lib/labels';

export type NavTab = 'interviews' | 'questions' | 'trends' | 'create';

const TAB_BAR_ITEMS: { tab: NavTab; to: string; label: string }[] = [
  { tab: 'interviews', to: '/', label: '面试' },
  { tab: 'questions', to: '/questions', label: '题库' },
  { tab: 'trends', to: '/trends', label: '成长分析' },
  { tab: 'create', to: '/interviews/new', label: '新建' },
];

const LEAVE_CONFIRM = '离开将中断本场面试，确定离开吗？';

interface AppNavProps {
  tab: NavTab;
  confirmLeave?: boolean;
}

export default function AppNav({ tab, confirmLeave = false }: AppNavProps) {
  const { logout } = useAuth();

  function guard(): boolean {
    if (!confirmLeave) return true;
    return window.confirm(LEAVE_CONFIRM);
  }

  function handleClick(e: MouseEvent) {
    if (!guard()) e.preventDefault();
  }

  function handleLogout() {
    if (!guard()) return;
    logout();
  }

  return (
    <>
      <header className="interview-header">
        <Link
          className="interview-brand"
          to="/"
          onClick={(e) => handleClick(e)}
        >
          {APP_NAME}
        </Link>
        <div className="interview-header-actions">
          {TAB_BAR_ITEMS.map((item) => {
            const isCreate = item.tab === 'create';
            const linkClass = isCreate
              ? 'interview-header-cta header-nav-link'
              : 'interview-header-link header-nav-link';
            return item.tab === tab ? (
              <span
                key={item.to}
                className={linkClass}
                aria-current="page"
              >
                {item.label}
              </span>
            ) : (
              <Link
                key={item.to}
                className={linkClass}
                to={item.to}
                onClick={(e) => handleClick(e)}
              >
                {item.label}
              </Link>
            );
          })}
          <button type="button" className="interview-header-link" onClick={handleLogout}>
            退出登录
          </button>
        </div>
      </header>
      <nav className="mobile-tabbar" aria-label="主导航">
        {TAB_BAR_ITEMS.map((item) => (
          <Link
            key={item.to}
            to={item.to}
            className={`mobile-tabbar-item${item.tab === tab ? ' is-active' : ''}`}
            aria-current={item.tab === tab ? 'page' : undefined}
            onClick={(e) => handleClick(e)}
          >
            {item.label}
          </Link>
        ))}
      </nav>
    </>
  );
}
