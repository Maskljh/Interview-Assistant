import { fetchJSON, setToken } from './client';

export interface User {
  id: number;
  email: string;
  username?: string;
  nickname?: string;
  avatar_url?: string;
  user_id?: string; // WPS 账号全局数字 ID
}

export interface AuthResponse {
  token: string;
  user: User;
}

export interface WPSAuthorizeResponse {
  url: string;
}

/**
 * 获取 WPS 授权页地址（后端生成 CSRF state 后返回），前端整页跳转。
 */
export async function authorizeWPS(): Promise<WPSAuthorizeResponse> {
  return fetchJSON<WPSAuthorizeResponse>('/api/auth/wps/authorize', {
    method: 'GET',
    skipAuthRedirect: true,
  });
}

/**
 * 用 WPS 回调带回的一次性 oauth_code 换取应用 token 与用户信息。
 */
export async function exchangeWPS(code: string): Promise<AuthResponse> {
  const data = await fetchJSON<AuthResponse>('/api/auth/wps/exchange', {
    method: 'POST',
    body: JSON.stringify({ code }),
    skipAuthRedirect: true,
  });
  setToken(data.token);
  return data;
}

/** 拉取当前登录用户资料（用户名等），用于刷新侧边栏/弹窗。 */
export async function getMe(): Promise<User> {
  return fetchJSON<User>('/api/auth/me');
}
