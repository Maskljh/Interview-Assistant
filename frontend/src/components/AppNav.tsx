import { useEffect, useState, type MouseEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import UserModal from './UserModal';
import './AppNav.css';

export type NavTab = 'create' | 'questions' | 'history' | 'trends';

const NAV_ITEMS: { tab: NavTab; to: string; label: string }[] = [
  { tab: 'create', to: '/interviews/new', label: '开始面试' },
  { tab: 'questions', to: '/questions', label: '面试信息管理' },
  { tab: 'history', to: '/history', label: '面试记录' },
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
  const { user, logout, refreshUser } = useAuth();
  const [userModalOpen, setUserModalOpen] = useState(false);

  // 页面加载时拉取最新用户资料（昵称/头像可能已在 WPS 侧更新）
  useEffect(() => {
    void refreshUser().catch(() => {});
  }, [refreshUser]);

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

  const displayName = user?.nickname || user?.username || user?.email || '未登录';
  // 优先显示 WPS 账号全局 ID（个人中心可见的数字），无则回退系统内 MZ- 编号
  const displayId = user?.user_id
    ? String(user.user_id)
    : user?.id
      ? `MZ-${String(user.id).padStart(8, '0')}`
      : '';
  const avatarUrl = user?.avatar_url || '';

  function avatarInitial(name: string): string {
    const trimmed = name.trim();
    return trimmed ? trimmed.charAt(0).toUpperCase() : '?';
  }

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
        <div className="app-sidebar-user-area">
          <button
            type="button"
            className="app-sidebar-user-info"
            onClick={() => setUserModalOpen(true)}
            aria-label="打开用户管理"
          >
            <span className="app-sidebar-avatar" aria-hidden>
              {avatarUrl ? (
                <img className="app-sidebar-avatar-img" src={avatarUrl} alt="" />
              ) : (
                avatarInitial(displayName)
              )}
            </span>
            <span className="app-sidebar-user-text">
              <span className="app-sidebar-username" title={displayName}>
                {displayName}
              </span>
              {displayId && (
                <span className="app-sidebar-useid" title={displayId}>
                  {displayId}
                </span>
              )}
            </span>
          </button>
          <button
            type="button"
            className="app-sidebar-logout"
            onClick={() => setUserModalOpen(true)}
          >
            退出
          </button>
        </div>
      </aside>
      {userModalOpen && <UserModal onClose={() => setUserModalOpen(false)} />}
    </>
  );
}
