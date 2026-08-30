import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: {
    // KaTeX fonts (largest ~63KB .ttf, ~33KB .woff2) must be embedded as
    // data: URIs so the ?inline KaTeX CSS string stays self-contained when
    // the exported HTML is opened standalone (file://) or printed to PDF.
    // The default 4KB limit would emit them as separate /assets/ files.
    assetsInlineLimit: 1000000,
  },
  test: {
    environment: 'happy-dom',
    setupFiles: ['./src/test-setup.ts'],
    include: ['src/**/*.test.ts'],
  },
})
