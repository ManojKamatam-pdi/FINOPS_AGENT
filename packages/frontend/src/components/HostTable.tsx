import React, { useState, useMemo } from 'react';
import { HostResult } from '../services/api';
import HostDetailRow from './HostDetailRow';

interface Props {
  hosts: HostResult[];
}

type SortKey = 'host_name' | 'instance_type' | 'cpu_avg_30d' | 'ram_avg_30d' | 'current_monthly_cost' | 'monthly_savings';

const PAGE_SIZE = 50;

// null means "no filter applied"
interface UtilFilters {
  cpuMax: number | null;    // show hosts using ≤ X% of provisioned CPU
  ramMax: number | null;    // show hosts using ≤ X% of provisioned RAM
  netMax: number | null;    // show hosts with avg network in+out ≤ X MB/day
  diskMax: number | null;   // show hosts using ≤ X% of provisioned disk
  labelFilter: string;
  envFilter: string;        // composite "provider:subtype" — "" means no filter
}

const DEFAULT_FILTERS: UtilFilters = {
  cpuMax: null,
  ramMax: null,
  netMax: null,
  diskMax: null,
  labelFilter: '',
  envFilter: '',
};

export default function HostTable({ hosts }: Props) {
  const [sortKey, setSortKey] = useState<SortKey>('monthly_savings');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [search, setSearch] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [showFilters, setShowFilters] = useState(false);

  // draft = what the sliders show; filters = what's actually applied to the table
  const [draft, setDraft] = useState<UtilFilters>(DEFAULT_FILTERS);
  const [filters, setFilters] = useState<UtilFilters>(DEFAULT_FILTERS);

  const activeCount = [
    filters.cpuMax !== null,
    filters.ramMax !== null,
    filters.netMax !== null,
    filters.diskMax !== null,
    !!filters.labelFilter,
    !!filters.envFilter,
  ].filter(Boolean).length;

  const draftDirty = JSON.stringify(draft) !== JSON.stringify(filters);

  function setDraftFilter<K extends keyof UtilFilters>(key: K, value: UtilFilters[K]) {
    setDraft(f => ({ ...f, [key]: value }));
  }

  function applyFilters() {
    setFilters(draft);
    setPage(1);
  }

  function resetFilters() {
    setDraft(DEFAULT_FILTERS);
    setFilters(DEFAULT_FILTERS);
    setPage(1);
  }

  function downloadJson() {
    const filename = `finops-hosts-${new Date().toISOString().slice(0, 10)}${sorted.length !== hosts.length ? `-filtered-${sorted.length}` : `-all-${sorted.length}`}.json`;
    const blob = new Blob([JSON.stringify(sorted, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  const sorted = useMemo(() => {
    const filtered = hosts.filter(h => {
      // text search
      if (search && !(
        (h.host_name ?? '').toLowerCase().includes(search.toLowerCase()) ||
        (h.instance_type ?? '').toLowerCase().includes(search.toLowerCase()) ||
        (h.tenant_id ?? '').toLowerCase().includes(search.toLowerCase())
      )) return false;

      // CPU utilisation ≤ threshold — exclude hosts with no CPU data when filter is active
      if (filters.cpuMax !== null && (h.cpu_avg_30d === null || h.cpu_avg_30d > filters.cpuMax)) return false;

      // RAM utilisation ≤ threshold — exclude hosts with no RAM data when filter is active
      if (filters.ramMax !== null && (h.ram_avg_30d === null || h.ram_avg_30d > filters.ramMax)) return false;

      // Network: convert bytes/sec to MB/day, sum in+out — exclude hosts with no network data when filter is active
      if (filters.netMax !== null) {
        if (h.network_in_avg_30d === null && h.network_out_avg_30d === null) return false;
        const netIn = h.network_in_avg_30d ?? 0;
        const netOut = h.network_out_avg_30d ?? 0;
        const totalMBPerDay = (netIn + netOut) * 86400 / (1024 * 1024);
        if (totalMBPerDay > filters.netMax) return false;
      }

      // Disk utilisation ≤ threshold — exclude hosts with no disk data when filter is active
      if (filters.diskMax !== null && (h.disk_avg_30d === null || h.disk_avg_30d > filters.diskMax)) return false;

      // label
      if (filters.labelFilter && h.efficiency_label !== filters.labelFilter) return false;

      // Hosted env filter — composite "provider:subtype" encoding
      // "aws:ec2" = aws + ec2 subtype; "aws:" = aws + null/other subtype; "azure:" = any azure
      if (filters.envFilter) {
        const colonIdx = filters.envFilter.indexOf(':');
        const filterProvider = filters.envFilter.slice(0, colonIdx);
        const filterSubtype = filters.envFilter.slice(colonIdx + 1); // "" means "other/null"
        if (h.cloud_provider !== filterProvider) return false;
        if (filterSubtype !== '') {
          // Specific subtype — must match exactly
          if ((h.host_subtype ?? '') !== filterSubtype) return false;
        } else if (filterProvider === 'aws') {
          // "aws:" means aws with no specific named subtype (null or unrecognized)
          const namedSubtypes = ['ec2', 'ecs', 'fargate', 'kubernetes_node'];
          if (namedSubtypes.includes(h.host_subtype ?? '')) return false;
        }
      }

      return true;
    });

    return [...filtered].sort((a, b) => {
      const av = (a as any)[sortKey] ?? -Infinity;
      const bv = (b as any)[sortKey] ?? -Infinity;
      const cmp = typeof av === 'string' ? av.localeCompare(bv) : av - bv;
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [hosts, sortKey, sortDir, search, filters]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageSlice = sorted.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir('desc'); }
    setPage(1);
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
      {/* Search + filter toggle */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          type="text"
          placeholder="Search by host name, instance type, or org..."
          value={search}
          onChange={e => { setSearch(e.target.value); setPage(1); }}
          style={{
            padding: '7px 12px', border: '1px solid #e2e8f0', borderRadius: 6,
            fontSize: 13, flex: '1 1 260px', maxWidth: 380,
          }}
        />
        <button
          onClick={() => setShowFilters(f => !f)}
          style={{
            padding: '7px 14px', border: `1px solid ${showFilters ? '#0066cc' : '#e2e8f0'}`,
            borderRadius: 6, fontSize: 13, cursor: 'pointer',
            background: showFilters ? '#eff6ff' : 'white',
            color: showFilters ? '#0066cc' : '#475569',
            fontWeight: showFilters ? 600 : 400,
            display: 'flex', alignItems: 'center', gap: 6,
          }}
        >
          ⚙ Filters
          {activeCount > 0 && (
            <span style={{
              background: '#0066cc', color: 'white', borderRadius: 10,
              fontSize: 11, fontWeight: 700, padding: '1px 6px', lineHeight: 1.4,
            }}>{activeCount}</span>
          )}
        </button>
        {activeCount > 0 && (
          <button
            onClick={resetFilters}
            style={{
              padding: '7px 12px', border: '1px solid #fca5a5', borderRadius: 6,
              fontSize: 13, cursor: 'pointer', background: '#fff5f5', color: '#dc2626',
            }}
          >✕ Clear</button>
        )}
        <button
          onClick={downloadJson}
          style={{
            padding: '7px 14px', border: '1px solid #e2e8f0', borderRadius: 6,
            fontSize: 13, cursor: 'pointer', background: 'white', color: '#475569',
            display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto',
          }}
        >
          ↓ Download JSON
          {sorted.length !== hosts.length && (
            <span style={{
              background: '#f1f5f9', color: '#64748b', borderRadius: 10,
              fontSize: 11, fontWeight: 600, padding: '1px 6px', lineHeight: 1.4,
            }}>{sorted.length}</span>
          )}
        </button>
      </div>

      {/* Filter panel */}
      {showFilters && (
        <div style={{
          background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8,
          padding: '16px 20px', marginBottom: 12,
        }}>
          <div style={{ fontSize: 12, color: '#64748b', marginBottom: 12, fontWeight: 600 }}>
            UTILISATION FILTERS — show hosts using at most this % of provisioned capacity
          </div>
          <div style={{ display: 'flex', gap: 32, flexWrap: 'wrap', alignItems: 'flex-start' }}>

            <UtilSlider
              label="CPU utilisation"
              unit="%"
              value={draft.cpuMax}
              max={100}
              hint={draft.cpuMax !== null ? `≤ ${draft.cpuMax}% of provisioned CPU` : 'No filter'}
              onChange={v => setDraftFilter('cpuMax', v)}
            />

            <UtilSlider
              label="RAM utilisation"
              unit="%"
              value={draft.ramMax}
              max={100}
              hint={draft.ramMax !== null ? `≤ ${draft.ramMax}% of provisioned RAM` : 'No filter'}
              onChange={v => setDraftFilter('ramMax', v)}
            />

            <UtilSlider
              label="Network (in + out)"
              unit=" MB/day"
              value={draft.netMax}
              max={10000}
              step={100}
              hint={draft.netMax !== null ? `≤ ${draft.netMax} MB/day total` : 'No filter'}
              onChange={v => setDraftFilter('netMax', v)}
            />

            <UtilSlider
              label="Disk utilisation"
              unit="%"
              value={draft.diskMax}
              max={100}
              hint={draft.diskMax !== null ? `≤ ${draft.diskMax}% of provisioned disk` : 'No filter'}
              onChange={v => setDraftFilter('diskMax', v)}
            />

            <div>
              <div style={{ fontSize: 12, color: '#64748b', marginBottom: 6, fontWeight: 600 }}>
                EFFICIENCY LABEL
              </div>
              <select
                value={draft.labelFilter}
                onChange={e => setDraftFilter('labelFilter', e.target.value)}
                style={{
                  padding: '6px 10px', border: '1px solid #e2e8f0', borderRadius: 6,
                  fontSize: 13, background: 'white', color: '#1e293b', cursor: 'pointer',
                }}
              >
                <option value="">All labels</option>
                <option value="over-provisioned">Over-provisioned</option>
                <option value="right-sized">Right-sized</option>
                <option value="under-provisioned">Under-provisioned</option>
                <option value="unknown">Unknown</option>
              </select>
            </div>

          </div>

          {/* Apply row */}
          <div style={{ marginTop: 16, display: 'flex', gap: 8, alignItems: 'center' }}>
            <button
              onClick={applyFilters}
              disabled={!draftDirty}
              style={{
                padding: '7px 20px', borderRadius: 6, fontSize: 13, fontWeight: 600,
                cursor: draftDirty ? 'pointer' : 'default',
                border: `1px solid ${draftDirty ? '#0066cc' : '#e2e8f0'}`,
                background: draftDirty ? '#0066cc' : '#f8fafc',
                color: draftDirty ? 'white' : '#94a3b8',
              }}
            >Apply filters</button>
            {draftDirty && (
              <span style={{ fontSize: 12, color: '#94a3b8' }}>Unsaved changes</span>
            )}
          </div>
        </div>
      )}

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
            {pageSlice.map(host => (
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
                    {host.efficiency_label === 'unknown' && host.instance_type && host.cpu_avg_30d == null && host.cpu_p95_30d == null ? (
                      <span style={{ color: '#d97706', fontWeight: 600, fontSize: 12 }} title="Instance known but no Datadog agent metrics">
                        no agent data
                      </span>
                    ) : (
                      <span style={{ color: labelColor[host.efficiency_label] || '#64748b', fontWeight: 600, fontSize: 12 }}>
                        {host.efficiency_label}
                      </span>
                    )}
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
            {pageSlice.length === 0 && (
              <tr>
                <td colSpan={9} style={{ ...tdStyle, textAlign: 'center', color: '#94a3b8', padding: 32 }}>
                  No hosts match the current filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <div style={{ fontSize: 12, color: '#94a3b8' }}>
          Showing {sorted.length === 0 ? 0 : (safePage - 1) * PAGE_SIZE + 1}–{Math.min(safePage * PAGE_SIZE, sorted.length)} of {sorted.length} hosts · Click a row to expand details
        </div>
        {totalPages > 1 && (
          <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={safePage === 1} style={pageBtn(safePage === 1)}>‹</button>
            {Array.from({ length: totalPages }, (_, i) => i + 1)
              .filter(p => p === 1 || p === totalPages || Math.abs(p - safePage) <= 2)
              .reduce<(number | '...')[]>((acc, p, idx, arr) => {
                if (idx > 0 && typeof arr[idx - 1] === 'number' && (p as number) - (arr[idx - 1] as number) > 1) acc.push('...');
                acc.push(p);
                return acc;
              }, [])
              .map((p, i) =>
                p === '...'
                  ? <span key={`ellipsis-${i}`} style={{ padding: '0 4px', color: '#94a3b8', fontSize: 13 }}>…</span>
                  : <button key={p} onClick={() => setPage(p as number)} style={pageBtn(false, p === safePage)}>{p}</button>
              )}
            <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={safePage === totalPages} style={pageBtn(safePage === totalPages)}>›</button>
          </div>
        )}
      </div>
    </div>
  );
}

// Slider with a numeric input beside it — drag or type
function UtilSlider({ label, unit, value, max, step = 1, hint, onChange }: {
  label: string;
  unit: string;
  value: number | null;
  max: number;
  step?: number;
  hint: string;
  onChange: (v: number | null) => void;
}) {
  const active = value !== null;
  return (
    <div style={{ minWidth: 200 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
        <span style={{ fontSize: 12, color: '#64748b', fontWeight: 600 }}>{label.toUpperCase()}</span>
        {active && (
          <button
            onClick={() => onChange(null)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94a3b8', fontSize: 12, padding: 0 }}
          >✕</button>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input
          type="range"
          min={0} max={max} step={step}
          value={value ?? max}
          onChange={e => onChange(parseInt(e.target.value, 10))}
          style={{ flex: 1, accentColor: '#0066cc', cursor: 'pointer' }}
        />
        <input
          type="number"
          min={0} max={max} step={step}
          value={value ?? ''}
          placeholder="—"
          onChange={e => {
            const v = e.target.value === '' ? null : Math.min(max, Math.max(0, parseInt(e.target.value, 10)));
            onChange(v);
          }}
          style={{
            width: 56, padding: '4px 6px', border: '1px solid #e2e8f0',
            borderRadius: 6, fontSize: 13, textAlign: 'right',
            color: active ? '#0066cc' : '#94a3b8', fontWeight: active ? 600 : 400,
          }}
        />
        <span style={{ fontSize: 12, color: '#64748b', whiteSpace: 'nowrap' }}>{unit}</span>
      </div>
      <div style={{ fontSize: 11, color: active ? '#0066cc' : '#94a3b8', marginTop: 2 }}>{hint}</div>
    </div>
  );
}

function pageBtn(disabled: boolean, active = false): React.CSSProperties {
  return {
    minWidth: 32, height: 32, padding: '0 8px',
    border: `1px solid ${active ? '#0066cc' : '#e2e8f0'}`,
    borderRadius: 6, fontSize: 13, cursor: disabled ? 'default' : 'pointer',
    background: active ? '#0066cc' : disabled ? '#f8fafc' : 'white',
    color: active ? 'white' : disabled ? '#cbd5e1' : '#1e293b',
    fontWeight: active ? 700 : 400,
  };
}
