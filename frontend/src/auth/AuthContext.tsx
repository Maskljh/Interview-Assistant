import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import * as authApi from '../api/auth';
import { getToken, setToken } from '../api/client';

const USER_KEY = 'auth_user';

export interface User {
  id: number;
  email: string;
  username?: string;
}

interface AuthContextValue {
  user: User | null;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string) => Promise<void>;
  logout: () => void;
  /** 模拟登录：不请求后端，直接以访客身份进入主页（UI 还原阶段使用）。 */
  loginAsGuest: () => void;
  /** 从后端刷新当前用户资料（用户名等）并更新本地存储。 */
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function readStoredUser(): User | null {
  if (!getToken()) return null;
  const raw = localStorage.getItem(USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as User;
  } catch {
    return null;
  }
}

function storeUser(user: User | null): void {
  if (user) {
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  } else {
    localStorage.removeItem(USER_KEY);
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(() => readStoredUser());

  const login = useCallback(async (email: string, password: string) => {
    const data = await authApi.login(email, password);
    setUser(data.user);
    storeUser(data.user);
  }, []);

  const register = useCallback(async (email: string, password: string) => {
    const data = await authApi.register(email, password);
    setUser(data.user);
    storeUser(data.user);
  }, []);

  const logout = useCallback(() => {
    setToken(null);
    storeUser(null);
    setUser(null);
  }, []);

  const refreshUser = useCallback(async () => {
    const fresh = await authApi.getMe();
    setUser((prev) => {
      const next = { ...(prev ?? { id: fresh.id, email: fresh.email }), ...fresh };
      storeUser(next);
      return next;
    });
  }, []);

  const loginAsGuest = useCallback(() => {
    setToken('guest-session');
    storeUser({ id: 0, email: 'guest' });
    setUser({ id: 0, email: 'guest' });
  }, []);

  const value = useMemo(
    () => ({ user, login, register, logout, loginAsGuest, refreshUser }),
    [user, login, register, logout, loginAsGuest, refreshUser],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return ctx;
}
