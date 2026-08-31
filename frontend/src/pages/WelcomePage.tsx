import { Link, Navigate } from 'react-router-dom';
import { getToken } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import welcomeLogo from '../assets/design/welcomeLogo.png';
import welcomeGlow from '../assets/design/welcomeGlow.svg';

/**
 * 首页欢迎页 —— 按新版设计稿（面知-模拟面试助手-UI设计.html）还原。
 * 完整落地页：顶部 Header（面知 + 登录）+ 居中 Hero + 底部 Footer。
 * 已登录用户访问根路径时直接进入「面试间准备」工作台。
 */
export default function WelcomePage() {
  const { user } = useAuth();
  const loggedIn = Boolean(getToken() && user);

  if (loggedIn) {
    return <Navigate to="/interviews/new" replace />;
  }

  return (
    <div id="design-root">
      <section className="welcome screen">
        <section className="welcome-page">
        <header className="welcome-header">
          <div className="wordmark">
            <img src={welcomeLogo} alt="面知 logo" />
            <b>面知</b>
          </div>
          <Link className="text-button" to="/login">
            登录
          </Link>
        </header>
        <div className="welcome-hero">
          <img className="welcome-glow" src={welcomeGlow} alt="" />
          <div className="welcome-content">
            <img className="hero-logo" src={welcomeLogo} alt="面知" />
            <h1>
              面知，把每一场模拟，
              <br />
              变成下一次可验证的进步
            </h1>
            <p>面试可定制、历史可复盘、进步可感知</p>
            <Link className="dark-button hero-button" to="/login">
              开始模拟面试
            </Link>
          </div>
        </div>
          <footer>面知：求职者全流程模拟面试助手</footer>
        </section>
      </section>
    </div>
  );
}
