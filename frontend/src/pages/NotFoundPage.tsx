import { Link } from 'react-router-dom';
import './NotFoundPage.css';

export default function NotFoundPage() {
  return (
    <div className="notfound-page">
      <div className="notfound-brand">面知</div>
      <main className="notfound-main">
        <h1>页面不存在</h1>
        <p className="notfound-subtitle">你访问的页面不存在或已被删除。</p>
        <div className="notfound-actions">
          <Link className="notfound-btn" to="/">
            返回首页
          </Link>
          <Link className="notfound-btn notfound-btn--ghost" to="/login">
            回到登录页
          </Link>
        </div>
      </main>
    </div>
  );
}
