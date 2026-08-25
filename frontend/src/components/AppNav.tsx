import type { MouseEvent, ReactNode } from 'react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import './AppNav.css';
import UserModal from './UserModal';

export type NavTab = 'home' | 'create' | 'questions' | 'history' | 'trends';

const NAV_ITEMS: { tab: NavTab; to: string; label: string }[] = [
  { tab: 'home', to: '/', label: '首页' },
  { tab: 'create', to: '/interviews/new', label: '开始练习' },
  { tab: 'questions', to: '/questions', label: '题库' },
  { tab: 'history', to: '/history', label: '历史记录' },
  { tab: 'trends', to: '/trends', label: '成长看板' },
];

const LEAVE_CONFIRM = '离开将中断本场面试，确定离开吗？';

interface AppNavProps {
  tab: NavTab;
  confirmLeave?: boolean;
  /** topbar: 顶部横条（实时面试沉浸式页）；sidebar: 左侧深蓝侧边导航（默认） */
  variant?: 'sidebar' | 'topbar';
  /** topbar 变体下，插入到「面知」品牌与右侧操作之间（如岗位信息、倒计时等） */
  children?: ReactNode;
}

export default function AppNav({
  tab,
  confirmLeave = false,
  variant = 'sidebar',
  children,
}: AppNavProps) {
  const { user, logout } = useAuth();
  const [userModalOpen, setUserModalOpen] = useState(false);

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

  const displayName = user?.username || user?.email || '未登录';

  function avatarInitial(name: string): string {
    const trimmed = name.trim();
    return trimmed ? trimmed.charAt(0).toUpperCase() : '?';
  }

  const mobileTabbar = (
    <nav className="mobile-tabbar" aria-label="主导航">
      {NAV_ITEMS.map((item) => (
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
  );

  if (variant === 'topbar') {
    return (
      <>
        <header className="interview-header">
          <Link
            className="interview-brand"
            to="/"
            onClick={(e) => handleClick(e)}
          >
            面知
          </Link>
          {children && <div className="interview-header-context">{children}</div>}
          <div className="interview-header-actions">
            <button
              type="button"
              className="interview-header-link"
              onClick={handleLogout}
            >
              退出登录
            </button>
          </div>
        </header>
        {mobileTabbar}
      </>
    );
  }

  return (
    <>
      <aside className="app-sidebar">
        <Link
          className="app-sidebar-brand"
          to="/"
          onClick={(e) => handleClick(e)}
        >
          面知
        </Link>
        <nav className="app-sidebar-nav" aria-label="主导航">
          {NAV_ITEMS.map((item) =>
            item.tab === tab ? (
              <span
                key={item.to}
                className="app-sidebar-item is-active"
                aria-current="page"
              >
                {item.label}
              </span>
            ) : (
              <Link
                key={item.to}
                className="app-sidebar-item"
                to={item.to}
                onClick={(e) => handleClick(e)}
              >
                {item.label}
              </Link>
            ),
          )}
        </nav>
        <button
          type="button"
          className="app-sidebar-user-btn"
          onClick={() => setUserModalOpen(true)}
        >
          <span className="app-sidebar-avatar" aria-hidden>
            {avatarInitial(displayName)}
          </span>
          <span className="app-sidebar-user" title={displayName}>
            {displayName}
          </span>
        </button>
      </aside>
      {userModalOpen && (
        <UserModal onClose={() => setUserModalOpen(false)} />
      )}
      {mobileTabbar}
    </>
  );
}
