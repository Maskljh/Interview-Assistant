import { useEffect, useState, type MouseEvent, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import UserModal from './UserModal';
import ConfirmModal from './ConfirmModal';
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
  const navigate = useNavigate();
  const { user, logout, refreshUser } = useAuth();
  const [userModalOpen, setUserModalOpen] = useState(false);
  // 待确认的离开动作：nav=跳转到 to；logout=退出登录（替代原生 window.confirm，样式统一）。
  const [pendingLeave, setPendingLeave] = useState<{ type: 'nav' | 'logout'; to?: string } | null>(null);
  // 侧边栏「退出」的二次确认（与用户管理弹窗内「退出登录」保持一致）。
  const [confirmLogoutOpen, setConfirmLogoutOpen] = useState(false);

  // 页面加载时拉取最新用户资料（昵称/头像可能已在 WPS 侧更新）
  useEffect(() => {
    void refreshUser().catch(() => {});
  }, [refreshUser]);

  // 支持从其他页面（如创建页简历库空态）打开用户管理弹窗
  useEffect(() => {
    const onOpen = () => setUserModalOpen(true);
    window.addEventListener('open-user-modal', onOpen);
    return () => window.removeEventListener('open-user-modal', onOpen);
  }, []);

  function handleClick(e: MouseEvent, to: string) {
    if (!confirmLeave) return;
    // 拦截默认跳转，弹出确认；确认后由 ConfirmModal 统一 navigate。
    e.preventDefault();
    setPendingLeave({ type: 'nav', to });
  }

  function handleLogout() {
    if (!confirmLeave) {
      logout();
      return;
    }
    setPendingLeave({ type: 'logout' });
  }

  function confirmLeaveNow() {
    if (!pendingLeave) return;
    if (pendingLeave.type === 'nav' && pendingLeave.to) {
      navigate(pendingLeave.to);
    } else if (pendingLeave.type === 'logout') {
      logout();
    }
    setPendingLeave(null);
  }

  const displayName = user?.nickname || user?.username || user?.email || '未登录';
  // WPS 用户信息接口返回的 user_id 实际可能是账号名（如 luojiehao）而非数字 ID：
  // 仅当它是纯数字时才当作 ID 展示，否则回退到系统内 MZ- 编号，避免名字下方重复显示用户名。
  const wpsUserId = user?.user_id ? String(user.user_id).trim() : '';
  const isNumericId = wpsUserId !== '' && /^\d+$/.test(wpsUserId);
  const displayId = isNumericId
    ? wpsUserId
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
            onClick={(e) => handleClick(e, '/')}
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
        <ConfirmModal
          open={pendingLeave !== null}
          title="离开面试"
          description={LEAVE_CONFIRM}
          confirmLabel="确定离开"
          cancelLabel="取消"
          onConfirm={confirmLeaveNow}
          onCancel={() => setPendingLeave(null)}
        />
      </>
    );
  }

  return (
    <>
      <aside className="app-sidebar">
        <Link
          className="app-sidebar-brand"
          to="/"
          onClick={(e) => handleClick(e, '/')}
        >
          面知
        </Link>
        <nav className="app-sidebar-nav" aria-label="主导航">
          {NAV_ITEMS.map((item) => (
            <Link
              key={item.to}
              className={`app-sidebar-item${item.tab === tab ? ' is-active' : ''}`}
              to={item.to}
              aria-current={item.tab === tab ? 'page' : undefined}
              onClick={(e) => handleClick(e, item.to)}
            >
              {item.label}
            </Link>
          ))}
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
            onClick={() => setConfirmLogoutOpen(true)}
          >
            退出
          </button>
        </div>
      </aside>
      {userModalOpen && <UserModal onClose={() => setUserModalOpen(false)} />}
      <ConfirmModal
        open={pendingLeave !== null}
        title="离开面试"
        description={LEAVE_CONFIRM}
        confirmLabel="确定离开"
        cancelLabel="取消"
        onConfirm={confirmLeaveNow}
        onCancel={() => setPendingLeave(null)}
      />
      <ConfirmModal
        open={confirmLogoutOpen}
        title="退出登录"
        description="退出后需要重新登录才能继续使用面试助手，确定退出吗？"
        confirmLabel="退出登录"
        cancelLabel="取消"
        onConfirm={() => {
          setConfirmLogoutOpen(false);
          logout();
        }}
        onCancel={() => setConfirmLogoutOpen(false)}
      />
    </>
  );
}
