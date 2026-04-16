import React from 'react';
import type { SloOrgSummary } from '../services/slo-api';

interface Props {
  summary: SloOrgSummary;
}

function tierColor(tier: string): { bg: string; text: string; border: string } {
  // Normalize: 'needs_improvement' → 'needs improvement', handle both forms
  const normalized = tier.toLowerCase().replace(/_/g, ' ');
  switch (normalized) {
    case 'excellent': return { bg: '#dcfce7', text: '#15803d', border: '#86efac' };
    case 'good': return { bg: '#dbeafe', text: '#1d4ed8', border: '#93c5fd' };
    case 'needs improvement': return { bg: '#fef9c3', text: '#a16207', border: '#fde047' };
    case 'poor': return { bg: '#ffedd5', text: '#c2410c', border: '#fdba74' };
    case 'critical': return { bg: '#fee2e2', text: '#dc2626', border: '#fca5a5' };
    default: return { bg: '#f1f5f9', text: '#475569', border: '#cbd5e1' };
  }
}

function scoreColor(score: number): string {
  if (score >= 90) return '#15803d';
  if (score >= 75) return '#1d4ed8';
  if (score >= 50) return '#a16207';
  if (score >= 25) return '#c2410c';
  return '#dc2626';
}

function monitoringBadge(ctx: SloOrgSummary['monitoring_context']): string {
  if (ctx.apm_enabled && ctx.synthetics_enabled) return 'APM + Synthetics + Infra';
  if (ctx.apm_enabled) return 'APM + Infra';
  if (ctx.synthetics_enabled) return 'Synthetics + Infra';
  return 'Infra Only';
}

function CategoryBadge({ label, score, isNA }: { label: string; score: number | null | undefined; isNA: boolean }) {
  if (isNA) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
        <span style={{ fontSize: 11, color: '#94a3b8', fontWeight: 500 }}>{label}</span>
        <span style={{ fontSize: 11, color: '#94a3b8', background: '#f1f5f9', padding: '1px 6px', borderRadius: 4 }}>N/A</span>
      </div>
    );
  }
  if (score === null || score === undefined) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
        <span style={{ fontSize: 11, color: '#94a3b8', fontWeight: 500 }}>{label}</span>
        <span style={{ fontSize: 11, color: '#dc2626', background: '#fee2e2', padding: '1px 6px', borderRadius: 4 }}>✗ 0%</span>
      </div>
    );
  }
  const color = score >= 75 ? '#15803d' : score >= 50 ? '#a16207' : '#dc2626';
  const bg = score >= 75 ? '#dcfce7' : score >= 50 ? '#fef9c3' : '#fee2e2';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
      <span style={{ fontSize: 11, color: '#64748b', fontWeight: 500 }}>{label}</span>
      <span style={{ fontSize: 11, color, background: bg, padding: '1px 6px', borderRadius: 4, fontWeight: 600 }}>
        ✓ {Math.round(score)}%
      </span>
    </div>
  );
}

export default function SloOrgCard({ summary }: Props) {
  // Defensive defaults — agent may omit fields when writing summary
  const tier = tierColor(summary.compliance_tier ?? 'critical');
  const topGap = (summary.gap_analysis ?? [])[0];
  const naCategories: string[] = summary.na_categories ?? [];
  const categoryScores = summary.category_scores ?? {};
  const monCtx = summary.monitoring_context ?? { apm_enabled: false, synthetics_enabled: false, infra_monitoring: true };
  const misconfigured = summary.misconfigured_slos ?? 0;
  const unclassified = summary.unclassified_slos ?? 0;
  const score = summary.compliance_score ?? 0;

  return (
    <div style={{
      background: 'white',
      borderRadius: 12,
      padding: 20,
      boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
      border: '1px solid #e2e8f0',
      minWidth: 280,
      flex: '1 1 280px',
      maxWidth: 400,
    }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
        <div>
          <h3 style={{ fontSize: 15, fontWeight: 700, color: '#1e293b', marginBottom: 4 }}>
            {summary.tenant_id}
          </h3>
          <span style={{
            fontSize: 11, color: '#64748b',
            background: '#f1f5f9', padding: '2px 8px', borderRadius: 10,
          }}>
            {monitoringBadge(monCtx)}
          </span>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 32, fontWeight: 800, color: scoreColor(score), lineHeight: 1 }}>
            {score}
          </div>
          <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 2 }}>/ 100</div>
        </div>
      </div>

      {/* Tier badge */}
      <div style={{ marginBottom: 14 }}>
        <span style={{
          fontSize: 12, fontWeight: 600,
          background: tier.bg, color: tier.text,
          border: `1px solid ${tier.border}`,
          padding: '3px 10px', borderRadius: 6,
        }}>
          {(summary.compliance_tier ?? 'Critical').replace(/_/g, ' ')}
        </span>
      </div>

      {/* SLO counts */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, marginBottom: 14 }}>
        {[
          { label: 'Total', value: summary.total_slos ?? 0, color: '#1e293b' },
          { label: 'Valid', value: summary.valid_slos ?? 0, color: '#15803d' },
          { label: 'Issues', value: misconfigured, color: misconfigured > 0 ? '#dc2626' : '#64748b' },
          { label: 'Unclear', value: unclassified, color: unclassified > 0 ? '#a16207' : '#64748b' },
        ].map(({ label, value, color }) => (
          <div key={label} style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 18, fontWeight: 700, color }}>{value}</div>
            <div style={{ fontSize: 10, color: '#94a3b8' }}>{label}</div>
          </div>
        ))}
      </div>

      {/* Category coverage */}
      <div style={{
        display: 'flex', justifyContent: 'space-around',
        padding: '10px 0', borderTop: '1px solid #f1f5f9', borderBottom: '1px solid #f1f5f9',
        marginBottom: 12,
      }}>
        <CategoryBadge
          label="Availability"
          score={categoryScores.availability}
          isNA={naCategories.includes('availability')}
        />
        <CategoryBadge
          label="Latency"
          score={categoryScores.latency}
          isNA={naCategories.includes('latency')}
        />
        <CategoryBadge
          label="Error Rate"
          score={categoryScores.error_rate}
          isNA={naCategories.includes('error_rate')}
        />
      </div>

      {/* Top gap insight */}
      {topGap && (
        <div style={{
          background: '#fafafa', borderRadius: 6, padding: '8px 10px',
          borderLeft: `3px solid ${(topGap.severity ?? '').toLowerCase() === 'critical' ? '#dc2626' : (topGap.severity ?? '').toLowerCase() === 'high' ? '#f97316' : '#f59e0b'}`,
        }}>
          <div style={{ fontSize: 10, color: '#94a3b8', marginBottom: 3, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Top Gap · {(topGap.severity ?? '').toLowerCase()}
          </div>
          <p style={{ fontSize: 12, color: '#475569', lineHeight: 1.4, margin: 0 }}>
            {typeof topGap.issue === 'string' && topGap.issue.length > 120 ? topGap.issue.slice(0, 120) + '…' : String(topGap.issue ?? '')}
          </p>
        </div>
      )}
    </div>
  );
}
