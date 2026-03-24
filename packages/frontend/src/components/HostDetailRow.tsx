import React from 'react';
import { HostResult } from '../services/api';

interface Props {
  host: HostResult;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(2)} GB/s`;
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(2)} MB/s`;
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(2)} KB/s`;
  return `${bytes.toFixed(0)} B/s`;
}

function MetricCard({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) {
  return (
    <div style={{ minWidth: 140 }}>
      <div style={{ color: '#64748b', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 }}>{label}</div>
      <div style={{ fontWeight: 700, fontSize: 15, color: '#1e293b' }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function NoData({ label }: { label: string }) {
  return (
    <div style={{ minWidth: 140 }}>
      <div style={{ color: '#64748b', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 }}>{label}</div>
      <div style={{ color: '#cbd5e1', fontSize: 13 }}>No data</div>
    </div>
  );
}

export default function HostDetailRow({ host }: Props) {
  const labelColor: Record<string, string> = {
    'over-provisioned': '#dc2626',
    'right-sized': '#16a34a',
    'under-provisioned': '#d97706',
    'unknown': '#94a3b8',
  };

  const hasSavings = (host.monthly_savings ?? 0) > 0;
  const hasRightSizing = !!(host.suggested_instance || host.current_monthly_cost || hasSavings);
  const hasInstanceSpecs = !!(host.instance_cpu_count || host.instance_ram_gb);
  const hasAnyMetrics = !!(host.cpu_avg_30d != null || host.cpu_p95_30d != null ||
    host.ram_avg_30d != null || host.disk_avg_30d != null || host.network_in_avg_30d != null);
  const noMetricsButKnownInstance = !hasAnyMetrics && !!(host.instance_type || hasInstanceSpecs);

  // Build a fallback recommendation from available data when agent wrote a keyword or null
  function buildFallbackRecommendation(): string | null {
    const cpu = host.cpu_avg_30d ?? host.cpu_p95_30d;
    const ram = host.ram_avg_30d;
    const label = host.efficiency_label;

    // No metrics but we know the instance — give cost context
    if (!cpu && !ram && host.instance_type) {
      const costStr = host.current_monthly_cost ? ` costing ~$${host.current_monthly_cost.toFixed(0)}/month` : '';
      return `No utilization metrics available for this host over 30 days — it is a ${host.instance_type}${host.instance_region ? ` in ${host.instance_region}` : ''}${costStr}. Install or verify the Datadog agent to enable utilization-based right-sizing.`;
    }
    if (!cpu && !ram) return null;

    const parts: string[] = [];
    if (cpu != null) parts.push(`CPU averaged ${cpu.toFixed(1)}%`);
    if (ram != null) parts.push(`RAM averaged ${ram.toFixed(1)}%`);
    const summary = parts.join(', ');

    if (label === 'over-provisioned') {
      if (host.suggested_instance && host.monthly_savings && host.monthly_savings > 0) {
        return `${summary} over 30 days — over-provisioned; downsize from ${host.instance_type} to ${host.suggested_instance} to save $${host.monthly_savings.toFixed(0)}/month.`;
      }
      return `${summary} over 30 days — over-provisioned; consider downsizing to match actual usage.`;
    }
    if (label === 'under-provisioned') {
      return `${summary} over 30 days — under-provisioned; consider scaling up to avoid performance issues.`;
    }
    if (label === 'right-sized') {
      if (host.suggested_instance && host.monthly_savings && host.monthly_savings > 0) {
        return `${summary} over 30 days — right-sized but a cheaper instance type ${host.suggested_instance} could save $${host.monthly_savings.toFixed(0)}/month.`;
      }
      return `${summary} over 30 days — right-sized for current workload.`;
    }
    return null;
  }

  const isKeywordRec = host.recommendation && host.recommendation.trim().split(/\s+/).length < 5;
  const displayRecommendation = isKeywordRec ? buildFallbackRecommendation() : (host.recommendation ?? buildFallbackRecommendation());

  return (
    <div style={{ padding: '20px 24px', background: '#f8fafc', borderTop: '1px solid #e2e8f0', fontSize: 13 }}>

      {/* ── Section 1: Utilisation metrics ── */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 12 }}>
          30-Day Utilisation
        </div>

        {noMetricsButKnownInstance ? (
          <div style={{
            padding: '10px 14px', background: '#fefce8', border: '1px solid #fde68a',
            borderRadius: 6, fontSize: 13, color: '#92400e', display: 'flex', alignItems: 'center', gap: 8,
          }}>
            ⚠️ No utilization metrics found in Datadog for this host over the last 30 days.
            The Datadog agent may not be installed, or this host may be stopped/terminated.
          </div>
        ) : (
        <div style={{ display: 'flex', gap: 32, flexWrap: 'wrap' }}>

          {/* Efficiency */}
          <div style={{ minWidth: 140 }}>
            <div style={{ color: '#64748b', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 }}>Efficiency</div>
            <span style={{
              padding: '3px 10px', borderRadius: 4, fontSize: 12, fontWeight: 700,
              background: '#f1f5f9', color: labelColor[host.efficiency_label] || '#64748b',
            }}>
              {host.efficiency_label}
              {host.efficiency_score != null ? ` · ${host.efficiency_score}/100` : ''}
            </span>
          </div>

          {/* CPU */}
          {host.cpu_avg_30d != null
            ? <MetricCard
                label="CPU avg / p95"
                value={`${host.cpu_avg_30d.toFixed(1)}% / ${host.cpu_p95_30d != null ? `${host.cpu_p95_30d.toFixed(1)}%` : '—'}`}
              />
            : host.cpu_p95_30d != null
              ? <MetricCard label="CPU p95" value={`${host.cpu_p95_30d.toFixed(1)}%`} sub="avg not available" />
              : <NoData label="CPU" />
          }

          {/* RAM */}
          {host.ram_avg_30d != null
            ? <MetricCard label="RAM avg" value={`${host.ram_avg_30d.toFixed(1)}%`} />
            : <NoData label="RAM avg" />
          }

          {/* Disk */}
          {host.disk_avg_30d != null
            ? <MetricCard label="Disk avg" value={`${host.disk_avg_30d.toFixed(1)}%`} />
            : <NoData label="Disk avg" />
          }

          {/* Network */}
          {host.network_in_avg_30d != null
            ? <MetricCard
                label="Network in / out"
                value={`${formatBytes(host.network_in_avg_30d)} / ${host.network_out_avg_30d != null ? formatBytes(host.network_out_avg_30d) : '—'}`}
              />
            : <NoData label="Network" />
          }

        </div>
        )}
      </div>

      {/* ── Section 2: Instance info ── */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 12 }}>
          Instance Info
        </div>
        <div style={{ display: 'flex', gap: 32, flexWrap: 'wrap' }}>

          {/* Cloud / region */}
          <MetricCard
            label="Cloud / region"
            value={host.cloud_provider || '—'}
            sub={host.instance_region ?? undefined}
          />

          {/* Instance type */}
          {host.instance_type
            ? <MetricCard label="Instance type" value={host.instance_type} />
            : <NoData label="Instance type" />
          }

          {/* Instance specs — show whatever we have */}
          {hasInstanceSpecs && (
            <MetricCard
              label="Provisioned specs"
              value={[
                host.instance_cpu_count != null ? `${host.instance_cpu_count} vCPU` : null,
                host.instance_ram_gb != null ? `${host.instance_ram_gb.toFixed(1)} GB RAM` : null,
              ].filter(Boolean).join(' · ') || '—'}
            />
          )}

        </div>
      </div>

      {/* ── Section 3: Right-sizing ── */}
      {hasRightSizing && (
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 12 }}>
            Right-Sizing
          </div>
          <div style={{ display: 'flex', gap: 32, flexWrap: 'wrap', alignItems: 'flex-start' }}>

            {host.current_monthly_cost != null && (
              <MetricCard label="Current cost" value={`$${host.current_monthly_cost.toFixed(2)}/mo`} />
            )}

            {host.suggested_instance && (
              <MetricCard label="Suggested instance" value={host.suggested_instance} />
            )}

            {host.suggested_monthly_cost != null && (
              <MetricCard label="Suggested cost" value={`$${host.suggested_monthly_cost.toFixed(2)}/mo`} />
            )}

            {hasSavings && (
              <div style={{ minWidth: 140 }}>
                <div style={{ color: '#64748b', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 }}>Monthly savings</div>
                <div style={{ fontWeight: 700, fontSize: 15, color: '#16a34a' }}>
                  ${host.monthly_savings!.toFixed(2)}
                  {host.savings_percent != null && (
                    <span style={{ fontSize: 12, color: '#16a34a', fontWeight: 500, marginLeft: 6 }}>({host.savings_percent.toFixed(1)}%)</span>
                  )}
                </div>
              </div>
            )}

          </div>
        </div>
      )}

      {/* ── Section 4: Recommendation ── */}
      {displayRecommendation && (
        <div style={{
          color: '#475569', lineHeight: 1.7, marginBottom: 12,
          padding: '12px 16px', background: 'white', borderRadius: 6,
          border: '1px solid #e2e8f0', fontSize: 13,
        }}>
          💡 {displayRecommendation}
        </div>
      )}

      {/* ── Pricing link ── */}
      {host.pricing_calc_url && (
        <a
          href={host.pricing_calc_url}
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: '#0066cc', fontSize: 13, fontWeight: 600 }}
        >
          🔗 View in AWS Pricing Calculator →
        </a>
      )}

    </div>
  );
}
