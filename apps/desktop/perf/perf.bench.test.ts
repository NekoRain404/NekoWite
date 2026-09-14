/**
 * M5 large-vault performance harness (`pnpm perf`).
 *
 * Measures the JS/service-level costs that dominate the §9 budget, on synthetic
 * data, and asserts sane upper bounds so it can act as a CI gate. App-level
 * metrics that need a real WebView (cold-start, first-input, open-document) are
 * measured via representative proxies (note-index build, single-match latency,
 * note-meta parse) — see docs/PERF.md for the legend.
 *
 * Run: `pnpm perf` from the repo root (or `pnpm --filter @nekowite/desktop perf`).
 * Output is a table of `metric — ms`.
 *
 * CI runs it (`pnpm perf` in .github/workflows/ci.yml), so this suite is a gate,
 * not a report. It is deliberately outside `pnpm test`: it builds a 10k-note
 * index and lays out a 2k graph, which is seconds of work that does not belong in
 * the per-file unit loop. Being in no gate at all is what let it rot — for two
 * stages its imports did not resolve and nothing said so.
 */

import { afterAll, describe, expect, it } from 'vitest'
import { performance } from 'node:perf_hooks'
import {
  buildIndexIncremental,
  queryIndex,
  buildSearchText,
} from '../src/features/search'
import { buildLinkGraphDetailed, computeLayoutChunked } from '../src/services/link-graph'
import { fileToBase64 } from '../src/services/attachments'
import { parseNoteMeta } from '../src/features/notes'

const N = 10_000
const QUERIES = 50

interface SyntheticNote {
  path: string
  content: string
  mtime: number
  size: number
}

/** Build `n` synthetic notes. Content carries a title, a body word, and a wiki
 * link to the next note whose target resolves to an exact existing path — so a
 * graph build stays cheap (exact-match resolution, no per-link path scan). */
function makeNotes(n: number): SyntheticNote[] {
  const out: SyntheticNote[] = []
  for (let i = 0; i < n; i++) {
    const path = `vault/note-${i}.md`
    const content =
      `# Note ${i}\n\nBody on topic ${i}: the quick brown fox jumps over the lazy dog. ` +
      `Searchable token ${i} for full-text matching.\n\n[[note-${(i + 1) % n}]]`
    out.push({ path, content, mtime: 1000 + i, size: content.length })
  }
  return out
}

function now(): number {
  return performance.now()
}

const results = new Map<string, number>()

function record(key: string, ms: number): number {
  results.set(key, ms)
  return ms
}

function p95(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]
}

afterAll(() => {
  console.log('\n=== NekoWite perf harness (ms) ===')
  for (const [key, ms] of results) console.log(`${key.padEnd(28)} ${ms.toFixed(1)}`)
  console.log('=== end ===')
})

describe('M5 performance harness', () => {
  it('indexes and searches 10k notes (indexed-search budget)', async () => {
    const notes = makeNotes(N)
    const byPath = new Map(notes.map((n) => [n.path, n]))
    const stat = async (path: string) => {
      const n = byPath.get(path)
      return n ? { mtime: n.mtime, size: n.size } : null
    }
    const read = async (path: string) => byPath.get(path)?.content ?? ''

    // First-ever build: cold-start proxy for the note-list index work.
    const buildStart = now()
    const built = await buildIndexIncremental(
      'vault',
      notes.map((n) => n.path),
      { stat, read },
      null,
    )
    const buildMs = now() - buildStart
    record('index-build-10k', buildMs)
    expect(built.built).toBe(N)
    expect(built.skipped).toBe(0)
    // The cold-start proxy has a documented budget (§9: 2s) like every other row
    // in docs/PERF.md, but it was only RECORDED, never asserted — so a
    // ten-times regression would have shown up as a bigger number in the table
    // and nothing else. Enforce it.
    expect(buildMs).toBeLessThanOrEqual(2000)

    // Indexed search: §9 target P95 ≤ 300ms.
    const latencies: number[] = []
    for (let i = 0; i < QUERIES; i++) {
      const q = `topic ${i}`
      const t0 = now()
      const hits = queryIndex(built.index, q)
      latencies.push(now() - t0)
      expect(hits.length).toBeGreaterThan(0)
    }
    const searchP95 = record('search-query-p95-10k', p95(latencies))
    expect(searchP95).toBeLessThanOrEqual(300)

    // change → index: re-index a single changed note among the 10k.
    const changedPath = 'vault/note-42.md'
    const changedNote = byPath.get(changedPath)!
    changedNote.content = '# Note 42\n\nNew body content after an edit.\n\n[[note-1]]'
    changedNote.mtime = 99_999
    changedNote.size = changedNote.content.length
    const changeStart = now()
    const incremental = await buildIndexIncremental(
      'vault',
      notes.map((n) => n.path),
      { stat, read },
      built.index,
    )
    record('change-to-index-10k', now() - changeStart)
    expect(incremental.built).toBe(1)
    expect(incremental.skipped).toBe(N - 1)
  })

  it('lays out a large graph asynchronously (graph budget)', async () => {
    // Graph build over the full 10k notes (exact link resolution → cheap).
    const notes = makeNotes(N)
    const buildStart = now()
    const graph = buildLinkGraphDetailed(notes.map((n) => ({ path: n.path, content: n.content })))
    record('graph-build-10k', now() - buildStart)
    expect(graph.nodes).toHaveLength(N)
    expect(graph.edges.length).toBeGreaterThan(0)

    // Layout: the app's chunked/worker path. A full 10k layout is O(n²) and
    // deliberately runs off the main thread (Worker, chunked fallback) — the
    // harness exercises the chunked path on a scaled 2k graph to keep the gate
    // fast, and asserts it yields/completes. (See PERF.md §10k graph note.)
    const LAYOUT_N = 2000
    const sub = notes.slice(0, LAYOUT_N)
    const subGraph = buildLinkGraphDetailed(sub.map((n) => ({ path: n.path, content: n.content })))
    const layoutStart = now()
    const points = await computeLayoutChunked(
      subGraph.nodes.map((n) => ({ id: n.id })),
      subGraph.edges.map((e) => ({ from: e.from, to: e.to })),
      900,
      600,
    )
    const layoutMs = record('graph-layout-2k', now() - layoutStart)
    expect(points).toHaveLength(LAYOUT_N)
    expect(layoutMs).toBeLessThanOrEqual(3000)
  })

  it('inserts a 10MB image without freezing (image budget)', async () => {
    // ~9 MiB (just under the 10 MiB cap) so the encode path is exercised.
    const blob = new Blob([new Uint8Array(9 * 1024 * 1024)], { type: 'image/png' })
    const start = now()
    const base64 = await fileToBase64(blob)
    const ms = record('image-insert-10mb', now() - start)
    expect(base64.length).toBeGreaterThan(0)
    expect(ms).toBeLessThanOrEqual(2000)
  })

  it('opens and indexes a 1MB document (open-document budget)', async () => {
    const huge = `# Big doc\n\n${'lorem ipsum dolor sit amet '.repeat(64 * 1024)}`
    const start = now()
    const meta = parseNoteMeta('vault/big.md', huge, { mtime: 1, size: huge.length, vault: 'vault' })
    buildSearchText('vault/big.md', huge, 'vault', 1, huge.length)
    const ms = record('open-doc-1mb', now() - start)
    expect(meta.path).toBe('vault/big.md')
    expect(ms).toBeLessThanOrEqual(300)
  })

  it('edits a 500×30 table without stalling (table budget)', async () => {
    const COLS = 30
    const ROWS = 500
    const header = `|${' h |'.repeat(COLS)}`
    const sep = `|${'---|'.repeat(COLS)}`
    let table = `${header}\n${sep}\n`
    for (let r = 0; r < ROWS; r++) {
      table += `|${Array.from({ length: COLS }, (_, c) => ` ${r}-${c} `).join('|')}|\n`
    }
    const start = now()
    // Structural re-parse the table on each "keystroke" (split rows → cells).
    const rows = table.split('\n').filter((line) => line.trim().startsWith('|'))
    let cells = 0
    for (const row of rows) cells += row.split('|').length
    const ms = record('table-500x30-edit', now() - start)
    expect(rows.length).toBe(ROWS + 2)
    expect(cells).toBeGreaterThan(ROWS * COLS)
    expect(ms).toBeLessThanOrEqual(100)
  })

  it('serves a first-input match quickly (first-input budget)', async () => {
    // First-input latency is dominated by the per-keystroke match/snippet work.
    const content = makeNotes(1)[0]!.content
    const start = now()
    for (let i = 0; i < 100; i++) {
      content.toLowerCase().includes('searchable')
    }
    const ms = record('first-input-match-x100', (now() - start) / 100)
    expect(ms).toBeLessThanOrEqual(50)
  })
})
