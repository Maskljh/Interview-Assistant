import { Navigate } from 'react-router-dom';
import { getToken } from '../api/client';
import { useAuth } from './AuthContext';

export function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const token = getToken();

  if (!token || !user) {
    return <Navigate to="/login" replace />;
  }

  return children;
}
