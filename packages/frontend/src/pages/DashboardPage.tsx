import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getResults, ResultsResponse } from '../services/api';
import { useAuth } from '../contexts/AuthContext';
import OrgSummaryCard from '../components/OrgSummaryCard';
import HostTable from '../components/HostTable';
import RunTriggerButton from '../components/RunTriggerButton';

export default function DashboardPage() {
  const { token, userEmail, logout } = useAuth();
  const navigate = useNavigate();
  const [results, setResults] = useState<ResultsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [noResults, setNoResults] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    getResults(token)
      .then(setResults)
      .catch(err => {
        if (err.status === 404) setNoResults(true);
      })
      .finally(() => setLoading(false));
  }, [token]);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 5000);
  };

  const handleRunStarted = (runId: string) => navigate(`/run/${runId}`);

  const handleAlreadyRunning = (runId: string) => {
    showToast(`Analysis already running. `);
    setTimeout(() => navigate(`/run/${runId}`), 1500);
  };

  return (
    <div style={{ minHeight: '100vh', background: '#f8fafc' }}>
      {/* Header */}
      <header style={{
        background: 'white', borderBottom: '1px solid #e2e8f0',
        padding: '0 24px', height: 56, display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 20 }}>📊</span>
          <span style={{ fontWeight: 700, fontSize: 16, color: '#1e293b' }}>PDI FinOps Intelligence</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <span style={{ fontSize: 13, color: '#64748b' }}>{userEmail}</span>
          <button onClick={logout} style={{ background: 'none', border: '1px solid #e2e8f0', borderRadius: 6, padding: '4px 12px', fontSize: 13, cursor: 'pointer', color: '#64748b' }}>
            Sign out
          </button>
        </div>
      </header>

      {/* Toast */}
      {toast && (
        <div style={{
          position: 'fixed', top: 16, right: 16, background: '#1e293b', color: 'white',
          padding: '12px 20px', borderRadius: 8, fontSize: 14, zIndex: 1000,
          boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
        }}>
          {toast}
        </div>
      )}

      <main style={{ maxWidth: 1400, margin: '0 auto', padding: '32px 24px' }}>
        {/* Page header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
          <div>
            <h1 style={{ fontSize: 28, fontWeight: 700, color: '#1e293b', marginBottom: 4 }}>
              Infrastructure Analysis
            </h1>
            {results && (
              <p style={{ fontSize: 13, color: '#94a3b8' }}>
                Last run: {new Date(results.completed_at).toLocaleString()} · {results.trigger_type}
              </p>
            )}
          </div>
          <RunTriggerButton onRunStarted={handleRunStarted} onAlreadyRunning={handleAlreadyRunning} />
        </div>

        {loading && (
          <div style={{ textAlign: 'center', padding: 64, color: '#64748b' }}>
            Loading analysis results...
          </div>
        )}

        {!loading && noResults && (
          <div style={{
            textAlign: 'center', padding: 64, background: 'white', borderRadius: 12,
            boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
          }}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>📭</div>
            <h2 style={{ fontSize: 20, fontWeight: 600, color: '#1e293b', marginBottom: 8 }}>
              No analysis run yet
            </h2>
            <p style={{ color: '#64748b', marginBottom: 24 }}>
              Run your first infrastructure analysis to see cost optimization recommendations.
            </p>
            <RunTriggerButton onRunStarted={handleRunStarted} onAlreadyRunning={handleAlreadyRunning} />
          </div>
        )}

        {!loading && results && (
          <>
            {/* Org Summary Cards */}
            <div style={{ display: 'flex', gap: 16, marginBottom: 32, flexWrap: 'wrap' }}>
              {results.org_summaries.map(summary => (
                <OrgSummaryCard key={summary.tenant_id} summary={summary} />
              ))}
            </div>

            {/* Host Table */}
            <div style={{ background: 'white', borderRadius: 12, padding: 24, boxShadow: '0 1px 3px rgba(0,0,0,0.1)' }}>
              <h2 style={{ fontSize: 18, fontWeight: 700, color: '#1e293b', marginBottom: 16 }}>
                Host Details
                <span style={{ fontSize: 13, fontWeight: 400, color: '#94a3b8', marginLeft: 8 }}>
                  {results.host_results.length} hosts
                </span>
              </h2>
              <HostTable hosts={results.host_results} />
            </div>
          </>
        )}
      </main>
    </div>
  );
}
