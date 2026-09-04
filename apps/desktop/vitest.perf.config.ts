import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

// Dedicated Vitest config for the M5 performance harness (`pnpm perf`).
//
// It is separate from the main suite (which uses vite.config.ts) so the slow
// benchmarks never run inside the regular `pnpm test`/CI gate. The harness runs
// in happy-dom for Blob/File/FileReader parity with the app, and is given a
// generous timeout because it indexes/lays out 10k synthetic notes.
export default defineConfig({
  plugins: [vue()],
  test: {
    environment: 'happy-dom',
    setupFiles: ['./src/test-setup.ts', './perf/perf.setup.ts'],
    include: ['perf/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    reporters: ['default'],
  },
})
