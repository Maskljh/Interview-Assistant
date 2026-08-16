import { fetchJSON } from './client';

export interface Profile {
  weak_dimensions: string[];
  based_on_sessions: number;
}

export async function fetchProfile(): Promise<Profile> {
  return fetchJSON<Profile>('/api/profile');
}
