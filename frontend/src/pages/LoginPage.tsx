import { useEffect, useState } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError, getToken } from '../api/client';
import * as authApi from '../api/auth';
import { useAuth } from '../auth/AuthContext';
import './LoginPage.css';

/**
 * 独立登录页 —— 按 Figma「00 独立登录页」还原。
 * 登录唯一方式为 WPS OAuth：点击授权按钮跳转 WPS 授权页，
 * 授权回调由后端处理，完成后带回一次性 oauth_code，前端凭它换取 token。
 */
export default function LoginPage() {
  const { user, loginWithWPS } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const oauthCode = searchParams.get('oauth_code');
  const oauthError = searchParams.get('error');

  // 处理 WPS 授权回调：带上一次性 oauth_code 即自动登录并进入主页。
  useEffect(() => {
    if (!oauthCode) return;
    let cancelled = false;
    setLoading(true);
    setError('');
    loginWithWPS(oauthCode)
      .then(() => {
        if (!cancelled) navigate('/', { replace: true });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof ApiError ? err.message : '登录失败，请重试');
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [oauthCode, loginWithWPS, navigate]);

  // 授权失败（如拒绝授权/state 校验失败）由后端带 error 参数跳回。
  useEffect(() => {
    if (oauthError) setError(oauthError);
  }, [oauthError]);

  async function handleAuthorize() {
    setError('');
    setLoading(true);
    try {
      const { url } = await authApi.authorizeWPS();
      window.location.href = url;
    } catch (err) {
      setLoading(false);
      setError(err instanceof ApiError ? err.message : '获取授权地址失败，请重试');
    }
  }

  if (getToken() && user) {
    return <Navigate to="/" replace />;
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
        <form
          className="login-card"
          onSubmit={(e) => {
            e.preventDefault();
            void handleAuthorize();
          }}
        >
          <div className="login-card-accent" aria-hidden="true" />
          <h2 className="login-card-title">使用 WPS 账号登录</h2>
          <p className="login-card-subtitle">授权后即可继续你的模拟面试训练</p>

          {error && <p className="login-error">{error}</p>}

          <button type="submit" className="login-wps-btn" disabled={loading}>
            {loading ? '正在跳转授权…' : '使用 WPS 账号授权登录'}
          </button>

          <p className="login-card-note">授权仅用于关联你的资料、训练记录与云文档</p>
        </form>
      </div>
    </div>
  );
}
