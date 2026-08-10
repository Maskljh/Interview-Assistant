import { useAuth } from '../auth/AuthContext';
import './HomePage.css';

export default function HomePage() {
  const { user, logout } = useAuth();

  return (
    <div className="home-page">
      <header className="home-header">
        <span className="home-brand">Interview Assistant</span>
        <button type="button" className="home-logout" onClick={logout}>
          Sign out
        </button>
      </header>
      <main className="home-main">
        <h1>Welcome</h1>
        <p className="home-email">{user?.email}</p>
        <p className="home-placeholder">Interview dashboard coming soon.</p>
      </main>
    </div>
  );
}
