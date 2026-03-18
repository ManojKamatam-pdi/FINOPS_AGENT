import React, { useState, useMemo } from 'react';
import { HostResult } from '../services/api';
import HostDetailRow from './HostDetailRow';

interface Props {
  hosts: HostResult[];
}

type SortKey = 'host_name' | 'instance_type' | 'cpu_avg_30d' | 'ram_avg_30d' | 'current_monthly_cost' | 'monthly_savings';

export default function HostTable({ hosts }: Props) {
  const [sortKey, setSortKey] = useState<SortKey>('monthly_savings');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [filter, setFilter] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const sorted = useMemo(() => {
    const filtered = hosts.filter(h =>
      !filter ||
      h.host_name.toLowerCase().includes(filter.toLowerCase()) ||
      (h.instance_type || '').toLowerCase().includes(filter.toLowerCase()) ||
      h.tenant_id.toLowerCase().includes(filter.toLowerCase())
    );
    return [...filtered].sort((a, b) => {
      const av = (a as any)[sortKey] ?? -Infinity;
      const bv = (b as any)[sortKey] ?? -Infinity;
      const cmp = typeof av === 'string' ? av.localeCompare(bv) : av - bv;
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [hosts, sortKey, sortDir, filter]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir('desc'); }
  };

  const thStyle: React.CSSProperties = {
    padding: '10px 12px', textAlign: 'left', fontSize: 12, fontWeight: 600,
    color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em',
    cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap',
  };

  const tdStyle: React.CSSProperties = {
    padding: '10px 12px', fontSize: 13, borderTop: '1px solid #f1f5f9',
  };

  const labelColor: Record<string, string> = {
    'over-provisioned': '#dc2626',
    'right-sized': '#16a34a',
    'under-provisioned': '#d97706',
    'unknown': '#94a3b8',
  };

  return (
    <div>
      <div style={{ marginBottom: 12 }}>
        <input
          type="text"
          placeholder="Filter by host name, instance type, or org..."
          value={filter}
          onChange={e => setFilter(e.target.value)}
          style={{
            padding: '8px 12px', border: '1px solid #e2e8f0', borderRadius: 6,
            fontSize: 14, width: '100%', maxWidth: 400,
          }}
        />
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', background: 'white', borderRadius: 8, overflow: 'hidden', boxShadow: '0 1px 3px rgba(0,0,0,0.1)' }}>
          <thead style={{ background: '#f8fafc' }}>
            <tr>
              <th style={thStyle} onClick={() => toggleSort('host_name')}>Host {sortKey === 'host_name' ? (sortDir === 'asc' ? '↑' : '↓') : ''}</th>
              <th style={thStyle}>Org</th>
              <th style={thStyle} onClick={() => toggleSort('instance_type')}>Instance {sortKey === 'instance_type' ? (sortDir === 'asc' ? '↑' : '↓') : ''}</th>
              <th style={thStyle} onClick={() => toggleSort('cpu_avg_30d')}>CPU avg {sortKey === 'cpu_avg_30d' ? (sortDir === 'asc' ? '↑' : '↓') : ''}</th>
              <th style={thStyle} onClick={() => toggleSort('ram_avg_30d')}>RAM avg {sortKey === 'ram_avg_30d' ? (sortDir === 'asc' ? '↑' : '↓') : ''}</th>
              <th style={thStyle} onClick={() => toggleSort('current_monthly_cost')}>Current $/mo {sortKey === 'current_monthly_cost' ? (sortDir === 'asc' ? '↑' : '↓') : ''}</th>
              <th style={thStyle}>Suggested</th>
              <th style={thStyle} onClick={() => toggleSort('monthly_savings')}>Savings $/mo {sortKey === 'monthly_savings' ? (sortDir === 'asc' ? '↑' : '↓') : ''}</th>
              <th style={thStyle}>Label</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map(host => (
              <React.Fragment key={`${host.tenant_id}:${host.host_id}`}>
                <tr
                  onClick={() => setExpandedId(expandedId === host.host_id ? null : host.host_id)}
                  style={{ cursor: 'pointer', background: expandedId === host.host_id ? '#f0f9ff' : 'white' }}
                >
                  <td style={tdStyle}>
                    <span style={{ fontWeight: 600 }}>{host.host_name}</span>
                    <span style={{ color: '#94a3b8', fontSize: 11, marginLeft: 4 }}>{host.host_id}</span>
                  </td>
                  <td style={{ ...tdStyle, color: '#64748b' }}>{host.tenant_id}</td>
                  <td style={tdStyle}>{host.instance_type || <span style={{ color: '#94a3b8' }}>—</span>}</td>
                  <td style={tdStyle}>{host.cpu_avg_30d != null ? `${host.cpu_avg_30d.toFixed(1)}%` : '—'}</td>
                  <td style={tdStyle}>{host.ram_avg_30d != null ? `${host.ram_avg_30d.toFixed(1)}%` : '—'}</td>
                  <td style={tdStyle}>{host.current_monthly_cost != null ? `$${host.current_monthly_cost.toFixed(2)}` : '—'}</td>
                  <td style={tdStyle}>{host.suggested_instance || <span style={{ color: '#94a3b8' }}>—</span>}</td>
                  <td style={{ ...tdStyle, fontWeight: 600, color: (host.monthly_savings ?? 0) > 0 ? '#16a34a' : '#64748b' }}>
                    {host.monthly_savings != null && host.monthly_savings > 0 ? `$${host.monthly_savings.toFixed(2)}` : '—'}
                  </td>
                  <td style={tdStyle}>
                    <span style={{ color: labelColor[host.efficiency_label] || '#64748b', fontWeight: 600, fontSize: 12 }}>
                      {host.efficiency_label}
                    </span>
                  </td>
                </tr>
                {expandedId === host.host_id && (
                  <tr>
                    <td colSpan={9} style={{ padding: 0 }}>
                      <HostDetailRow host={host} />
                    </td>
                  </tr>
                )}
              </React.Fragment>
            ))}
            {sorted.length === 0 && (
              <tr>
                <td colSpan={9} style={{ ...tdStyle, textAlign: 'center', color: '#94a3b8', padding: 32 }}>
                  No hosts match the filter.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div style={{ marginTop: 8, fontSize: 12, color: '#94a3b8' }}>
        Showing {sorted.length} of {hosts.length} hosts · Click a row to expand details
      </div>
    </div>
  );
}
