import React, { useState, useMemo } from 'react';
import type { SloResult } from '../services/slo-api';
import SloHistoryChart from './SloHistoryChart';

interface Props {
  sloResults: SloResult[];
}

type SortKey = 'validation_score' | 'sli_category' | 'tenant_id' | 'slo_name';

function statusColor(status: string): { bg: string; text: string } {
  switch (status) {
    case 'excellent': return { bg: '#dcfce7', text: '#15803d' };
    case 'good': return { bg: '#dbeafe', text: '#1d4ed8' };
    case 'needs_improvement': return { bg: '#fef9c3', text: '#a16207' };
    case 'poor': return { bg: '#ffedd5', text: '#c2410c' };
    case 'critical': return { bg: '#fee2e2', text: '#dc2626' };
    default: return { bg: '#f1f5f9', text: '#475569' };
  }
}

function formulaIcon(slo: SloResult): { icon: string; color: string; label: string } {
  if (!slo.formula_valid) return { icon: '✗', color: '#dc2626', label: 'Broken' };
  if (slo.blocker_issues?.length > 0) return { icon: '✗', color: '#dc2626', label: 'Broken' };
  if (slo.quality_issues?.length > 0) return { icon: '⚠', color: '#f59e0b', label: 'Issue' };
  return { icon: '✓', color: '#15803d', label: 'Valid' };
}

function categoryLabel(cat: string): string {
  switch (cat) {
    case 'availability': return 'Availability';
    case 'latency': return 'Latency';
    case 'error_rate': return 'Error Rate';
    case 'throughput': return 'Throughput';
    case 'saturation': return 'Saturation';
    case 'unclassified': return 'Unclassified';
    default: return cat;
  }
}

const PAGE_SIZE = 50;

export default function SloTable({ sloResults }: Props) {
  const [sortKey, setSortKey] = useState<SortKey>('validation_score');
  const [sortAsc, setSortAsc] = useState(false);
  const [filterOrg, setFilterOrg] = useState('');
  const [filterCategory, setFilterCategory] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [filterFormula, setFilterFormula] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [page, setPage] = useState(0);

  const orgs = useMemo(() => [...new Set(sloResults.map(s => s.tenant_id))].sort(), [sloResults]);
  const categories = useMemo(() => [...new Set(sloResults.map(s => s.sli_category))].sort(), [sloResults]);
  const statuses = ['excellent', 'good', 'needs_improvement', 'poor', 'critical'];

  const filtered = useMemo(() => {
    let items = [...sloResults];
    if (filterOrg) items = items.filter(s => s.tenant_id === filterOrg);
    if (filterCategory) items = items.filter(s => s.sli_category === filterCategory);
    if (filterStatus) items = items.filter(s => s.validation_status === filterStatus);
    if (filterFormula === 'valid') items = items.filter(s => s.formula_valid && !s.blocker_issues?.length);
    if (filterFormula === 'issue') items = items.filter(s => s.formula_valid && s.quality_issues?.length > 0);
    if (filterFormula === 'broken') items = items.filter(s => !s.formula_valid || s.blocker_issues?.length > 0);

    items.sort((a, b) => {
      let cmp = 0;
      if (sortKey === 'validation_score') cmp = (a.validation_score ?? 0) - (b.validation_score ?? 0);
      else if (sortKey === 'sli_category') cmp = a.sli_category.localeCompare(b.sli_category);
      else if (sortKey === 'tenant_id') cmp = a.tenant_id.localeCompare(b.tenant_id);
      else if (sortKey === 'slo_name') cmp = a.slo_name.localeCompare(b.slo_name);
      return sortAsc ? cmp : -cmp;
    });
    return items;
  }, [sloResults, filterOrg, filterCategory, filterStatus, filterFormula, sortKey, sortAsc]);

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const pageItems = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) setSortAsc(!sortAsc);
    else { setSortKey(key); setSortAsc(key !== 'validation_score'); }
    setPage(0);
  };

  const thStyle = (key: SortKey): React.CSSProperties => ({
    padding: '10px 12px', textAlign: 'left', fontSize: 12, fontWeight: 600,
    color: '#64748b', background: '#f8fafc', borderBottom: '1px solid #e2e8f0',
    cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap',
    borderRight: '1px solid #f1f5f9',
  });

  const sortIndicator = (key: SortKey) => sortKey === key ? (sortAsc ? ' ↑' : ' ↓') : '';

  return (
    <div>
      {/* Filters */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
        {orgs.length > 1 && (
          <select value={filterOrg} onChange={e => { setFilterOrg(e.target.value); setPage(0); }}
            style={{ padding: '6px 10px', border: '1px solid #e2e8f0', borderRadius: 6, fontSize: 13, color: '#1e293b', background: 'white' }}>
            <option value=''>All orgs</option>
            {orgs.map(o => <option key={o} value={o}>{o}</option>)}
          </select>
        )}
        <select value={filterCategory} onChange={e => { setFilterCategory(e.target.value); setPage(0); }}
          style={{ padding: '6px 10px', border: '1px solid #e2e8f0', borderRadius: 6, fontSize: 13, color: '#1e293b', background: 'white' }}>
          <option value=''>All categories</option>
          {categories.map(c => <option key={c} value={c}>{categoryLabel(c)}</option>)}
        </select>
        <select value={filterStatus} onChange={e => { setFilterStatus(e.target.value); setPage(0); }}
          style={{ padding: '6px 10px', border: '1px solid #e2e8f0', borderRadius: 6, fontSize: 13, color: '#1e293b', background: 'white' }}>
          <option value=''>All statuses</option>
          {statuses.map(s => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
        </select>
        <select value={filterFormula} onChange={e => { setFilterFormula(e.target.value); setPage(0); }}
          style={{ padding: '6px 10px', border: '1px solid #e2e8f0', borderRadius: 6, fontSize: 13, color: '#1e293b', background: 'white' }}>
          <option value=''>All formulas</option>
          <option value='valid'>✓ Valid</option>
          <option value='issue'>⚠ Issue</option>
          <option value='broken'>✗ Broken</option>
        </select>
        <span style={{ fontSize: 13, color: '#94a3b8', alignSelf: 'center' }}>
          {filtered.length} SLOs
        </span>
      </div>

      {/* Table */}
      <div style={{ overflowX: 'auto', borderRadius: 8, border: '1px solid #e2e8f0' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr>
              {orgs.length > 1 && <th style={thStyle('tenant_id')} onClick={() => handleSort('tenant_id')}>Org{sortIndicator('tenant_id')}</th>}
              <th style={thStyle('slo_name')} onClick={() => handleSort('slo_name')}>SLO Name{sortIndicator('slo_name')}</th>
              <th style={thStyle('sli_category')} onClick={() => handleSort('sli_category')}>Category{sortIndicator('sli_category')}</th>
              <th style={{ ...thStyle('validation_score'), cursor: 'default' }}>Type</th>
              <th style={thStyle('validation_score')} onClick={() => handleSort('validation_score')}>Score{sortIndicator('validation_score')}</th>
              <th style={{ ...thStyle('validation_score'), cursor: 'default' }}>Status</th>
              <th style={{ ...thStyle('validation_score'), cursor: 'default' }}>Formula</th>
              <th style={{ ...thStyle('validation_score'), cursor: 'default' }}>Target</th>
              <th style={{ ...thStyle('validation_score'), cursor: 'default' }}>Windows</th>
            </tr>
          </thead>
          <tbody>
            {pageItems.map((slo) => {
              const rowKey = `${slo.tenant_id}#${slo.slo_id}`;
              const isExpanded = expandedId === rowKey;
              const sc = statusColor(slo.validation_status);
              const fi = formulaIcon(slo);
              return (
                <React.Fragment key={rowKey}>
                  <tr
                    onClick={() => setExpandedId(isExpanded ? null : rowKey)}
                    style={{
                      cursor: 'pointer',
                      background: isExpanded ? '#f8fafc' : 'white',
                      borderBottom: '1px solid #f1f5f9',
                    }}
                  >
                    {orgs.length > 1 && (
                      <td style={{ padding: '10px 12px', color: '#64748b', fontSize: 12 }}>{slo.tenant_id}</td>
                    )}
                    <td style={{ padding: '10px 12px', color: '#1e293b', fontWeight: 500, maxWidth: 280 }}>
                      <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={slo.slo_name}>
                        {slo.slo_name}
                      </div>
                    </td>
                    <td style={{ padding: '10px 12px' }}>
                      <span style={{
                        fontSize: 11, padding: '2px 7px', borderRadius: 4,
                        background: '#f1f5f9', color: '#475569', fontWeight: 500,
                      }}>
                        {categoryLabel(slo.sli_category)}
                      </span>
                    </td>
                    <td style={{ padding: '10px 12px', color: '#64748b', fontSize: 12 }}>{slo.slo_type}</td>
                    <td style={{ padding: '10px 12px', fontWeight: 700, color: fi.color === '#dc2626' ? '#dc2626' : '#1e293b' }}>
                      {slo.validation_score}
                    </td>
                    <td style={{ padding: '10px 12px' }}>
                      <span style={{
                        fontSize: 11, padding: '2px 8px', borderRadius: 4,
                        background: sc.bg, color: sc.text, fontWeight: 600,
                      }}>
                        {slo.validation_status?.replace('_', ' ')}
                      </span>
                    </td>
                    <td style={{ padding: '10px 12px', fontWeight: 700, color: fi.color, fontSize: 14 }}>
                      {fi.icon} <span style={{ fontSize: 11, fontWeight: 400 }}>{fi.label}</span>
                    </td>
                    <td style={{ padding: '10px 12px', color: '#64748b', fontSize: 12 }}>
                      {slo.target_percentage != null ? `${slo.target_percentage}%` : '—'}
                    </td>
                    <td style={{ padding: '10px 12px', color: '#64748b', fontSize: 12 }}>
                      {slo.time_windows?.join(', ') || '—'}
                    </td>
                  </tr>
                  {isExpanded && (
                    <tr style={{ background: '#f8fafc' }}>
                      <td colSpan={orgs.length > 1 ? 9 : 8} style={{ padding: '12px 20px 16px' }}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                          {slo.blocker_issues?.length > 0 && (
                            <div>
                              <div style={{ fontSize: 11, fontWeight: 700, color: '#dc2626', marginBottom: 4, textTransform: 'uppercase' }}>
                                🚫 Blocker Issues
                              </div>
                              {slo.blocker_issues.map((issue, i) => (
                                <div key={i} style={{ fontSize: 12, color: '#dc2626', padding: '3px 0', paddingLeft: 12 }}>• {issue}</div>
                              ))}
                            </div>
                          )}
                          {slo.quality_issues?.length > 0 && (
                            <div>
                              <div style={{ fontSize: 11, fontWeight: 700, color: '#a16207', marginBottom: 4, textTransform: 'uppercase' }}>
                                ⚠ Quality Issues
                              </div>
                              {slo.quality_issues.map((issue, i) => (
                                <div key={i} style={{ fontSize: 12, color: '#a16207', padding: '3px 0', paddingLeft: 12 }}>• {issue}</div>
                              ))}
                            </div>
                          )}
                          {slo.enhancements?.length > 0 && (
                            <div>
                              <div style={{ fontSize: 11, fontWeight: 700, color: '#1d4ed8', marginBottom: 4, textTransform: 'uppercase' }}>
                                💡 Enhancements
                              </div>
                              {slo.enhancements.map((item, i) => (
                                <div key={i} style={{ fontSize: 12, color: '#1d4ed8', padding: '3px 0', paddingLeft: 12 }}>• {item}</div>
                              ))}
                            </div>
                          )}
                          {slo.insight && (
                            <div style={{
                              background: '#f5f3ff', border: '1px solid #ddd6fe',
                              borderRadius: 6, padding: '10px 14px',
                            }}>
                              <div style={{ fontSize: 11, fontWeight: 700, color: '#7c3aed', marginBottom: 4, textTransform: 'uppercase' }}>
                                🤖 AI Insight
                              </div>
                              <p style={{ fontSize: 13, color: '#4c1d95', lineHeight: 1.5, margin: 0 }}>{slo.insight}</p>
                            </div>
                          )}
                          {slo.tags?.length > 0 && (
                            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                              {slo.tags.slice(0, 10).map((tag, i) => (
                                <span key={i} style={{
                                  fontSize: 10, padding: '1px 6px', borderRadius: 3,
                                  background: '#f1f5f9', color: '#64748b',
                                }}>
                                  {tag}
                                </span>
                              ))}
                              {slo.tags.length > 10 && (
                                <span style={{ fontSize: 10, color: '#94a3b8' }}>+{slo.tags.length - 10} more</span>
                              )}
                            </div>
                          )}
                          <SloHistoryChart
                            sloId={slo.slo_id}
                            tenantId={slo.tenant_id}
                            targetPercentage={slo.target_percentage}
                          />
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
            {pageItems.length === 0 && (
              <tr>
                <td colSpan={orgs.length > 1 ? 9 : 8} style={{ padding: 32, textAlign: 'center', color: '#94a3b8' }}>
                  No SLOs match the current filters
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div style={{ display: 'flex', justifyContent: 'center', gap: 8, marginTop: 16 }}>
          <button
            onClick={() => setPage(p => Math.max(0, p - 1))}
            disabled={page === 0}
            style={{
              padding: '6px 14px', border: '1px solid #e2e8f0', borderRadius: 6,
              fontSize: 13, cursor: page === 0 ? 'not-allowed' : 'pointer',
              background: page === 0 ? '#f8fafc' : 'white', color: page === 0 ? '#94a3b8' : '#1e293b',
            }}
          >
            ← Prev
          </button>
          <span style={{ fontSize: 13, color: '#64748b', alignSelf: 'center' }}>
            Page {page + 1} of {totalPages}
          </span>
          <button
            onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
            disabled={page >= totalPages - 1}
            style={{
              padding: '6px 14px', border: '1px solid #e2e8f0', borderRadius: 6,
              fontSize: 13, cursor: page >= totalPages - 1 ? 'not-allowed' : 'pointer',
              background: page >= totalPages - 1 ? '#f8fafc' : 'white',
              color: page >= totalPages - 1 ? '#94a3b8' : '#1e293b',
            }}
          >
            Next →
          </button>
        </div>
      )}
    </div>
  );
}
