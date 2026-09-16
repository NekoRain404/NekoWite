import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** This package's manifest, for the version the UI displays. */
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }

// Group the large, rarely-changing vendor libs into their own chunks so the
// initial HTML/graph stays small and each vendor chunk can be cached and
// loaded on demand. The per-frame editor work (Milkdown/ProseMirror), the
// heavyweight on-demand helpers (MathLive, citation-js, KaTeX, CodeMirror),
// the Vue runtime/i18n, and the unified/markdown parse stack are split apart
// so a hot reload does not re-evaluate a megabyte of unrelated code and
// hashes stay stable across app-only edits.
//
// Chunk membership is derived deterministically from the module's package name
// (the path segment(s) right after `node_modules/`), so the grouping never
// churns on unrelated source edits and identical deps always land in the same
// chunk for cache-stable hash output.
function manualChunks(id: string): string | undefined {
  if (!id.includes('node_modules')) return undefined

  // Package name is the segment(s) immediately after the (last) `node_modules/`
  // directory. With pnpm the real package lives under a
  // `node_modules/.pnpm/<name>@<version>/node_modules/<name>/` chain, so we
  // take the segment after the LAST `node_modules/` to get the actual package
  // name: `@citation-js/core`, `@milkdown/prose`, `vue`, `orderedmap`, etc.
  const pkg = id
    .replace(/^.*node_modules[\\/]/, '')
    .match(/^(?:@[^\\/]+[\\/])?[^\\/]+/)?.[0]
  if (!pkg) return undefined

  // Heavy, on-demand helpers that are only ever pulled in via dynamic
  // import() (math, citations, and the HTML-export path) — kept isolated so
  // they never enter the startup graph and can be parsed/cached independently.
  if (pkg === 'katex') return 'vendor-katex'
  if (pkg === 'mathlive') return 'vendor-mathlive'
  if (pkg.startsWith('@citation-js')) return 'vendor-citation'

  // Milkdown re-exports ProseMirror via @milkdown/prose — catch the whole
  // editor stack before the generic prosemirror rule so it stays together.
  if (pkg.startsWith('@milkdown')) return 'vendor-milkdown'

  // ProseMirror core and the editor frame.
  if (
    pkg.startsWith('prosemirror') ||
    pkg.startsWith('@prosemirror') ||
    pkg === 'orderedmap' ||
    pkg === 'w3c-keyname' ||
    pkg === 'rope-sequence' ||
    pkg === 'crelt'
  ) {
    return 'vendor-prosemirror'
  }

  // CodeMirror / Lezer highlighting.
  if (pkg.startsWith('@codemirror') || pkg.startsWith('@lezer')) return 'vendor-codemirror'

  // App framework: Vue + its runtime helpers, Pinia, the i18n runtime, and the
  // icon set. All are imported eagerly but are stable — grouping them lets the
  // browser cache them across releases while app edits don't re-hash them.
  if (
    pkg === 'vue' ||
    pkg.startsWith('@vue') ||
    pkg === 'pinia' ||
    pkg === 'vue-i18n' ||
    pkg.startsWith('@intlify') ||
    pkg === 'lucide-vue-next'
  ) {
    return 'vendor-vue'
  }

  // Unified/remark markdown parse pipeline (remark/unified/micromark/mdast/
  // hast/vfile) that backs both the editor doc model and the HTML export.
  if (
    pkg.startsWith('remark') ||
    pkg.startsWith('unified') ||
    pkg.startsWith('micromark') ||
    pkg === 'mdast' ||
    pkg.startsWith('mdast-') ||
    pkg.startsWith('hast') ||
    pkg === 'vfile' ||
    pkg.startsWith('vfile-') ||
    pkg.startsWith('unist') ||
    pkg.startsWith('mdx') ||
    pkg.startsWith('@mdx') ||
    pkg.startsWith('rehype')
  ) {
    return 'vendor-markdown'
  }

  return 'vendor'
}

export default defineConfig({
  // The version a user sees in Settings has to be the BUILD's version: a bug
  // report that cannot name its build costs a round trip. Injected at build
  // time because the renderer has no filesystem, and read from Tauri at
  // runtime when the app is packaged (see src/platform/appVersion.ts).
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },  plugins: [vue()],
  clearScreen: false,
  server: { port: 1420, strictPort: true, watch: { ignored: ['**/src-tauri/target/**'] } },
  // The off-main-thread graph layout uses `new Worker(new URL(..., import.meta.url),
  // { type: 'module' })`. That worker chunk can contain code-split imports, which
  // the default `iife` worker output format does not support — build it as an ES
  // module so Rollup can emit (and dynamically import) auxiliary chunks.
  worker: { format: 'es' },
  build: {
    // KaTeX fonts (largest ~63KB .ttf, ~33KB .woff2) must be embedded as
    // data: URIs so the ?inline KaTeX CSS string stays self-contained when
    // the exported HTML is opened standalone (file://) or printed to PDF.
    // The default 4KB limit would emit them as separate /assets/ files.
    assetsInlineLimit: 1000000,
    rollupOptions: {
      // Two pages, because §7.1 gives the pet a window that is not a second application: the
      // pet's window loads `desktop-pet.html`, whose module graph is the pet and nothing else
      // (`src/app/desktop-pet-entry.ts`), so it never parses the editor, the index or the agent
      // panel. The dev server would serve the file anyway — Vite serves the project root
      // statically — but a *build* only emits the HTML files named here, and a window whose page
      // was missing from the bundle would load a blank frame in exactly the packaged app the
      // pet ships in.
      input: {
        index: fileURLToPath(new URL('index.html', import.meta.url)),
        'desktop-pet': fileURLToPath(new URL('desktop-pet.html', import.meta.url)),
      },
      output: { manualChunks },
      // `remark-math` pulls in `micromark-extension-math`, whose root index
      // re-exports `lib/html.js` — a module that statically `import katex
      // from 'katex'` solely to implement the `mathHtml` HTML serializer.
      // We never invoke that serializer (the export pipeline renders math from
      // its own mdast walk), so that static `import 'katex'` would otherwise
      // drag the whole 1.7MB `vendor-katex` chunk into the entry's initial
      // modulepreload graph at startup. Marking `katex` as side-effect-free
      // lets Rollup tree-shake that unused import; KaTeX is then only reached
      // through the app's own on-demand `import('katex')`/`?inline` CSS.
      treeshake: {
        moduleSideEffects: (id) => !id.includes('node_modules/katex'),
      },
    },
  },
  test: {
    environment: 'happy-dom',
    setupFiles: ['./src/test-setup.ts'],
    include: ['src/**/*.test.ts'],
  },
})

