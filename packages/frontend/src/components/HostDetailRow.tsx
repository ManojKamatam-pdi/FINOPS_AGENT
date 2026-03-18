import React from 'react';
import { HostResult } from '../services/api';

interface Props {
  host: HostResult;
}

export default function HostDetailRow({ host }: Props) {
  const labelColor: Record<string, string> = {
    'over-provisioned': '#dc2626',
    'right-sized': '#16a34a',
    'under-provisioned': '#d97706',
    'unknown': '#94a3b8',
  };

  return (
    <div style={{
      padding: '16px 20px', background: '#f8fafc', borderTop: '1px solid #e2e8f0',
      fontSize: 13,
    }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 16, marginBottom: 12 }}>
        <div>
          <div style={{ color: '#64748b', marginBottom: 2 }}>Efficiency</div>
          <span style={{
            padding: '2px 8px', borderRadius: 4, fontSize: 12, fontWeight: 600,
            background: '#f1f5f9', color: labelColor[host.efficiency_label] || '#64748b',
          }}>
            {host.efficiency_label} (score: {host.efficiency_score})
          </span>
        </div>
        {host.cpu_avg_30d != null && (
          <div>
            <div style={{ color: '#64748b', marginBottom: 2 }}>CPU (avg / p95)</div>
            <div style={{ fontWeight: 600 }}>{host.cpu_avg_30d.toFixed(1)}% / {host.cpu_p95_30d?.toFixed(1) ?? '—'}%</div>
          </div>
        )}
        {host.ram_avg_30d != null && (
          <div>
            <div style={{ color: '#64748b', marginBottom: 2 }}>RAM avg</div>
            <div style={{ fontWeight: 600 }}>{host.ram_avg_30d.toFixed(1)}%</div>
          </div>
        )}
        {host.network_in_avg_30d != null && (
          <div>
            <div style={{ color: '#64748b', marginBottom: 2 }}>Network (in / out)</div>
            <div style={{ fontWeight: 600 }}>{host.network_in_avg_30d.toFixed(2)} / {host.network_out_avg_30d?.toFixed(2) ?? '—'} GB/day</div>
          </div>
        )}
        {host.instance_cpu_count != null && (
          <div>
            <div style={{ color: '#64748b', marginBottom: 2 }}>Instance specs</div>
            <div style={{ fontWeight: 600 }}>{host.instance_cpu_count} vCPU · {host.instance_ram_gb} GB RAM</div>
          </div>
        )}
      </div>
      {host.recommendation && (
        <div style={{ color: '#475569', lineHeight: 1.5, marginBottom: 12 }}>
          {host.recommendation}
        </div>
      )}
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
