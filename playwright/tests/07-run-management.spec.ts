import { test, expect } from '@playwright/test';

/**
 * Run Management & Status Visibility Tests
 * Tests: active-run endpoint, abort endpoint, banner visibility, conflict handling, progress page metadata
 */
test.describe('Run Management & Status Visibility', () => {
  let accessToken: string;

  test.setTimeout(180000);

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
    // Retry up to 3 times to handle DynamoDB propagation delay
    for (let i = 0; i < 3; i++) {
      try {
        const activeResp = await page.request.get('http://localhost:8005/api/active-run', {
          headers: { Authorization: `Bearer ${token}` },
          timeout: 5000,
        });
        if (activeResp.status() === 404) return; // clean
        if (activeResp.status() === 200) {
          const active = await activeResp.json();
          await page.request.post('http://localhost:8005/api/abort', {
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            data: { run_id: active.run_id },
            timeout: 5000,
          });
          await page.waitForTimeout(1000);
        }
      } catch {
        await page.waitForTimeout(500);
      }
    }
  }

  test('GET /api/active-run returns 404 when no run is active', async ({ page }) => {
    const resp = await page.request.get('http://localhost:8005/api/active-run', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(resp.status()).toBe(404);
    console.log('GET /api/active-run with no active run → 404 ✓');
  });

  test('GET /api/active-run returns run info when a run is active', async ({ page }) => {
    const triggerResp = await page.request.post('http://localhost:8005/api/trigger', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(triggerResp.status()).toBe(202);
    const { run_id } = await triggerResp.json();

    const activeResp = await page.request.get('http://localhost:8005/api/active-run', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(activeResp.status()).toBe(200);
    const active = await activeResp.json();
    expect(active.run_id).toBe(run_id);
    expect(active.status).toBe('running');
    expect(active.triggered_by).toBeTruthy();
    expect(active.started_at).toBeTruthy();
    expect(typeof active.progress_pct).toBe('number');
    console.log('GET /api/active-run → run_id:', active.run_id, 'triggered_by:', active.triggered_by, '✓');

    // Cleanup
    await page.request.post('http://localhost:8005/api/abort', {
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      data: { run_id },
    });
  });

  test('POST /api/abort stops a running run', async ({ page }) => {
    const triggerResp = await page.request.post('http://localhost:8005/api/trigger', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(triggerResp.status()).toBe(202);
    const { run_id } = await triggerResp.json();

    const abortResp = await page.request.post('http://localhost:8005/api/abort', {
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      data: { run_id },
    });
    expect(abortResp.status()).toBe(200);
    const abortBody = await abortResp.json();
    expect(abortBody.status).toBe('failed');
    expect(abortBody.run_id).toBe(run_id);
    console.log('POST /api/abort → status:', abortBody.status, '✓');

    const afterAbort = await page.request.get('http://localhost:8005/api/active-run', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(afterAbort.status()).toBe(404);
    console.log('After abort, GET /api/active-run → 404 ✓');
  });

  test('POST /api/trigger returns 409 with rich conflict info when run is active', async ({ page }) => {
    const first = await page.request.post('http://localhost:8005/api/trigger', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(first.status()).toBe(202);
    const { run_id } = await first.json();

    const second = await page.request.post('http://localhost:8005/api/trigger', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(second.status()).toBe(409);
    const conflict = await second.json();
    expect(conflict.run_id).toBe(run_id);
    expect(conflict.triggered_by).toBeTruthy();
    expect(conflict.started_at).toBeTruthy();
    expect(typeof conflict.progress_pct).toBe('number');
    console.log('409 conflict info → triggered_by:', conflict.triggered_by, 'progress:', conflict.progress_pct + '% ✓');

    // Cleanup
    await page.request.post('http://localhost:8005/api/abort', {
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      data: { run_id },
    });
  });

  test('ActiveRunBanner appears on dashboard when a run is active', async ({ page }) => {
    const triggerResp = await page.request.post('http://localhost:8005/api/trigger', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(triggerResp.status()).toBe(202);
    const { run_id } = await triggerResp.json();

    // Reload — banner polls on mount
    await page.reload();
    await page.waitForURL(/localhost:3000\/?$/, { timeout: 15000 });

    await expect(page.getByText('Analysis in progress')).toBeVisible({ timeout: 15000 });
    await expect(page.getByText('View Progress →')).toBeVisible({ timeout: 5000 });
    await expect(page.getByRole('button', { name: 'Abort run' })).toBeVisible({ timeout: 5000 });
    console.log('ActiveRunBanner visible on dashboard ✓');

    // Cleanup via API (don't rely on UI for cleanup)
    await page.request.post('http://localhost:8005/api/abort', {
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      data: { run_id },
    });
  });

  test('Abort run button in banner shows confirmation modal and aborts', async ({ page }) => {
    const triggerResp = await page.request.post('http://localhost:8005/api/trigger', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(triggerResp.status()).toBe(202);
    const { run_id } = await triggerResp.json();

    await page.reload();
    await page.waitForURL(/localhost:3000\/?$/, { timeout: 15000 });
    await expect(page.getByText('Analysis in progress')).toBeVisible({ timeout: 15000 });

    // Click Abort run in banner
    await page.getByRole('button', { name: 'Abort run' }).click();

    // Modal appears
    await expect(page.getByRole('heading', { name: 'Abort this run?' })).toBeVisible({ timeout: 5000 });
    await expect(page.getByRole('button', { name: 'Yes, abort run' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cancel' })).toBeVisible();
    console.log('Abort confirmation modal appears ✓');

    // Confirm
    await page.getByRole('button', { name: 'Yes, abort run' }).click();

    // Banner disappears — poll is 10s so give it up to 15s
    await expect(page.getByText('Analysis in progress')).not.toBeVisible({ timeout: 15000 });
    console.log('Banner disappears after abort ✓');

    // Verify via API too
    const afterAbort = await page.request.get('http://localhost:8005/api/active-run', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(afterAbort.status()).toBe(404);
    console.log('API confirms no active run after abort ✓');
    // run_id already aborted via UI — no API cleanup needed
  });

  test('progress page shows triggered_by and abort button', async ({ page }) => {
    const triggerResp = await page.request.post('http://localhost:8005/api/trigger', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(triggerResp.status()).toBe(202);
    const { run_id } = await triggerResp.json();

    await page.goto(`/run/${run_id}`);
    await page.waitForURL(/\/run\//, { timeout: 10000 });

    await expect(page.getByText(/Started by/i).first()).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole('button', { name: 'Abort this run' })).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole('heading', { name: 'Analysis Progress' })).toBeVisible({ timeout: 10000 });
    console.log('Progress page shows triggered_by and abort button ✓');

    // Cleanup
    await page.request.post('http://localhost:8005/api/abort', {
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      data: { run_id },
    });
  });
});
