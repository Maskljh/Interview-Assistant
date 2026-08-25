import { type FormEvent, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { ApiError, getToken } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import './LoginPage.css';

/**
 * 独立登录页 —— 按 Figma「00 独立登录页」还原。
 * 左侧深蓝品牌区 + 右侧暖白登录卡。
 * 当前走真实登录接口；为便于本地演示，表单默认填充测试账号
 * （ocr-e2e-test@example.com / test123456）。
 */
export default function LoginPage() {
  const { login, user } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('ocr-e2e-test@example.com');
  const [password, setPassword] = useState('test123456');
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
      await login(email, password);
      navigate('/', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '登录失败');
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
          <h2 className="login-card-title">使用 WPS 账号登录</h2>
          <p className="login-card-subtitle">授权后即可继续你的模拟面试训练</p>

          {error && <p className="login-error">{error}</p>}

          <div className="login-field">
            <label htmlFor="login-email">邮箱</label>
            <input
              id="login-email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="login-field">
            <label htmlFor="login-password">密码</label>
            <input
              id="login-password"
              type="password"
              autoComplete="current-password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>

          <button type="submit" className="login-wps-btn" disabled={loading}>
            {loading ? '登录中…' : '使用 WPS 账号授权登录'}
          </button>

          <p className="login-card-note">授权仅用于关联你的资料、训练记录与云文档</p>
        </form>
      </div>
    </div>
  );
}
