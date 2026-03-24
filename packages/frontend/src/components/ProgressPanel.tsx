import React from 'react';
import { RunStatus } from '../services/api';

function formatElapsed(startedAt: string): string {
  const ms = Date.now() - new Date(startedAt).getTime();
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return '<1m';
}

interface Props {
  status: RunStatus;
  triggeredBy?: string;
  startedAt?: string;
}

export default function ProgressPanel({ status, triggeredBy, startedAt }: Props) {
  const isDiscovering = status.hosts_total === 0;
  const pct = status.progress_pct;

  return (
    <div style={{
      background: 'white', borderRadius: 12, padding: 24,
      boxShadow: '0 1px 3px rgba(0,0,0,0.1)', border: '1px solid #e2e8f0',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
        <h3 style={{ fontSize: 18, fontWeight: 700, color: '#1e293b' }}>Analysis Progress</h3>
        <span style={{
          padding: '4px 10px', borderRadius: 20, fontSize: 12, fontWeight: 600,
          background: status.status === 'running' ? '#dbeafe' : status.status === 'completed' ? '#dcfce7' : '#fee2e2',
          color: status.status === 'running' ? '#1d4ed8' : status.status === 'completed' ? '#16a34a' : '#dc2626',
        }}>
          {status.status}
        </span>
      </div>

      {/* Started by / elapsed line */}
      {(triggeredBy || startedAt) && (
        <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 16 }}>
          {triggeredBy && <>Started by <span style={{ color: '#64748b', fontWeight: 500 }}>{triggeredBy}</span></>}
          {startedAt && status.status === 'running' && (
            <span> · {formatElapsed(startedAt)} elapsed</span>
          )}
        </div>
      )}

      {isDiscovering ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
          <div style={{ width: 20, height: 20, border: '3px solid #e2e8f0', borderTopColor: '#0066cc', borderRadius: '50%', animation: 'spin 1s linear infinite' }} />
          <span style={{ color: '#64748b' }}>Discovering hosts across all orgs...</span>
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        </div>
      ) : (
        <div style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
            <span style={{ fontSize: 13, color: '#64748b' }}>
              {status.hosts_done} / {status.hosts_total} hosts analyzed
            </span>
            <span style={{ fontSize: 13, fontWeight: 600, color: '#1e293b' }}>{pct}%</span>
          </div>
          <div style={{ height: 8, background: '#e2e8f0', borderRadius: 4, overflow: 'hidden' }}>
            <div style={{
              height: '100%', width: `${pct}%`, background: '#0066cc',
              borderRadius: 4, transition: 'width 0.3s ease',
            }} />
          </div>
          <div style={{ marginTop: 4, fontSize: 12, color: '#94a3b8' }}>
            {status.tenants_done} / {status.tenants_total} orgs complete
          </div>
        </div>
      )}

      {status.log.length > 0 && (
        <div>
          <div style={{ fontSize: 12, fontWeight: 600, color: '#64748b', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Activity Log
          </div>
          <div style={{
            background: '#0f172a', borderRadius: 6, padding: '10px 12px',
            maxHeight: 200, overflowY: 'auto', fontFamily: 'monospace', fontSize: 12,
          }}>
            {status.log.map((entry, i) => (
              <div key={i} style={{ color: '#94a3b8', marginBottom: 2 }}>
                <span style={{ color: '#475569' }}>{String(i + 1).padStart(2, '0')} </span>
                {entry}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
