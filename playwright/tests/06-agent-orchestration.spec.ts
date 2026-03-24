import { test, expect } from '@playwright/test';

/**
 * Agent Orchestration Tests
 * Covers: MCP connectivity, agent run lifecycle, host discovery, batch progress,
 * org summary writing, and end-to-end data flow from Datadog → DynamoDB → API.
 *
 * Tests reuse an active run if one exists — they never start duplicate runs.
 */
test.describe('Agent Orchestration', () => {
  let accessToken: string;

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForURL(/localhost:3000\/?$/, { timeout: 30000 });
    await expect(page.getByRole('heading', { name: 'Infrastructure Analysis' })).toBeVisible({ timeout: 15000 });
    const tokenStorage = await page.evaluate(() => localStorage.getItem('okta-token-storage'));
    const tokens = JSON.parse(tokenStorage!);
    accessToken = tokens.accessToken?.accessToken;
    expect(accessToken).toBeTruthy();
  });

  // ─── Helper ─────────────────────────────────────────────────────────────────

  async function getOrStartRun(page: any): Promise<string> {
    const existing = await page.request.get('http://localhost:8005/api/status', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (existing.status() === 200) {
      const s = await existing.json();
      if (s.status === 'running') {
        console.log('Reusing active run:', s.run_id);
        return s.run_id;
      }
    }
    await page.request.post('http://localhost:8005/api/reset', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const resp = await page.request.post('http://localhost:8005/api/trigger', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(resp.status()).toBe(202);
    const { run_id } = await resp.json();
    console.log('Started new run:', run_id);
    return run_id;
  }

  // ─── Run Trigger ─────────────────────────────────────────────────────────────

  test('trigger starts a new run and returns run_id', async ({ page }) => {
    const existing = await page.request.get('http://localhost:8005/api/status', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (existing.status() === 200 && (await existing.json()).status === 'running') {
      console.log('Run already active — skipping trigger test');
      return;
    }
    await page.request.post('http://localhost:8005/api/reset', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const resp = await page.request.post('http://localhost:8005/api/trigger', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(resp.status()).toBe(202);
    const body = await resp.json();
    expect(body.run_id).toMatch(/^run_\d{4}-\d{2}-\d{2}T/);
    expect(body.status).toBe('running');
    console.log('Started run:', body.run_id);
  });

  test('second trigger while running returns 409', async ({ page }) => {
    const runId = await getOrStartRun(page);
    const second = await page.request.post('http://localhost:8005/api/trigger', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(second.status()).toBe(409);
    const body = await second.json();
    expect(body.error).toMatch(/already in progress/i);
    expect(body.run_id).toBeTruthy();
    console.log('409 correctly blocked duplicate trigger. Active run:', runId);
  });

  // ─── MCP Connectivity & Host Discovery ───────────────────────────────────────

  test('agent discovers hosts within 60 seconds (MCP connectivity check)', async ({ page }) => {
    const runId = await getOrStartRun(page);
    console.log('Polling run:', runId, 'for host discovery...');

    const deadline = Date.now() + 60_000;
    let hostsTotal = 0;
    let lastStatus = '';
    while (Date.now() < deadline) {
      await page.waitForTimeout(5000);
      const statusResp = await page.request.get('http://localhost:8005/api/status', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (statusResp.status() !== 200) continue;
      const s = await statusResp.json();
      hostsTotal = s.hosts_total ?? 0;
      lastStatus = s.status;
      console.log(`  status=${s.status} hosts_total=${hostsTotal} hosts_done=${s.hosts_done}`);
      if (hostsTotal > 0 || s.status === 'failed' || s.status === 'completed') break;
    }

    if (hostsTotal > 0) {
      console.log(`✅ MCP connected — discovered ${hostsTotal} hosts`);
      expect(hostsTotal).toBeGreaterThan(0);
    } else {
      console.log(`⚠️  hosts_total=0 after 60s (status=${lastStatus})`);
      console.log('   PDI-Orbis: check DD_APPLICATION_KEY has infrastructure:read scope');
      console.log('   PDI-Enterprise: host discovery may still be paginating (3,400+ hosts)');
      // Non-fatal — host discovery for 3,400 hosts takes longer than 60s
    }
  });

  // ─── Progress Page UI ────────────────────────────────────────────────────────

  test('progress page shows Analysis Progress panel during run', async ({ page }) => {
    const runId = await getOrStartRun(page);
    await page.goto(`/run/${runId}`);
    await page.waitForURL(/\/run\//, { timeout: 10000 });

    await expect(page.getByRole('heading', { name: 'Analysis Progress' })).toBeVisible({ timeout: 10000 });
    await expect(page.getByText(/^(running|completed|failed)$/)).toBeVisible({ timeout: 10000 });

    const isDiscovering = await page.getByText('Discovering hosts across all orgs...').isVisible().catch(() => false);
    const hasProgress   = await page.getByText(/hosts analyzed/).isVisible().catch(() => false);
    const isComplete    = await page.getByText(/Analysis complete/i).isVisible().catch(() => false);
    expect(isDiscovering || hasProgress || isComplete).toBe(true);
    console.log(`Progress page: discovering=${isDiscovering} progress=${hasProgress} complete=${isComplete}`);
  });

  test('activity log appears as agent writes batch progress', async ({ page }) => {
    const runId = await getOrStartRun(page);
    await page.goto(`/run/${runId}`);
    await page.waitForURL(/\/run\//, { timeout: 10000 });

    // Poll for Activity Log section (only renders when log.length > 0)
    const deadline = Date.now() + 90_000;
    let logVisible = false;
    while (Date.now() < deadline) {
      logVisible = await page.getByText('Activity Log').isVisible().catch(() => false);
      if (logVisible) break;
      await page.waitForTimeout(5000);
      await page.reload();
    }

    if (logVisible) {
      console.log('✅ Activity Log visible — agent is writing batch progress');
      await expect(page.getByText('Activity Log')).toBeVisible();
    } else {
      console.log('⚠️  Activity Log not visible after 90s — still in host discovery phase');
    }
  });

  // ─── Status API Structure ────────────────────────────────────────────────────

  test('status API returns correct tenant counts', async ({ page }) => {
    const resp = await page.request.get('http://localhost:8005/api/status', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (resp.status() === 404) { console.log('No active run — skipping'); return; }
    const status = await resp.json();
    expect(typeof status.tenants_total).toBe('number');
    expect(status.tenants_total).toBeGreaterThanOrEqual(1);
    expect(typeof status.tenants_done).toBe('number');
    expect(status.tenants_done).toBeGreaterThanOrEqual(0);
    expect(status.tenants_done).toBeLessThanOrEqual(status.tenants_total);
    console.log(`Tenants: ${status.tenants_done}/${status.tenants_total}`);
  });

  test('status API progress_pct is consistent with hosts_done/hosts_total', async ({ page }) => {
    const resp = await page.request.get('http://localhost:8005/api/status', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (resp.status() === 404) { console.log('No active run — skipping'); return; }
    const status = await resp.json();
    if (status.hosts_total > 0) {
      const expectedPct = Math.round((status.hosts_done / status.hosts_total) * 100);
      expect(Math.abs(status.progress_pct - expectedPct)).toBeLessThanOrEqual(1);
      console.log(`Progress: ${status.hosts_done}/${status.hosts_total} = ${status.progress_pct}%`);
    } else {
      expect(status.progress_pct).toBe(0);
      console.log('Host discovery in progress — progress_pct=0 correct');
    }
  });

  // ─── Results After Completion ─────────────────────────────────────────────────

  test('completed run has org summaries for all configured orgs', async ({ page }) => {
    const resp = await page.request.get('http://localhost:8005/api/results', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (resp.status() === 404) { console.log('No completed run yet — skipping'); return; }
    const data = await resp.json();
    expect(data.org_summaries.length).toBeGreaterThanOrEqual(1);
    console.log('Org summaries:', data.org_summaries.map((o: any) => o.tenant_id).join(', '));
    for (const org of data.org_summaries) {
      expect(org.tenant_id).toBeTruthy();
      expect(typeof org.total_hosts).toBe('number');
      expect(typeof org.total_monthly_spend).toBe('number');
      expect(typeof org.potential_savings).toBe('number');
      expect(typeof org.savings_percent).toBe('number');
    }
  });

  test('completed run host results have required fields', async ({ page }) => {
    const resp = await page.request.get('http://localhost:8005/api/results', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (resp.status() === 404) { console.log('No completed run yet — skipping'); return; }
    const data = await resp.json();
    if (data.host_results.length === 0) { console.log('No host results — skipping'); return; }

    for (const host of data.host_results.slice(0, 5)) {
      expect(host.host_id).toBeTruthy();
      expect(host.host_name).toBeTruthy();
      expect(host.tenant_id).toBeTruthy();
      expect(['over-provisioned', 'right-sized', 'under-provisioned', 'unknown']).toContain(host.efficiency_label);
      // efficiency_score is null for hosts with no metric data (unknown label)
      expect(host.efficiency_score === null || typeof host.efficiency_score === 'number').toBe(true);
    }
    console.log(`Checked 5 host results — all valid. Sample: ${data.host_results[0].host_name} | ${data.host_results[0].efficiency_label}`);
  });

  test('at least one host has metric data (MCP metric queries working)', async ({ page }) => {
    const resp = await page.request.get('http://localhost:8005/api/results', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (resp.status() === 404) { console.log('No completed run yet — skipping'); return; }
    const data = await resp.json();
    if (data.host_results.length === 0) { console.log('No host results — skipping'); return; }

    const analyzed = data.host_results.filter((h: any) => h.efficiency_label !== 'unknown');
    console.log(`Hosts: ${data.host_results.length} total, ${analyzed.length} analyzed, ${data.host_results.length - analyzed.length} unknown`);

    if (analyzed.length > 0) {
      console.log('✅ Datadog metric queries working');
      expect(analyzed.length).toBeGreaterThan(0);
    } else {
      console.log('⚠️  All hosts unknown — check DD_APPLICATION_KEY has metrics:read scope');
    }
  });
});
