import { type FormEvent, useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { ApiError, getToken } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import './LoginPage.css';

/**
 * 注册页 —— 与登录页同款 Figma 双栏布局（左深蓝品牌区 + 右暖白注册卡）。
 * 注册成功后直接进入主页。
 */
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
    <div className="login-page">
      <div className="login-brand">
        <div className="login-brand-logo">面知</div>
        <h1 className="login-brand-title">
          把每一场模拟面试，
          <br />
          变成下一次可验证的进步。
        </h1>
        <p className="login-brand-sub">
          从资料准备、动态追问，到复盘与成长追踪，
          <br />
          为求职者构建完整的长期训练闭环。
        </p>
        <div className="login-brand-deco" aria-hidden="true" />
      </div>

      <div className="login-card-wrap">
        <form className="login-card" onSubmit={handleSubmit}>
          <div className="login-card-accent" aria-hidden="true" />
          <h2 className="login-card-title">创建账号</h2>
          <p className="login-card-subtitle">注册后即可开始你的模拟面试训练</p>

          {error && <p className="login-error">{error}</p>}

          <div className="login-field">
            <label htmlFor="reg-email">邮箱</label>
            <input
              id="reg-email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="login-field">
            <label htmlFor="reg-password">密码（至少 8 位）</label>
            <input
              id="reg-password"
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>

          <button type="submit" className="login-wps-btn" disabled={loading}>
            {loading ? '创建中…' : '创建账号'}
          </button>

          <p className="login-card-note">
            已有账号？ <Link to="/login">登录</Link>
          </p>
        </form>
      </div>
    </div>
  );
}
