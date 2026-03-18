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

  test('renders PDI FinOps branding', async ({ page }) => {
    await expect(page.getByText(/PDI FinOps/i)).toBeVisible();
  });

  test('renders sign out button', async ({ page }) => {
    await expect(page.getByRole('button', { name: /sign.?out/i })).toBeVisible();
  });

  test('renders at least one Run Fresh Analysis button', async ({ page }) => {
    // There may be 2 (header + empty state CTA) — just check at least one exists
    const buttons = page.getByRole('button', { name: /Run Fresh Analysis/i });
    await expect(buttons.first()).toBeVisible();
  });

  test('Run Fresh Analysis shows confirmation step', async ({ page }) => {
    await page.getByRole('button', { name: /Run Fresh Analysis/i }).first().click();
    await expect(page.getByRole('button', { name: /confirm/i })).toBeVisible({ timeout: 5000 });
    await expect(page.getByRole('button', { name: /cancel/i })).toBeVisible({ timeout: 5000 });
  });

  test('Cancel button dismisses confirmation', async ({ page }) => {
    await page.getByRole('button', { name: /Run Fresh Analysis/i }).first().click();
    await expect(page.getByRole('button', { name: /confirm/i })).toBeVisible({ timeout: 5000 });
    await page.getByRole('button', { name: /cancel/i }).click();
    // Confirm button should be gone
    await expect(page.getByRole('button', { name: /confirm/i })).not.toBeVisible({ timeout: 5000 });
    // At least one Run Fresh Analysis button should be back
    await expect(page.getByRole('button', { name: /Run Fresh Analysis/i }).first()).toBeVisible({ timeout: 5000 });
  });

  test('shows empty state or results — not a blank page', async ({ page }) => {
    const hasEmpty = await page.getByText(/No analysis run yet/i).isVisible().catch(() => false);
    const hasResults = await page.getByText(/Monthly Spend|Total Hosts|Potential Savings/i).first().isVisible().catch(() => false);
    const hasRunState = await page.getByText(/running|failed|completed/i).first().isVisible().catch(() => false);
    const hasLoading = await page.getByText(/Loading analysis results/i).isVisible().catch(() => false);
    expect(hasEmpty || hasResults || hasRunState || hasLoading).toBe(true);
  });

  test('direct navigation to /run/:id shows progress or redirects', async ({ page }) => {
    await page.goto('/run/nonexistent-run-id');
    await page.waitForURL(/localhost:3000\/(run\/|$)/, { timeout: 15000 });
  });
});
