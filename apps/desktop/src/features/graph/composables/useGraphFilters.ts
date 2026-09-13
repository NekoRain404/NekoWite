/**
 * The graph panel's filters: directory, tag, link kind, plus the broken and
 * orphan visibility toggles, and the read-only queries derived from them
 * (§13.4: the `query` half of the feature - nothing here writes the graph).
 *
 * The filters run on the built graph, so a filter change re-lays out the canvas
 * rather than leaving hidden nodes in the layout.
 */

import { computed, ref, type ComputedRef, type Ref } from 'vue'
import {
  orphanNodes,
  type DetailedGraph,
  type LinkGraphEdge,
  type LinkGraphNode,
} from '../../../services/linkGraph'
import { parseFrontmatterBlock, splitFrontmatterRaw } from '../../../services/noteMeta'
import { dirOf } from '../services/graph-geometry'

/** A node-and-edge slice of the graph: what the canvas lays out and draws. */
export interface VisibleGraph {
  nodes: LinkGraphNode[]
  edges: LinkGraphEdge[]
}

export type LinkKindFilter = 'all' | 'wiki' | 'markdown'

export interface UseGraphFiltersOptions {
  /** The full graph, uncapped by any filter. */
  graph: Ref<DetailedGraph | null>
  /** Vault-relative path → raw content, for the tag filter's frontmatter. */
  contentsRecord: Ref<Map<string, string>>
}

export interface GraphFilters {
  filterDir: Ref<string>
  filterTag: Ref<string>
  filterLink: Ref<LinkKindFilter>
  showOrphans: Ref<boolean>
  showBroken: Ref<boolean>
  /** Distinct directories across the graph's nodes, for the filter dropdown. */
  directories: ComputedRef<string[]>
  /** Distinct tags across the graph's nodes, for the filter dropdown. */
  tagOptions: ComputedRef<string[]>
  /** Nodes that are linked to by a broken (unresolvable) link, shown distinctly. */
  brokenSources: ComputedRef<Set<string>>
  /** Nodes/edges after applying directory, tag and link-type filters. */
  visibleGraph: ComputedRef<VisibleGraph | null>
  /** Orphan (degree-0) nodes in the full graph, for the legend count. */
  orphanCount: ComputedRef<number>
  /** Broken-link count, for the legend count. */
  brokenCount: ComputedRef<number>
}

export function useGraphFilters(options: UseGraphFiltersOptions): GraphFilters {
  const { graph, contentsRecord } = options

  // Filters: directory, tag, link kind, plus broken/orphan visibility toggles.
  const filterDir = ref('')
  const filterTag = ref('')
  const filterLink = ref<LinkKindFilter>('all')
  const showOrphans = ref(true)
  const showBroken = ref(true)

  const directories = computed(() => {
    const g = graph.value
    if (!g) return []
    const set = new Set<string>()
    for (const node of g.nodes) set.add(dirOf(node.id))
    return [...set].sort((a, b) => a.localeCompare(b))
  })

  /** path → tags parsed from each note's frontmatter, for the tag filter. */
  const nodeTags = computed(() => {
    const map = new Map<string, string[]>()
    for (const [path, content] of contentsRecord.value) {
      const { front } = splitFrontmatterRaw(content)
      map.set(path, parseFrontmatterBlock(front).tags)
    }
    return map
  })

  const tagOptions = computed(() => {
    const set = new Set<string>()
    for (const tags of nodeTags.value.values()) for (const tag of tags) set.add(tag)
    return [...set].sort((a, b) => a.localeCompare(b))
  })

  const brokenSources = computed(() => {
    const g = graph.value
    if (!g) return new Set<string>()
    return new Set(g.broken.map((b) => b.from))
  })

  /** Nodes/edges after applying directory, tag and link-type filters (and the
   *  orphan-visibility toggle). Layout runs on this filtered graph, so a filter
   *  change re-lays out rather than silently keeping hidden nodes. */
  const visibleGraph = computed<VisibleGraph | null>(() => {
    const g = graph.value
    if (!g) return null
    const useDir = filterDir.value !== ''
    const useTag = filterTag.value !== ''
    const useLink = filterLink.value !== 'all'
    const nodes = g.nodes.filter((n) => {
      if (useDir && dirOf(n.id) !== filterDir.value) return false
      if (useTag && !(nodeTags.value.get(n.id) ?? []).includes(filterTag.value)) return false
      if (!showOrphans.value && n.degree === 0) return false
      return true
    })
    const ids = new Set(nodes.map((n) => n.id))
    const edges = g.edges.filter((e) => {
      if (!ids.has(e.from) || !ids.has(e.to)) return false
      if (useLink && e.kind !== filterLink.value) return false
      return true
    })
    return { nodes, edges }
  })

  const orphanCount = computed(() => (graph.value ? orphanNodes(graph.value).length : 0))
  const brokenCount = computed(() => graph.value?.broken.length ?? 0)

  return {
    filterDir,
    filterTag,
    filterLink,
    showOrphans,
    showBroken,
    directories,
    tagOptions,
    brokenSources,
    visibleGraph,
    orphanCount,
    brokenCount,
  }
}
