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
  });

  test('POST /api/trigger returns run_id', async ({ page }) => {
    // Check if a run is already active
    const statusResp = await page.request.get('http://localhost:8005/api/status', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (statusResp.status() === 200) {
      const status = await statusResp.json();
      if (status.status === 'running') {
        console.log('Run already active:', status.run_id, '— skipping trigger test');
        return;
      }
    }

    const resp = await page.request.post('http://localhost:8005/api/trigger', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    // 202 = started, 409 = already running — both valid
    expect([202, 409]).toContain(resp.status());
    const body = await resp.json();
    expect(body.run_id).toBeTruthy();
    console.log('Triggered run_id:', body.run_id, 'status:', resp.status());
  });

  test('clicking Confirm navigates to /run/:runId', async ({ page }) => {
    await page.getByRole('button', { name: /Run Fresh Analysis/i }).first().click();
    await expect(page.getByRole('button', { name: /confirm/i })).toBeVisible({ timeout: 5000 });
    await page.getByRole('button', { name: /confirm/i }).click();

    // Should navigate to /run/:runId (or stay on dashboard if 409 already running)
    await page.waitForURL(/localhost:3000\/(run\/|\?|$)/, { timeout: 15000 });
    const url = page.url();
    console.log('After trigger URL:', url);

    if (url.includes('/run/')) {
      await expect(page.getByText(/Discovering hosts|Analyzing hosts|Analysis complete|running|failed/i).first()).toBeVisible({ timeout: 10000 });
    }
  });

  test('progress page shows progress panel elements', async ({ page }) => {
    // Get or create a run
    const triggerResp = await page.request.post('http://localhost:8005/api/trigger', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect([202, 409]).toContain(triggerResp.status());
    const { run_id } = await triggerResp.json();

    await page.goto(`/run/${run_id}`);
    await page.waitForURL(/\/run\//, { timeout: 10000 });

    await expect(page.getByText(/running|completed|failed/i).first()).toBeVisible({ timeout: 10000 });
    await expect(page.getByText(/hosts|orgs|Discovering|Analyzing/i).first()).toBeVisible({ timeout: 10000 });
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
    console.log('Run status:', status.status, 'progress:', status.progress_pct + '%');
  });
});
