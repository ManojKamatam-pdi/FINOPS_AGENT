import { test as setup, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';

const authFile = path.join(__dirname, '../.auth/user.json');

/**
 * Auth Setup — opens the app, pauses for manual Okta login, saves auth state.
 * Run once: npx playwright test --project=setup
 * Then run e2e tests: npx playwright test --project=e2e
 */
setup('authenticate with Okta', async ({ page }) => {
  // Reuse saved auth if it exists and is less than 8 hours old
  if (fs.existsSync(authFile)) {
    try {
      const state = JSON.parse(fs.readFileSync(authFile, 'utf-8'));
      for (const origin of state.origins ?? []) {
        for (const entry of origin.localStorage ?? []) {
          if (entry.name === 'okta-token-storage') {
            const tokens = JSON.parse(entry.value);
            const accessToken = tokens?.accessToken;
            if (accessToken?.expiresAt) {
              const remaining = accessToken.expiresAt - Math.floor(Date.now() / 1000) - 300;
              if (remaining > 0) {
                console.log(`\n✅ Auth still valid (~${Math.round(remaining / 60)} min remaining) — skipping login\n`);
                return;
              }
            }
          }
        }
      }
    } catch { /* fall through to fresh login */ }
  }

  console.log('\n========================================');
  console.log('OKTA LOGIN REQUIRED');
  console.log('1. Browser will open and navigate to the app');
  console.log('2. You will be redirected to Okta login');
  console.log('3. Enter your credentials manually');
  console.log('4. After login, press Resume in the Playwright inspector');
  console.log('========================================\n');

  await page.goto('http://localhost:3000');
  await page.pause();

  // After resume: wait for the callback to be processed and redirect to dashboard
  // The app goes: /login/callback?code=... → processes token → window.location.replace('/')
  await page.waitForURL(/localhost:3000\/?$/, { timeout: 60000 });

  const authDir = path.dirname(authFile);
  if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

  await page.context().storageState({ path: authFile });
  console.log(`\n✅ Auth state saved to: ${authFile}\n`);
});
