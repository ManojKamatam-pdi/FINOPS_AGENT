import React, { useState } from 'react';
import { triggerRun, ConflictInfo, ActiveRunInfo } from '../services/api';
import { useAuth } from '../contexts/AuthContext';

interface Props {
  onRunStarted: (runId: string) => void;
  onAlreadyRunning: (conflict: ConflictInfo) => void;
  activeRun?: ActiveRunInfo | null;
}

export default function RunTriggerButton({ onRunStarted, onAlreadyRunning, activeRun }: Props) {
  const { token } = useAuth();
  const [confirming, setConfirming] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleClick = () => setConfirming(true);

  const handleConfirm = async () => {
    if (!token) return;
    setLoading(true);
    setConfirming(false);
    try {
      const result = await triggerRun(token);
      onRunStarted(result.run_id);
    } catch (err: any) {
      if (err.message === 'already_running') {
        onAlreadyRunning(err.conflict);
      }
    } finally {
      setLoading(false);
    }
  };

  if (confirming) {
    return (
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <span style={{ fontSize: 14, color: '#64748b' }}>Run fresh analysis? This may take 30–60 min.</span>
        <button onClick={handleConfirm} style={btnStyle('#0066cc')}>Confirm</button>
        <button onClick={() => setConfirming(false)} style={btnStyle('#94a3b8')}>Cancel</button>
      </div>
    );
  }

  return (
    <button
      onClick={handleClick}
      disabled={loading || !!activeRun}
      style={btnStyle(activeRun ? '#94a3b8' : '#0066cc', !!activeRun)}
    >
      {loading ? 'Starting...' : '▶ Run Fresh Analysis'}
    </button>
  );
}

function btnStyle(bg: string, disabled = false): React.CSSProperties {
  return {
    padding: '8px 16px', background: bg, color: 'white', border: 'none',
    borderRadius: 6, fontSize: 14, fontWeight: 600,
    cursor: disabled ? 'not-allowed' : 'pointer',
  };
}
