const API_URL = process.env.REACT_APP_API_URL || 'http://localhost:8005';

export interface SloRunStatus {
  run_id: string;
  status: 'running' | 'completed' | 'failed';
  trigger_type: string;
  triggered_by: string;
  started_at: string;
  completed_at: string | null;
  tenants_total: number;
  tenants_done: number;
  slos_total: number;
  slos_done: number;
  progress_pct: number;
  log: string[];
}

export interface SloActiveRunInfo {
  run_id: string;
  status: 'running';
  triggered_by: string;
  started_at: string;
  progress_pct: number;
  slos_done: number;
  slos_total: number;
}

export interface SloConflictInfo {
  run_id: string;
  triggered_by: string;
  started_at: string;
  progress_pct: number;
  slos_done: number;
  slos_total: number;
}

export interface GapItem {
  severity: 'critical' | 'high' | 'medium' | 'low';
  gap_type: string;
  issue: string;
  affected_slo_names: string[];
  recommendation?: string;
}

export interface SloOrgSummary {
  tenant_id: string;
  run_id: string;
  total_slos: number;
  valid_slos: number;
  misconfigured_slos: number;
  unclassified_slos: number;
  compliance_score: number;
  compliance_tier: string;
  monitoring_context: {
    apm_enabled: boolean;
    synthetics_enabled: boolean;
    infra_monitoring: boolean;
  };
  category_scores: {
    availability?: number | null;
    latency?: number | null;
    error_rate?: number | null;
  };
  na_categories: string[];
  gap_analysis: GapItem[];
  completed_at: string;
}

export interface SloResult {
  tenant_id: string;
  slo_id: string;
  slo_name: string;
  slo_type: string;
  sli_category: string;
  formula_valid: boolean;
  formula_issue: string | null;
  context_compatible: boolean;
  validation_score: number;
  validation_status: string;
  blocker_issues: string[];
  quality_issues: string[];
  enhancements: string[];
  insight: string;
  tags: string[];
  target_percentage: number | null;
  time_windows: string[];
  analyzed_at: string;
}

export interface SloResultsResponse {
  run_id: string;
  completed_at: string | null;
  trigger_type: string;
  org_summaries: SloOrgSummary[];
  slo_results: SloResult[];
}

function authHeader(token: string): HeadersInit {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

export async function triggerSloRun(token: string): Promise<{ run_id: string; status: string }> {
  const resp = await fetch(`${API_URL}/api/slo/trigger`, {
    method: 'POST',
    headers: authHeader(token),
  });
  if (resp.status === 409) {
    const data = await resp.json();
    const conflict: SloConflictInfo = {
      run_id: data.run_id,
      triggered_by: data.triggered_by,
      started_at: data.started_at,
      progress_pct: data.progress_pct,
      slos_done: data.slos_done,
      slos_total: data.slos_total,
    };
    throw Object.assign(new Error('already_running'), { conflict });
  }
  if (!resp.ok) throw new Error(`SLO trigger failed: ${resp.status}`);
  return resp.json();
}

export async function getSloStatus(token: string, runId?: string): Promise<SloRunStatus> {
  const url = runId ? `${API_URL}/api/slo/status?run_id=${runId}` : `${API_URL}/api/slo/status`;
  const resp = await fetch(url, { headers: authHeader(token) });
  if (!resp.ok) throw new Error(`SLO status fetch failed: ${resp.status}`);
  return resp.json();
}

export async function getSloResults(token: string, runId?: string): Promise<SloResultsResponse> {
  const url = runId ? `${API_URL}/api/slo/results?run_id=${runId}` : `${API_URL}/api/slo/results`;
  const resp = await fetch(url, { headers: authHeader(token) });
  if (resp.status === 404) throw Object.assign(new Error('no_results'), { status: 404 });
  if (!resp.ok) throw new Error(`SLO results fetch failed: ${resp.status}`);
  return resp.json();
}

export async function getActiveSloRun(token: string): Promise<SloActiveRunInfo | null> {
  const resp = await fetch(`${API_URL}/api/slo/active-run`, { headers: authHeader(token) });
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`Active SLO run fetch failed: ${resp.status}`);
  return resp.json();
}

export async function abortSloRun(token: string, runId: string): Promise<void> {
  const resp = await fetch(`${API_URL}/api/slo/abort`, {
    method: 'POST',
    headers: authHeader(token),
    body: JSON.stringify({ run_id: runId }),
  });
  if (!resp.ok) throw new Error(`SLO abort failed: ${resp.status}`);
}

export interface SloHistoryDataPoint {
  month: string;
  timestamp: number;
  sli_value: number;
}

export interface SloHistoryResponse {
  slo_id: string;
  tenant_id: string;
  overall_sli: number | null;
  data_points: SloHistoryDataPoint[];
}

export async function getSloHistory(token: string, sloId: string, tenantId: string): Promise<SloHistoryResponse> {
  const resp = await fetch(
    `${API_URL}/api/slo/history?slo_id=${encodeURIComponent(sloId)}&tenant_id=${encodeURIComponent(tenantId)}`,
    { headers: authHeader(token) }
  );
  if (!resp.ok) throw new Error(`SLO history fetch failed: ${resp.status}`);
  return resp.json();
}
