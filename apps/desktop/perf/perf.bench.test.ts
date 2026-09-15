/**
 * M5 large-vault performance harness (`pnpm perf`).
 *
 * Measures the JS/service-level costs that dominate the §9 budget, on synthetic
 * data, and asserts sane upper bounds so it can act as a CI gate. App-level
 * metrics that need a real WebView (cold-start, first-input, open-document) are
 * measured via representative proxies (note-index build, a content-search
 * keystroke, note-meta parse) — see docs/PERF.md for the legend.
 *
 * Every assertion here is over a call into application code. A proxy that
 * measures the harness's own string work passes whatever the app does, which is
 * how the two rows this file used to end with sat ~50 000× under budget while
 * reading as coverage in docs/PERF.md.
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
import { escapeUnescapedPipes } from '@nekowite/editor-core'
import {
  buildIndexIncremental,
  queryIndex,
  buildSearchText,
} from '../src/features/search'
import { buildLinkGraphDetailed, computeLayoutChunked } from '../src/services/link-graph'
import { fileToBase64 } from '../src/services/attachments'
import { CONTENT_SEARCH_CONCURRENCY, searchWithIndex } from '../src/services/content-search'
import type { ContentSearchCandidate, IndexLookupResult } from '../src/services/content-search'
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

/** Nearest-rank quantile of `values` (`q` in 0..1) over a sorted copy. */
function quantile(values: number[], q: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]
}

function p50(values: number[]): number {
  return quantile(values, 0.5)
}

function p95(values: number[]): number {
  return quantile(values, 0.95)
}

afterAll(() => {
  console.log('\n=== NekoWite perf harness (ms) ===')
  for (const [key, ms] of results) console.log(`${key.padEnd(34)} ${ms.toFixed(1)}`)
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

  it('escapes a 500×30 table on save (table budget)', () => {
    const COLS = 30
    const ROWS = 500
    const header = `|${' h |'.repeat(COLS)}`
    const sep = `|${'---|'.repeat(COLS)}`
    let table = `${header}\n${sep}\n`
    for (let r = 0; r < ROWS; r++) {
      table += `|${Array.from({ length: COLS }, (_, c) => ` ${r}-${c} `).join('|')}|\n`
    }
    // This row used to time the two `split` calls below and nothing else: the
    // "edit" it measured was the harness re-parsing a string the harness had
    // just built. What it measures now is the save path's share of a table
    // edit — the serializer escapes every cell's text through
    // `escapeUnescapedPipes` (packages/editor-core/src/table/stringify.ts) so a
    // `|` the author typed cannot split the row into extra cells on the next
    // open. Same table, same traversal: every piece `split('|')` produces is
    // one call, which is the number of calls a save of this table makes.
    const rows = table.split('\n').filter((line) => line.trim().startsWith('|'))
    const cells: string[] = []
    for (const row of rows) cells.push(...row.split('|'))

    const sweep = (): void => {
      for (const cell of cells) escapeUnescapedPipes(cell)
    }
    for (let w = 0; w < 5; w++) sweep()
    const samples: number[] = []
    for (let i = 0; i < 20; i++) {
      const start = now()
      sweep()
      samples.push(now() - start)
    }
    record('table-500x30-save-escape-p50', p50(samples))
    record('table-500x30-save-escape-p95', p95(samples))
    record('table-500x30-save-escape-max', Math.max(...samples))

    expect(rows.length).toBe(ROWS + 2)
    // 502 rows × 32 pieces: the 30 columns plus the empty piece each row's
    // leading and trailing `|` leaves behind.
    expect(cells.length).toBe((ROWS + 2) * (COLS + 2))
    // Ceiling from the measurement with stated headroom, not from §9 — the
    // budget this row is named after ("500×30 表格编辑 输入响应 P95 ≤ 100ms") is
    // not reachable through the app's real code, which opens this table in
    // ~3.9–5.6s and saves it in ~3.6–3.8s (docs/PERF.md §两行重定向).
    expect(p95(samples)).toBeLessThanOrEqual(50)
  })

  it('serves a content-search keystroke over 10k notes (first-input budget)', async () => {
    const notes = makeNotes(N)
    const byPath = new Map(notes.map((n) => [n.path, n]))
    // The candidate list the note list rebuilds on every keystroke in content
    // search. `readContent` resolves from the cache — the filesystem behind it
    // is the app's, not this harness's — so the row measures the search
    // pipeline (index gate → fold → indexOf → snippet), which is what a
    // headless process can measure at all.
    let bodyReads = 0
    const candidates: ContentSearchCandidate[] = notes.map((n) => ({
      path: n.path,
      name: n.path.slice('vault/'.length),
      title: n.path,
      tags: [],
      summary: n.content.split('\n')[0] ?? '',
      readContent: async () => {
        bodyReads += 1
        return byPath.get(n.path)?.content ?? null
      },
    }))
    const haystack = new Map(notes.map((n) => [n.path, n.content.toLowerCase()]))
    // The persistent index fully up to date — the state the app is in after an
    // index run, and the state in which the gate below is authoritative. A
    // missing or stale entry makes the lookup advisory instead (see
    // `IndexLookupResult`), which is what the app degrades to when its fs
    // subscription is degraded.
    const indexLookup = (path: string): IndexLookupResult | null => {
      const text = haystack.get(path)
      return text === undefined ? null : { upToDate: true, text }
    }

    const QUERIES = 40
    // A word being typed. `token 7` also matches `token 70`…, so ~1.1k of the
    // 10k bodies are read and the other ~9k are skipped by the index gate:
    // both halves of the path are exercised, and the gate's skipping is
    // asserted below rather than assumed.
    const typed = Array.from({ length: QUERIES }, (_, i) => `token ${i}`)
    // The keystroke the gate cannot help with: a word the whole vault matches,
    // so every body is read and every snippet built. Recorded, not asserted —
    // see the note under both metrics in docs/PERF.md.
    const broad = Array.from({ length: QUERIES }, () => 'quick brown fox')

    const measure = async (queries: string[]): Promise<number[]> => {
      for (let w = 0; w < 3; w++) {
        await searchWithIndex(candidates, queries[0]!, indexLookup, undefined, CONTENT_SEARCH_CONCURRENCY)
      }
      bodyReads = 0
      const latencies: number[] = []
      for (const q of queries) {
        const start = now()
        const hits = await searchWithIndex(candidates, q, indexLookup, undefined, CONTENT_SEARCH_CONCURRENCY)
        latencies.push(now() - start)
        // A search that matched nothing would be fast and would gate nothing.
        expect(hits.length).toBeGreaterThan(0)
      }
      return latencies
    }

    const typedLatencies = await measure(typed)
    const typedReads = bodyReads
    record('search-keystroke-10k-p50', p50(typedLatencies))
    const typedP95 = record('search-keystroke-10k-p95', p95(typedLatencies))
    record('search-keystroke-10k-max', Math.max(...typedLatencies))
    // §9: first-input response P95 ≤ 50ms. Measured 12–18ms on this machine
    // under load, so the row fails at a ~3× regression of the real path.
    expect(typedP95).toBeLessThanOrEqual(50)
    // The gate's own value, and the regression it is here to catch: an
    // `upToDate` that stopped being consulted reads every body on every
    // keystroke. Bodies read are counted, not timed — a latency budget alone
    // would let that regression through at ~2× (see docs/PERF.md §两行重定向).
    expect(typedReads).toBeLessThanOrEqual(QUERIES * N * 0.5)

    const broadLatencies = await measure(broad)
    const broadReads = bodyReads
    record('search-broad-10k-p50', p50(broadLatencies))
    record('search-broad-10k-p95', p95(broadLatencies))
    record('search-broad-10k-max', Math.max(...broadLatencies))
    // The shape really is the whole vault: every candidate matched, so no body
    // was skipped.
    expect(broadReads).toBeGreaterThanOrEqual(QUERIES * N * 0.9)
  })
})
