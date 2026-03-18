import React from 'react';
import { OrgSummary } from '../services/api';

interface Props {
  summary: OrgSummary;
}

export default function OrgSummaryCard({ summary }: Props) {
  const savingsColor = (summary.potential_savings ?? 0) > 0 ? '#16a34a' : '#64748b';

  return (
    <div style={{
      background: 'white', borderRadius: 12, padding: 24,
      boxShadow: '0 1px 3px rgba(0,0,0,0.1)', border: '1px solid #e2e8f0',
      minWidth: 280, flex: 1,
    }}>
      <h3 style={{ fontSize: 18, fontWeight: 700, color: '#1e293b', marginBottom: 16 }}>
        {summary.tenant_id}
      </h3>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Metric label="Total Hosts" value={(summary.total_hosts ?? 0).toString()} />
        <Metric label="Analyzed" value={(summary.hosts_analyzed ?? 0).toString()} />
        <Metric label="Over-provisioned" value={(summary.hosts_over_provisioned ?? 0).toString()} color="#dc2626" />
        <Metric label="Right-sized" value={(summary.hosts_right_sized ?? 0).toString()} color="#16a34a" />
        <Metric label="Avg CPU" value={`${summary.avg_cpu_utilization?.toFixed(1) ?? '—'}%`} />
        <Metric label="Avg RAM" value={`${summary.avg_ram_utilization?.toFixed(1) ?? '—'}%`} />
        <Metric
          label="Monthly Spend"
          value={`$${summary.total_monthly_spend?.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 }) ?? '—'}`}
        />
        <Metric
          label="Potential Savings"
          value={`$${summary.potential_savings?.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 }) ?? '—'}/mo`}
          color={savingsColor}
        />
      </div>
      {summary.savings_percent > 0 && (
        <div style={{
          marginTop: 16, padding: '8px 12px', background: '#f0fdf4',
          borderRadius: 6, fontSize: 13, color: '#16a34a', fontWeight: 600,
        }}>
          💰 {(summary.savings_percent ?? 0).toFixed(1)}% savings opportunity
        </div>
      )}
    </div>
  );
}

function Metric({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700, color: color || '#1e293b' }}>{value}</div>
    </div>
  );
}
