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
  const { body } = splitFrontmatter(content)
  const text = stripCodeFences(body)
  const links: string[] = []
  for (const match of text.matchAll(WIKI_OR_MD_RE)) {
    if (match[1] !== undefined) {
      const target = wikiTarget(match[1])
      if (target) links.push(target)
      continue
    }
    const start = match.index ?? 0
    if (start > 0 && text[start - 1] === '!') continue
    const target = inlineTarget(match[3] ?? '')
    if (target) links.push(target)
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

/** Resolve a link target found in `fromNotePath` against the vault's note
 * paths. Relative paths go through the shared resolver; extension-less
 * wiki names first try `.md`/`.mdx` suffixes on the resolved path, then
 * fall back to matching by file-name stem. Returns the vault-relative
 * path of the matched note, or null when nothing matches. */
export function resolveLinkPath(
  fromNotePath: string,
  linkTarget: string,
  allPaths: string[],
): string | null {
  const normalized = linkTarget.replace(/\\/g, '/').trim()
  if (!normalized || normalized.startsWith('#') || SCHEME_RE.test(normalized)) return null
  const withoutAnchor = normalized.split('#')[0].trim()
  if (!withoutAnchor) return null
  const resolved = resolveRelativePath(noteDirectory(fromNotePath), withoutAnchor)
  if (hasMarkdownExtension(resolved)) {
    const exact = allPaths.find((path) => path === resolved)
    if (exact) return exact
  } else {
    for (const candidate of [`${resolved}.md`, `${resolved}.mdx`]) {
      const exact = allPaths.find((path) => path === candidate)
      if (exact) return exact
    }
  }
  const stem = basenameStem(withoutAnchor).toLowerCase()
  if (stem) {
    const byStem = allPaths.find((path) => basenameStem(path).toLowerCase() === stem)
    if (byStem) return byStem
  }
  return null
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

/** Simple Fruchterman-Reingold style force-directed layout: pairwise
 * repulsion, spring attraction on edges, a light pull toward the canvas
 * center and linear cooling. Precomputed (~300 iterations, no animation);
 * the same inputs and seed always yield the same coordinates, clamped to
 * the canvas. */
export function computeLayout(
  nodes: Array<{ id: string }>,
  edges: Array<{ from: string; to: string }>,
  width: number,
  height: number,
  options: LayoutOptions = {},
): LayoutPoint[] {
  const count = nodes.length
  if (count === 0 || width <= 0 || height <= 0) return []
  const margin = Math.min(24, width / 4, height / 4)
  const innerW = Math.max(1, width - margin * 2)
  const innerH = Math.max(1, height - margin * 2)
  const centerX = width / 2
  const centerY = height / 2
  const random = mulberry32(options.seed ?? 20240903)

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
  const iterations = Math.max(1, options.iterations ?? 300)
  let temp = Math.max(innerW, innerH) * 0.12
  const cooling = temp / iterations
  const gravity = 0.02

  for (let step = 0; step < iterations; step++) {
    const fx = new Float64Array(total)
    const fy = new Float64Array(total)
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
    temp = Math.max(1, temp - cooling)
  }

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
