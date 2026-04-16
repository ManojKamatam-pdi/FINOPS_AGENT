import { test, expect } from '@playwright/test';

test('Capture SLO page state', async ({ page }) => {
  // Navigate and load auth
  await page.goto('/slo', { waitUntil: 'networkidle' });
  await page.waitForURL(/\/slo$/, { timeout: 10000 });
  
  // Wait for page to fully load
  await page.waitForTimeout(2000);
  
  // Take full page screenshot
  await page.screenshot({ path: 'slo-page-full.png', fullPage: true });
  
  // Check for key UI elements
  const hasHeading = await page.locator('h1:has-text("SLO Compliance Audit")').isVisible().catch(() => false);
  const hasCards = await page.locator('[style*="flexWrap: wrap"]').count();
  const hasTabs = await page.locator('button:has-text("SLO Details")').isVisible().catch(() => false);
  const hasEmptyState = await page.locator('h2:has-text("No audit run yet")').isVisible().catch(() => false);
  
  console.log('==== PAGE STATE ====');
  console.log('Has main heading:', hasHeading);
  console.log('Wrapped elements found:', hasCards);
  console.log('Has tabs:', hasTabs);
  console.log('Has empty state:', hasEmptyState);
  
  // Try clicking on SLO Details tab
  if (hasTabs) {
    await page.getByRole('button', { name: 'SLO Details' }).first().click();
    await page.waitForTimeout(500);
    console.log('Clicked SLO Details tab');
  }
  
  // Try clicking on Gap Analysis tab
  const hasGapTab = await page.locator('button:has-text("Gap Analysis")').isVisible().catch(() => false);
  if (hasGapTab) {
    await page.getByRole('button', { name: 'Gap Analysis' }).click();
    await page.waitForTimeout(500);
    console.log('Clicked Gap Analysis tab');
  }
  
  // Take tab state screenshot
  await page.screenshot({ path: 'slo-page-tabs.png', fullPage: true });
  
  console.log('==== END PAGE STATE ====');
});
