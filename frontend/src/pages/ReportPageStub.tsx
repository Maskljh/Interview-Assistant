import { Link, useParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import './InterviewPages.css';

export default function ReportPageStub() {
  const { logout } = useAuth();
  const { id } = useParams<{ id: string }>();

  return (
    <div className="interview-page">
      <header className="interview-header">
        <Link className="interview-brand" to="/">
          Interview Assistant
        </Link>
        <div className="interview-header-actions">
          <Link className="interview-header-link" to={`/interviews/${id}`}>
            Detail
          </Link>
          <button type="button" className="interview-header-link" onClick={logout}>
            Sign out
          </button>
        </div>
      </header>
      <main className="interview-main">
        <h1>Report</h1>
        <div className="interview-stub">
          <p>Report page for interview #{id} coming in Task 11.</p>
          <Link className="interview-header-link" to="/">
            Back to list
          </Link>
        </div>
      </main>
    </div>
  );
}
