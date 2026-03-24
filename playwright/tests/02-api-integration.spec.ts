import { test, expect } from '@playwright/test';

/**
 * API Integration Tests
 * Covers: token validity against backend, all API endpoints
 */
test.describe('API Integration', () => {
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

  test('GET /health returns 200', async ({ page }) => {
    const resp = await page.request.get('http://localhost:8005/health');
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(body.status).toBe('ok');
  });

  test('GET /api/status returns 200 or 404 with valid token', async ({ page }) => {
    const resp = await page.request.get('http://localhost:8005/api/status', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    console.log('/api/status status:', resp.status());
    expect([200, 404]).toContain(resp.status());
  });

  test('GET /api/results returns 200 or 404 with valid token', async ({ page }) => {
    const resp = await page.request.get('http://localhost:8005/api/results', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    console.log('/api/results status:', resp.status());
    expect([200, 404]).toContain(resp.status());
  });

  test('GET /api/active-run returns 404 or 200 with valid token', async ({ page }) => {
    const resp = await page.request.get('http://localhost:8005/api/active-run', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect([200, 404]).toContain(resp.status());
    if (resp.status() === 200) {
      const body = await resp.json();
      expect(body.run_id).toBeTruthy();
      expect(body.status).toBe('running');
      console.log('/api/active-run: active run found', body.run_id);
    } else {
      console.log('/api/active-run: no active run (404)');
    }
  });

  test('API returns 401 without token', async ({ page }) => {
    const resp = await page.request.get('http://localhost:8005/api/results');
    expect(resp.status()).toBe(401);
  });

  test('API returns 401 with bad token', async ({ page }) => {
    const resp = await page.request.get('http://localhost:8005/api/results', {
      headers: { Authorization: 'Bearer not-a-real-token' },
    });
    expect(resp.status()).toBe(401);
  });

  test('OPTIONS preflight returns 2xx (CORS)', async ({ page }) => {
    const resp = await page.request.fetch('http://localhost:8005/api/results', {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:3000',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'authorization',
      },
    });
    // Express CORS returns 204 for preflight (no content) — 200 or 204 both valid
    expect([200, 204]).toContain(resp.status());
    console.log('CORS preflight status:', resp.status());
  });
});
