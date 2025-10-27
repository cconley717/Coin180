import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.{spec,test}.ts'],
    exclude: ['node_modules/**', 'dist/**', 'build/**', 'out/**'],
    coverage: {
      provider: 'v8', // or 'istanbul'
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/__tests__/**'],
      thresholds: {
        statements: 90,
        branches: 85,
        functions: 90,
        lines: 90,
      },
    },
  },
});
