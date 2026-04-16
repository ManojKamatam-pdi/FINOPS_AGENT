import React, { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { abortSloRun, getSloStatus, SloRunStatus } from '../services/slo-api';
import { startPolling } from '../services/polling';
import { useAuth } from '../contexts/AuthContext';

function formatElapsed(startedAt: string): string {
  const ms = Date.now() - new Date(startedAt).getTime();
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return '<1m';
}

export default function SloRunProgressPage() {
  const { runId } = useParams<{ runId: string }>();
  const { token } = useAuth();
  const navigate = useNavigate();
  const [status, setStatus] = useState<SloRunStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState('');
  const [showAbortModal, setShowAbortModal] = useState(false);
  const [aborting, setAborting] = useState(false);
  const stopRef = useRef<(() => void) | null>(null);
  const elapsedRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!token || !runId) return;

    const poll = async () => {
      try {
        const s = await getSloStatus(token, runId);
        setStatus(s);
        if (s.status === 'completed') {
          stopRef.current?.();
          setTimeout(() => navigate('/slo'), 2000);
        } else if (s.status === 'failed') {
          stopRef.current?.();
        }
      } catch (e: any) {
        setError(e.message);
      }
    };

    poll();
    stopRef.current = startPolling(poll, 3000);
    return () => stopRef.current?.();
  }, [token, runId, navigate]);

  useEffect(() => {
    if (!status?.started_at || status.status !== 'running') return;
    setElapsed(formatElapsed(status.started_at));
    elapsedRef.current = setInterval(() => {
      setElapsed(formatElapsed(status.started_at));
    }, 30000);
    return () => {
      if (elapsedRef.current) clearInterval(elapsedRef.current);
    };
  }, [status?.started_at, status?.status]);

  const handleAbort = async () => {
    if (!token || !runId) return;
    setAborting(true);
    try {
      await abortSloRun(token, runId);
      setShowAbortModal(false);
      navigate('/slo');
    } catch (err) {
      console.error('Abort failed:', err);
    } finally {
      setAborting(false);
    }
  };

  const pct = status?.progress_pct ?? 0;

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
      </header>

      <main style={{ maxWidth: 800, margin: '0 auto', padding: '32px 24px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
          <button
            onClick={() => navigate('/slo')}
            style={{ background: 'none', border: 'none', color: '#0066cc', cursor: 'pointer', fontSize: 14 }}
          >
            ← Back to SLO Audit
          </button>
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
          <div>
            <h1 style={{ fontSize: 24, fontWeight: 700, color: '#1e293b', marginBottom: 4 }}>
              SLO Audit Run
              {runId && <span style={{ fontSize: 14, fontWeight: 400, color: '#94a3b8', marginLeft: 8 }}>{runId}</span>}
            </h1>
            {status && (
              <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 13, color: '#64748b' }}>
                  Started by <strong style={{ color: '#1e293b' }}>{status.triggered_by}</strong>
                </span>
                {status.status === 'running' && elapsed && (
                  <span style={{ fontSize: 13, color: '#64748b' }}>· {elapsed} elapsed</span>
                )}
              </div>
            )}
          </div>
          {status?.status === 'running' && (
            <button
              onClick={() => setShowAbortModal(true)}
              style={{
                padding: '7px 14px', background: '#fee2e2', color: '#dc2626',
                border: '1px solid #fca5a5', borderRadius: 6, fontSize: 13,
                fontWeight: 500, cursor: 'pointer',
              }}
            >
              Abort this run
            </button>
          )}
        </div>

        {error && (
          <div style={{ padding: 16, background: '#fee2e2', borderRadius: 8, color: '#dc2626', marginBottom: 16 }}>
            {error}
          </div>
        )}

        {status && (
          <div style={{ background: 'white', borderRadius: 12, padding: 24, boxShadow: '0 1px 3px rgba(0,0,0,0.1)', marginBottom: 16 }}>
            {/* Progress bar */}
            <div style={{ marginBottom: 20 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                <span style={{ fontSize: 14, fontWeight: 600, color: '#1e293b' }}>
                  {status.slos_total > 0
                    ? `${status.slos_done} / ${status.slos_total} SLOs audited`
                    : 'Discovering SLOs...'}
                </span>
                <span style={{ fontSize: 14, fontWeight: 700, color: '#0066cc' }}>{pct}%</span>
              </div>
              <div style={{ height: 8, background: '#e2e8f0', borderRadius: 4, overflow: 'hidden' }}>
                <div style={{
                  height: '100%',
                  width: status.slos_total > 0 ? `${pct}%` : '10%',
                  background: 'linear-gradient(90deg, #0066cc, #3b82f6)',
                  borderRadius: 4,
                  transition: 'width 0.5s ease',
                }} />
              </div>
            </div>

            {/* Tenant progress */}
            <div style={{ display: 'flex', gap: 24, marginBottom: 20 }}>
              <div>
                <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 2 }}>Tenants</div>
                <div style={{ fontSize: 16, fontWeight: 700, color: '#1e293b' }}>
                  {status.tenants_done} / {status.tenants_total}
                </div>
              </div>
              <div>
                <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 2 }}>Status</div>
                <div style={{ fontSize: 14, fontWeight: 600, color: status.status === 'running' ? '#0066cc' : status.status === 'completed' ? '#15803d' : '#dc2626' }}>
                  {status.status}
                </div>
              </div>
            </div>

            {/* Activity log */}
            {status.log && status.log.length > 0 && (
              <div>
                <div style={{ fontSize: 12, fontWeight: 600, color: '#64748b', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  Activity Log
                </div>
                <div style={{
                  background: '#0f172a', borderRadius: 8, padding: 16,
                  maxHeight: 300, overflowY: 'auto', fontFamily: 'monospace',
                }}>
                  {[...status.log].reverse().map((entry, i) => (
                    <div key={i} style={{ fontSize: 12, color: '#94a3b8', marginBottom: 4, lineHeight: 1.4 }}>
                      {entry}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {status?.status === 'completed' && (
          <div style={{ padding: 16, background: '#dcfce7', borderRadius: 8, color: '#16a34a', fontWeight: 600 }}>
            ✅ SLO audit complete! Redirecting to results...
          </div>
        )}

        {!status && !error && (
          <div style={{ color: '#64748b' }}>Loading run status...</div>
        )}
      </main>

      {/* Abort Modal */}
      {showAbortModal && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2000,
        }}>
          <div style={{
            background: 'white', borderRadius: 12, padding: 28, maxWidth: 420, width: '90%',
            boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
          }}>
            <div style={{ fontSize: 24, marginBottom: 12 }}>⚠️</div>
            <h3 style={{ fontSize: 18, fontWeight: 700, color: '#1e293b', marginBottom: 8 }}>Abort this run?</h3>
            <p style={{ fontSize: 14, color: '#64748b', marginBottom: 24, lineHeight: 1.5 }}>
              This will immediately stop the SLO audit run. Partial results will not be saved.
            </p>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => setShowAbortModal(false)} disabled={aborting}
                style={{ padding: '8px 18px', background: '#f1f5f9', color: '#475569', border: '1px solid #e2e8f0', borderRadius: 6, fontSize: 14, fontWeight: 500, cursor: 'pointer' }}>
                Cancel
              </button>
              <button onClick={handleAbort} disabled={aborting}
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
