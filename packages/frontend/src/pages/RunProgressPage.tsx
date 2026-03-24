import React, { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { abortRun, getStatus, RunStatus } from '../services/api';
import { startPolling } from '../services/polling';
import { useAuth } from '../contexts/AuthContext';
import ProgressPanel from '../components/ProgressPanel';

function formatElapsed(startedAt: string): string {
  const ms = Date.now() - new Date(startedAt).getTime();
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return '<1m';
}

export default function RunProgressPage() {
  const { runId } = useParams<{ runId: string }>();
  const { token } = useAuth();
  const navigate = useNavigate();
  const [status, setStatus] = useState<RunStatus | null>(null);
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
        const s = await getStatus(token, runId);
        setStatus(s);
        if (s.status === 'completed') {
          stopRef.current?.();
          setTimeout(() => navigate('/'), 2000);
        } else if (s.status === 'failed') {
          stopRef.current?.();
          const isAborted = String(s.triggered_by ?? '').startsWith('aborted by');
          if (!isAborted) {
            setError('Analysis run failed. Check the activity log for details.');
          }
        }
      } catch (e: any) {
        setError(e.message);
      }
    };

    poll();
    stopRef.current = startPolling(poll, 3000);
    return () => stopRef.current?.();
  }, [token, runId, navigate]);

  // Update elapsed time every 30s while running
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
      await abortRun(token, runId);
      setShowAbortModal(false);
      navigate('/');
    } catch (err) {
      console.error('Abort failed:', err);
    } finally {
      setAborting(false);
    }
  };

  const isAborted = status && String(status.triggered_by ?? '').startsWith('aborted by');

  return (
    <div style={{ maxWidth: 800, margin: '0 auto', padding: '32px 16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
        <button
          onClick={() => navigate('/')}
          style={{ background: 'none', border: 'none', color: '#0066cc', cursor: 'pointer', fontSize: 14 }}
        >
          ← Back to Dashboard
        </button>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 700, color: '#1e293b', marginBottom: 4 }}>
            Analysis Run
            {runId && <span style={{ fontSize: 14, fontWeight: 400, color: '#94a3b8', marginLeft: 8 }}>{runId}</span>}
          </h1>
          {status && (
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 13, color: '#64748b' }}>
                Started by <strong style={{ color: '#1e293b' }}>{status.triggered_by}</strong>
              </span>
              {status.status === 'running' && elapsed && (
                <span style={{ fontSize: 13, color: '#64748b' }}>
                  · {elapsed} elapsed
                </span>
              )}
            </div>
          )}
        </div>

        {/* Abort button — only shown while running */}
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

      {isAborted && (
        <div style={{ padding: 16, background: '#fef3c7', borderRadius: 8, color: '#92400e', marginBottom: 16, fontWeight: 500 }}>
          ⛔ This run was aborted by {String(status!.triggered_by).replace('aborted by ', '')}
        </div>
      )}

      {status ? (
        <>
          <ProgressPanel
            status={status}
            triggeredBy={status.triggered_by}
            startedAt={status.started_at}
          />
          {status.status === 'completed' && (
            <div style={{ marginTop: 16, padding: 16, background: '#dcfce7', borderRadius: 8, color: '#16a34a', fontWeight: 600 }}>
              ✅ Analysis complete! Redirecting to dashboard...
            </div>
          )}
        </>
      ) : !error ? (
        <div style={{ color: '#64748b' }}>Loading run status...</div>
      ) : null}

      {/* Abort Confirmation Modal */}
      {showAbortModal && (
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
              This will immediately stop the analysis run.
            </p>
            <p style={{ fontSize: 14, color: '#64748b', marginBottom: 24, lineHeight: 1.5 }}>
              Any partial results will not be saved. The last completed report will remain visible on the dashboard.
            </p>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button
                onClick={() => setShowAbortModal(false)}
                disabled={aborting}
                style={{
                  padding: '8px 18px', background: '#f1f5f9', color: '#475569',
                  border: '1px solid #e2e8f0', borderRadius: 6, fontSize: 14,
                  fontWeight: 500, cursor: 'pointer',
                }}
              >
                Cancel
              </button>
              <button
                onClick={handleAbort}
                disabled={aborting}
                style={{
                  padding: '8px 18px', background: '#dc2626', color: 'white',
                  border: 'none', borderRadius: 6, fontSize: 14,
                  fontWeight: 600, cursor: aborting ? 'not-allowed' : 'pointer',
                  opacity: aborting ? 0.7 : 1,
                }}
              >
                {aborting ? 'Aborting...' : 'Yes, abort run'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
