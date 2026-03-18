import { test, expect } from '@playwright/test';

/**
 * Auth Flow Tests
 * Covers: login page, authenticated state, sign out, page reload persistence
 */
test.describe('Auth Flow', () => {
  test('dashboard loads after login — not stuck on login page', async ({ page }) => {
    await page.goto('/');
    await page.waitForURL(/localhost:3000\/?$/, { timeout: 30000 });
    await expect(page.getByRole('heading', { name: 'Infrastructure Analysis' })).toBeVisible({ timeout: 15000 });
  });

  test('user email is shown in dashboard header', async ({ page }) => {
    await page.goto('/');
    await page.waitForURL(/localhost:3000\/?$/, { timeout: 30000 });
    await expect(page.getByRole('heading', { name: 'Infrastructure Analysis' })).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole('button', { name: /sign.?out/i })).toBeVisible({ timeout: 10000 });
  });

  test('localStorage has valid okta access token', async ({ page }) => {
    await page.goto('/');
    await page.waitForURL(/localhost:3000\/?$/, { timeout: 30000 });
    const tokenStorage = await page.evaluate(() => localStorage.getItem('okta-token-storage'));
    expect(tokenStorage).not.toBeNull();
    const tokens = JSON.parse(tokenStorage!);
    expect(tokens.accessToken?.accessToken).toBeTruthy();
    const expiresAt = tokens.accessToken?.expiresAt;
    expect(expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
    console.log('Token valid for:', Math.round((expiresAt - Date.now() / 1000) / 60), 'minutes');
  });

  test('page reload keeps user authenticated', async ({ page }) => {
    await page.goto('/');
    await page.waitForURL(/localhost:3000\/?$/, { timeout: 30000 });
    await expect(page.getByRole('heading', { name: 'Infrastructure Analysis' })).toBeVisible({ timeout: 15000 });
    await page.reload();
    await page.waitForURL(/localhost:3000\/?$/, { timeout: 30000 });
    await expect(page.getByRole('heading', { name: 'Infrastructure Analysis' })).toBeVisible({ timeout: 15000 });
  });

  test('unauthenticated access to / redirects to /login', async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: undefined });
    const page = await ctx.newPage();
    await page.goto('http://localhost:3000/');
    await page.waitForURL(/\/login/, { timeout: 15000 });
    await expect(page.getByRole('button', { name: /sign in with okta/i })).toBeVisible({ timeout: 10000 });
    await ctx.close();
  });

  test('sign out returns to login page', async ({ page }) => {
    await page.goto('/');
    await page.waitForURL(/localhost:3000\/?$/, { timeout: 30000 });
    await expect(page.getByRole('heading', { name: 'Infrastructure Analysis' })).toBeVisible({ timeout: 15000 });
    await page.getByRole('button', { name: /sign.?out/i }).click();
    await page.waitForURL(/\/login/, { timeout: 15000 });
    await expect(page.getByRole('button', { name: /sign in with okta/i })).toBeVisible({ timeout: 10000 });
  });
});
