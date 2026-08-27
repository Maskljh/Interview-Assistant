import { Link, Navigate } from 'react-router-dom';
import { getToken } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import './WelcomePage.css';

/**
 * 首页欢迎页 —— 按新版 Figma「00 欢迎页」(node 110:2) 还原。
 * 完整落地页：顶部 Header（面知 + 登录/进入应用）+ 居中 Hero + 底部 Footer。
 * 已登录用户访问根路径时直接进入创建面试页，不再停留欢迎页。
 */
export default function WelcomePage() {
  const { user } = useAuth();
  const loggedIn = Boolean(getToken() && user);

  if (loggedIn) {
    return <Navigate to="/interviews/new" replace />;
  }

  return (
    <div className="welcome-page">
      <header className="welcome-header">
        <Link className="welcome-brand" to="/">
          <img className="welcome-brand-logo" src="/logo.png" alt="面知" />
          <span className="welcome-brand-name">面知</span>
        </Link>
        <div className="welcome-header-actions">
          <Link className="welcome-login" to="/login">
            登录
          </Link>
        </div>
      </header>

      <main className="welcome-hero">
        <div className="welcome-glow" aria-hidden="true" />
        <div className="welcome-hero-content">
          <img className="welcome-hero-logo" src="/logo.png" alt="面知" />
          <h1>
            面知，把每一场模拟，
            <br />
            变成下一次可验证的进步
          </h1>
          <p className="welcome-subtitle">面试可定制、历史可复盘、进步可感知</p>
          <Link className="welcome-start" to="/login">
            开始模拟面试
          </Link>
        </div>
      </main>

      <footer className="welcome-footer">
        <span>面知：求职者全流程模拟面试助手</span>
      </footer>
    </div>
  );
}
