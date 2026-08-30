// Build-level assertion: the desktop build must embed the KaTeX fonts as
// data: URIs inside the ?inline KaTeX CSS string. Vitest runs with
// `css: false` so unit tests never see the real CSS pipeline — this check
// runs against the actual `vite build` output in dist/.
//
// Run after `pnpm --filter @nekowite/desktop build`:
//   node apps/desktop/scripts/check-katex.ts
//
// Exits non-zero if the produced bundle references KaTeX fonts via
// `/assets/KaTeX_*.woff2` paths (i.e. fonts would 404 when the exported HTML
// is opened standalone or printed to PDF).

import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const distDir = resolve(import.meta.dirname, '../dist/assets')

const jsFiles = (await readdir(distDir)).filter((f) => f.endsWith('.js'))

const bundle = (
  await Promise.all(jsFiles.map((f) => readFile(join(distDir, f), 'utf8')))
).join('\n')

if (!bundle.includes('.katex')) {
  console.error('check-katex: FAIL — KaTeX CSS (.katex) not found in built bundle')
  process.exit(1)
}

const dataFonts = bundle.match(/data:font\/[^;,)]+/g) ?? []
console.log(`check-katex: OK — ${dataFonts.length} embedded data:font asset(s)`)

const externalRefs = bundle.match(/[("']\/assets\/KaTeX_[^)"']+/g) ?? []
if (externalRefs.length > 0) {
  console.error(
    `check-katex: FAIL — ${externalRefs.length} KaTeX font ref(s) still point at external /assets/ paths:`,
    [...new Set(externalRefs)].slice(0, 10),
  )
  process.exit(1)
}

console.log('check-katex: OK — no external KaTeX font references remain')
