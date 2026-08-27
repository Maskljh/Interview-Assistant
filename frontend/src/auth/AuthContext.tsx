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
  nickname?: string;
  avatar_url?: string;
  user_id?: string; // WPS 账号全局数字 ID
}

interface AuthContextValue {
  user: User | null;
  logout: () => void;
  /** 用 WPS 回调带回的一次性 oauth_code 完成登录。 */
  loginWithWPS: (code: string) => Promise<void>;
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

  const loginWithWPS = useCallback(async (code: string) => {
    const data = await authApi.exchangeWPS(code);
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

  const value = useMemo(
    () => ({ user, logout, loginWithWPS, refreshUser }),
    [user, logout, loginWithWPS, refreshUser],
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
