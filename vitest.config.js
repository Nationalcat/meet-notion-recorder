import { defineConfig } from 'vitest/config';

process.env.TZ = 'Asia/Taipei';

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['test/unit/**/*.test.js'],
    restoreMocks: true,
    unstubGlobals: true,
    setupFiles: ['test/helpers/setup.js'],
    coverage: {
      provider: 'v8',
      include: ['*.js', 'lib/**/*.js'],
      exclude: ['*.config.js'],
      reporter: ['text', 'html'],
      thresholds: { lines: 100, functions: 100, branches: 100, statements: 100 }
    }
  }
});
