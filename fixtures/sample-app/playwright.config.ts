import { defineConfig } from '@playwright/test'

const bugs = process.env.BUGS ?? 'all'

export default defineConfig({
  testDir: './tests',
  // The tests share one SQLite database.
  workers: 1,
  use: {
    baseURL: 'http://localhost:3731',
    channel: 'chrome',
    trace: 'retain-on-failure',
  },
  // Never reuse a running server: on a busy port that could be another app.
  webServer: [
    {
      command: 'npm run dev:api',
      url: 'http://127.0.0.1:8731/api/health',
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: 'npm run dev:web',
      url: 'http://localhost:3731/login',
      reuseExistingServer: false,
      timeout: 120_000,
      env: { NUXT_PUBLIC_BUGS: bugs, NUXT_TELEMETRY_DISABLED: '1' },
    },
  ],
})
