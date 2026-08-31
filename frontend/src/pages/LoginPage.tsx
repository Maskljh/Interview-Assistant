import { useEffect, useRef, useState } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError, getToken } from '../api/client';
import * as authApi from '../api/auth';
import { useAuth } from '../auth/AuthContext';
import {
  registerMockUser,
  verifyMockCode,
  verifyMockPassword,
} from '../lib/mockData';

type AuthMode =
  | 'login-password'
  | 'login-otp'
  | 'register'
  | 'verify'
  | 'forgot-start'
  | 'forgot-reset';

/**
 * 认证页 —— 按新版设计稿（面知-模拟面试助手-UI设计.html）还原。
 * 支持 6 种形态：账号密码登录 / 验证码登录 / 注册（两步）/ 忘记密码（两步）。
 * 无后端时用本地 mock 校验（演示账号 demo@mianzhi.cn / demo123456，验证码 123456）；
 * 「使用 WPS 账号登录」保留真实 WPS OAuth 授权流程。
 */
export default function LoginPage() {
  const { user, loginWithWPS, loginWithMock } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [mode, setMode] = useState<AuthMode>('login-password');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  // 倒计时（秒），用于验证码按钮
  const [countdown, setCountdown] = useState(0);
  const countdownRef = useRef<number | null>(null);

  // ── 表单值 ──
  const [account, setAccount] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [username, setUsername] = useState('');
  // 忘记密码
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  const oauthCode = searchParams.get('oauth_code');
  const oauthError = searchParams.get('error');

  // WPS 授权回调：带上一次性 oauth_code 即自动登录并进入主页。
  useEffect(() => {
    if (!oauthCode) return;
    let cancelled = false;
    setLoading(true);
    setError('');
    loginWithWPS(oauthCode)
      .then(() => {
        if (!cancelled) navigate('/interviews/new', { replace: true });
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

  useEffect(() => {
    if (oauthError) setError(oauthError);
  }, [oauthError]);

  // 倒计时清理
  useEffect(() => {
    return () => {
      if (countdownRef.current) window.clearInterval(countdownRef.current);
    };
  }, []);

  function startCountdown() {
    setCountdown(60);
    if (countdownRef.current) window.clearInterval(countdownRef.current);
    countdownRef.current = window.setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          if (countdownRef.current) window.clearInterval(countdownRef.current);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  }

  /** mock 登录成功：进入「面试间准备」工作台。 */
  function enterApp(acc: string, name?: string) {
    loginWithMock(acc, name);
    navigate('/interviews/new', { replace: true });
  }

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

  function submitPassword(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (!verifyMockPassword(account, password)) {
      setError('账号或密码错误（演示账号 demo@mianzhi.cn / demo123456）');
      return;
    }
    enterApp(account);
  }

  function submitOtp(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (!verifyMockCode(code)) {
      setError('验证码错误（演示验证码 123456）');
      return;
    }
    enterApp(account);
  }

  function submitRegister(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (password.length < 8) {
      setError('密码至少 8 位，包含字母和数字');
      return;
    }
    // 演示环境：跳过真实发送，直接进入验证码步骤
    setMode('verify');
  }

  function submitVerify(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (!verifyMockCode(code)) {
      setError('验证码错误（演示验证码 123456）');
      return;
    }
    const ok = registerMockUser(account, password);
    if (!ok) {
      setError('该账号已注册，请直接登录');
      return;
    }
    enterApp(account, username);
  }

  function submitForgotStart(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (!verifyMockCode(code)) {
      setError('验证码错误（演示验证码 123456）');
      return;
    }
    setMode('forgot-reset');
  }

  function submitForgotReset(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (newPassword.length < 8) {
      setError('密码至少 8 位，包含字母和数字');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('两次输入的密码不一致');
      return;
    }
    setMode('login-password');
    setPassword('');
    setError('');
  }

  if (getToken() && user) {
    return <Navigate to="/interviews/new" replace />;
  }

  const codeInputs = Array.from({ length: 6 }, (_, i) => (
    <input
      key={i}
      required
      maxLength={1}
      inputMode="numeric"
      aria-label={`验证码第 ${i + 1} 位`}
      value={code[i] ?? ''}
      onChange={(e) => {
        const v = e.target.value.replace(/\D/g, '');
        const next = code.split('');
        next[i] = v;
        setCode(next.join('').slice(0, 6));
        // 自动跳到下一位
        if (v && i < 5) {
          const inputs = e.currentTarget.parentElement?.querySelectorAll('input');
          (inputs?.[i + 1] as HTMLInputElement | undefined)?.focus();
        }
      }}
    />
  ));

  return (
    <div id="design-root">
      <section className="auth-page">
        <button className="auth-exit" onClick={() => navigate('/')}>
          退出
        </button>
        <aside className="brand-panel">
          <b>面知</b>
          <div className="brand-copy">
            <h2>
              把每一场模拟面试，
              <br />
              变成下一次可验证的进步。
            </h2>
            <p>
              从资料准备、动态追问，到复盘与成长追踪，
              <br />
              为求职者构建完整的长期训练闭环。
            </p>
          </div>
          <i />
        </aside>

        <div className="auth-stage">
          <div className="auth-card login-card">
            {mode === 'login-password' && (
              <>
                <h1>欢迎回来</h1>
                <p className="subcopy">登录后继续你的模拟面试训练</p>
                <div className="tabs">
                  <button className="active" onClick={() => setMode('login-password')}>
                    账号密码登录
                  </button>
                  <button onClick={() => setMode('login-otp')}>验证码登录</button>
                </div>
                <form onSubmit={submitPassword}>
                  <label>
                    账号
                    <input
                      required
                      placeholder="请输入手机号或邮箱"
                      value={account}
                      onChange={(e) => setAccount(e.target.value)}
                    />
                  </label>
                  <label>
                    密码
                    <input
                      required
                      type="password"
                      placeholder="请输入密码"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                    />
                  </label>
                  {error && <p className="auth-error">{error}</p>}
                  <button type="button" className="forgot" onClick={() => setMode('forgot-start')}>
                    忘记密码？
                  </button>
                  <button className="primary-button">登录</button>
                </form>
                <div className="other-login">
                  <span>其他登录方式</span>
                </div>
                <button className="wps-button" onClick={() => void handleAuthorize()} disabled={loading}>
                  {loading ? '正在跳转授权…' : '使用 WPS 账号登录'}
                </button>
                <p className="switch-copy">
                  还没有账号？{' '}
                  <button className="link-button" onClick={() => setMode('register')}>
                    立即注册
                  </button>
                </p>
              </>
            )}

            {mode === 'login-otp' && (
              <>
                <h1>欢迎回来</h1>
                <p className="subcopy">登录后继续你的模拟面试训练</p>
                <div className="tabs">
                  <button onClick={() => setMode('login-password')}>账号密码登录</button>
                  <button className="active" onClick={() => setMode('login-otp')}>
                    验证码登录
                  </button>
                </div>
                <form onSubmit={submitOtp}>
                  <label>
                    账号
                    <input
                      required
                      placeholder="请输入手机号或邮箱"
                      value={account}
                      onChange={(e) => setAccount(e.target.value)}
                    />
                  </label>
                  <label>
                    验证码
                    <button
                      type="button"
                      className={`field-action ${countdown > 0 ? 'counting' : ''}`}
                      disabled={countdown > 0}
                      onClick={startCountdown}
                    >
                      {countdown > 0 ? `${countdown}s 后重新获取` : '获取验证码'}
                    </button>
                    <input
                      required
                      inputMode="numeric"
                      placeholder="请输入验证码"
                      value={code}
                      onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                    />
                  </label>
                  {error && <p className="auth-error">{error}</p>}
                  <button type="button" className="forgot forgot-placeholder" tabIndex={-1} aria-hidden="true">
                    忘记密码？
                  </button>
                  <button className="primary-button">登录</button>
                </form>
                <div className="other-login">
                  <span>其他登录方式</span>
                </div>
                <button className="wps-button" onClick={() => void handleAuthorize()} disabled={loading}>
                  {loading ? '正在跳转授权…' : '使用 WPS 账号登录'}
                </button>
                <p className="switch-copy">
                  还没有账号？{' '}
                  <button className="link-button" onClick={() => setMode('register')}>
                    立即注册
                  </button>
                </p>
              </>
            )}

            {mode === 'register' && (
              <>
                <h1>创建账号</h1>
                <p className="subcopy">填写基本信息，开启你的面试训练</p>
                <div className="step-label">
                  <span>1　设置基本信息</span>
                  <span>2　验证账号</span>
                </div>
                <div className="progress">
                  <i />
                </div>
                <form onSubmit={submitRegister}>
                  <label>
                    用户名
                    <input
                      required
                      placeholder="请输入用户名，后续可在设置中修改"
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                    />
                  </label>
                  <label>
                    账号
                    <input
                      required
                      placeholder="请输入手机号或邮箱"
                      value={account}
                      onChange={(e) => setAccount(e.target.value)}
                    />
                  </label>
                  <label>
                    设置密码
                    <input
                      required
                      type="password"
                      placeholder="至少 8 位，包含字母和数字"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                    />
                  </label>
                  {error && <p className="auth-error">{error}</p>}
                  <button className="primary-button">下一步</button>
                </form>
                <p className="switch-copy">
                  已有账号？{' '}
                  <button className="link-button" onClick={() => setMode('login-password')}>
                    去登录
                  </button>
                </p>
              </>
            )}

            {mode === 'verify' && (
              <>
                <h1>输入验证码</h1>
                <p className="subcopy">验证码已发送至 {account || 'xxxxxx'}，5分钟内有效</p>
                <div className="step-label active-step">
                  <span>1　基本信息</span>
                  <span>2　验证手机号</span>
                </div>
                <div className="progress complete">
                  <i />
                </div>
                <form onSubmit={submitVerify}>
                  <label className="verification-label">输入 6 位验证码</label>
                  <div className="code-inputs">{codeInputs}</div>
                  {error && <p className="auth-error">{error}</p>}
                  <p className="resend">
                    未收到验证码？　<span>{countdown > 0 ? `${countdown} 秒后重新发送` : '重新发送'}</span>
                  </p>
                  <button className="primary-button">完成注册</button>
                </form>
                <p className="switch-copy">
                  <button className="link-button" onClick={() => setMode('register')}>
                    返回
                  </button>
                </p>
              </>
            )}

            {mode === 'forgot-start' && (
              <>
                <h1>重置密码</h1>
                <p className="subcopy">验证账号后，为你的账号设置新密码</p>
                <div className="step-label">
                  <span>1　验证身份</span>
                  <span>2　设置新密码</span>
                </div>
                <div className="progress">
                  <i />
                </div>
                <form onSubmit={submitForgotStart}>
                  <label>
                    账号
                    <input
                      required
                      placeholder="请输入注册时的手机号或邮箱"
                      value={account}
                      onChange={(e) => setAccount(e.target.value)}
                    />
                  </label>
                  <label>
                    验证码
                    <button
                      type="button"
                      className={`field-action ${countdown > 0 ? 'counting' : ''}`}
                      disabled={countdown > 0}
                      onClick={startCountdown}
                    >
                      {countdown > 0 ? `${countdown}s 后重新获取` : '获取验证码'}
                    </button>
                    <input
                      required
                      inputMode="numeric"
                      placeholder="请输入 6 位验证码"
                      value={code}
                      onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                    />
                  </label>
                  {error && <p className="auth-error">{error}</p>}
                  <button className="primary-button">确认</button>
                </form>
                <p className="switch-copy">
                  <button className="link-button muted-link" onClick={() => setMode('login-password')}>
                    返回
                  </button>
                </p>
              </>
            )}

            {mode === 'forgot-reset' && (
              <>
                <h1>重置密码</h1>
                <p className="subcopy">验证账号后，为你的账号设置新密码</p>
                <div className="step-label active-step">
                  <span>1　验证身份</span>
                  <span>2　设置新密码</span>
                </div>
                <div className="progress complete">
                  <i />
                </div>
                <form onSubmit={submitForgotReset}>
                  <label>
                    重置密码
                    <input
                      required
                      type="password"
                      placeholder="至少 8 位，包含字母和数字"
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                    />
                  </label>
                  <label>
                    确认密码
                    <input
                      required
                      type="password"
                      placeholder="请再次输入新密码"
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                    />
                  </label>
                  {error && <p className="auth-error">{error}</p>}
                  <button className="primary-button">确认重置密码</button>
                </form>
                <p className="switch-copy">
                  <button className="link-button muted-link" onClick={() => setMode('login-password')}>
                    返回
                  </button>
                </p>
              </>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
