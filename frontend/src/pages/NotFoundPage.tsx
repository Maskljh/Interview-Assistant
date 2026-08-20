import { Link } from 'react-router-dom';
import { APP_NAME } from '../lib/labels';
import './InterviewPages.css';

export default function NotFoundPage() {
  return (
    <div className="interview-page">
      <header className="interview-header">
        <Link className="interview-brand" to="/">
          {APP_NAME}
        </Link>
      </header>
      <main className="interview-main">
        <h1>页面不存在</h1>
        <p className="interview-subtitle">
          你访问的页面不存在或已被删除。
        </p>
        <div className="interview-list-links">
          <Link className="interview-inline-link" to="/">
            返回面试列表
          </Link>
          <Link className="interview-inline-link" to="/login">
            回到登录页
          </Link>
        </div>
      </main>
    </div>
  );
}
