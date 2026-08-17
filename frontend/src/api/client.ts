const TOKEN_KEY = 'auth_token';
const USER_KEY = 'auth_user';
// 默认 API 地址跟随当前页面的 hostname：桌面访问 localhost 时连本机，
// 手机通过局域网访问（如 http://10.213.211.101:5174）时自动连电脑的局域网 IP。
// 显式设置 VITE_API_BASE 时优先。
const API_BASE =
  import.meta.env.VITE_API_BASE ??
  `${window.location.protocol}//${window.location.hostname}:8080`;

export function getApiBase(): string {
  return API_BASE;
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null): void {
  if (token) {
    localStorage.setItem(TOKEN_KEY, token);
  } else {
    localStorage.removeItem(TOKEN_KEY);
  }
}

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export type FetchJSONOptions = RequestInit & {
  skipAuthRedirect?: boolean;
};

export async function fetchJSON<T>(
  path: string,
  opts: FetchJSONOptions = {},
): Promise<T> {
  const { skipAuthRedirect, ...fetchOpts } = opts;
  const headers = new Headers(fetchOpts.headers);
  if (!headers.has('Content-Type') && opts.body) {
    headers.set('Content-Type', 'application/json');
  }

  const token = getToken();
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  const res = await fetch(`${API_BASE}${path}`, { ...fetchOpts, headers });

  if (res.status === 401) {
    setToken(null);
    localStorage.removeItem(USER_KEY);
    const text = await res.text();
    const data = text ? (JSON.parse(text) as unknown) : null;
    const message =
      data && typeof data === 'object' && 'error' in data
        ? String((data as { error: unknown }).error)
        : 'Unauthorized';
    if (
      !skipAuthRedirect &&
      !window.location.pathname.startsWith('/login') &&
      !window.location.pathname.startsWith('/register')
    ) {
      window.location.href = '/login';
    }
    throw new ApiError(401, message);
  }

  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : null;

  if (!res.ok) {
    const message =
      data && typeof data === 'object' && 'error' in data
        ? String((data as { error: unknown }).error)
        : res.statusText || 'Request failed';
    throw new ApiError(res.status, message);
  }

  return data as T;
}
