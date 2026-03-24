import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { abortRun, ConflictInfo, getResults, ResultsResponse } from '../services/api';
import { useAuth } from '../contexts/AuthContext';
import OrgSummaryCard from '../components/OrgSummaryCard';
import HostTable from '../components/HostTable';
import RunTriggerButton from '../components/RunTriggerButton';
import ActiveRunBanner from '../components/ActiveRunBanner';

export default function DashboardPage() {
  const { token, userEmail, logout } = useAuth();
  const navigate = useNavigate();
  const [results, setResults] = useState<ResultsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [noResults, setNoResults] = useState(false);
  const [tenantFilter, setTenantFilter] = useState<string>('');
  const [conflict, setConflict] = useState<ConflictInfo | null>(null);
  const [abortingConflict, setAbortingConflict] = useState(false);
  const [showConflictAbortModal, setShowConflictAbortModal] = useState(false);

  const fetchResults = useCallback(() => {
    if (!token) return;
    setLoading(true);
    getResults(token)
      .then(data => {
        setResults(data);
        setNoResults(false);
      })
      .catch(err => {
        if (err.status === 404) setNoResults(true);
      })
      .finally(() => setLoading(false));
  }, [token]);

  useEffect(() => {
    fetchResults();
  }, [fetchResults]);

  const handleRunStarted = (runId: string) => navigate(`/run/${runId}`);

  const handleAlreadyRunning = (conflictInfo: ConflictInfo) => {
    setConflict(conflictInfo);
  };

  const handleRunCompleted = () => {
    setConflict(null);
    fetchResults();
  };

  const handleAbortConflict = async () => {
    if (!token || !conflict) return;
    setAbortingConflict(true);
    try {
      await abortRun(token, conflict.run_id);
      setConflict(null);
      setShowConflictAbortModal(false);
      fetchResults();
    } catch (err) {
      console.error('Abort failed:', err);
    } finally {
      setAbortingConflict(false);
    }
  };

  const formatStartedAt = (iso: string) =>
    new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  // Derive filtered results client-side — no extra API call needed
  const allTenants = results ? results.org_summaries.map(o => o.tenant_id) : [];
  const filteredResults = results && tenantFilter
    ? {
        ...results,
        org_summaries: results.org_summaries.filter(o => o.tenant_id === tenantFilter),
        host_results: results.host_results.filter(h => h.tenant_id === tenantFilter),
      }
    : results;

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

      <main style={{ maxWidth: 1400, margin: '0 auto', padding: '32px 24px' }}>
        {/* Active Run Banner — polls independently, visible to all users */}
        <ActiveRunBanner onRunCompleted={handleRunCompleted} />

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
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
            {allTenants.length > 1 && (
              <select
                value={tenantFilter}
                onChange={e => setTenantFilter(e.target.value)}
                style={{
                  padding: '7px 12px', border: '1px solid #e2e8f0', borderRadius: 6,
                  fontSize: 13, color: '#1e293b', background: 'white', cursor: 'pointer',
                }}
              >
                <option value=''>All orgs</option>
                {allTenants.map(tid => (
                  <option key={tid} value={tid}>{tid}</option>
                ))}
              </select>
            )}
            <div>
            <RunTriggerButton onRunStarted={handleRunStarted} onAlreadyRunning={handleAlreadyRunning} />

            {/* Inline conflict message when 409 returned */}
            {conflict && (
              <div style={{
                marginTop: 10, padding: '12px 14px', background: '#fffbeb',
                border: '1px solid #fcd34d', borderRadius: 8, maxWidth: 340,
              }}>
                <p style={{ fontSize: 13, color: '#92400e', marginBottom: 8, lineHeight: 1.5 }}>
                  A run is already in progress, started by{' '}
                  <strong>{conflict.triggered_by}</strong> at {formatStartedAt(conflict.started_at)}
                  {conflict.hosts_total > 0 && ` · ${conflict.progress_pct}% complete`}.
                </p>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    onClick={() => navigate(`/run/${conflict.run_id}`)}
                    style={{
                      fontSize: 12, padding: '4px 10px', background: '#0066cc', color: 'white',
                      border: 'none', borderRadius: 5, cursor: 'pointer', fontWeight: 500,
                    }}
                  >
                    View Progress
                  </button>
                  <button
                    onClick={() => setShowConflictAbortModal(true)}
                    style={{
                      fontSize: 12, padding: '4px 10px', background: '#fee2e2', color: '#dc2626',
                      border: '1px solid #fca5a5', borderRadius: 5, cursor: 'pointer', fontWeight: 500,
                    }}
                  >
                    Abort run
                  </button>
                  <button
                    onClick={() => setConflict(null)}
                    style={{
                      fontSize: 12, padding: '4px 10px', background: 'none', color: '#94a3b8',
                      border: '1px solid #e2e8f0', borderRadius: 5, cursor: 'pointer',
                    }}
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            )}
            </div>
          </div>
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

        {!loading && filteredResults && (
          <>
            {/* Org Summary Cards */}
            <div style={{ display: 'flex', gap: 16, marginBottom: 32, flexWrap: 'wrap' }}>
              {filteredResults.org_summaries.map(summary => (
                <OrgSummaryCard key={summary.tenant_id} summary={summary} />
              ))}
            </div>

            {/* Host Table */}
            <div style={{ background: 'white', borderRadius: 12, padding: 24, boxShadow: '0 1px 3px rgba(0,0,0,0.1)' }}>
              <h2 style={{ fontSize: 18, fontWeight: 700, color: '#1e293b', marginBottom: 16 }}>
                Host Details
                <span style={{ fontSize: 13, fontWeight: 400, color: '#94a3b8', marginLeft: 8 }}>
                  {filteredResults.host_results.length} hosts
                </span>
              </h2>
              <HostTable hosts={filteredResults.host_results} />
            </div>
          </>
        )}
      </main>

      {/* Conflict Abort Confirmation Modal */}
      {showConflictAbortModal && conflict && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          zIndex: 2000,
        }}>
          <div style={{
            background: 'white', borderRadius: 12, padding: 28, maxWidth: 420, width: '90%',
            boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
          }}>
            <div style={{ fontSize: 24, marginBottom: 12 }}>⚠️</div>
            <h3 style={{ fontSize: 18, fontWeight: 700, color: '#1e293b', marginBottom: 8 }}>
              Abort this run?
            </h3>
            <p style={{ fontSize: 14, color: '#64748b', marginBottom: 6, lineHeight: 1.5 }}>
              This will stop the analysis run started by{' '}
              <strong style={{ color: '#1e293b' }}>{conflict.triggered_by}</strong>.
            </p>
            <p style={{ fontSize: 14, color: '#64748b', marginBottom: 24, lineHeight: 1.5 }}>
              The last completed report will remain visible on the dashboard.
            </p>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button
                onClick={() => setShowConflictAbortModal(false)}
                disabled={abortingConflict}
                style={{
                  padding: '8px 18px', background: '#f1f5f9', color: '#475569',
                  border: '1px solid #e2e8f0', borderRadius: 6, fontSize: 14,
                  fontWeight: 500, cursor: 'pointer',
                }}
              >
                Cancel
              </button>
              <button
                onClick={handleAbortConflict}
                disabled={abortingConflict}
                style={{
                  padding: '8px 18px', background: '#dc2626', color: 'white',
                  border: 'none', borderRadius: 6, fontSize: 14,
                  fontWeight: 600, cursor: abortingConflict ? 'not-allowed' : 'pointer',
                  opacity: abortingConflict ? 0.7 : 1,
                }}
              >
                {abortingConflict ? 'Aborting...' : 'Yes, abort run'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
