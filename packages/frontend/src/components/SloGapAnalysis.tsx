import React, { useState, useMemo } from 'react';
import type { SloOrgSummary } from '../services/slo-api';

interface Props {
  orgSummaries: SloOrgSummary[];
}

interface GapRow {
  tenant_id: string;
  slo_name: string;       // specific SLO name, or '' for org-wide
  gap_type: string;       // theme / title
  severity: string;
  issue: string;
  recommendation?: string;
}

function severityOrder(sev: string): number {
  switch (sev) {
    case 'critical': return 0;
    case 'high': return 1;
    case 'medium': return 2;
    case 'low': return 3;
    default: return 4;
  }
}

function severityColor(sev: string): { bg: string; text: string; border: string } {
  switch (sev) {
    case 'critical': return { bg: '#fee2e2', text: '#dc2626', border: '#fca5a5' };
    case 'high':     return { bg: '#ffedd5', text: '#c2410c', border: '#fdba74' };
    case 'medium':   return { bg: '#fef9c3', text: '#a16207', border: '#fde047' };
    case 'low':      return { bg: '#dbeafe', text: '#1d4ed8', border: '#93c5fd' };
    default:         return { bg: '#f1f5f9', text: '#475569', border: '#cbd5e1' };
  }
}

function buildGapRows(orgSummaries: SloOrgSummary[]): GapRow[] {
  const rows: GapRow[] = [];
  for (const org of orgSummaries) {
    for (const gap of (org.gap_analysis ?? [])) {
      const names = gap.affected_slo_names ?? [];
      if (names.length === 0) {
        // Org-wide gap — no specific SLO
        rows.push({
          tenant_id: org.tenant_id,
          slo_name: '',
          gap_type: gap.gap_type ?? '',
          severity: gap.severity ?? 'medium',
          issue: gap.issue ?? '',
          recommendation: gap.recommendation,
        });
      } else {
        // Explode: one row per affected SLO
        for (const sloName of names) {
          rows.push({
            tenant_id: org.tenant_id,
            slo_name: sloName,
            gap_type: gap.gap_type ?? '',
            severity: gap.severity ?? 'medium',
            issue: gap.issue ?? '',
            recommendation: gap.recommendation,
          });
        }
      }
    }
  }
  return rows;
}

const PAGE_SIZE = 50;

export default function SloGapAnalysis({ orgSummaries }: Props) {
  const [filterOrg, setFilterOrg] = useState('');
  const [filterSeverity, setFilterSeverity] = useState('');
  const [expandedRow, setExpandedRow] = useState<number | null>(null);
  const [page, setPage] = useState(0);

  const orgs = useMemo(() => orgSummaries.map(s => s.tenant_id).sort(), [orgSummaries]);

  const allRows = useMemo(() => buildGapRows(orgSummaries), [orgSummaries]);

  const filtered = useMemo(() => {
    let rows = allRows;
    if (filterOrg) rows = rows.filter(r => r.tenant_id === filterOrg);
    if (filterSeverity) rows = rows.filter(r => r.severity === filterSeverity);
    return [...rows].sort((a, b) => severityOrder(a.severity) - severityOrder(b.severity));
  }, [allRows, filterOrg, filterSeverity]);

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const pageRows = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  // Severity counts for summary bar
  const counts = useMemo(() => {
    const c = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const r of allRows) {
      if (r.severity in c) c[r.severity as keyof typeof c]++;
    }
    return c;
  }, [allRows]);

  if (allRows.length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: 48, color: '#94a3b8' }}>
        No gap analysis available.
      </div>
    );
  }

  const thStyle: React.CSSProperties = {
    padding: '10px 14px', textAlign: 'left', fontSize: 12, fontWeight: 600,
    color: '#64748b', background: '#f8fafc', borderBottom: '2px solid #e2e8f0',
    whiteSpace: 'nowrap',
  };

  return (
    <div>
      {/* Summary bar */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 18, flexWrap: 'wrap', alignItems: 'center' }}>
        {(['critical', 'high', 'medium', 'low'] as const).map(sev => {
          const n = counts[sev];
          if (n === 0) return null;
          const sc = severityColor(sev);
          return (
            <button
              key={sev}
              onClick={() => { setFilterSeverity(filterSeverity === sev ? '' : sev); setPage(0); }}
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '5px 12px', borderRadius: 20,
                border: `1px solid ${filterSeverity === sev ? sc.border : '#e2e8f0'}`,
                background: filterSeverity === sev ? sc.bg : 'white',
                color: filterSeverity === sev ? sc.text : '#64748b',
                cursor: 'pointer', fontSize: 12, fontWeight: 600,
                transition: 'all 0.15s',
              }}
            >
              <span style={{
                width: 8, height: 8, borderRadius: '50%',
                background: sc.text, display: 'inline-block',
              }} />
              {n} {sev}
            </button>
          );
        })}
        <span style={{ fontSize: 13, color: '#94a3b8', marginLeft: 4 }}>
          {allRows.length} total issues
        </span>
        {orgs.length > 1 && (
          <select value={filterOrg} onChange={e => { setFilterOrg(e.target.value); setPage(0); }}
            style={{ marginLeft: 'auto', padding: '6px 10px', border: '1px solid #e2e8f0', borderRadius: 6, fontSize: 13, color: '#1e293b', background: 'white' }}>
            <option value=''>All orgs</option>
            {orgs.map(o => <option key={o} value={o}>{o}</option>)}
          </select>
        )}
        {(filterOrg || filterSeverity) && (
          <button onClick={() => { setFilterOrg(''); setFilterSeverity(''); setPage(0); }}
            style={{ padding: '5px 10px', border: '1px solid #e2e8f0', borderRadius: 6, fontSize: 12, color: '#94a3b8', background: 'white', cursor: 'pointer' }}>
            Clear filters
          </button>
        )}
      </div>

      {/* Table */}
      <div style={{ overflowX: 'auto', borderRadius: 10, border: '1px solid #e2e8f0', boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr>
              {orgs.length > 1 && <th style={thStyle}>Org</th>}
              <th style={thStyle}>SLO Name</th>
              <th style={{ ...thStyle, minWidth: 180 }}>Gap Type</th>
              <th style={thStyle}>Severity</th>
              <th style={{ ...thStyle, minWidth: 300 }}>Issue</th>
              <th style={{ ...thStyle, minWidth: 260 }}>Recommendation</th>
            </tr>
          </thead>
          <tbody>
            {pageRows.map((row, i) => {
              const globalIdx = page * PAGE_SIZE + i;
              const isExpanded = expandedRow === globalIdx;
              const sc = severityColor(row.severity);
              const isOrgWide = !row.slo_name;
              return (
                <React.Fragment key={globalIdx}>
                  <tr
                    onClick={() => setExpandedRow(isExpanded ? null : globalIdx)}
                    style={{
                      borderBottom: isExpanded ? 'none' : '1px solid #f1f5f9',
                      background: isExpanded ? '#fafafa' : 'white',
                      cursor: 'pointer',
                      transition: 'background 0.1s',
                    }}
                    onMouseEnter={e => { if (!isExpanded) (e.currentTarget as HTMLTableRowElement).style.background = '#f8fafc'; }}
                    onMouseLeave={e => { if (!isExpanded) (e.currentTarget as HTMLTableRowElement).style.background = 'white'; }}
                  >
                    {orgs.length > 1 && (
                      <td style={{ padding: '11px 14px', color: '#64748b', fontSize: 12, whiteSpace: 'nowrap', verticalAlign: 'top' }}>
                        {row.tenant_id}
                      </td>
                    )}
                    <td style={{ padding: '11px 14px', maxWidth: 220, verticalAlign: 'top' }}>
                      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
                        <span style={{ fontSize: 10, color: '#94a3b8', marginTop: 2, flexShrink: 0 }}>
                          {isExpanded ? '▼' : '▶'}
                        </span>
                        {isOrgWide ? (
                          <span style={{ fontSize: 11, color: '#94a3b8', fontStyle: 'italic' }}>— org-wide</span>
                        ) : (
                          <div style={{ fontWeight: 600, color: '#1e293b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={row.slo_name}>
                            {row.slo_name}
                          </div>
                        )}
                      </div>
                    </td>
                    <td style={{ padding: '11px 14px', maxWidth: 200, verticalAlign: 'top' }}>
                      <div style={{ fontSize: 12, color: '#475569', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={row.gap_type}>
                        {row.gap_type}
                      </div>
                    </td>
                    <td style={{ padding: '11px 14px', verticalAlign: 'top', whiteSpace: 'nowrap' }}>
                      <span style={{
                        fontSize: 11, padding: '2px 9px', borderRadius: 12,
                        background: sc.bg, color: sc.text, fontWeight: 700,
                        textTransform: 'uppercase', letterSpacing: '0.04em',
                        border: `1px solid ${sc.border}`,
                      }}>
                        {row.severity}
                      </span>
                    </td>
                    <td style={{ padding: '11px 14px', color: '#374151', lineHeight: 1.5, verticalAlign: 'top' }}>
                      {!isExpanded && (
                        <div style={{
                          display: '-webkit-box', WebkitLineClamp: 2,
                          WebkitBoxOrient: 'vertical', overflow: 'hidden',
                        }}>
                          {row.issue}
                        </div>
                      )}
                      {isExpanded && (
                        <span style={{ fontSize: 11, color: '#94a3b8', fontStyle: 'italic' }}>expanded below ↓</span>
                      )}
                    </td>
                    <td style={{ padding: '11px 14px', color: '#475569', lineHeight: 1.5, verticalAlign: 'top' }}>
                      {!isExpanded && row.recommendation && (
                        <div style={{
                          display: '-webkit-box', WebkitLineClamp: 2,
                          WebkitBoxOrient: 'vertical', overflow: 'hidden',
                        }}>
                          {row.recommendation}
                        </div>
                      )}
                      {!isExpanded && !row.recommendation && (
                        <span style={{ color: '#cbd5e1', fontSize: 12 }}>—</span>
                      )}
                      {isExpanded && (
                        <span style={{ fontSize: 11, color: '#94a3b8', fontStyle: 'italic' }}>expanded below ↓</span>
                      )}
                    </td>
                  </tr>
                  {isExpanded && (
                    <tr style={{ background: '#f8fafc', borderBottom: '2px solid #e2e8f0' }}>
                      <td colSpan={orgs.length > 1 ? 6 : 5} style={{ padding: '12px 20px 16px 20px' }}>
                        <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
                          <div style={{ flex: 1, minWidth: 260 }}>
                            <div style={{ fontSize: 11, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
                              Issue
                            </div>
                            <p style={{ fontSize: 13, color: '#374151', lineHeight: 1.65, margin: 0 }}>{row.issue}</p>
                          </div>
                          {row.recommendation && (
                            <div style={{ flex: 1, minWidth: 260, borderLeft: '3px solid #bfdbfe', paddingLeft: 16 }}>
                              <div style={{ fontSize: 11, fontWeight: 700, color: '#1d4ed8', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
                                Recommendation
                              </div>
                              <p style={{ fontSize: 13, color: '#374151', lineHeight: 1.65, margin: 0 }}>{row.recommendation}</p>
                            </div>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
            {pageRows.length === 0 && (
              <tr>
                <td colSpan={orgs.length > 1 ? 6 : 5} style={{ padding: 32, textAlign: 'center', color: '#94a3b8' }}>
                  No issues match the current filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div style={{ display: 'flex', justifyContent: 'center', gap: 8, marginTop: 16 }}>
          <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0}
            style={{ padding: '6px 14px', border: '1px solid #e2e8f0', borderRadius: 6, fontSize: 13, cursor: page === 0 ? 'not-allowed' : 'pointer', background: page === 0 ? '#f8fafc' : 'white', color: page === 0 ? '#94a3b8' : '#1e293b' }}>
            ← Prev
          </button>
          <span style={{ fontSize: 13, color: '#64748b', alignSelf: 'center' }}>
            {filtered.length} issues · Page {page + 1} of {totalPages}
          </span>
          <button onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1}
            style={{ padding: '6px 14px', border: '1px solid #e2e8f0', borderRadius: 6, fontSize: 13, cursor: page >= totalPages - 1 ? 'not-allowed' : 'pointer', background: page >= totalPages - 1 ? '#f8fafc' : 'white', color: page >= totalPages - 1 ? '#94a3b8' : '#1e293b' }}>
            Next →
          </button>
        </div>
      )}
    </div>
  );
}
