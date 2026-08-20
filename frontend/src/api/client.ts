const TOKEN_KEY = 'auth_token';
const USER_KEY = 'auth_user';

// 后端 API 地址解析：
// 1. 显式设置 VITE_API_BASE 时优先（打包 APK 时注入电脑局域网 IP）
// 2. Capacitor 原生 App 内：window.location.hostname 是 localhost（手机自己），
//    必须用注入的地址，否则回退到当前 hostname
// 3. 浏览器环境：跟随当前页面的 hostname（桌面 localhost、手机经局域网访问时自动用局域网 IP）
import { Capacitor } from '@capacitor/core';

const isNative = Capacitor.isNativePlatform();
const API_BASE = import.meta.env.VITE_API_BASE
  ? import.meta.env.VITE_API_BASE
  : isNative
    ? 'http://10.213.211.101:9090' // App 内默认指向开发机局域网 IP（打包时按需改）
    : `${window.location.protocol}//${window.location.hostname}:9090`;

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
  'invalid credentials': '邮箱或密码错误',
  'email already registered': '该邮箱已注册',
  'invalid email': '邮箱格式不正确',
  'password must be at least 8 characters': '密码至少需要 8 位',
  'question generation failed': '题目生成失败，请检查服务器 AI 配置后重试',
  'not found': '未找到相关内容',
  'report not available': '报告尚未生成',
  'speech service unavailable': '语音服务暂不可用',
  'digital human service unavailable': '数字人服务暂不可用',
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
  skipAuthRedirect?: boolean;
};

export async function fetchJSON<T>(
  path: string,
  opts: FetchJSONOptions = {},
): Promise<T> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), 20000);

  const { skipAuthRedirect, ...fetchOpts } = opts;
  const headers = new Headers(fetchOpts.headers);
  if (!headers.has('Content-Type') && opts.body) {
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
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new ApiError(0, '请求超时，请检查网络后重试', 'request timeout');
    }
    throw new ApiError(0, '网络异常或请求超时，请检查连接后重试', String(err));
  } finally {
    window.clearTimeout(timeoutId);
  }

  if (res.status === 401) {
    setToken(null);
    localStorage.removeItem(USER_KEY);
    const data = parseBody(await res.text());
    const rawMessage =
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
