import { splitFrontmatter } from '@nekowite/editor-core'
import { noteDirectory, resolveRelativePath } from './attachments'

/**
 * Note link extraction and graph building for the relations panel.
 * Pure functions only: the panel feeds it note contents and gets back
 * a {nodes, edges} graph plus a computed force-directed layout.
 */

export interface LinkGraphEdge {
  from: string
  to: string
}

export interface LinkGraphNode {
  id: string
  degree: number
}

export interface LinkGraph {
  nodes: LinkGraphNode[]
  edges: LinkGraphEdge[]
}

/** How a link was written: a `[[wikilink]]` or a `[label](target.md)` markdown
 *  link. Kept on detailed edges so the graph can filter by link type. */
export type LinkKind = 'wiki' | 'markdown'

export interface DetailedEdge extends LinkGraphEdge {
  kind: LinkKind
}

/** A link target that could not be resolved to any note in the vault. */
export interface BrokenLink {
  from: string
  target: string
  text: string
}

export interface DetailedGraph {
  nodes: LinkGraphNode[]
  edges: DetailedEdge[]
  broken: BrokenLink[]
}

export interface LayoutPoint {
  id: string
  x: number
  y: number
}

export interface LayoutOptions {
  seed?: number
  iterations?: number
}

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/
const WIKI_OR_MD_RE =
  /\[\[([^[\]|]+)(?:\|[^[\]]*)?\]\]|\[([^\]]*)\]\(([^()\s]+)(?:\s+"[^"]*")?\)/g
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i

/** Remove fenced code blocks so their contents are never scanned for links. */
function stripCodeFences(body: string): string {
  const lines = body.split(/\r\n|\n|\r/)
  const kept: string[] = []
  let fence: { char: string; len: number } | null = null
  for (const line of lines) {
    const match = FENCE_RE.exec(line)
    if (match) {
      const char = match[1][0]
      const len = match[1].length
      if (fence === null) {
        fence = { char, len }
      } else if (char === fence.char && len >= fence.len && match[2].trim() === '') {
        fence = null
      }
      continue
    }
    if (fence !== null) continue
    kept.push(line)
  }
  return kept.join('\n')
}

/** Strip wiki anchors/alias, keep the bare link target. */
function wikiTarget(raw: string): string {
  return raw.split('#')[0].trim()
}

function inlineTarget(raw: string): string | null {
  const target = raw.trim()
  if (!target || target.startsWith('#') || SCHEME_RE.test(target)) return null
  let decoded = target
  try {
    decoded = decodeURIComponent(target)
  } catch {
    // Malformed percent-encoding: fall back to the raw text.
  }
  const withoutAnchor = decoded.split('#')[0].trim()
  if (!withoutAnchor) return null
  const lower = withoutAnchor.toLowerCase()
  if (!lower.endsWith('.md') && !lower.endsWith('.mdx')) return null
  return withoutAnchor
}

/** Extract link targets (wiki and relative .md/.mdx inline links) from a
 * note body. Frontmatter and fenced code blocks are ignored; http(s),
 * anchors and non-markdown (attachment/image) targets are skipped. */
export function extractLinks(content: string): string[] {
  return extractLinksDetailed(content).map((link) => link.target)
}

/** Like {@link extractLinks} but keeps the link kind (wiki vs. markdown) and
 * the display text, so callers can filter by link type and show broken links. */
export function extractLinksDetailed(
  content: string,
): Array<{ target: string; kind: LinkKind; text: string }> {
  const { body } = splitFrontmatter(content)
  const text = stripCodeFences(body)
  const links: Array<{ target: string; kind: LinkKind; text: string }> = []
  for (const match of text.matchAll(WIKI_OR_MD_RE)) {
    const start = match.index ?? 0
    if (start > 0 && text[start - 1] === '!') continue
    if (match[1] !== undefined) {
      const target = wikiTarget(match[1])
      if (!target) continue
      // The wiki alias lives outside a capture group, so pull it from the raw
      // `[[target|alias]]` match: `match[0]` is the whole `[[…]]` token.
      const inner = match[0].slice(2, -2)
      const pipe = inner.lastIndexOf('|')
      const alias = pipe >= 0 ? inner.slice(pipe + 1).trim() : ''
      links.push({ target, kind: 'wiki', text: alias })
      continue
    }
    const target = inlineTarget(match[3] ?? '')
    if (target) links.push({ target, kind: 'markdown', text: (match[2] ?? '').trim() })
  }
  return links
}

function basenameStem(path: string): string {
  const base = path.replace(/\\/g, '/').split('/').pop() ?? path
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(0, dot) : base
}

function hasMarkdownExtension(value: string): boolean {
  const lower = value.toLowerCase()
  return lower.endsWith('.md') || lower.endsWith('.mdx')
}

/** Count how many leading directory segments two vault-relative paths share
 * (`docs/` vs `docs/notes/b.md` → 1). Used to rank a best-match fallback. */
function leadingSharedSegments(a: string, b: string): number {
  const left = a.split('/').filter(Boolean)
  const right = b.split('/').filter(Boolean)
  let i = 0
  while (i < left.length && i < right.length && left[i] === right[i]) i += 1
  return i
}

/** Resolve a link target found in `fromNotePath` against the vault's note
 * paths. Relative paths go through the shared resolver; extension-less
 * wiki names first try `.md`/`.mdx` suffixes on the resolved path, then
 * fall back to a DETERMINISTIC best-match by file-name stem. Returns the
 * vault-relative path of the matched note, or null when nothing matches.
 *
 * A leading `/` anchors the target to the vault ROOT (vault-relative),
 * independently of the source note's directory. That root anchor is kept
 * lossless: stripping it and resolving against the note directory would
 * produce a spurious sub-path, silently miss the exact match, and fall back
 * to "the first note with that filename" — picking a wrong same-name note.
 * The stem fallback is likewise deterministic: it prefers the path sharing
 * the most leading directories with the source note, then the
 * lexicographically smallest path, never "first by input order". */
export function resolveLinkPath(
  fromNotePath: string,
  linkTarget: string,
  allPaths: string[],
): string | null {
  const normalized = linkTarget.replace(/\\/g, '/').trim()
  if (!normalized || normalized.startsWith('#') || SCHEME_RE.test(normalized)) return null
  const withoutAnchor = normalized.split('#')[0].trim()
  if (!withoutAnchor) return null
  const rootRelative = withoutAnchor.startsWith('/')
  const target = rootRelative ? withoutAnchor.replace(/^\/+/, '') : withoutAnchor
  if (!target) return null
  const resolved = rootRelative
    ? target
    : resolveRelativePath(noteDirectory(fromNotePath), target)

  const candidates = hasMarkdownExtension(resolved)
    ? [resolved]
    : [`${resolved}.md`, `${resolved}.mdx`]
  for (const candidate of candidates) {
    const exact = allPaths.find((path) => path === candidate)
    if (exact) return exact
  }

  const stem = basenameStem(target).toLowerCase()
  if (!stem) return null
  const fromDir = noteDirectory(fromNotePath)
  let best: string | null = null
  let bestShared = -1
  for (const path of allPaths) {
    if (basenameStem(path).toLowerCase() !== stem) continue
    const shared = leadingSharedSegments(fromDir, path)
    if (best === null || shared > bestShared || (shared === bestShared && path < best)) {
      best = path
      bestShared = shared
    }
  }
  return best
}

/** Build a richer graph that also tracks each edge's link kind and every
 * unresolved (broken) link target. `broken` lists link targets that resolve to
 * no note, useful for a visible "broken links" warning. */
export function buildLinkGraphDetailed(notes: Array<{ path: string; content: string }>): DetailedGraph {
  const paths = notes.map((note) => note.path)
  const edgeKeys = new Set<string>()
  const edges: DetailedEdge[] = []
  const broken: BrokenLink[] = []
  for (const note of notes) {
    for (const link of extractLinksDetailed(note.content)) {
      const resolved = resolveLinkPath(note.path, link.target, paths)
      if (!resolved) {
        broken.push({ from: note.path, target: link.target, text: link.text })
        continue
      }
      if (resolved === note.path) continue
      const key = `${note.path} ${resolved}`
      if (edgeKeys.has(key)) continue
      edgeKeys.add(key)
      edges.push({ from: note.path, to: resolved, kind: link.kind })
    }
  }
  const degree = new Map<string, number>()
  for (const path of paths) degree.set(path, 0)
  for (const edge of edges) {
    degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1)
    degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1)
  }
  const nodes: LinkGraphNode[] = paths.map((path) => ({ id: path, degree: degree.get(path) ?? 0 }))
  return { nodes, edges, broken }
}

/** Nodes with no edges — "orphaned" notes that nothing links to and that link
 *  to nothing. Kept as a pure helper so the UI can show a count / highlight. */
export function orphanNodes(graph: Pick<LinkGraph, 'nodes'>): LinkGraphNode[] {
  return graph.nodes.filter((node) => node.degree === 0)
}

/** Find every broken link (a target that resolves to no note) across the whole
 *  vault. `from` is the note path that contains the link; `target` is the raw
 *  link target. */
export function findBrokenLinks(
  notes: Array<{ path: string; content: string }>,
): Array<BrokenLink> {
  const paths = notes.map((note) => note.path)
  const broken: BrokenLink[] = []
  for (const note of notes) {
    for (const link of extractLinksDetailed(note.content)) {
      const resolved = resolveLinkPath(note.path, link.target, paths)
      if (!resolved) broken.push({ from: note.path, target: link.target, text: link.text })
    }
  }
  return broken
}

/** Incrementally update a {@link DetailedGraph} after one note's content
 *  changes, without re-reading every note or rebuilding the whole graph.
 *
 *  Only the changed note's OUTGOING edges are recomputed (its incoming edges,
 *  from other notes, are unaffected by its own content). Degrees are
 *  recomputed in one cheap pass over the edge list. When `content` is null the
 *  note is removed: its node and every edge touching it are dropped. The path
 *  set must otherwise be unchanged (a real add/delete/move changes which other
 *  notes' links resolve, so callers should fall back to a full rebuild there).
 */
export function refreshNode(
  graph: DetailedGraph,
  path: string,
  content: string | null,
  allPaths: string[],
): DetailedGraph {
  const paths = allPaths.length > 0 ? allPaths : graph.nodes.map((n) => n.id)
  const pathSet = new Set(paths)
  // A content change only affects the note's OUTGOING edges; an update must keep
  // its incoming edges (other notes still link to it), while a delete drops both.
  const edges =
    content === null
      ? graph.edges.filter((edge) => edge.from !== path && edge.to !== path)
      : graph.edges.filter((edge) => edge.from !== path)
  const broken = graph.broken.filter((b) => b.from !== path)
  const nodesById = new Map(graph.nodes.map((n) => [n.id, n]))

  if (content === null) {
    // Delete: drop the node and every edge touching it.
    nodesById.delete(path)
  } else {
    // Update / create: ensure the node exists, then re-extract its links.
    if (!nodesById.has(path) && pathSet.has(path)) {
      nodesById.set(path, { id: path, degree: 0 })
    }
    const edgeKeys = new Set(edges.map((e) => `${e.from} ${e.to}`))
    for (const link of extractLinksDetailed(content)) {
      const resolved = resolveLinkPath(path, link.target, paths)
      if (!resolved) {
        broken.push({ from: path, target: link.target, text: link.text })
        continue
      }
      if (resolved === path) continue
      const key = `${path} ${resolved}`
      if (edgeKeys.has(key)) continue
      edgeKeys.add(key)
      edges.push({ from: path, to: resolved, kind: link.kind })
    }
  }

  const degree = new Map<string, number>()
  for (const id of nodesById.keys()) degree.set(id, 0)
  for (const edge of edges) {
    degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1)
    degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1)
  }
  const ordered = paths
    .filter((p) => nodesById.has(p))
    .map((p) => ({ id: p, degree: degree.get(p) ?? 0 }))
  const extras = Array.from(nodesById.values()).filter((n) => !pathSet.has(n.id))
  const nodes: LinkGraphNode[] = ordered.length > 0 ? ordered.concat(extras) : Array.from(nodesById.values())
  return { nodes, edges, broken }
}

/** Build the note graph: every note becomes a node, every successfully
 * resolved link becomes a deduplicated edge. Self-links are dropped. */
export function buildLinkGraph(notes: Array<{ path: string; content: string }>): LinkGraph {
  const paths = notes.map((note) => note.path)
  const edgeKeys = new Set<string>()
  const edges: LinkGraphEdge[] = []
  for (const note of notes) {
    for (const target of extractLinks(note.content)) {
      const resolved = resolveLinkPath(note.path, target, paths)
      if (!resolved || resolved === note.path) continue
      const key = `${note.path}\u0000${resolved}`
      if (edgeKeys.has(key)) continue
      edgeKeys.add(key)
      edges.push({ from: note.path, to: resolved })
    }
  }
  const degree = new Map<string, number>()
  for (const path of paths) degree.set(path, 0)
  for (const edge of edges) {
    degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1)
    degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1)
  }
  const nodes: LinkGraphNode[] = paths.map((path) => ({ id: path, degree: degree.get(path) ?? 0 }))
  return { nodes, edges }
}

/** mulberry32: tiny deterministic PRNG so a seed reproduces a layout. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 0xffffffff
  }
}

/**
 * Layout iteration budget. The pairwise repulsion is O(n²) per pass, so a
 * fixed 300-iteration run on a 200-node graph is ~6M node-pair computations
 * that would block the main thread. Scale the budget down with node count to
 * keep total work bounded, while small graphs still converge with the full
 * budget.
 */
const MIN_ITERATIONS = 40
const MAX_ITERATIONS = 300
const PAIR_BUDGET = 1_500_000
const DEFAULT_SEED = 20240903

function adaptiveIterationCount(count: number): number {
  const pairs = Math.max(1, (count * (count - 1)) / 2)
  return Math.min(MAX_ITERATIONS, Math.max(MIN_ITERATIONS, Math.floor(PAIR_BUDGET / pairs)))
}

interface LayoutState {
  ids: string[]
  px: Float64Array
  py: Float64Array
  total: number
  neighbors: number[][]
  ideal: number
  iterations: number
  temp: number
  cooling: number
  gravity: number
  centerX: number
  centerY: number
  margin: number
  width: number
  height: number
  random: () => number
}

/** Prepare the initial simulation state shared by the synchronous and chunked
 * layout paths. Yields null when there is nothing to lay out. */
function prepareLayout(
  nodes: Array<{ id: string }>,
  edges: Array<{ from: string; to: string }>,
  width: number,
  height: number,
  options: LayoutOptions,
): LayoutState | null {
  const count = nodes.length
  if (count === 0 || width <= 0 || height <= 0) return null
  const margin = Math.min(24, width / 4, height / 4)
  const innerW = Math.max(1, width - margin * 2)
  const innerH = Math.max(1, height - margin * 2)
  const centerX = width / 2
  const centerY = height / 2
  const random = mulberry32(options.seed ?? DEFAULT_SEED)

  const index = new Map<string, number>()
  const ids: string[] = []
  for (const node of nodes) {
    if (index.has(node.id)) continue
    index.set(node.id, ids.length)
    ids.push(node.id)
  }
  const total = ids.length
  const px = new Float64Array(total)
  const py = new Float64Array(total)
  const golden = Math.PI * (3 - Math.sqrt(5))
  for (let i = 0; i < total; i++) {
    const radius = (Math.sqrt((i + 0.5) / total) * Math.min(innerW, innerH)) / 2
    const angle = i * golden + (random() - 0.5) * 0.6
    px[i] = centerX + Math.cos(angle) * radius + (random() - 0.5) * 2
    py[i] = centerY + Math.sin(angle) * radius + (random() - 0.5) * 2
  }

  const neighbors: number[][] = Array.from({ length: total }, () => [])
  for (const edge of edges) {
    const a = index.get(edge.from)
    const b = index.get(edge.to)
    if (a === undefined || b === undefined || a === b) continue
    neighbors[a].push(b)
    neighbors[b].push(a)
  }

  const ideal = Math.max(24, Math.sqrt((innerW * innerH) / Math.max(total, 1)))
  const iterations =
    options.iterations !== undefined
      ? Math.max(1, Math.floor(options.iterations))
      : adaptiveIterationCount(total)
  const temp = Math.max(innerW, innerH) * 0.12
  const cooling = temp / Math.max(iterations, 1)

  return {
    ids,
    px,
    py,
    total,
    neighbors,
    ideal,
    iterations,
    temp,
    cooling,
    gravity: 0.02,
    centerX,
    centerY,
    margin,
    width,
    height,
    random,
  }
}

/** One Fruchterman-Reingold iteration: pairwise repulsion, spring attraction
 * on edges, a light pull toward the canvas center and linear cooling. Mutates
 * the position buffer in place; shared by the sync and chunked paths so both
 * produce identical coordinates for identical inputs and seed. */
function stepLayout(state: LayoutState): void {
  const { px, py, neighbors, ideal, gravity, centerX, centerY, total, random } = state
  const fx = new Float64Array(total)
  const fy = new Float64Array(total)
  const temp = state.temp

  for (let i = 0; i < total; i++) {
    for (let j = i + 1; j < total; j++) {
      let dx = px[i] - px[j]
      let dy = py[i] - py[j]
      let dist = Math.sqrt(dx * dx + dy * dy)
      if (dist < 0.01) {
        dx = (random() - 0.5) * 0.1
        dy = (random() - 0.5) * 0.1
        dist = Math.sqrt(dx * dx + dy * dy)
      }
      const force = (ideal * ideal) / dist
      const ux = (dx / dist) * force
      const uy = (dy / dist) * force
      fx[i] += ux
      fy[i] += uy
      fx[j] -= ux
      fy[j] -= uy
    }
  }

  for (let a = 0; a < total; a++) {
    for (const b of neighbors[a]) {
      if (b <= a) continue
      const dx = px[a] - px[b]
      const dy = py[a] - py[b]
      const dist = Math.max(0.01, Math.sqrt(dx * dx + dy * dy))
      const force = (dist * dist) / ideal
      const ux = (dx / dist) * force
      const uy = (dy / dist) * force
      fx[a] -= ux
      fy[a] -= uy
      fx[b] += ux
      fy[b] += uy
    }
  }

  for (let i = 0; i < total; i++) {
    fx[i] += (centerX - px[i]) * gravity
    fy[i] += (centerY - py[i]) * gravity
    px[i] += Math.max(-temp, Math.min(temp, fx[i]))
    py[i] += Math.max(-temp, Math.min(temp, fy[i]))
  }

  state.temp = Math.max(1, temp - state.cooling)
}

function finalizePoints(state: LayoutState): LayoutPoint[] {
  const { ids, px, py, total, margin, width, height } = state
  const points: LayoutPoint[] = []
  for (let i = 0; i < total; i++) {
    points.push({
      id: ids[i],
      x: Math.min(width - margin, Math.max(margin, px[i])),
      y: Math.min(height - margin, Math.max(margin, py[i])),
    })
  }
  return points
}

/** Cooperative yield to the event loop so a large layout never blocks input
 * for long. Prefers the scheduler API, then requestAnimationFrame, then a
 * macrotask timeout. */
function yieldToMainThread(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler
  if (typeof scheduler?.yield === 'function') return scheduler.yield()
  return new Promise<void>((resolve) => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => resolve())
    } else {
      setTimeout(resolve, 0)
    }
  })
}

/**
 * Simple Fruchterman-Reingold style force-directed layout: pairwise
 * repulsion, spring attraction on edges, a light pull toward the canvas
 * center and linear cooling. Runs synchronously on the calling thread; the
 * iteration count scales with node count and is always capped, so tiny
 * graphs are cheap and large graphs stay time-bounded. The same inputs and
 * seed always yield the same coordinates, clamped to the canvas.
 */
export function computeLayout(
  nodes: Array<{ id: string }>,
  edges: Array<{ from: string; to: string }>,
  width: number,
  height: number,
  options: LayoutOptions = {},
): LayoutPoint[] {
  const state = prepareLayout(nodes, edges, width, height, options)
  if (!state) return []
  for (let step = 0; step < state.iterations; step++) stepLayout(state)
  return finalizePoints(state)
}

/**
 * Chunked variant of {@link computeLayout}: yields to the event loop every few
 * milliseconds so a large graph never blocks input. Produces identical
 * coordinates to `computeLayout` for the same inputs and seed — the only
 * difference is scheduling, not the math. Await it from the UI; pass `seed`
 * in `options` for reproducibility.
 */
export async function computeLayoutChunked(
  nodes: Array<{ id: string }>,
  edges: Array<{ from: string; to: string }>,
  width: number,
  height: number,
  options: LayoutOptions = {},
): Promise<LayoutPoint[]> {
  const state = prepareLayout(nodes, edges, width, height, options)
  if (!state) return []
  const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now())
  let lastYield = now()
  for (let step = 0; step < state.iterations; step++) {
    stepLayout(state)
    if (step + 1 < state.iterations && now() - lastYield > 8) {
      await yieldToMainThread()
      lastYield = now()
    }
  }
  return finalizePoints(state)
}

/**
 * Order-insensitive structural key for a graph (set of node ids + set of
 * directed edges) used to cache layouts across presentational updates
 * (resize, theme, view toggles) so a re-layout only runs when the graph
 * actually changed.
 */
export function graphSignature(
  nodes: Array<{ id: string }>,
  edges: Array<{ from: string; to: string }>,
): string {
  const nodeIds = nodes.map((node) => node.id).sort()
  const edgeKeys = edges
    .map((edge) =>
      edge.from < edge.to ? `${edge.from}\u0000${edge.to}` : `${edge.to}\u0000${edge.from}`,
    )
    .sort()
  return `${nodeIds.join('\u0001')}|${edgeKeys.join('\u0001')}`
}
