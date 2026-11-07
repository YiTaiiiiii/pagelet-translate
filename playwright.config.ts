import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: 'list',
  use: { channel: 'chromium', headless: true, viewport: { width: 1440, height: 1050 }, colorScheme: 'light' },
  webServer: { command: 'node scripts/serve-output.mjs', url: 'http://127.0.0.1:5197/popup.html', reuseExistingServer: true },
});
