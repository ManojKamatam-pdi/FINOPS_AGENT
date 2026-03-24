const API_URL = process.env.REACT_APP_API_URL || 'http://localhost:8005';

export interface RunStatus {
  run_id: string;
  status: 'running' | 'completed' | 'failed';
  trigger_type: string;
  triggered_by: string;
  started_at: string;
  completed_at: string | null;
  tenants_total: number;
  tenants_done: number;
  hosts_total: number;
  hosts_done: number;
  progress_pct: number;
  log: string[];
}

export interface ActiveRunInfo {
  run_id: string;
  status: 'running';
  triggered_by: string;
  started_at: string;
  progress_pct: number;
  hosts_done: number;
  hosts_total: number;
}

export interface ConflictInfo {
  run_id: string;
  triggered_by: string;
  started_at: string;
  progress_pct: number;
  hosts_done: number;
  hosts_total: number;
}

export interface OrgSummary {
  tenant_id: string;
  total_hosts: number;
  hosts_analyzed: number;
  hosts_over_provisioned: number;
  hosts_right_sized: number;
  hosts_under_provisioned: number;
  hosts_no_tag: number;
  total_monthly_spend: number;
  potential_savings: number;
  savings_percent: number;
  avg_cpu_utilization: number;
  avg_ram_utilization: number;
  top_offenders: string[];
  completed_at: string;
}

export interface HostResult {
  tenant_id: string;
  host_id: string;
  host_name: string;
  cloud_provider: string;
  cpu_avg_30d: number | null;
  cpu_p95_30d: number | null;
  ram_avg_30d: number | null;
  disk_avg_30d: number | null;
  network_in_avg_30d: number | null;
  network_out_avg_30d: number | null;
  instance_type: string | null;
  instance_region: string | null;
  instance_cpu_count: number | null;
  instance_ram_gb: number | null;
  has_instance_tag: boolean;
  catalog_data_available: boolean;
  current_monthly_cost: number | null;
  suggested_instance: string | null;
  suggested_monthly_cost: number | null;
  monthly_savings: number | null;
  savings_percent: number | null;
  pricing_calc_url: string | null;
  efficiency_score: number;
  efficiency_label: string;
  recommendation: string;
  analyzed_at: string;
}

export interface ResultsResponse {
  run_id: string;
  completed_at: string;
  trigger_type: string;
  org_summaries: OrgSummary[];
  host_results: HostResult[];
}

function authHeader(token: string): HeadersInit {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

export async function triggerRun(token: string): Promise<{ run_id: string; status: string }> {
  const resp = await fetch(`${API_URL}/api/trigger`, {
    method: 'POST',
    headers: authHeader(token),
  });
  if (resp.status === 409) {
    const data = await resp.json();
    const conflict: ConflictInfo = {
      run_id: data.run_id,
      triggered_by: data.triggered_by,
      started_at: data.started_at,
      progress_pct: data.progress_pct,
      hosts_done: data.hosts_done,
      hosts_total: data.hosts_total,
    };
    throw Object.assign(new Error('already_running'), { conflict });
  }
  if (!resp.ok) throw new Error(`Trigger failed: ${resp.status}`);
  return resp.json();
}

export async function getStatus(token: string, runId?: string): Promise<RunStatus> {
  const url = runId ? `${API_URL}/api/status?run_id=${runId}` : `${API_URL}/api/status`;
  const resp = await fetch(url, { headers: authHeader(token) });
  if (!resp.ok) throw new Error(`Status fetch failed: ${resp.status}`);
  return resp.json();
}

export async function getResults(token: string, runId?: string): Promise<ResultsResponse> {
  const url = runId ? `${API_URL}/api/results?run_id=${runId}` : `${API_URL}/api/results`;
  const resp = await fetch(url, { headers: authHeader(token) });
  if (resp.status === 404) throw Object.assign(new Error('no_results'), { status: 404 });
  if (!resp.ok) throw new Error(`Results fetch failed: ${resp.status}`);
  return resp.json();
}

export async function getActiveRun(token: string): Promise<ActiveRunInfo | null> {
  const resp = await fetch(`${API_URL}/api/active-run`, { headers: authHeader(token) });
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`Active run fetch failed: ${resp.status}`);
  return resp.json();
}

export async function abortRun(token: string, runId: string): Promise<void> {
  const resp = await fetch(`${API_URL}/api/abort`, {
    method: 'POST',
    headers: authHeader(token),
    body: JSON.stringify({ run_id: runId }),
  });
  if (!resp.ok) throw new Error(`Abort failed: ${resp.status}`);
}
