import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './auth/AuthContext';
import { ProtectedRoute } from './auth/ProtectedRoute';
import CreateInterviewPage from './pages/CreateInterviewPage';
import NotFoundPage from './pages/NotFoundPage';
import InterviewDetailPage from './pages/InterviewDetailPage';
import InterviewListPage from './pages/InterviewListPage';
import InterviewRoomPage from './pages/InterviewRoomPage';
import LoginPage from './pages/LoginPage';
import QuestionBankPage from './pages/QuestionBankPage';
import ReportPage from './pages/ReportPage';
import TrendsPage from './pages/TrendsPage';
import WelcomePage from './pages/WelcomePage';

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/" element={<WelcomePage />} />
          <Route
            path="/history"
            element={
              <ProtectedRoute>
                <InterviewListPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/questions"
            element={
              <ProtectedRoute>
                <QuestionBankPage />
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
                <ReportPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/trends"
            element={
              <ProtectedRoute>
                <TrendsPage />
              </ProtectedRoute>
            }
          />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
