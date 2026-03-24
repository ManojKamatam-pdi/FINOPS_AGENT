import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { getActiveRun, abortRun, ActiveRunInfo } from '../services/api';
import { useAuth } from '../contexts/AuthContext';

interface Props {
  onRunCompleted?: () => void;
}

function formatElapsed(startedAt: string): string {
  const ms = Date.now() - new Date(startedAt).getTime();
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `<1m`;
}

export default function ActiveRunBanner({ onRunCompleted }: Props) {
  const { token } = useAuth();
  const [activeRun, setActiveRun] = useState<ActiveRunInfo | null>(null);
  const [showAbortModal, setShowAbortModal] = useState(false);
  const [aborting, setAborting] = useState(false);
  const [elapsed, setElapsed] = useState('');
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const elapsedRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const wasRunningRef = useRef(false);

  const poll = useCallback(async () => {
    if (!token) return;
    try {
      const run = await getActiveRun(token);
      setActiveRun(run);
      if (!run && wasRunningRef.current) {
        // Run just completed/failed — notify dashboard to refresh
        onRunCompleted?.();
      }
      wasRunningRef.current = !!run;
    } catch {
      // Silently ignore poll errors
    }
  }, [token, onRunCompleted]);

  useEffect(() => {
    poll();
    intervalRef.current = setInterval(poll, 10000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [poll]);

  // Update elapsed time every 30s
  useEffect(() => {
    if (!activeRun) return;
    setElapsed(formatElapsed(activeRun.started_at));
    elapsedRef.current = setInterval(() => {
      setElapsed(formatElapsed(activeRun.started_at));
    }, 30000);
    return () => {
      if (elapsedRef.current) clearInterval(elapsedRef.current);
    };
  }, [activeRun?.started_at]);

  const handleAbort = async () => {
    if (!token || !activeRun) return;
    setAborting(true);
    try {
      await abortRun(token, activeRun.run_id);
      setShowAbortModal(false);
      setActiveRun(null);
      onRunCompleted?.();
    } catch (err) {
      console.error('Abort failed:', err);
    } finally {
      setAborting(false);
    }
  };

  if (!activeRun) return null;

  const pct = activeRun.progress_pct;
  const startedTime = new Date(activeRun.started_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  return (
    <>
      <div style={{
        background: 'linear-gradient(135deg, #0f172a 0%, #1e3a5f 100%)',
        borderRadius: 10,
        padding: '14px 20px',
        marginBottom: 24,
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        boxShadow: '0 2px 8px rgba(0,102,204,0.25)',
        border: '1px solid rgba(59,130,246,0.3)',
        position: 'relative',
        overflow: 'hidden',
      }}>
        {/* Animated shimmer background */}
        <div style={{
          position: 'absolute', inset: 0,
          background: 'linear-gradient(90deg, transparent 0%, rgba(59,130,246,0.06) 50%, transparent 100%)',
          animation: 'bannerShimmer 3s ease-in-out infinite',
          pointerEvents: 'none',
        }} />
        <style>{`
          @keyframes bannerShimmer {
            0%, 100% { transform: translateX(-100%); }
            50% { transform: translateX(100%); }
          }
          @keyframes spin {
            to { transform: rotate(360deg); }
          }
          @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.5; }
          }
        `}</style>

        {/* Spinner */}
        <div style={{
          width: 20, height: 20, flexShrink: 0,
          border: '2.5px solid rgba(59,130,246,0.3)',
          borderTopColor: '#3b82f6',
          borderRadius: '50%',
          animation: 'spin 1s linear infinite',
        }} />

        {/* Main info */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: '#f1f5f9' }}>
              Analysis in progress
            </span>
            <span style={{ fontSize: 12, color: '#94a3b8' }}>—</span>
            <span style={{ fontSize: 12, color: '#94a3b8' }}>
              started by <span style={{ color: '#93c5fd', fontWeight: 500 }}>{activeRun.triggered_by}</span>
            </span>
            <span style={{ fontSize: 12, color: '#94a3b8' }}>
              at {startedTime}
            </span>
            <span style={{
              fontSize: 11, color: '#60a5fa', background: 'rgba(59,130,246,0.15)',
              padding: '1px 7px', borderRadius: 10, fontWeight: 500,
              animation: 'pulse 2s ease-in-out infinite',
            }}>
              {elapsed} elapsed
            </span>
          </div>

          {/* Progress bar */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ flex: 1, height: 5, background: 'rgba(255,255,255,0.1)', borderRadius: 3, overflow: 'hidden' }}>
              <div style={{
                height: '100%',
                width: activeRun.hosts_total > 0 ? `${pct}%` : '15%',
                background: activeRun.hosts_total > 0
                  ? 'linear-gradient(90deg, #3b82f6, #60a5fa)'
                  : 'linear-gradient(90deg, #3b82f6, #60a5fa)',
                borderRadius: 3,
                transition: 'width 0.5s ease',
                animation: activeRun.hosts_total === 0 ? 'bannerShimmer 1.5s ease-in-out infinite' : undefined,
              }} />
            </div>
            <span style={{ fontSize: 12, color: '#94a3b8', whiteSpace: 'nowrap', flexShrink: 0 }}>
              {activeRun.hosts_total > 0
                ? `${activeRun.hosts_done} / ${activeRun.hosts_total} hosts · ${pct}%`
                : 'Discovering hosts...'}
            </span>
          </div>
        </div>

        {/* Actions */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
          <Link
            to={`/run/${activeRun.run_id}`}
            style={{
              fontSize: 13, color: '#60a5fa', textDecoration: 'none', fontWeight: 500,
              padding: '5px 12px', borderRadius: 6, border: '1px solid rgba(96,165,250,0.3)',
              background: 'rgba(59,130,246,0.1)',
              transition: 'all 0.15s',
              whiteSpace: 'nowrap',
            }}
          >
            View Progress →
          </Link>
          <button
            onClick={() => setShowAbortModal(true)}
            style={{
              fontSize: 13, color: '#fca5a5', background: 'rgba(239,68,68,0.1)',
              border: '1px solid rgba(239,68,68,0.3)', borderRadius: 6,
              padding: '5px 12px', cursor: 'pointer', fontWeight: 500,
              whiteSpace: 'nowrap',
            }}
          >
            Abort run
          </button>
        </div>
      </div>

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
              This will immediately stop the analysis run started by{' '}
              <strong style={{ color: '#1e293b' }}>{activeRun.triggered_by}</strong>.
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
    </>
  );
}
