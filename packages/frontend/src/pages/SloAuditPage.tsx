import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import {
  abortSloRun,
  getActiveSloRun,
  getSloResults,
  triggerSloRun,
  SloConflictInfo,
  SloResultsResponse,
  SloActiveRunInfo,
} from '../services/slo-api';
import { useAuth } from '../contexts/AuthContext';
import SloOrgCard from '../components/SloOrgCard';
import SloTable from '../components/SloTable';
import SloGapAnalysis from '../components/SloGapAnalysis';
import SloTrendsView from '../components/SloTrendsView';

type TabKey = 'details' | 'gap_analysis' | 'trends';

function formatElapsed(startedAt: string): string {
  const ms = Date.now() - new Date(startedAt).getTime();
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return '<1m';
}

export default function SloAuditPage() {
  const { token, userEmail, logout } = useAuth();
  const navigate = useNavigate();
  const [results, setResults] = useState<SloResultsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [noResults, setNoResults] = useState(false);
  const [tenantFilter, setTenantFilter] = useState('');
  const [activeTab, setActiveTab] = useState<TabKey>('details');
  const [conflict, setConflict] = useState<SloConflictInfo | null>(null);
  const [activeRun, setActiveRun] = useState<SloActiveRunInfo | null>(null);
  const [triggerLoading, setTriggerLoading] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [showAbortModal, setShowAbortModal] = useState(false);
  const [aborting, setAborting] = useState(false);
  const [elapsed, setElapsed] = useState('');

  const fetchResults = useCallback(() => {
    if (!token) return;
    setLoading(true);
    getSloResults(token)
      .then(data => {
        setResults(data);
        setNoResults(false);
      })
      .catch(err => {
        if (err.status === 404) setNoResults(true);
      })
      .finally(() => setLoading(false));
  }, [token]);

  // Poll active run independently
  useEffect(() => {
    if (!token) return;
    let wasRunning = false;
    const poll = async () => {
      try {
        const run = await getActiveSloRun(token);
        setActiveRun(run);
        if (!run && wasRunning) fetchResults();
        wasRunning = !!run;
      } catch { /* ignore */ }
    };
    poll();
    const interval = setInterval(poll, 10000);
    return () => clearInterval(interval);
  }, [token, fetchResults]);

  // Update elapsed time
  useEffect(() => {
    if (!activeRun) return;
    setElapsed(formatElapsed(activeRun.started_at));
    const interval = setInterval(() => setElapsed(formatElapsed(activeRun.started_at)), 30000);
    return () => clearInterval(interval);
  }, [activeRun?.started_at]);

  useEffect(() => {
    fetchResults();
  }, [fetchResults]);

  const handleTrigger = async () => {
    if (!token) return;
    setTriggerLoading(true);
    setConfirming(false);
    try {
      const result = await triggerSloRun(token);
      navigate(`/slo/run/${result.run_id}`);
    } catch (err: any) {
      if (err.message === 'already_running') {
        setConflict(err.conflict);
      }
    } finally {
      setTriggerLoading(false);
    }
  };

  const handleAbortActive = async () => {
    if (!token || !activeRun) return;
    setAborting(true);
    try {
      await abortSloRun(token, activeRun.run_id);
      setShowAbortModal(false);
      setActiveRun(null);
      fetchResults();
    } catch (err) {
      console.error('Abort failed:', err);
    } finally {
      setAborting(false);
    }
  };

  const allTenants = results ? results.org_summaries.map(o => o.tenant_id) : [];
  const filteredResults = results && tenantFilter
    ? {
        ...results,
        org_summaries: results.org_summaries.filter(o => o.tenant_id === tenantFilter),
        slo_results: results.slo_results.filter(s => s.tenant_id === tenantFilter),
      }
    : results;

  const tabStyle = (key: TabKey): React.CSSProperties => ({
    padding: '8px 20px',
    fontSize: 14,
    fontWeight: activeTab === key ? 600 : 400,
    color: activeTab === key ? '#0066cc' : '#64748b',
    background: 'none',
    border: 'none',
    borderBottom: activeTab === key ? '2px solid #0066cc' : '2px solid transparent',
    cursor: 'pointer',
    transition: 'all 0.15s',
  });

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

      {/* Nav */}
      <div style={{ background: 'white', borderBottom: '1px solid #e2e8f0', padding: '0 24px', display: 'flex', gap: 4 }}>
        <Link to="/" style={{ padding: '12px 16px', fontSize: 14, color: '#64748b', textDecoration: 'none', borderBottom: '2px solid transparent' }}>
          Infrastructure Analysis
        </Link>
        <Link to="/slo" style={{ padding: '12px 16px', fontSize: 14, color: '#0066cc', fontWeight: 600, textDecoration: 'none', borderBottom: '2px solid #0066cc' }}>
          SLO Audit
        </Link>
      </div>

      <main style={{ maxWidth: 1400, margin: '0 auto', padding: '32px 24px' }}>
        {/* Active Run Banner */}
        {activeRun && (
          <div style={{
            background: 'linear-gradient(135deg, #0f172a 0%, #1e3a5f 100%)',
            borderRadius: 10, padding: '14px 20px', marginBottom: 24,
            display: 'flex', alignItems: 'center', gap: 16,
            boxShadow: '0 2px 8px rgba(0,102,204,0.25)',
            border: '1px solid rgba(59,130,246,0.3)',
          }}>
            <div style={{
              width: 20, height: 20, flexShrink: 0,
              border: '2.5px solid rgba(59,130,246,0.3)', borderTopColor: '#3b82f6',
              borderRadius: '50%', animation: 'spin 1s linear infinite',
            }} />
            <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
            <div style={{ flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: '#f1f5f9' }}>SLO audit in progress</span>
                <span style={{ fontSize: 12, color: '#94a3b8' }}>—</span>
                <span style={{ fontSize: 12, color: '#94a3b8' }}>
                  started by <span style={{ color: '#93c5fd', fontWeight: 500 }}>{activeRun.triggered_by}</span>
                </span>
                {elapsed && <span style={{ fontSize: 11, color: '#60a5fa', background: 'rgba(59,130,246,0.15)', padding: '1px 7px', borderRadius: 10 }}>{elapsed} elapsed</span>}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ flex: 1, height: 5, background: 'rgba(255,255,255,0.1)', borderRadius: 3, overflow: 'hidden' }}>
                  <div style={{
                    height: '100%',
                    width: activeRun.slos_total > 0 ? `${activeRun.progress_pct}%` : '10%',
                    background: 'linear-gradient(90deg, #3b82f6, #60a5fa)',
                    borderRadius: 3, transition: 'width 0.5s ease',
                  }} />
                </div>
                <span style={{ fontSize: 12, color: '#94a3b8', whiteSpace: 'nowrap' }}>
                  {activeRun.slos_total > 0
                    ? `${activeRun.slos_done} / ${activeRun.slos_total} SLOs · ${activeRun.progress_pct}%`
                    : 'Discovering SLOs...'}
                </span>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 10, flexShrink: 0 }}>
              <button onClick={() => navigate(`/slo/run/${activeRun.run_id}`)}
                style={{ fontSize: 13, color: '#60a5fa', background: 'rgba(59,130,246,0.1)', border: '1px solid rgba(96,165,250,0.3)', borderRadius: 6, padding: '5px 12px', cursor: 'pointer', fontWeight: 500 }}>
                View Progress →
              </button>
              <button onClick={() => setShowAbortModal(true)}
                style={{ fontSize: 13, color: '#fca5a5', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 6, padding: '5px 12px', cursor: 'pointer', fontWeight: 500 }}>
                Abort run
              </button>
            </div>
          </div>
        )}

        {/* Page header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
          <div>
            <h1 style={{ fontSize: 28, fontWeight: 700, color: '#1e293b', marginBottom: 4 }}>
              SLO Compliance Audit
            </h1>
            {results && (
              <p style={{ fontSize: 13, color: '#94a3b8' }}>
                Last run: {results.completed_at ? new Date(results.completed_at).toLocaleString() : 'Unknown'} · {results.trigger_type}
              </p>
            )}
          </div>
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
            {allTenants.length > 1 && (
              <select value={tenantFilter} onChange={e => setTenantFilter(e.target.value)}
                style={{ padding: '7px 12px', border: '1px solid #e2e8f0', borderRadius: 6, fontSize: 13, color: '#1e293b', background: 'white', cursor: 'pointer' }}>
                <option value=''>All orgs</option>
                {allTenants.map(tid => <option key={tid} value={tid}>{tid}</option>)}
              </select>
            )}
            <div>
              {confirming ? (
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span style={{ fontSize: 14, color: '#64748b' }}>Run SLO audit? This may take 10–30 min.</span>
                  <button onClick={handleTrigger} style={{ padding: '8px 16px', background: '#0066cc', color: 'white', border: 'none', borderRadius: 6, fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>
                    {triggerLoading ? 'Starting...' : 'Confirm'}
                  </button>
                  <button onClick={() => setConfirming(false)} style={{ padding: '8px 16px', background: '#94a3b8', color: 'white', border: 'none', borderRadius: 6, fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>
                    Cancel
                  </button>
                </div>
              ) : (
                <button onClick={() => setConfirming(true)} disabled={triggerLoading || !!activeRun}
                  style={{ padding: '8px 16px', background: activeRun ? '#94a3b8' : '#0066cc', color: 'white', border: 'none', borderRadius: 6, fontSize: 14, fontWeight: 600, cursor: activeRun ? 'not-allowed' : 'pointer' }}>
                  ▶ Run SLO Audit
                </button>
              )}
              {conflict && (
                <div style={{ marginTop: 10, padding: '12px 14px', background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: 8, maxWidth: 340 }}>
                  <p style={{ fontSize: 13, color: '#92400e', marginBottom: 8, lineHeight: 1.5 }}>
                    A run is already in progress, started by <strong>{conflict.triggered_by}</strong>
                    {conflict.slos_total > 0 && ` · ${conflict.progress_pct}% complete`}.
                  </p>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button onClick={() => navigate(`/slo/run/${conflict.run_id}`)}
                      style={{ fontSize: 12, padding: '4px 10px', background: '#0066cc', color: 'white', border: 'none', borderRadius: 5, cursor: 'pointer', fontWeight: 500 }}>
                      View Progress
                    </button>
                    <button onClick={() => setConflict(null)}
                      style={{ fontSize: 12, padding: '4px 10px', background: 'none', color: '#94a3b8', border: '1px solid #e2e8f0', borderRadius: 5, cursor: 'pointer' }}>
                      Dismiss
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {loading && (
          <div style={{ textAlign: 'center', padding: 64, color: '#64748b' }}>Loading SLO audit results...</div>
        )}

        {!loading && noResults && (
          <div style={{ textAlign: 'center', padding: 64, background: 'white', borderRadius: 12, boxShadow: '0 1px 3px rgba(0,0,0,0.1)' }}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>🎯</div>
            <h2 style={{ fontSize: 20, fontWeight: 600, color: '#1e293b', marginBottom: 8 }}>No audit run yet</h2>
            <p style={{ color: '#64748b', marginBottom: 24 }}>
              Run your first SLO compliance audit to see AI-powered gap analysis and scoring.
            </p>
            <button onClick={() => setConfirming(true)}
              style={{ padding: '10px 24px', background: '#0066cc', color: 'white', border: 'none', borderRadius: 6, fontSize: 15, fontWeight: 600, cursor: 'pointer' }}>
              ▶ Run SLO Audit
            </button>
          </div>
        )}

        {!loading && filteredResults && (
          <>
            {/* Org Cards */}
            <div style={{ display: 'flex', gap: 16, marginBottom: 32, flexWrap: 'wrap' }}>
              {filteredResults.org_summaries.map(summary => (
                <SloOrgCard key={summary.tenant_id} summary={summary} />
              ))}
            </div>

            {/* Tabs */}
            <div style={{ background: 'white', borderRadius: 12, boxShadow: '0 1px 3px rgba(0,0,0,0.1)' }}>
              <div style={{ borderBottom: '1px solid #e2e8f0', padding: '0 24px', display: 'flex', gap: 4 }}>
                <button style={tabStyle('details')} onClick={() => setActiveTab('details')}>
                  SLO Details
                  <span style={{ fontSize: 11, color: '#94a3b8', marginLeft: 6 }}>
                    ({filteredResults.slo_results.length})
                  </span>
                </button>
                <button style={tabStyle('gap_analysis')} onClick={() => setActiveTab('gap_analysis')}>
                  Gap Analysis
                  <span style={{ fontSize: 11, color: '#94a3b8', marginLeft: 6 }}>
                    ({filteredResults.org_summaries.reduce((sum, s) => {
                      const gaps = s.gap_analysis ?? [];
                      // Count exploded rows: each gap × max(1, affected_slo_names.length)
                      return sum + gaps.reduce((gs, g) => gs + Math.max(1, (g.affected_slo_names ?? []).length), 0);
                    }, 0)})
                  </span>
                </button>
                <button style={tabStyle('trends')} onClick={() => setActiveTab('trends')}>
                  📈 Trends
                  <span style={{ fontSize: 11, color: '#94a3b8', marginLeft: 6 }}>
                    ({filteredResults.slo_results.filter(s => s.slo_id).length})
                  </span>
                </button>
              </div>
              <div style={{ padding: 24 }}>
                {activeTab === 'details' && (
                  <SloTable sloResults={filteredResults.slo_results} />
                )}
                {activeTab === 'gap_analysis' && (
                  <SloGapAnalysis orgSummaries={filteredResults.org_summaries} />
                )}
                {activeTab === 'trends' && (
                  <SloTrendsView sloResults={filteredResults.slo_results} />
                )}
              </div>
            </div>
          </>
        )}
      </main>

      {/* Abort Modal */}
      {showAbortModal && activeRun && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2000 }}>
          <div style={{ background: 'white', borderRadius: 12, padding: 28, maxWidth: 420, width: '90%', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}>
            <div style={{ fontSize: 24, marginBottom: 12 }}>⚠️</div>
            <h3 style={{ fontSize: 18, fontWeight: 700, color: '#1e293b', marginBottom: 8 }}>Abort this run?</h3>
            <p style={{ fontSize: 14, color: '#64748b', marginBottom: 24, lineHeight: 1.5 }}>
              This will stop the SLO audit run started by <strong style={{ color: '#1e293b' }}>{activeRun.triggered_by}</strong>.
              The last completed report will remain visible.
            </p>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => setShowAbortModal(false)} disabled={aborting}
                style={{ padding: '8px 18px', background: '#f1f5f9', color: '#475569', border: '1px solid #e2e8f0', borderRadius: 6, fontSize: 14, fontWeight: 500, cursor: 'pointer' }}>
                Cancel
              </button>
              <button onClick={handleAbortActive} disabled={aborting}
                style={{ padding: '8px 18px', background: '#dc2626', color: 'white', border: 'none', borderRadius: 6, fontSize: 14, fontWeight: 600, cursor: aborting ? 'not-allowed' : 'pointer', opacity: aborting ? 0.7 : 1 }}>
                {aborting ? 'Aborting...' : 'Yes, abort run'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
