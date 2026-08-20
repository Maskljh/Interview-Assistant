import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    pool: 'threads',
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
