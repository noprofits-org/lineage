import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 20_000,
  use: { baseURL: 'http://127.0.0.1:8010' },
  webServer: {
    command: 'python3 -m http.server 8010',
    port: 8010,
    reuseExistingServer: true,
  },
})
