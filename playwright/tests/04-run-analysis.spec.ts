import { test, expect } from '@playwright/test';

/**
 * Run Analysis Flow Tests
 * Covers: trigger run, navigate to progress page, progress panel elements
 */
test.describe('Run Analysis Flow', () => {
  let accessToken: string;

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForURL(/localhost:3000\/?$/, { timeout: 30000 });
    await expect(page.getByRole('heading', { name: 'Infrastructure Analysis' })).toBeVisible({ timeout: 15000 });
    const tokenStorage = await page.evaluate(() => localStorage.getItem('okta-token-storage'));
    const tokens = JSON.parse(tokenStorage!);
    accessToken = tokens.accessToken?.accessToken;
    expect(accessToken).toBeTruthy();

    // Ensure no run is active before each test
    await ensureNoActiveRun(page, accessToken);
  });

  async function ensureNoActiveRun(page: any, token: string) {
    try {
      const activeResp = await page.request.get('http://localhost:8005/api/active-run', {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 5000,
      });
      if (activeResp.status() === 200) {
        const active = await activeResp.json();
        await page.request.post('http://localhost:8005/api/abort', {
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          data: { run_id: active.run_id },
          timeout: 5000,
        });
        await page.waitForTimeout(500);
      }
    } catch {
      // Ignore errors — no active run
    }
  }

  test('POST /api/trigger returns 202 with run_id when no run is active', async ({ page }) => {
    const resp = await page.request.post('http://localhost:8005/api/trigger', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(resp.status()).toBe(202);
    const body = await resp.json();
    expect(body.run_id).toBeTruthy();
    expect(body.status).toBe('running');
    console.log('Triggered run_id:', body.run_id);

    // Cleanup
    await page.request.post('http://localhost:8005/api/abort', {
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      data: { run_id: body.run_id },
    });
  });

  test('clicking Confirm navigates to /run/:runId', async ({ page }) => {
    await page.getByRole('button', { name: /Run Fresh Analysis/i }).first().click();
    await expect(page.getByRole('button', { name: 'Confirm' })).toBeVisible({ timeout: 5000 });
    await page.getByRole('button', { name: 'Confirm' }).click();

    // Should navigate to /run/:runId
    await page.waitForURL(/\/run\//, { timeout: 15000 });
    expect(page.url()).toMatch(/\/run\//);
    console.log('Navigated to:', page.url());

    // Cleanup — extract run_id from URL and abort
    const runId = page.url().split('/run/')[1];
    if (runId) {
      await page.request.post('http://localhost:8005/api/abort', {
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        data: { run_id: runId },
      });
    }
  });

  test('progress page shows Analysis Progress panel', async ({ page }) => {
    const triggerResp = await page.request.post('http://localhost:8005/api/trigger', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(triggerResp.status()).toBe(202);
    const { run_id } = await triggerResp.json();

    await page.goto(`/run/${run_id}`);
    await page.waitForURL(/\/run\//, { timeout: 10000 });

    // ProgressPanel renders "Analysis Progress" heading
    await expect(page.getByRole('heading', { name: 'Analysis Progress' })).toBeVisible({ timeout: 10000 });
    // Status badge shows "running"
    await expect(page.getByText('running')).toBeVisible({ timeout: 10000 });
    // Either discovering or analyzing
    await expect(
      page.getByText(/Discovering hosts|hosts analyzed|orgs complete/i).first()
    ).toBeVisible({ timeout: 10000 });

    // Cleanup
    await page.request.post('http://localhost:8005/api/abort', {
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      data: { run_id },
    });
  });

  test('GET /api/status returns valid run structure', async ({ page }) => {
    const resp = await page.request.get('http://localhost:8005/api/status', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (resp.status() === 404) {
      console.log('No active run — skipping status structure test');
      return;
    }
    expect(resp.status()).toBe(200);
    const status = await resp.json();
    expect(status.run_id).toBeTruthy();
    expect(['running', 'completed', 'failed']).toContain(status.status);
    expect(typeof status.progress_pct).toBe('number');
    expect(Array.isArray(status.log)).toBe(true);
    expect(typeof status.hosts_total).toBe('number');
    expect(typeof status.hosts_done).toBe('number');
    console.log('Run status:', status.status, 'progress:', status.progress_pct + '%',
      'hosts:', status.hosts_done + '/' + status.hosts_total);
  });
});
