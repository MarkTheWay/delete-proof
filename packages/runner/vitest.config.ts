import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 60_000,  // scenarios need real DB/Redis
    hookTimeout: 30_000,
    reporters: ['verbose'],
    include: ['src/**/*.test.ts'],
  },
});
