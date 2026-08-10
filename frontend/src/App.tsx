import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './auth/AuthContext';
import { ProtectedRoute } from './auth/ProtectedRoute';
import CreateInterviewPage from './pages/CreateInterviewPage';
import InterviewDetailPage from './pages/InterviewDetailPage';
import InterviewListPage from './pages/InterviewListPage';
import InterviewRoomPage from './pages/InterviewRoomPage';
import LoginPage from './pages/LoginPage';
import RegisterPage from './pages/RegisterPage';
import ReportPageStub from './pages/ReportPageStub';

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />
          <Route
            path="/"
            element={
              <ProtectedRoute>
                <InterviewListPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/interviews/new"
            element={
              <ProtectedRoute>
                <CreateInterviewPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/interviews/:id"
            element={
              <ProtectedRoute>
                <InterviewDetailPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/interviews/:id/room"
            element={
              <ProtectedRoute>
                <InterviewRoomPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/interviews/:id/report"
            element={
              <ProtectedRoute>
                <ReportPageStub />
              </ProtectedRoute>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
