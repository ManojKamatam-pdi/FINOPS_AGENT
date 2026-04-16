import React, { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import type { SloResult, SloHistoryDataPoint } from '../services/slo-api';
import { getSloHistory } from '../services/slo-api';
import { useAuth } from '../contexts/AuthContext';

interface Props {
  sloResults: SloResult[];
}

// 12 distinct colors for lines
const LINE_COLORS = [
  '#2563eb', '#dc2626', '#16a34a', '#d97706', '#7c3aed',
  '#0891b2', '#db2777', '#65a30d', '#ea580c', '#6366f1',
  '#0d9488', '#b45309',
];

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

interface SeriesData {
  slo: SloResult;
  points: SloHistoryDataPoint[];
  overallSli: number | null;
  color: string;
  loading: boolean;
  error: boolean;
}

function buildPath(pts: { x: number; y: number }[]): string {
  if (pts.length < 2) return '';
  return pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
}

// ─── Searchable SLO multi-select combobox ────────────────────────────────────

interface SloFilterProps {
  series: SeriesData[];
  selectedIds: Set<string>;
  onToggle: (key: string) => void;
  onClear: () => void;
}

function SloFilterCombobox({ series, selectedIds, onToggle, onClear }: SloFilterProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Close on outside click
  useEffect(() => {
    function handleMouseDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setSearch('');
      }
    }
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, []);

  // Close on Escape
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') { setOpen(false); setSearch(''); }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  function openDropdown() {
    setOpen(true);
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  const filtered = useMemo(() => {
    if (!search.trim()) return series;
    const q = search.toLowerCase();
    return series.filter(s => s.slo.slo_name.toLowerCase().includes(q));
  }, [series, search]);

  const chips = series.filter(s => selectedIds.has(`${s.slo.tenant_id}#${s.slo.slo_id}`));
  const hasSelection = selectedIds.size > 0;

  return (
    <div ref={containerRef} style={{ position: 'relative', flex: 1, minWidth: 0 }}>
      {/* Trigger / chip container */}
      <div
        onClick={openDropdown}
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: 6,
          minHeight: 36,
          padding: chips.length > 0 ? '4px 8px' : '0 10px',
          border: `1px solid ${open ? '#2563eb' : '#e2e8f0'}`,
          borderRadius: 8,
          background: 'white',
          cursor: 'text',
          boxShadow: open ? '0 0 0 3px rgba(37,99,235,0.1)' : 'none',
          transition: 'border-color 0.15s, box-shadow 0.15s',
        }}
      >
        {chips.length === 0 && (
          <span style={{ fontSize: 13, color: '#94a3b8', lineHeight: '36px', userSelect: 'none' }}>
            Filter SLOs…
          </span>
        )}
        {chips.map(s => {
          const key = `${s.slo.tenant_id}#${s.slo.slo_id}`;
          return (
            <span
              key={key}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                padding: '2px 8px 2px 6px',
                borderRadius: 20,
                background: `${s.color}18`,
                border: `1px solid ${s.color}55`,
                fontSize: 12,
                fontWeight: 600,
                color: s.color,
                maxWidth: 200,
                whiteSpace: 'nowrap',
              }}
            >
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: s.color, flexShrink: 0 }} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 160 }}>{s.slo.slo_name}</span>
              <button
                onClick={e => { e.stopPropagation(); onToggle(key); }}
                style={{
                  background: 'none', border: 'none', cursor: 'pointer',
                  padding: 0, marginLeft: 2, lineHeight: 1,
                  color: s.color, fontSize: 14, fontWeight: 700,
                  display: 'flex', alignItems: 'center',
                }}
                aria-label={`Remove ${s.slo.slo_name}`}
              >×</button>
            </span>
          );
        })}
        {/* Caret */}
        <span style={{
          marginLeft: 'auto',
          color: '#94a3b8',
          fontSize: 10,
          lineHeight: 1,
          transform: open ? 'rotate(180deg)' : 'none',
          transition: 'transform 0.15s',
          flexShrink: 0,
          paddingLeft: 4,
        }}>▼</span>
      </div>

      {/* Dropdown panel */}
      {open && (
        <div style={{
          position: 'absolute',
          top: 'calc(100% + 4px)',
          left: 0,
          right: 0,
          background: 'white',
          border: '1px solid #e2e8f0',
          borderRadius: 10,
          boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
          zIndex: 200,
          overflow: 'hidden',
        }}>
          {/* Search input */}
          <div style={{ padding: '8px 10px', borderBottom: '1px solid #f1f5f9', display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ color: '#94a3b8', fontSize: 13, flexShrink: 0 }}>🔍</span>
            <input
              ref={inputRef}
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search SLOs…"
              style={{
                flex: 1,
                border: 'none',
                outline: 'none',
                fontSize: 13,
                color: '#1e293b',
                background: 'transparent',
              }}
            />
            {search && (
              <button onClick={() => setSearch('')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94a3b8', fontSize: 14, padding: 0 }}>×</button>
            )}
          </div>

          {/* SLO list */}
          <div style={{ maxHeight: 280, overflowY: 'auto' }}>
            {filtered.length === 0 ? (
              <div style={{ padding: '12px 14px', fontSize: 13, color: '#94a3b8', textAlign: 'center' }}>No SLOs match "{search}"</div>
            ) : (
              filtered.map((s, idx) => {
                const key = `${s.slo.tenant_id}#${s.slo.slo_id}`;
                const isSelected = selectedIds.has(key);
                const hasTs = s.points.length >= 2;
                const noData = !s.loading && !hasTs;
                return (
                  <div
                    key={key}
                    onClick={() => onToggle(key)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      padding: '8px 14px',
                      cursor: 'pointer',
                      background: isSelected ? '#f0f7ff' : 'white',
                      borderBottom: idx < filtered.length - 1 ? '1px solid #f8fafc' : 'none',
                      transition: 'background 0.1s',
                      opacity: noData ? 0.5 : 1,
                    }}
                    onMouseEnter={e => { if (!isSelected) (e.currentTarget as HTMLDivElement).style.background = '#f8fafc'; }}
                    onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background = isSelected ? '#f0f7ff' : 'white'; }}
                  >
                    {/* Color dot */}
                    <span style={{
                      width: 10, height: 10, borderRadius: '50%', flexShrink: 0,
                      background: noData ? '#cbd5e1' : s.color,
                      border: noData ? '1.5px solid #cbd5e1' : 'none',
                    }} />
                    {/* SLO name */}
                    <span style={{
                      flex: 1,
                      fontSize: 13,
                      fontWeight: isSelected ? 600 : 400,
                      color: noData ? '#94a3b8' : '#1e293b',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}>{s.slo.slo_name}</span>
                    {/* Category badge */}
                    <span style={{
                      fontSize: 10,
                      fontWeight: 600,
                      color: noData ? '#cbd5e1' : s.color,
                      background: noData ? '#f8fafc' : `${s.color}14`,
                      padding: '2px 6px',
                      borderRadius: 10,
                      flexShrink: 0,
                      whiteSpace: 'nowrap',
                    }}>{categoryLabel(s.slo.sli_category)}</span>
                    {/* Org name (only if multiple orgs) */}
                    <span style={{ fontSize: 11, color: '#94a3b8', flexShrink: 0, whiteSpace: 'nowrap' }}>{s.slo.tenant_id}</span>
                    {/* Checkmark */}
                    {isSelected && (
                      <span style={{ color: '#2563eb', fontSize: 14, fontWeight: 700, flexShrink: 0 }}>✓</span>
                    )}
                  </div>
                );
              })
            )}
          </div>

          {/* Footer: clear selection */}
          {hasSelection && (
            <div style={{ borderTop: '1px solid #f1f5f9', padding: '6px 14px' }}>
              <button
                onClick={() => { onClear(); setOpen(false); setSearch(''); }}
                style={{
                  background: 'none', border: 'none', cursor: 'pointer',
                  fontSize: 12, color: '#64748b', padding: '2px 0',
                  fontWeight: 500,
                }}
              >Clear selection</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function SloTrendsView({ sloResults }: Props) {
  const { token } = useAuth();
  const [filterOrg, setFilterOrg] = useState('');
  const [filterCategory, setFilterCategory] = useState('');
  // Inclusion model: empty = show all, non-empty = show only selected
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [tooltip, setTooltip] = useState<{ x: number; y: number; lines: { name: string; value: string; color: string }[]; month: string } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const orgs = useMemo(() => [...new Set(sloResults.map(s => s.tenant_id))].sort(), [sloResults]);
  const categories = useMemo(() => [...new Set(sloResults.map(s => s.sli_category))].sort(), [sloResults]);

  const validSlos = useMemo(() =>
    sloResults.filter(s => s.slo_id && s.slo_id.length > 0),
    [sloResults]
  );

  const filtered = useMemo(() => {
    let items = validSlos;
    if (filterOrg) items = items.filter(s => s.tenant_id === filterOrg);
    if (filterCategory) items = items.filter(s => s.sli_category === filterCategory);
    return items;
  }, [validSlos, filterOrg, filterCategory]);

  // Series state — one entry per filtered SLO
  const [seriesMap, setSeriesMap] = useState<Map<string, SeriesData>>(new Map());

  // Fetch history for each filtered SLO
  useEffect(() => {
    if (!token) return;
    for (const slo of filtered) {
      const key = `${slo.tenant_id}#${slo.slo_id}`;
      if (seriesMap.has(key)) continue;
      setSeriesMap(prev => {
        const next = new Map(prev);
        next.set(key, {
          slo,
          points: [],
          overallSli: null,
          color: LINE_COLORS[next.size % LINE_COLORS.length],
          loading: true,
          error: false,
        });
        return next;
      });
      getSloHistory(token, slo.slo_id, slo.tenant_id)
        .then(resp => {
          setSeriesMap(prev => {
            const next = new Map(prev);
            const existing = next.get(key);
            if (existing) {
              next.set(key, { ...existing, points: resp.data_points, overallSli: resp.overall_sli, loading: false });
            }
            return next;
          });
        })
        .catch(() => {
          setSeriesMap(prev => {
            const next = new Map(prev);
            const existing = next.get(key);
            if (existing) next.set(key, { ...existing, loading: false, error: true });
            return next;
          });
        });
    }
  }, [token, filtered]); // eslint-disable-line

  // Assign stable colors based on insertion order
  const series: SeriesData[] = useMemo(() => {
    return filtered.map((slo, idx) => {
      const key = `${slo.tenant_id}#${slo.slo_id}`;
      const existing = seriesMap.get(key);
      return existing ?? {
        slo,
        points: [],
        overallSli: null,
        color: LINE_COLORS[idx % LINE_COLORS.length],
        loading: true,
        error: false,
      };
    }).map((s, idx) => ({ ...s, color: LINE_COLORS[idx % LINE_COLORS.length] }));
  }, [filtered, seriesMap]);

  // Inclusion model: empty selectedIds = show all
  const visibleSeries = useMemo(() =>
    selectedIds.size === 0
      ? series
      : series.filter(s => selectedIds.has(`${s.slo.tenant_id}#${s.slo.slo_id}`)),
    [series, selectedIds]
  );

  const toggleSlo = useCallback((key: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);

  // Collect all unique months across all loaded series
  const allMonths = useMemo(() => {
    const monthSet = new Set<string>();
    for (const s of series) {
      for (const p of s.points) monthSet.add(p.month);
    }
    return [...monthSet].sort();
  }, [series]);

  const loadingCount = series.filter(s => s.loading).length;
  const hasAnyData = visibleSeries.some(s => s.points.length > 0);

  if (validSlos.length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: 48, color: '#94a3b8' }}>
        No SLO data available for trend analysis.
      </div>
    );
  }

  // Chart dimensions
  const CHART_W = 900;
  const CHART_H = 340;
  const PAD_LEFT = 56;
  const PAD_RIGHT = 20;
  const PAD_TOP = 20;
  const PAD_BOTTOM = 44;
  const INNER_W = CHART_W - PAD_LEFT - PAD_RIGHT;
  const INNER_H = CHART_H - PAD_TOP - PAD_BOTTOM;

  // Y axis: 0–100 range, zoomed to data
  const allValues = visibleSeries.flatMap(s => s.points.map(p => p.sli_value));
  const rawMin = allValues.length > 0 ? Math.min(...allValues) : 90;
  const rawMax = allValues.length > 0 ? Math.max(...allValues) : 100;
  const range = rawMax - rawMin || 1;
  const yMin = Math.max(0, rawMin - range * 0.15);
  const yMax = Math.min(100, rawMax + range * 0.15);
  const yRange = yMax - yMin || 1;

  const toX = (monthIdx: number) =>
    PAD_LEFT + (allMonths.length <= 1 ? INNER_W / 2 : (monthIdx / (allMonths.length - 1)) * INNER_W);
  const toY = (v: number) => PAD_TOP + INNER_H - ((v - yMin) / yRange) * INNER_H;

  // Y ticks
  const Y_TICKS = 5;
  const yTicks = Array.from({ length: Y_TICKS }, (_, i) => {
    const v = yMin + (yMax - yMin) * (i / (Y_TICKS - 1));
    return { v, y: toY(v), label: v.toFixed(1) + '%' };
  });

  // X labels — show every Nth month to avoid crowding
  const xStep = allMonths.length > 12 ? Math.ceil(allMonths.length / 12) : 1;
  const xLabels = allMonths
    .map((m, i) => ({ m, i }))
    .filter(({ i }) => i % xStep === 0 || i === allMonths.length - 1);

  // Mouse move handler for tooltip
  function handleMouseMove(e: React.MouseEvent<SVGSVGElement>) {
    if (!svgRef.current || allMonths.length === 0) return;
    const rect = svgRef.current.getBoundingClientRect();
    const scaleX = CHART_W / rect.width;
    const mx = (e.clientX - rect.left) * scaleX;
    const relX = mx - PAD_LEFT;
    const frac = Math.max(0, Math.min(1, relX / INNER_W));
    const idx = Math.round(frac * (allMonths.length - 1));
    const month = allMonths[idx];
    if (!month) return;

    const lines = visibleSeries
      .filter(s => s.points.length > 0)
      .map(s => {
        const pt = s.points.find(p => p.month === month);
        return pt ? { name: s.slo.slo_name, value: pt.sli_value.toFixed(3) + '%', color: s.color } : null;
      })
      .filter(Boolean) as { name: string; value: string; color: string }[];

    if (lines.length === 0) { setTooltip(null); return; }

    const tipX = toX(idx);
    setTooltip({ x: tipX, y: PAD_TOP, lines, month });
  }

  return (
    <div>
      {/* Filter row: SLO combobox + org + category */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, alignItems: 'flex-start' }}>
        <SloFilterCombobox
          series={series}
          selectedIds={selectedIds}
          onToggle={toggleSlo}
          onClear={clearSelection}
        />
        {orgs.length > 1 && (
          <select value={filterOrg} onChange={e => setFilterOrg(e.target.value)}
            style={{ padding: '6px 10px', border: '1px solid #e2e8f0', borderRadius: 6, fontSize: 13, color: '#1e293b', background: 'white', flexShrink: 0 }}>
            <option value=''>All orgs</option>
            {orgs.map(o => <option key={o} value={o}>{o}</option>)}
          </select>
        )}
        <select value={filterCategory} onChange={e => setFilterCategory(e.target.value)}
          style={{ padding: '6px 10px', border: '1px solid #e2e8f0', borderRadius: 6, fontSize: 13, color: '#1e293b', background: 'white', flexShrink: 0 }}>
          <option value=''>All categories</option>
          {categories.map(c => <option key={c} value={c}>{categoryLabel(c)}</option>)}
        </select>
      </div>

      {/* Info line */}
      <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 12 }}>
        Monthly SLI performance over 12 months · {filtered.length} SLOs
        {selectedIds.size > 0 && <span style={{ color: '#2563eb', marginLeft: 6 }}>· {selectedIds.size} selected</span>}
        {loadingCount > 0 && <span style={{ marginLeft: 6 }}>· loading {loadingCount}…</span>}
      </div>

      {/* Chart */}
      <div style={{ background: 'white', borderRadius: 12, border: '1px solid #e2e8f0', padding: '20px 16px', boxShadow: '0 1px 4px rgba(0,0,0,0.05)' }}>
        {!hasAnyData && loadingCount > 0 ? (
          <div style={{ textAlign: 'center', padding: '60px 0', color: '#94a3b8', fontSize: 13 }}>
            <div style={{ marginBottom: 10 }}>Loading SLO history from Datadog…</div>
            <div style={{ fontSize: 11 }}>{loadingCount} of {filtered.length} SLOs loading</div>
          </div>
        ) : !hasAnyData ? (
          <div style={{ textAlign: 'center', padding: '60px 0', color: '#94a3b8', fontSize: 13 }}>
            No time-series history available for the selected SLOs.
          </div>
        ) : (
          <div style={{ overflowX: 'auto', position: 'relative' }}>
            <svg
              ref={svgRef}
              width={CHART_W}
              height={CHART_H}
              viewBox={`0 0 ${CHART_W} ${CHART_H}`}
              style={{ display: 'block', width: '100%', fontFamily: 'inherit' }}
              onMouseMove={handleMouseMove}
              onMouseLeave={() => setTooltip(null)}
            >
              {/* Grid lines */}
              {yTicks.map((t, i) => (
                <line key={i} x1={PAD_LEFT} y1={t.y} x2={PAD_LEFT + INNER_W} y2={t.y}
                  stroke="#f1f5f9" strokeWidth={1} />
              ))}

              {/* Y axis labels */}
              {yTicks.map((t, i) => (
                <text key={i} x={PAD_LEFT - 6} y={t.y + 4}
                  fontSize={10} fill="#94a3b8" textAnchor="end">{t.label}</text>
              ))}

              {/* X axis labels */}
              {xLabels.map(({ m, i }) => (
                <text key={i} x={toX(i)} y={CHART_H - 8}
                  fontSize={10} fill="#94a3b8" textAnchor="middle">{m}</text>
              ))}

              {/* Axes */}
              <line x1={PAD_LEFT} y1={PAD_TOP} x2={PAD_LEFT} y2={PAD_TOP + INNER_H} stroke="#e2e8f0" strokeWidth={1} />
              <line x1={PAD_LEFT} y1={PAD_TOP + INNER_H} x2={PAD_LEFT + INNER_W} y2={PAD_TOP + INNER_H} stroke="#e2e8f0" strokeWidth={1} />

              {/* Series lines */}
              {visibleSeries.map(s => {
                if (s.points.length < 2) return null;
                const pts = s.points.map(p => {
                  const idx = allMonths.indexOf(p.month);
                  return { x: toX(idx), y: toY(p.sli_value) };
                });
                return (
                  <path key={`${s.slo.tenant_id}#${s.slo.slo_id}`}
                    d={buildPath(pts)}
                    fill="none"
                    stroke={s.color}
                    strokeWidth={2}
                    strokeLinejoin="round"
                    opacity={0.9}
                  />
                );
              })}

              {/* Dots at each data point */}
              {visibleSeries.map(s =>
                s.points.map(p => {
                  const idx = allMonths.indexOf(p.month);
                  if (idx < 0) return null;
                  return (
                    <circle key={`${s.slo.slo_id}-${p.month}`}
                      cx={toX(idx)} cy={toY(p.sli_value)} r={3}
                      fill={s.color} stroke="white" strokeWidth={1.5}
                    />
                  );
                })
              )}

              {/* Tooltip vertical line */}
              {tooltip && (
                <line x1={tooltip.x} y1={PAD_TOP} x2={tooltip.x} y2={PAD_TOP + INNER_H}
                  stroke="#94a3b8" strokeWidth={1} strokeDasharray="4 3" />
              )}
            </svg>

            {/* Tooltip — absolutely positioned inside the chart container, no layout reflow */}
            {tooltip && (
              <div style={{
                position: 'absolute',
                top: PAD_TOP,
                left: `${Math.min((tooltip.x / CHART_W) * 100, 65)}%`,
                pointerEvents: 'none',
                background: 'white',
                border: '1px solid #e2e8f0',
                borderRadius: 8,
                padding: '8px 12px',
                boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
                fontSize: 12,
                minWidth: 180,
                maxWidth: 280,
                zIndex: 10,
              }}>
                <div style={{ fontWeight: 700, color: '#1e293b', marginBottom: 6, fontSize: 11 }}>{tooltip.month}</div>
                {tooltip.lines.map((l, i) => (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginBottom: 2 }}>
                    <span style={{ color: l.color, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 160 }}>{l.name}</span>
                    <span style={{ color: '#1e293b', fontWeight: 700, flexShrink: 0 }}>{l.value}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
