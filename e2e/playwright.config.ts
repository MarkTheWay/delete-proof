import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  timeout: 180_000,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.RUNNER_URL ?? 'http://localhost:3001',
    trace: 'off',
  },
  projects: [
    {
      name: 'api',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
