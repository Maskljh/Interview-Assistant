import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';

export type DesignSidebarActive = 'home' | 'manage' | 'records' | 'growth';

const NAV_ITEMS: { key: DesignSidebarActive; label: string; path: string }[] = [
  { key: 'home', label: '开始面试', path: '/interviews/new' },
  { key: 'manage', label: '面试信息管理', path: '/manage' },
  { key: 'records', label: '面试记录', path: '/history' },
  { key: 'growth', label: '成长看板', path: '/trends' },
];

/**
 * 设计稿共享侧边栏：面知品牌 + 4 项主导航 + 个人资料/退出。
 * 用于工作台（home）、信息管理（manage）、记录（records）、成长（growth）四类页面。
 */
export default function DesignSidebar({ active }: { active: DesignSidebarActive }) {
  const navigate = useNavigate();
  const { user, logout, refreshUser } = useAuth();

  // 页面加载时拉取最新用户资料（昵称/头像可能已在 WPS 侧更新）
  useEffect(() => {
    void refreshUser().catch(() => {});
  }, [refreshUser]);

  function handleLogout() {
    logout();
    navigate('/welcome', { replace: true });
  }

  const displayName = user?.username || user?.nickname || 'username';
  const displayId = user?.user_id || user?.email || 'useid';
  const avatarUrl = user?.avatar_url || '';

  function avatarInitial(name: string): string {
    const trimmed = name.trim();
    return trimmed ? trimmed.charAt(0).toUpperCase() : '?';
  }

  return (
    <aside className="sidebar">
      <b>面知</b>
      <nav>
        {NAV_ITEMS.map((item) => (
          <button
            key={item.key}
            className={active === item.key ? 'selected' : ''}
            onClick={() => navigate(item.path)}
            type="button"
          >
            {item.label}
          </button>
        ))}
      </nav>
      <div className="profile">
        <span aria-hidden>
          {avatarUrl ? (
            <img className="sidebar-avatar-img" src={avatarUrl} alt="" />
          ) : (
            avatarInitial(displayName)
          )}
        </span>
        <div>
          <strong>{displayName}</strong>
          <small>{displayId}</small>
        </div>
        <button type="button" onClick={handleLogout}>
          退出
        </button>
      </div>
    </aside>
  );
}
