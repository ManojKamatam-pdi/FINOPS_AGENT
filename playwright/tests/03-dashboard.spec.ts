import { test, expect } from '@playwright/test';

/**
 * Dashboard Page Tests
 * Covers: empty state, header elements, run trigger button, navigation
 */
test.describe('Dashboard Page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForURL(/localhost:3000\/?$/, { timeout: 30000 });
    await expect(page.getByRole('heading', { name: 'Infrastructure Analysis' })).toBeVisible({ timeout: 15000 });
  });

  test('renders page header with title', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Infrastructure Analysis' })).toBeVisible();
  });

  test('renders PDI FinOps branding in header', async ({ page }) => {
    await expect(page.getByText('PDI FinOps Intelligence')).toBeVisible();
  });

  test('renders sign out button', async ({ page }) => {
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  });

  test('renders at least one Run Fresh Analysis button', async ({ page }) => {
    // Button text is "▶ Run Fresh Analysis" — use partial match
    const buttons = page.getByRole('button', { name: /Run Fresh Analysis/i });
    await expect(buttons.first()).toBeVisible();
  });

  test('Run Fresh Analysis shows confirmation step', async ({ page }) => {
    await page.getByRole('button', { name: /Run Fresh Analysis/i }).first().click();
    // Confirmation shows "Confirm" and "Cancel" buttons
    await expect(page.getByRole('button', { name: 'Confirm' })).toBeVisible({ timeout: 5000 });
    await expect(page.getByRole('button', { name: 'Cancel' })).toBeVisible({ timeout: 5000 });
    // Also shows the warning text
    await expect(page.getByText(/30.{1,5}60 min/i)).toBeVisible({ timeout: 5000 });
  });

  test('Cancel button dismisses confirmation', async ({ page }) => {
    await page.getByRole('button', { name: /Run Fresh Analysis/i }).first().click();
    await expect(page.getByRole('button', { name: 'Confirm' })).toBeVisible({ timeout: 5000 });
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('button', { name: 'Confirm' })).not.toBeVisible({ timeout: 5000 });
    await expect(page.getByRole('button', { name: /Run Fresh Analysis/i }).first()).toBeVisible({ timeout: 5000 });
  });

  test('shows empty state or results — not a blank page', async ({ page }) => {
    const hasEmpty   = await page.getByText('No analysis run yet').isVisible().catch(() => false);
    const hasResults = await page.getByText(/Monthly Spend|Total Hosts|Potential Savings/i).first().isVisible().catch(() => false);
    const hasRunning = await page.getByText(/running|failed|completed/i).first().isVisible().catch(() => false);
    const hasLoading = await page.getByText('Loading analysis results...').isVisible().catch(() => false);
    expect(hasEmpty || hasResults || hasRunning || hasLoading).toBe(true);
  });

  test('direct navigation to /run/:id shows run page or redirects', async ({ page }) => {
    await page.goto('/run/nonexistent-run-id');
    // Should stay on /run/ path and show "Loading run status..." or an error
    await page.waitForTimeout(3000);
    const onRunPage = page.url().includes('/run/');
    const onDashboard = page.url().match(/localhost:3000\/?$/);
    expect(onRunPage || onDashboard).toBeTruthy();
  });
});
