import { type FormEvent, useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { ApiError, getToken } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { APP_NAME } from '../lib/labels';
import './AuthPages.css';

export default function RegisterPage() {
  const { register, user } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  if (getToken() && user) {
    return <Navigate to="/" replace />;
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await register(email, password);
      navigate('/', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '注册失败');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <h1>注册</h1>
        <p className="subtitle">{APP_NAME}</p>
        <form className="auth-form" onSubmit={handleSubmit}>
          {error && <p className="auth-error">{error}</p>}
          <div className="auth-field">
            <label htmlFor="email">邮箱</label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="auth-field">
            <label htmlFor="password">密码（至少 8 位）</label>
            <input
              id="password"
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <button className="auth-submit" type="submit" disabled={loading}>
            {loading ? '创建中…' : '创建账号'}
          </button>
        </form>
        <p className="auth-footer">
          已有账号？ <Link to="/login">登录</Link>
        </p>
      </div>
    </div>
  );
}
