import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// Group the large, rarely-changing vendor libs into their own chunks so the
// initial HTML/graph stays small and each vendor chunk can be cached and
// loaded on demand. The per-frame editor work (Milkdown/ProseMirror) and the
// heavyweight helpers (MathLive, citation-js, CodeMirror) are split apart so a
// hot reload does not re-evaluate a megabyte of unrelated code.
function manualChunks(id: string): string | undefined {
  if (!id.includes('node_modules')) return undefined

  if (id.includes('mathlive')) return 'vendor-mathlive'
  if (id.includes('citation-js') || id.includes('@citation')) return 'vendor-citation'
  // Milkdown re-exports ProseMirror via @milkdown/prose — catch it before the
  // generic prosemirror rule so the whole editor stack stays together.
  if (id.includes('@milkdown')) return 'vendor-milkdown'
  if (id.includes('@codemirror') || id.includes('@lezer')) return 'vendor-codemirror'
  if (id.includes('katex')) return 'vendor-katex'

  if (
    id.includes('prosemirror-') ||
    id.includes('@prosemirror/') ||
    id.includes('orderedmap') ||
    id.includes('w3c-keyname') ||
    id.includes('rope-sequence')
  ) {
    return 'vendor-prosemirror'
  }

  return 'vendor'
}

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
    rollupOptions: {
      output: { manualChunks },
    },
  },
  test: {
    environment: 'happy-dom',
    setupFiles: ['./src/test-setup.ts'],
    include: ['src/**/*.test.ts'],
  },
})
