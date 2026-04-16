import React, { useEffect, useState } from 'react';
import { getSloHistory } from '../services/slo-api';
import type { SloHistoryDataPoint, SloHistoryResponse } from '../services/slo-api';
import { useAuth } from '../contexts/AuthContext';

interface Props {
  sloId: string;
  tenantId: string;
  targetPercentage: number | null;
  /** When true, renders a larger chart suitable for a modal */
  expanded?: boolean;
}

function buildPath(points: { x: number; y: number }[]): string {
  if (points.length === 0) return '';
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
}

function buildAreaPath(points: { x: number; y: number }[], bottomY: number): string {
  if (points.length === 0) return '';
  const line = buildPath(points);
  const last = points[points.length - 1];
  const first = points[0];
  return `${line} L ${last.x.toFixed(1)} ${bottomY} L ${first.x.toFixed(1)} ${bottomY} Z`;
}

function renderChart(
  dataPoints: SloHistoryDataPoint[],
  target: number,
  expanded: boolean,
) {
  const CHART_W = expanded ? 760 : 520;
  const CHART_H = expanded ? 220 : 110;
  const PAD_LEFT = expanded ? 52 : 44;
  const PAD_RIGHT = expanded ? 16 : 12;
  const PAD_TOP = expanded ? 16 : 10;
  const PAD_BOTTOM = expanded ? 36 : 26;
  const INNER_W = CHART_W - PAD_LEFT - PAD_RIGHT;
  const INNER_H = CHART_H - PAD_TOP - PAD_BOTTOM;

  const sliValues = dataPoints.map(p => p.sli_value);
  const rawMin = Math.min(...sliValues);
  const rawMax = Math.max(...sliValues);

  const allValues = [...sliValues, target];
  const dataMin = Math.min(...allValues);
  const dataMax = Math.max(...allValues);
  const range = dataMax - dataMin || 0.5;
  const yMin = Math.max(0, dataMin - range * 0.2);
  const yMax = Math.min(100, dataMax + range * 0.2);
  const yRange = yMax - yMin || 1;

  const toX = (i: number) => PAD_LEFT + (i / Math.max(dataPoints.length - 1, 1)) * INNER_W;
  const toY = (v: number) => PAD_TOP + INNER_H - ((v - yMin) / yRange) * INNER_H;

  const chartPoints = dataPoints.map((p, i) => ({ x: toX(i), y: toY(p.sli_value) }));
  const targetY = toY(target);
  const bottomY = PAD_TOP + INNER_H;

  const anyBelowTarget = sliValues.some(v => v < target);
  const lineColor = anyBelowTarget ? '#dc2626' : '#15803d';
  const areaColor = anyBelowTarget ? 'rgba(220,38,38,0.07)' : 'rgba(21,128,61,0.07)';

  // Y axis ticks — 4 ticks for expanded, 3 for compact
  const tickCount = expanded ? 4 : 3;
  const yTicks = Array.from({ length: tickCount }, (_, i) => {
    const v = yMin + (yMax - yMin) * (i / (tickCount - 1));
    return { value: v, y: toY(v), label: v.toFixed(2) + '%' };
  });

  // X axis labels — show month labels, skip to avoid crowding
  const step = dataPoints.length > 10 ? Math.ceil(dataPoints.length / (expanded ? 10 : 6)) : 1;
  const xLabels = dataPoints
    .map((p, i) => ({ i, month: p.month }))
    .filter((_, i) => i % step === 0 || i === dataPoints.length - 1);

  const fontSize = expanded ? 10 : 9;

  return (
    <div>
      <div style={{ overflowX: 'auto' }}>
        <svg
          width={CHART_W}
          height={CHART_H}
          style={{ display: 'block', fontFamily: 'inherit' }}
          viewBox={`0 0 ${CHART_W} ${CHART_H}`}
        >
          {/* Grid lines */}
          {yTicks.map((tick, i) => (
            <line key={i} x1={PAD_LEFT} y1={tick.y} x2={PAD_LEFT + INNER_W} y2={tick.y}
              stroke="#f1f5f9" strokeWidth={1} />
          ))}

          {/* Target line */}
          <line x1={PAD_LEFT} y1={targetY} x2={PAD_LEFT + INNER_W} y2={targetY}
            stroke="#f59e0b" strokeWidth={1.5} strokeDasharray="5 3" />
          <text x={PAD_LEFT + INNER_W + 2} y={targetY + 4}
            fontSize={fontSize - 1} fill="#f59e0b" fontWeight={600}>
            {target}%
          </text>

          {/* Area fill */}
          <path d={buildAreaPath(chartPoints, bottomY)} fill={areaColor} />

          {/* Line */}
          <path d={buildPath(chartPoints)} fill="none" stroke={lineColor}
            strokeWidth={expanded ? 2.5 : 2} strokeLinejoin="round" />

          {/* Data point dots — only in expanded mode or when few points */}
          {(expanded || dataPoints.length <= 12) && chartPoints.map((p, i) => (
            <circle key={i} cx={p.x} cy={p.y} r={expanded ? 4 : 3} fill={lineColor}
              stroke="white" strokeWidth={1} />
          ))}

          {/* Tooltip-style value labels in expanded mode */}
          {expanded && chartPoints.map((p, i) => (
            <text key={i} x={p.x} y={p.y - 8} fontSize={9} fill={lineColor}
              textAnchor="middle" fontWeight={600}>
              {dataPoints[i].sli_value.toFixed(2)}%
            </text>
          ))}

          {/* Y axis labels */}
          {yTicks.map((tick, i) => (
            <text key={i} x={PAD_LEFT - 4} y={tick.y + 4}
              fontSize={fontSize} fill="#94a3b8" textAnchor="end">
              {tick.label}
            </text>
          ))}

          {/* X axis labels */}
          {xLabels.map(({ i, month }) => (
            <text key={i} x={toX(i)} y={CHART_H - (expanded ? 6 : 4)}
              fontSize={fontSize} fill="#94a3b8" textAnchor="middle">
              {month}
            </text>
          ))}

          {/* Axes */}
          <line x1={PAD_LEFT} y1={PAD_TOP} x2={PAD_LEFT} y2={bottomY}
            stroke="#e2e8f0" strokeWidth={1} />
          <line x1={PAD_LEFT} y1={bottomY} x2={PAD_LEFT + INNER_W} y2={bottomY}
            stroke="#e2e8f0" strokeWidth={1} />
        </svg>
      </div>

      {/* Legend */}
      <div style={{ display: 'flex', gap: 16, marginTop: 6, fontSize: 11, color: '#64748b', flexWrap: 'wrap' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ width: 16, height: 2, background: lineColor, display: 'inline-block', borderRadius: 1 }} />
          SLI% · min {rawMin.toFixed(3)}% · max {rawMax.toFixed(3)}%
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ width: 12, height: 0, borderTop: '2px dashed #f59e0b', display: 'inline-block' }} />
          Target {target}%
        </span>
        {anyBelowTarget && (
          <span style={{ color: '#dc2626', fontWeight: 600 }}>⚠ Below target</span>
        )}
      </div>
    </div>
  );
}

export default function SloHistoryChart({ sloId, tenantId, targetPercentage, expanded = false }: Props) {
  const { token } = useAuth();
  const [resp, setResp] = useState<SloHistoryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    setLoading(true);
    setError(null);
    getSloHistory(token, sloId, tenantId)
      .then(r => setResp(r))
      .catch(err => setError(String(err)))
      .finally(() => setLoading(false));
  }, [token, sloId, tenantId]);

  if (loading) {
    return (
      <div style={{ padding: expanded ? '24px 0' : '10px 0', color: '#94a3b8', fontSize: 12, textAlign: expanded ? 'center' : 'left' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={{
            width: 12, height: 12, border: '2px solid #e2e8f0', borderTopColor: '#94a3b8',
            borderRadius: '50%', display: 'inline-block', animation: 'spin 1s linear infinite',
          }} />
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
          Loading performance history...
        </span>
      </div>
    );
  }

  if (error) {
    return null;
  }

  const target = targetPercentage ?? 99.9;
  const dataPoints = resp?.data_points ?? [];
  const overallSli = resp?.overall_sli;

  // No time-series data — show overall SLI gauge if available
  if (dataPoints.length === 0) {
    if (overallSli != null) {
      const color = overallSli >= target ? '#15803d' : '#dc2626';
      const bg = overallSli >= target ? '#dcfce7' : '#fee2e2';
      return (
        <div style={{ padding: expanded ? '20px 0' : '10px 0' }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#7c3aed', marginBottom: 8, textTransform: 'uppercase' }}>
            📈 Overall SLI
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{
              fontSize: expanded ? 36 : 24, fontWeight: 800, color,
              background: bg, padding: expanded ? '12px 20px' : '6px 14px',
              borderRadius: 8, lineHeight: 1,
            }}>
              {overallSli.toFixed(3)}%
            </div>
            <div style={{ fontSize: 12, color: '#64748b' }}>
              <div>Target: {target}%</div>
              <div style={{ color, fontWeight: 600 }}>
                {overallSli >= target ? '✓ Meeting target' : '✗ Below target'}
              </div>
            </div>
          </div>
        </div>
      );
    }
    return null;
  }

  return (
    <div style={{ marginTop: expanded ? 0 : 10 }}>
      {!expanded && (
        <div style={{ fontSize: 11, fontWeight: 700, color: '#7c3aed', marginBottom: 6, textTransform: 'uppercase' }}>
          📈 SLI Performance Trend (12 months)
        </div>
      )}
      {renderChart(dataPoints, target, expanded)}
    </div>
  );
}
