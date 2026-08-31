const TOKEN_KEY = 'auth_token';
const USER_KEY = 'auth_user';

// 应用登录失效（401）时派发的事件：由 AuthProvider 监听并做路由级跳转，避免整页刷新。
export const AUTH_UNAUTHORIZED_EVENT = 'app:unauthorized';

// 后端 API 地址解析：显式设置 VITE_API_BASE 时优先，否则跟随当前页面的 hostname
const API_BASE = import.meta.env.VITE_API_BASE
  ? import.meta.env.VITE_API_BASE
  : `${window.location.protocol}//${window.location.hostname}:18080`;

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
  rawMessage: string;

  constructor(status: number, message: string, rawMessage?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.rawMessage = rawMessage ?? message;
  }
}

const MESSAGE_MAP: Record<string, string> = {
  'invalid email': '邮箱格式不正确',
  'question generation failed': '题目生成失败，请检查服务器 AI 配置后重试',
  'session has no questions': '该场面试暂无题目可存入题库',
  'not found': '未找到相关内容',
  'report not available': '报告尚未生成',
  'wps 账号未授权或登录已过期，请重新登录': 'WPS 账号未授权或已过期，请重新登录授权',
  'speech service unavailable': '语音服务暂不可用',
};

const STATUS_MESSAGES: Record<number, string> = {
  401: '登录已过期，请重新登录',
  403: '没有权限执行此操作',
  404: '未找到相关内容',
  429: '操作过于频繁，请稍后再试',
  500: '服务器开小差了，请稍后重试',
  502: '服务器开小差了，请稍后重试',
  503: '服务器开小差了，请稍后重试',
  0: '网络异常或请求超时，请检查连接后重试',
};

export function toUserMessage(status: number, raw: string): string {
  const key = raw.trim().toLowerCase();
  if (MESSAGE_MAP[key]) return MESSAGE_MAP[key];
  if (STATUS_MESSAGES[status]) return STATUS_MESSAGES[status];
  return raw;
}

function parseBody(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

export type FetchJSONOptions = RequestInit & {
  /** 401 时不跳转登录页（登录流程等场景）。 */
  skipAuthRedirect?: boolean;
  /** 401 时既不清理登录态也不跳转（如 WPS 子授权失效，不应把用户整体登出）。 */
  skipAuthClear?: boolean;
};

export async function fetchJSON<T>(
  path: string,
  opts: FetchJSONOptions = {},
): Promise<T> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), 20000);

  const { skipAuthRedirect, skipAuthClear, ...fetchOpts } = opts;
  const headers = new Headers(fetchOpts.headers);
  // FormData 由 fetch 自动生成 multipart Content-Type（含 boundary），
  // 不能覆盖为 JSON；否则后端解析不到 multipart 文件。
  const isFormData = typeof FormData !== 'undefined' && opts.body instanceof FormData;
  if (!headers.has('Content-Type') && opts.body && !isFormData) {
    headers.set('Content-Type', 'application/json');
  }

  const token = getToken();
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...fetchOpts,
      headers,
      signal: controller.signal,
    });
  } catch (err) {
    if (err && (err as Error).name === 'AbortError') {
      throw new ApiError(0, '请求超时，请检查网络后重试', 'request timeout');
    }
    throw new ApiError(0, '网络异常或请求超时，请检查连接后重试', String(err));
  } finally {
    window.clearTimeout(timeoutId);
  }

  if (res.status === 401) {
    const data = parseBody(await res.text());
    const rawMessage =
      data && typeof data === 'object' && 'error' in data
        ? String((data as { error: unknown }).error)
        : 'Unauthorized';
    // 子授权类 401（如 WPS 授权失效）：应用登录仍有效，不清理登录态、不跳登录页。
    if (!skipAuthClear) {
      // mock 演示模式（token 以 mock-token- 开头）：后端无此账号，401 属预期，
      // 不清登录态也不登出，交由页面捕获后回退到本地 mock 数据。
      const isMockToken = token != null && token.startsWith('mock-token-');
      if (!isMockToken) {
        setToken(null);
        localStorage.removeItem(USER_KEY);
        if (
          !skipAuthRedirect &&
          !window.location.pathname.startsWith('/login')
        ) {
          // 路由级跳转（SPA）而非整页刷新：保留应用现场，避免闪白与状态丢失。
          window.dispatchEvent(new CustomEvent(AUTH_UNAUTHORIZED_EVENT));
        }
      }
    }
    throw new ApiError(401, toUserMessage(401, rawMessage), rawMessage);
  }

  const text = await res.text();
  const data = parseBody(text);

  if (!res.ok) {
    const rawMessage =
      data && typeof data === 'object' && 'error' in data
        ? String((data as { error: unknown }).error)
        : res.statusText || 'Request failed';
    console.warn('[api]', res.status, rawMessage);
    throw new ApiError(res.status, toUserMessage(res.status, rawMessage), rawMessage);
  }

  return data as T;
}
