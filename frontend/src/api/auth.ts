import { fetchJSON, setToken } from './client';

export interface User {
  id: number;
  email: string;
}

export interface AuthResponse {
  token: string;
  user: User;
}

export async function login(email: string, password: string): Promise<AuthResponse> {
  const data = await fetchJSON<AuthResponse>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
    skipAuthRedirect: true,
  });
  setToken(data.token);
  return data;
}

export async function register(email: string, password: string): Promise<AuthResponse> {
  const data = await fetchJSON<AuthResponse>('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
    skipAuthRedirect: true,
  });
  setToken(data.token);
  return data;
}
