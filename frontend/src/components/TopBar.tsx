import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';

export type TopBarActive = 'hub' | 'manage' | 'records' | 'growth';

const NAV_ITEMS: { key: TopBarActive; label: string; path: string }[] = [
  { key: 'hub', label: '开始面试', path: '/interviews/new' },
  { key: 'manage', label: '面试信息管理', path: '/manage' },
  { key: 'records', label: '面试记录', path: '/history' },
  { key: 'growth', label: '成长看板', path: '/trends' },
];

/**
 * v2.0 设计稿共享顶栏：面知品牌 + Candimate + 4 项主导航 + 个人资料/退出。
 * 与 DesignSidebar 渲染同一份导航数据，但改为顶部通栏布局（topbar）。
 */
export default function TopBar({ active }: { active: TopBarActive }) {
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
  const avatarUrl = user?.avatar_url || '';

  function avatarInitial(name: string): string {
    const trimmed = name.trim();
    return trimmed ? trimmed.charAt(0).toUpperCase() : '?';
  }

  return (
    <header className="topbar">
      <b>
        <img className="topbar-mark" src="/mianzhi-ribbon-simple.svg" alt="" />
        <span>面知</span>
        <small>Candimate</small>
      </b>
      <nav>
        {NAV_ITEMS.map((item) => (
          <button
            key={item.key}
            className={active === item.key ? 'selected' : ''}
            data-action={item.key}
            onClick={() => navigate(item.path)}
            type="button"
          >
            {item.label}
          </button>
        ))}
      </nav>
      <div className="topbar-profile">
        <span aria-hidden>
          {avatarUrl ? (
            <img className="topbar-avatar-img" src={avatarUrl} alt="" />
          ) : (
            avatarInitial(displayName)
          )}
        </span>
        <strong>{displayName}</strong>
        <button type="button" onClick={handleLogout}>
          退出
        </button>
      </div>
    </header>
  );
}
