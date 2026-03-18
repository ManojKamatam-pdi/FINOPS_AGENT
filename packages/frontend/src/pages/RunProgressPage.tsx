import React, { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { getStatus, RunStatus } from '../services/api';
import { startPolling } from '../services/polling';
import { useAuth } from '../contexts/AuthContext';
import ProgressPanel from '../components/ProgressPanel';

export default function RunProgressPage() {
  const { runId } = useParams<{ runId: string }>();
  const { token } = useAuth();
  const navigate = useNavigate();
  const [status, setStatus] = useState<RunStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const stopRef = useRef<(() => void) | null>(null);

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
          setError('Analysis run failed. Check the activity log for details.');
        }
      } catch (e: any) {
        setError(e.message);
      }
    };

    poll();
    stopRef.current = startPolling(poll, 3000);
    return () => stopRef.current?.();
  }, [token, runId, navigate]);

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
      <h1 style={{ fontSize: 24, fontWeight: 700, color: '#1e293b', marginBottom: 24 }}>
        Analysis Run
        {runId && <span style={{ fontSize: 14, fontWeight: 400, color: '#94a3b8', marginLeft: 8 }}>{runId}</span>}
      </h1>
      {error && (
        <div style={{ padding: 16, background: '#fee2e2', borderRadius: 8, color: '#dc2626', marginBottom: 16 }}>
          {error}
        </div>
      )}
      {status ? (
        <>
          <ProgressPanel status={status} />
          {status.status === 'completed' && (
            <div style={{ marginTop: 16, padding: 16, background: '#dcfce7', borderRadius: 8, color: '#16a34a', fontWeight: 600 }}>
              ✅ Analysis complete! Redirecting to dashboard...
            </div>
          )}
        </>
      ) : !error ? (
        <div style={{ color: '#64748b' }}>Loading run status...</div>
      ) : null}
    </div>
  );
}
