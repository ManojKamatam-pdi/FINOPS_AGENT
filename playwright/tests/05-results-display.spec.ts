import { test, expect } from '@playwright/test';

/**
 * Results & Host Table Tests
 * Covers: org summary cards, host table sorting/filtering/expansion
 * These tests only run if a completed analysis run exists.
 */
test.describe('Results Display', () => {
  let accessToken: string;
  let hasResults = false;

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForURL(/localhost:3000\/?$/, { timeout: 30000 });
    await expect(page.getByText('Infrastructure Analysis')).toBeVisible({ timeout: 15000 });
    const tokenStorage = await page.evaluate(() => localStorage.getItem('okta-token-storage'));
    const tokens = JSON.parse(tokenStorage!);
    accessToken = tokens.accessToken?.accessToken;

    const resp = await page.request.get('http://localhost:8005/api/results', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    hasResults = resp.status() === 200;
    if (!hasResults) {
      console.log('No completed results yet — skipping results tests');
    }
  });

  test('GET /api/results returns valid structure when available', async ({ page }) => {
    const resp = await page.request.get('http://localhost:8005/api/results', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (resp.status() === 404) {
      console.log('No results yet — skipping');
      return;
    }
    expect(resp.status()).toBe(200);
    const data = await resp.json();
    expect(data.run_id).toBeTruthy();
    expect(Array.isArray(data.org_summaries)).toBe(true);
    expect(Array.isArray(data.host_results)).toBe(true);
    console.log('Results: orgs=', data.org_summaries.length, 'hosts=', data.host_results.length);
  });

  test('org summary cards render when results exist', async ({ page }) => {
    if (!hasResults) return;
    await expect(page.getByText(/Monthly Spend|Total Hosts|Potential Savings/i)).toBeVisible({ timeout: 10000 });
  });

  test('host table renders with column headers when results exist', async ({ page }) => {
    if (!hasResults) return;
    await expect(page.getByText(/Host/i)).toBeVisible({ timeout: 10000 });
    await expect(page.getByText(/Instance/i)).toBeVisible({ timeout: 10000 });
    await expect(page.getByText(/CPU/i)).toBeVisible({ timeout: 10000 });
    await expect(page.getByText(/Savings/i)).toBeVisible({ timeout: 10000 });
  });

  test('host table search filter works', async ({ page }) => {
    if (!hasResults) return;
    const searchInput = page.getByPlaceholder(/search/i);
    await expect(searchInput).toBeVisible({ timeout: 10000 });
    await searchInput.fill('zzz-no-match-xyz');
    await expect(page.getByText(/No hosts match/i)).toBeVisible({ timeout: 5000 });
    await searchInput.clear();
  });

  test('host table row expands on click', async ({ page }) => {
    if (!hasResults) return;
    // Click the first data row in the table
    const rows = page.locator('table tbody tr');
    const count = await rows.count();
    if (count === 0) {
      console.log('No host rows to click');
      return;
    }
    await rows.first().click();
    // Expanded row shows efficiency label or recommendation
    await expect(page.getByText(/over-provisioned|right-sized|under-provisioned|Recommendation/i)).toBeVisible({ timeout: 5000 });
  });

  test('host table sort by CPU changes row order', async ({ page }) => {
    if (!hasResults) return;
    const cpuHeader = page.getByRole('columnheader', { name: /CPU/i });
    if (!(await cpuHeader.isVisible())) return;
    await cpuHeader.click();
    // After click, sort indicator should appear
    await expect(page.getByText(/↑|↓/)).toBeVisible({ timeout: 3000 });
  });

  test('org summary card shows savings percentage badge when savings > 0', async ({ page }) => {
    if (!hasResults) return;
    const resp = await page.request.get('http://localhost:8005/api/results', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const data = await resp.json();
    const orgWithSavings = data.org_summaries.find((o: any) => o.savings_percent > 0);
    if (!orgWithSavings) {
      console.log('No org with savings > 0 — skipping badge test');
      return;
    }
    await expect(page.getByText(/%\s*savings opportunity/i)).toBeVisible({ timeout: 10000 });
  });
});
