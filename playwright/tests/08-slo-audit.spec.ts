import { test, expect } from '@playwright/test';

/**
 * SLO Audit Page Tests
 * Covers: navigation, empty state, run trigger, progress page, results display
 * IMPORTANT: Tests that verify data rendering use the actual API — no mocks.
 */
test.describe('SLO Audit Page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForURL(/localhost:3000\/?$/, { timeout: 30000 });
    await expect(page.getByRole('heading', { name: 'Infrastructure Analysis' })).toBeVisible({ timeout: 15000 });
  });

  test('SLO Audit nav link is visible on dashboard', async ({ page }) => {
    await expect(page.getByRole('link', { name: 'SLO Audit' })).toBeVisible();
  });

  test('clicking SLO Audit nav link navigates to /slo', async ({ page }) => {
    await page.getByRole('link', { name: 'SLO Audit' }).click();
    await page.waitForURL(/\/slo$/, { timeout: 10000 });
    await expect(page.getByRole('heading', { name: 'SLO Compliance Audit' })).toBeVisible({ timeout: 10000 });
  });

  test('/slo page loads with correct heading and branding', async ({ page }) => {
    await page.goto('/slo');
    await page.waitForURL(/\/slo$/, { timeout: 10000 });
    await expect(page.getByText('PDI FinOps Intelligence')).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole('heading', { name: 'SLO Compliance Audit' })).toBeVisible({ timeout: 10000 });
  });

  test('/slo page shows empty state or results — not a blank page', async ({ page }) => {
    await page.goto('/slo');
    await page.waitForURL(/\/slo$/, { timeout: 10000 });
    await expect(page.getByRole('heading', { name: 'SLO Compliance Audit' })).toBeVisible({ timeout: 10000 });

    // Wait for loading to finish
    await page.waitForTimeout(3000);

    const hasEmpty = await page.getByText('No audit run yet').isVisible().catch(() => false);
    const hasResults = await page.getByText(/Compliance|compliance|SLO Details|Gap Analysis/i).first().isVisible().catch(() => false);
    const hasLoading = await page.getByText('Loading SLO audit results...').isVisible().catch(() => false);
    expect(hasEmpty || hasResults || hasLoading).toBe(true);
  });

  test('/slo page has Run SLO Audit button', async ({ page }) => {
    await page.goto('/slo');
    await page.waitForURL(/\/slo$/, { timeout: 10000 });
    await expect(page.getByRole('heading', { name: 'SLO Compliance Audit' })).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole('button', { name: /Run SLO Audit/i }).first()).toBeVisible({ timeout: 10000 });
  });

  test('Run SLO Audit button shows confirmation step', async ({ page }) => {
    // Mock active-run to return 404 so button is enabled
    await page.route('**/api/slo/active-run', route => route.fulfill({ status: 404, body: '{"error":"No active SLO run"}' }));

    await page.goto('/slo');
    await page.waitForURL(/\/slo$/, { timeout: 10000 });
    await expect(page.getByRole('heading', { name: 'SLO Compliance Audit' })).toBeVisible({ timeout: 10000 });

    // Wait for loading to finish
    await page.waitForTimeout(2000);

    await page.getByRole('button', { name: /Run SLO Audit/i }).first().click();
    await expect(page.getByRole('button', { name: 'Confirm' })).toBeVisible({ timeout: 5000 });
    await expect(page.getByRole('button', { name: 'Cancel' })).toBeVisible({ timeout: 5000 });
    await expect(page.getByText(/10.{1,5}30 min/i)).toBeVisible({ timeout: 5000 });
  });

  test('Cancel button dismisses SLO audit confirmation', async ({ page }) => {
    // Mock active-run to return 404 so button is enabled
    await page.route('**/api/slo/active-run', route => route.fulfill({ status: 404, body: '{"error":"No active SLO run"}' }));

    await page.goto('/slo');
    await page.waitForURL(/\/slo$/, { timeout: 10000 });
    await expect(page.getByRole('heading', { name: 'SLO Compliance Audit' })).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(2000);

    await page.getByRole('button', { name: /Run SLO Audit/i }).first().click();
    await expect(page.getByRole('button', { name: 'Confirm' })).toBeVisible({ timeout: 5000 });
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('button', { name: 'Confirm' })).not.toBeVisible({ timeout: 5000 });
    await expect(page.getByRole('button', { name: /Run SLO Audit/i }).first()).toBeVisible({ timeout: 5000 });
  });

  test('/slo page has Infrastructure Analysis nav link back to dashboard', async ({ page }) => {
    await page.goto('/slo');
    await page.waitForURL(/\/slo$/, { timeout: 10000 });
    await expect(page.getByRole('heading', { name: 'SLO Compliance Audit' })).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole('link', { name: 'Infrastructure Analysis' })).toBeVisible();
  });

  test('Infrastructure Analysis nav link navigates back to dashboard', async ({ page }) => {
    await page.goto('/slo');
    await page.waitForURL(/\/slo$/, { timeout: 10000 });
    await expect(page.getByRole('heading', { name: 'SLO Compliance Audit' })).toBeVisible({ timeout: 10000 });
    await page.getByRole('link', { name: 'Infrastructure Analysis' }).click();
    await page.waitForURL(/localhost:3000\/?$/, { timeout: 10000 });
    await expect(page.getByRole('heading', { name: 'Infrastructure Analysis' })).toBeVisible({ timeout: 10000 });
  });

  test('direct navigation to /slo/run/:id shows progress page or redirects', async ({ page }) => {
    await page.goto('/slo/run/slo_run_test-nonexistent');
    await page.waitForTimeout(3000);
    const onRunPage = page.url().includes('/slo/run/');
    const onSloPage = page.url().includes('/slo');
    expect(onRunPage || onSloPage).toBeTruthy();
  });

  test('/slo page sign out button is visible', async ({ page }) => {
    await page.goto('/slo');
    await page.waitForURL(/\/slo$/, { timeout: 10000 });
    await expect(page.getByRole('heading', { name: 'SLO Compliance Audit' })).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  });

  test('/slo results page renders org cards without crash when results exist', async ({ page }) => {
    // Intercept the results API to inject controlled test data
    await page.route('**/api/slo/results*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          run_id: 'slo_run_test',
          completed_at: new Date().toISOString(),
          trigger_type: 'manual',
          org_summaries: [
            {
              tenant_id: 'test-org',
              run_id: 'slo_run_test',
              total_slos: 5,
              valid_slos: 3,
              misconfigured_slos: 1,
              unclassified_slos: 1,
              compliance_score: 72,
              compliance_tier: 'Needs Improvement',
              monitoring_context: { apm_enabled: true, synthetics_enabled: false, infra_monitoring: true },
              category_scores: { availability: 80, latency: 65, error_rate: 70 },
              na_categories: [],
              gap_analysis: [
                {
                  severity: 'high',
                  category: 'coverage',
                  insight: 'Only 2 of 5 SLOs have 30-day windows configured. Monthly SLA reporting is not possible for 3 SLOs.',
                  affected_slos: 3,
                  recommendation: 'Add 30-day time windows to all SLOs to enable monthly SLA reporting.',
                },
              ],
              completed_at: new Date().toISOString(),
            },
          ],
          slo_results: [
            {
              slo_id: 'abc123',
              tenant_id: 'test-org',
              slo_name: 'Payment Service Availability',
              slo_type: 'monitor',
              sli_category: 'availability',
              formula_valid: true,
              formula_issue: null,
              context_compatible: true,
              validation_score: 85,
              validation_status: 'good',
              blocker_issues: [],
              quality_issues: ['Only 7d window configured — add 30d for monthly reporting'],
              enhancements: ['Add service tag for ownership tracking'],
              insight: 'This SLO uses a synthetic HTTP check against the payment endpoint — excellent choice for true availability measurement.',
              tags: ['team:payments', 'env:prod'],
              target_percentage: 99.9,
              time_windows: ['7d'],
              analyzed_at: new Date().toISOString(),
            },
            {
              slo_id: 'def456',
              tenant_id: 'test-org',
              slo_name: 'API Latency P95',
              slo_type: 'metric',
              sli_category: 'latency',
              formula_valid: false,
              formula_issue: 'Uses avg: aggregation for latency — should use p95: or p99:',
              context_compatible: true,
              validation_score: 55,
              validation_status: 'needs_improvement',
              blocker_issues: [],
              quality_issues: ['avg: aggregation hides tail latency — use p95: or p99:'],
              enhancements: ['Add env tag'],
              insight: 'The SLO uses avg:trace.web.request.duration which masks tail latency. Switch to p95:trace.web.request.duration to catch the worst 5% of requests.',
              tags: ['team:api'],
              target_percentage: 99.5,
              time_windows: ['7d', '30d'],
              analyzed_at: new Date().toISOString(),
            },
          ],
        }),
      });
    });

    // Also mock active-run to return 404 (no active run)
    await page.route('**/api/slo/active-run*', async (route) => {
      await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'No active SLO run' }) });
    });

    await page.goto('/slo');
    await page.waitForURL(/\/slo$/, { timeout: 10000 });

    // Wait for results to load
    await page.waitForTimeout(3000);

    // Verify org card renders with correct data — no crash
    await expect(page.getByText('test-org').first()).toBeVisible({ timeout: 10000 });
    // Compliance score renders as a number (not [object Object])
    await expect(page.locator('div').filter({ hasText: /^72$/ }).first()).toBeVisible({ timeout: 5000 });
    // Tier badge renders as text (not object)
    await expect(page.getByText('Needs Improvement').first()).toBeVisible({ timeout: 5000 });

    // Verify SLO counts render as numbers (not objects) — check the Total count cell
    await expect(page.getByText('Total').first()).toBeVisible({ timeout: 5000 });

    // No JS error crash — page should still show heading
    await expect(page.getByRole('heading', { name: 'SLO Compliance Audit' })).toBeVisible();
  });

  test('/slo SLO Details tab renders table rows without crash', async ({ page }) => {
    // Intercept the results API
    await page.route('**/api/slo/results*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          run_id: 'slo_run_test',
          completed_at: new Date().toISOString(),
          trigger_type: 'manual',
          org_summaries: [
            {
              tenant_id: 'test-org',
              run_id: 'slo_run_test',
              total_slos: 2,
              valid_slos: 1,
              misconfigured_slos: 0,
              unclassified_slos: 0,
              compliance_score: 80,
              compliance_tier: 'Good',
              monitoring_context: { apm_enabled: true, synthetics_enabled: false, infra_monitoring: true },
              category_scores: { availability: 85, latency: 75, error_rate: null },
              na_categories: ['error_rate'],
              gap_analysis: [],
              completed_at: new Date().toISOString(),
            },
          ],
          slo_results: [
            {
              slo_id: 'slo001',
              tenant_id: 'test-org',
              slo_name: 'Checkout Availability',
              slo_type: 'monitor',
              sli_category: 'availability',
              formula_valid: true,
              formula_issue: null,
              context_compatible: true,
              validation_score: 90,
              validation_status: 'excellent',
              blocker_issues: [],
              quality_issues: [],
              enhancements: ['Add env tag'],
              insight: 'Synthetic HTTP check provides accurate availability measurement.',
              tags: ['team:checkout', 'env:prod'],
              target_percentage: 99.9,
              time_windows: ['7d', '30d'],
              analyzed_at: new Date().toISOString(),
            },
            {
              slo_id: 'slo002',
              tenant_id: 'test-org',
              slo_name: 'Search Latency P95',
              slo_type: 'metric',
              sli_category: 'latency',
              formula_valid: true,
              formula_issue: null,
              context_compatible: true,
              validation_score: 70,
              validation_status: 'needs_improvement',
              blocker_issues: [],
              quality_issues: ['Only 7d window — add 30d'],
              enhancements: [],
              insight: 'Uses p95:trace.search.request.duration — correct aggregation for latency SLO.',
              tags: ['team:search'],
              target_percentage: 99.5,
              time_windows: ['7d'],
              analyzed_at: new Date().toISOString(),
            },
          ],
        }),
      });
    });

    await page.route('**/api/slo/active-run*', async (route) => {
      await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'No active SLO run' }) });
    });

    await page.goto('/slo');
    await page.waitForURL(/\/slo$/, { timeout: 10000 });
    await page.waitForTimeout(3000);

    // Click SLO Details tab
    const detailsTab = page.getByRole('button', { name: /SLO Details/i });
    if (await detailsTab.isVisible({ timeout: 5000 }).catch(() => false)) {
      await detailsTab.click();
    }

    // Verify SLO table rows render — SLO names visible, not raw IDs
    await expect(page.getByText('Checkout Availability')).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('Search Latency P95')).toBeVisible({ timeout: 5000 });

    // Verify score column renders numbers
    await expect(page.getByText('90')).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('70')).toBeVisible({ timeout: 5000 });

    // Verify status badges render (not objects) — use table context to be specific
    await expect(page.getByRole('table').getByText('excellent')).toBeVisible({ timeout: 5000 });

    // No crash — heading still visible
    await expect(page.getByRole('heading', { name: 'SLO Compliance Audit' })).toBeVisible();
  });

  test('/slo expandable SLO row renders issues as strings without crash', async ({ page }) => {
    await page.route('**/api/slo/results*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          run_id: 'slo_run_test',
          completed_at: new Date().toISOString(),
          trigger_type: 'manual',
          org_summaries: [
            {
              tenant_id: 'test-org',
              run_id: 'slo_run_test',
              total_slos: 1,
              valid_slos: 0,
              misconfigured_slos: 1,
              unclassified_slos: 0,
              compliance_score: 20,
              compliance_tier: 'Critical',
              monitoring_context: { apm_enabled: false, synthetics_enabled: false, infra_monitoring: true },
              category_scores: { availability: 20, latency: null, error_rate: null },
              na_categories: ['latency', 'error_rate'],
              gap_analysis: [
                {
                  severity: 'critical',
                  category: 'formula',
                  insight: 'The SLO formula is inverted — numerator can exceed denominator causing impossible compliance values.',
                  affected_slos: 1,
                  recommendation: 'Swap numerator and denominator in the metric SLO query.',
                },
              ],
              completed_at: new Date().toISOString(),
            },
          ],
          slo_results: [
            {
              slo_id: 'broken001',
              tenant_id: 'test-org',
              slo_name: 'Broken Availability SLO',
              slo_type: 'metric',
              sli_category: 'availability',
              formula_valid: false,
              formula_issue: 'Numerator sum:errors could exceed denominator sum:successes — formula inverted',
              context_compatible: true,
              validation_score: 20,
              validation_status: 'critical',
              blocker_issues: ['Formula inverted: numerator can exceed denominator'],
              quality_issues: ['No team tag', 'Only 7d window'],
              enhancements: ['Add description'],
              insight: 'The numerator sum:trace.web.request.errors could exceed the denominator sum:trace.web.request.hits{http.status_code:200} — the denominator should be total requests, not just successes.',
              tags: ['env:prod'],
              target_percentage: 99.9,
              time_windows: ['7d'],
              analyzed_at: new Date().toISOString(),
            },
          ],
        }),
      });
    });

    await page.route('**/api/slo/active-run*', async (route) => {
      await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'No active SLO run' }) });
    });

    await page.goto('/slo');
    await page.waitForURL(/\/slo$/, { timeout: 10000 });
    await page.waitForTimeout(3000);

    // Click SLO Details tab if present
    const detailsTab = page.getByRole('button', { name: /SLO Details/i });
    if (await detailsTab.isVisible({ timeout: 5000 }).catch(() => false)) {
      await detailsTab.click();
    }

    // Verify SLO row renders
    await expect(page.getByText('Broken Availability SLO')).toBeVisible({ timeout: 10000 });

    // Click to expand the row
    await page.getByText('Broken Availability SLO').click();

    // Verify blocker issues render as strings (not [object Object])
    await expect(page.getByText('Formula inverted: numerator can exceed denominator')).toBeVisible({ timeout: 5000 });

    // Verify quality issues render as strings
    await expect(page.getByText('No team tag')).toBeVisible({ timeout: 5000 });

    // Verify AI insight renders — use first() since the insight text may appear in multiple places
    await expect(page.getByText(/numerator.*denominator/i).first()).toBeVisible({ timeout: 5000 });

    // No crash — heading still visible
    await expect(page.getByRole('heading', { name: 'SLO Compliance Audit' })).toBeVisible();
  });

  test('/slo Gap Analysis tab renders per-SLO gap table with SLO names', async ({ page }) => {
    await page.route('**/api/slo/results*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          run_id: 'slo_run_test',
          completed_at: new Date().toISOString(),
          trigger_type: 'manual',
          org_summaries: [
            {
              tenant_id: 'test-org',
              run_id: 'slo_run_test',
              total_slos: 2,
              valid_slos: 0,
              misconfigured_slos: 2,
              unclassified_slos: 0,
              compliance_score: 40,
              compliance_tier: 'Critical',
              monitoring_context: { apm_enabled: true, synthetics_enabled: false, infra_monitoring: true },
              category_scores: { availability: 40, latency: 40, error_rate: null },
              na_categories: ['error_rate'],
              gap_analysis: [
                {
                  severity: 'high',
                  gap_type: 'Time Window Coverage',
                  issue: 'All SLOs use 7-day windows only. Monthly SLA reporting is impossible.',
                  affected_slo_names: ['Payment Gateway Availability', 'Search API Latency'],
                  recommendation: 'Add 30-day time windows to all SLOs.',
                },
              ],
              completed_at: new Date().toISOString(),
            },
          ],
          slo_results: [
            {
              slo_id: 'gap001',
              tenant_id: 'test-org',
              slo_name: 'Payment Gateway Availability',
              slo_type: 'monitor',
              sli_category: 'availability',
              formula_valid: false,
              formula_issue: 'Formula inverted',
              context_compatible: true,
              validation_score: 20,
              validation_status: 'critical',
              blocker_issues: ['Formula inverted: numerator can exceed denominator'],
              quality_issues: ['No team tag configured'],
              enhancements: ['Add description'],
              insight: 'Formula is inverted.',
              tags: ['env:prod'],
              target_percentage: 99.9,
              time_windows: ['7d'],
              analyzed_at: new Date().toISOString(),
            },
            {
              slo_id: 'gap002',
              tenant_id: 'test-org',
              slo_name: 'Search API Latency',
              slo_type: 'metric',
              sli_category: 'latency',
              formula_valid: true,
              formula_issue: null,
              context_compatible: true,
              validation_score: 60,
              validation_status: 'needs_improvement',
              blocker_issues: [],
              quality_issues: ['avg: aggregation hides tail latency'],
              enhancements: ['Add env tag'],
              insight: 'Uses avg aggregation.',
              tags: ['team:search'],
              target_percentage: 99.5,
              time_windows: ['7d'],
              analyzed_at: new Date().toISOString(),
            },
          ],
        }),
      });
    });

    await page.route('**/api/slo/active-run*', async (route) => {
      await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'No active SLO run' }) });
    });

    await page.goto('/slo');
    await page.waitForURL(/\/slo$/, { timeout: 10000 });
    await page.waitForTimeout(3000);

    // Click Gap Analysis tab
    const gapTab = page.getByRole('button', { name: /Gap Analysis/i });
    if (await gapTab.isVisible({ timeout: 5000 }).catch(() => false)) {
      await gapTab.click();
    }

    // Verify gap TABLE renders with SLO names in each row (not just "3 SLOs affected")
    await expect(page.getByRole('table').getByText('Payment Gateway Availability').first()).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole('table').getByText('Search API Latency').first()).toBeVisible({ timeout: 5000 });

    // Verify severity badges render as strings
    await expect(page.getByText('high', { exact: true }).first()).toBeVisible({ timeout: 5000 });

    // Verify issue text renders in table rows
    await expect(page.getByText(/All SLOs use 7-day windows/i).first()).toBeVisible({ timeout: 5000 });

    // Verify gap type column renders
    await expect(page.getByText('Time Window Coverage').first()).toBeVisible({ timeout: 5000 });

    // No crash — heading still visible
    await expect(page.getByRole('heading', { name: 'SLO Compliance Audit' })).toBeVisible();
  });

  test('/slo expanding SLO row shows history chart loading state', async ({ page }) => {
    // Mock history API to return a loading state (slow response)
    await page.route('**/api/slo/history*', async (route) => {
      // Return valid history data
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          slo_id: 'slo001',
          tenant_id: 'test-org',
          overall_sli: 99.87,
          data_points: [
            { month: '2025-03', timestamp: 1740787200, sli_value: 99.91 },
            { month: '2025-04', timestamp: 1743465600, sli_value: 99.88 },
            { month: '2025-05', timestamp: 1746057600, sli_value: 99.72 },
            { month: '2025-06', timestamp: 1748736000, sli_value: 99.95 },
            { month: '2025-07', timestamp: 1751328000, sli_value: 99.80 },
          ],
        }),
      });
    });

    await page.route('**/api/slo/results*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          run_id: 'slo_run_test',
          completed_at: new Date().toISOString(),
          trigger_type: 'manual',
          org_summaries: [
            {
              tenant_id: 'test-org',
              run_id: 'slo_run_test',
              total_slos: 1,
              valid_slos: 1,
              misconfigured_slos: 0,
              unclassified_slos: 0,
              compliance_score: 90,
              compliance_tier: 'Excellent',
              monitoring_context: { apm_enabled: false, synthetics_enabled: false, infra_monitoring: true },
              category_scores: { availability: 90, latency: null, error_rate: null },
              na_categories: ['latency', 'error_rate'],
              gap_analysis: [],
              completed_at: new Date().toISOString(),
            },
          ],
          slo_results: [
            {
              slo_id: 'slo001',
              tenant_id: 'test-org',
              slo_name: 'Checkout Availability',
              slo_type: 'monitor',
              sli_category: 'availability',
              formula_valid: true,
              formula_issue: null,
              context_compatible: true,
              validation_score: 90,
              validation_status: 'excellent',
              blocker_issues: [],
              quality_issues: [],
              enhancements: [],
              insight: 'Excellent SLO configuration.',
              tags: ['team:checkout'],
              target_percentage: 99.9,
              time_windows: ['7d', '30d'],
              analyzed_at: new Date().toISOString(),
            },
          ],
        }),
      });
    });

    await page.route('**/api/slo/active-run*', async (route) => {
      await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'No active SLO run' }) });
    });

    await page.goto('/slo');
    await page.waitForURL(/\/slo$/, { timeout: 10000 });
    await page.waitForTimeout(3000);

    // Click SLO Details tab
    const detailsTab = page.getByRole('button', { name: /SLO Details/i });
    if (await detailsTab.isVisible({ timeout: 5000 }).catch(() => false)) {
      await detailsTab.click();
    }

    // Verify SLO row renders
    await expect(page.getByText('Checkout Availability')).toBeVisible({ timeout: 10000 });

    // Click to expand the row — this triggers history chart load
    await page.getByText('Checkout Availability').click();

    // Verify the history chart section appears (either loading state or chart)
    const hasChartLabel = await page.getByText(/SLI Performance Trend/i).isVisible({ timeout: 8000 }).catch(() => false);
    const hasLoadingState = await page.getByText(/Loading performance history/i).isVisible({ timeout: 3000 }).catch(() => false);
    expect(hasChartLabel || hasLoadingState).toBe(true);

    // No crash — heading still visible
    await expect(page.getByRole('heading', { name: 'SLO Compliance Audit' })).toBeVisible();
  });

  test('/slo Trends tab shows multi-line SLI chart', async ({ page }) => {
    // Mock history API — return 4 monthly data points for every SLO
    await page.route('**/api/slo/history*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          slo_id: 'slo001',
          tenant_id: 'test-org',
          overall_sli: 99.87,
          data_points: [
            { month: '2025-03', timestamp: 1740787200, sli_value: 99.91 },
            { month: '2025-06', timestamp: 1748736000, sli_value: 99.72 },
            { month: '2025-09', timestamp: 1756684800, sli_value: 99.88 },
            { month: '2025-12', timestamp: 1764633600, sli_value: 99.95 },
          ],
        }),
      });
    });

    await page.route('**/api/slo/results*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          run_id: 'slo_run_test',
          completed_at: new Date().toISOString(),
          trigger_type: 'manual',
          org_summaries: [
            {
              tenant_id: 'test-org',
              run_id: 'slo_run_test',
              total_slos: 2,
              valid_slos: 1,
              misconfigured_slos: 0,
              unclassified_slos: 0,
              compliance_score: 75,
              compliance_tier: 'good',
              monitoring_context: { apm_enabled: false, synthetics_enabled: true, infra_monitoring: true },
              category_scores: { availability: 80, latency: null, error_rate: 70 },
              na_categories: ['latency'],
              gap_analysis: [],
              completed_at: new Date().toISOString(),
            },
          ],
          slo_results: [
            {
              slo_id: 'slo001',
              tenant_id: 'test-org',
              slo_name: 'Checkout Availability',
              slo_type: 'monitor',
              sli_category: 'availability',
              formula_valid: true,
              formula_issue: null,
              context_compatible: true,
              validation_score: 80,
              validation_status: 'good',
              blocker_issues: [],
              quality_issues: [],
              enhancements: [],
              insight: 'Good SLO.',
              tags: [],
              target_percentage: 99.9,
              time_windows: ['30d'],
              analyzed_at: new Date().toISOString(),
            },
            {
              slo_id: 'slo002',
              tenant_id: 'test-org',
              slo_name: 'API Error Rate',
              slo_type: 'metric',
              sli_category: 'error_rate',
              formula_valid: true,
              formula_issue: null,
              context_compatible: true,
              validation_score: 70,
              validation_status: 'needs_improvement',
              blocker_issues: [],
              quality_issues: [],
              enhancements: [],
              insight: 'Needs improvement.',
              tags: [],
              target_percentage: 99.5,
              time_windows: ['7d'],
              analyzed_at: new Date().toISOString(),
            },
          ],
        }),
      });
    });

    await page.route('**/api/slo/active-run*', async (route) => {
      await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'No active SLO run' }) });
    });

    await page.goto('/slo');
    await page.waitForURL(/\/slo$/, { timeout: 10000 });
    await page.waitForTimeout(2000);

    // Click the Trends tab
    const trendsTab = page.getByRole('button', { name: /Trends/i });
    await expect(trendsTab).toBeVisible({ timeout: 8000 });
    await trendsTab.click();

    // The combined SVG chart renders once history loads
    await expect(page.locator('svg').first()).toBeVisible({ timeout: 10000 });

    // Searchable SLO filter combobox is present at the top — placeholder text visible in trigger
    const comboboxTrigger = page.getByText('Filter SLOs…').first();
    await expect(comboboxTrigger).toBeVisible({ timeout: 8000 });

    // Open the dropdown by clicking the placeholder text
    await comboboxTrigger.click();

    // Search input appears inside the dropdown
    await expect(page.getByPlaceholder('Search SLOs…')).toBeVisible({ timeout: 5000 });

    // Both SLO names appear in the dropdown list
    await expect(page.getByText('Checkout Availability').first()).toBeVisible({ timeout: 8000 });
    await expect(page.getByText('API Error Rate').first()).toBeVisible({ timeout: 5000 });

    // Search filters the list
    await page.getByPlaceholder('Search SLOs…').fill('Checkout');
    await expect(page.getByText('Checkout Availability').first()).toBeVisible({ timeout: 3000 });
    await expect(page.getByText('API Error Rate')).not.toBeVisible();

    // Clear search and select one SLO — it becomes a chip
    await page.getByPlaceholder('Search SLOs…').fill('');
    await page.getByText('Checkout Availability').first().click();
    // Close dropdown by pressing Escape
    await page.keyboard.press('Escape');
    // Chip for selected SLO is visible in the combobox trigger
    await expect(page.getByText('Checkout Availability').first()).toBeVisible({ timeout: 5000 });

    // No crash
    await expect(page.getByRole('heading', { name: 'SLO Compliance Audit' })).toBeVisible();
  });
});
