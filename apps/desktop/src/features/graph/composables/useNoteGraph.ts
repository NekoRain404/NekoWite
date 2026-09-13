/**
 * The note graph the panel shows: what the vault holds, the graph built from
 * those notes, the render cap, and the incremental refresh that keeps it
 * current while the panel is open (§13.4: the `state` and `command` halves).
 *
 * Store access lives here and nowhere else in the feature (§10.2), so the panel
 * never touches a store: it hands this module a `vaultReady` getter and gets
 * back refs and commands. Reads go through the vault file index and the fs
 * gateway - the platform adapters (§13.5) - and the canvas is told to re-lay
 * out through `onGraphChanged`, because the layout belongs to the view.
 */

import { computed, onBeforeUnmount, onMounted, ref, type ComputedRef, type Ref } from 'vue'
import { useTabsStore } from '../../../stores/tabs'
import {
  buildLinkGraphDetailed,
  refreshNode,
  type DetailedGraph,
} from '../../../services/linkGraph'
import { vaultFileIndex } from '../../../services/vaultFiles'
import { fsService, type FsChangeEvent } from '../../../platform/gateways/fs'

const READ_CONCURRENCY = 8
/** Coalesce bursts of fs-change events into a single graph rebuild (a save may
 * otherwise fire several read/stat events for one note). */
const REBUILD_DEBOUNCE_MS = 300

export interface UseNoteGraphOptions {
  /** `false` pauses loading (e.g. the parent's vault is not mounted yet);
   *  undefined follows the tabs store. */
  vaultReady: () => boolean | undefined
  /** Initial render cap; 0 renders the whole vault. */
  maxNotes: number
  /** The graph changed: re-lay out and repaint (the canvas owns the layout). */
  onGraphChanged: () => Promise<void>
  /** The graph is gone: drop the cached layout and repaint blank. */
  onGraphCleared: () => void
}

export interface NoteGraph {
  /** The vault the graph is built from, or null when none is open. */
  vault: ComputedRef<string | null>
  /** Open a note in a tab (the canvas gesture's command). */
  openNote(path: string): void
  loading: Ref<boolean>
  failed: Ref<boolean>
  truncated: Ref<boolean>
  noteCount: Ref<number>
  edgeCount: Ref<number>
  /** Total number of markdown notes found in the vault, before any node cap is
   *  applied. Surfaced so truncation is never silent (showing first N depends on M). */
  totalNotes: Ref<number>
  /** Active node cap. 0 means "full vault" (render all). */
  capValue: Ref<number>
  /** Full detailed graph (all nodes/edges, uncapped by any render cap), updated
   *  incrementally on content-only fs changes. */
  graph: Ref<DetailedGraph | null>
  /** Vault-relative path → raw content, kept so a single-note edit refreshes just
   *  that note rather than re-reading every note. */
  contentsRecord: Ref<Map<string, string>>
  /** Degree of a node id, for node size and the pick radius. */
  degreeOf(id: string): number
  /** Pending coalesced fs-change rebuild; non-null while one is armed. */
  rebuildTimer: Ref<ReturnType<typeof setTimeout> | null>
  rebuild(): Promise<void>
  /** Drop the graph and its counts (vault closed or switched away). */
  clear(): void
}

export function useNoteGraph(options: UseNoteGraphOptions): NoteGraph {
  const tabs = useTabsStore()

  const vault = computed(() => tabs.vault)
  const loading = ref(false)
  const failed = ref(false)
  const truncated = ref(false)
  const noteCount = ref(0)
  const edgeCount = ref(0)
  const totalNotes = ref(0)
  const capValue = ref(Math.max(0, options.maxNotes))

  const graph = ref<DetailedGraph | null>(null)
  const contentsRecord = ref<Map<string, string>>(new Map())
  /** The path set the current graph was built from (used to detect structural
   * add/delete/move changes that force a full rebuild). */
  let currentPathSet = new Set<string>()
  let degreeMap = new Map<string, number>()
  let generation = 0
  // fs-change subscription and a debounced rebuild so the graph stays fresh while
  // the panel is open (not just on vault switch). Derived from the library/fs
  // change event; coalesces a burst and is cancelled on vault switch/teardown.
  let unlistenFs: (() => void) | null = null
  const rebuildTimer = ref<ReturnType<typeof setTimeout> | null>(null)
  let disposed = false

  function degreeOf(id: string): number {
    return degreeMap.get(id) ?? 0
  }

  function openNote(path: string): void {
    void tabs.openTab(path)
  }

  /** Disarm a pending coalesced rebuild (vault switch, teardown). */
  function cancelPendingRebuild(): void {
    if (rebuildTimer.value !== null) {
      clearTimeout(rebuildTimer.value)
      rebuildTimer.value = null
    }
  }

  async function readWithConcurrency(
    vault: string,
    paths: string[],
    shouldAbort: () => boolean = () => false,
  ): Promise<Array<{ path: string; content: string }>> {
    const out: Array<{ path: string; content: string }> = []
    let cursor = 0
    const workers = Array.from({ length: Math.min(READ_CONCURRENCY, paths.length) }, async () => {
      while (cursor < paths.length) {
        // Stop issuing reads once the build is superseded (e.g. a newer rebuild
        // or a vault switch bumped `generation`). Without this, a stale in-flight
        // readWithConcurrency keeps calling fsService.read — which in tests
        // crosses test boundaries (resetMock) and bleeds read counts. The
        // post-await generation check backstop remains.
        if (shouldAbort()) return
        const path = paths[cursor++]!
        try {
          out.push({ path, content: await fsService.read(vault, path) })
        } catch {
          out.push({ path, content: '' })
        }
      }
    })
    await Promise.all(workers)
    return out
  }

  function pathSetEquals(a: string[], b: Set<string>): boolean {
    if (a.length !== b.size) return false
    for (const p of a) if (!b.has(p)) return false
    return true
  }

  async function rebuild(): Promise<void> {
    const openVault = vault.value
    if (!openVault || options.vaultReady() === false) return
    const thisGeneration = ++generation
    loading.value = true
    failed.value = false
    truncated.value = false
    try {
      const paths = await vaultFileIndex.get(openVault)
      if (thisGeneration !== generation) return
      totalNotes.value = paths.length
      const cap = capValue.value
      const useCap = cap > 0
      const selected = useCap ? paths.slice(0, cap) : paths
      truncated.value = useCap && paths.length > cap
      const contents = await readWithConcurrency(openVault, selected, () => thisGeneration !== generation)
      if (thisGeneration !== generation) return
      contentsRecord.value = new Map(contents.map((c) => [c.path, c.content]))
      currentPathSet = new Set(selected)
      graph.value = buildLinkGraphDetailed(contents)
      degreeMap = new Map(graph.value.nodes.map((node) => [node.id, node.degree]))
      noteCount.value = graph.value.nodes.length
      edgeCount.value = graph.value.edges.length
      await options.onGraphChanged()
    } catch {
      if (thisGeneration !== generation) return
      graph.value = null
      noteCount.value = 0
      edgeCount.value = 0
      totalNotes.value = 0
      failed.value = true
      options.onGraphCleared()
    } finally {
      if (thisGeneration === generation) loading.value = false
    }
  }

  /** Incrementally apply a single-note fs-change to an already-built graph.
   *  A content-only change refreshes only that note's node/edges; a structural
   *  change (add/remove/move) falls back to a full rebuild because other notes'
   *  links may re-resolve. */
  async function applyChange(path: string, kind: string): Promise<void> {
    const openVault = vault.value
    if (!openVault || !graph.value) return
    if (kind === 'removed') {
      void rebuild()
      return
    }
    const paths = await vaultFileIndex.get(openVault)
    if (!pathSetEquals(paths, currentPathSet)) {
      // Path set changed (add / move / delete) — a full recompute is the safe,
      // correct path (links from other notes may now resolve differently).
      void rebuild()
      return
    }
    const thisGeneration = generation
    try {
      const content = await fsService.read(openVault, path)
      if (thisGeneration !== generation) return
      contentsRecord.value.set(path, content)
      const candidate = refreshNode(graph.value, path, content, Array.from(currentPathSet))
      graph.value = candidate
      degreeMap = new Map(candidate.nodes.map((n) => [n.id, n.degree]))
      noteCount.value = candidate.nodes.length
      edgeCount.value = candidate.edges.length
      await options.onGraphChanged()
    } catch {
      void rebuild()
    }
  }

  /** Auto-rebuild the graph when note/link data changes (not just on vault
   *  switch). Only markdown changes affect the graph; attachment/directory churn
   *  is ignored. Invalidate the vault file index so an add/delete is picked up,
   *  then apply the change incrementally where the path set is unchanged
   *  (resize/theme-only updates still reuse the cached layout via relayout()). */
  function onFsChangeHandler(e: FsChangeEvent): void {
    if (disposed) return
    const openVault = vault.value
    if (!openVault || options.vaultReady() === false) return
    if (!/\.(md|mdx)$/i.test(e.path)) return
    vaultFileIndex.invalidate(openVault)
    cancelPendingRebuild()
    rebuildTimer.value = setTimeout(() => {
      rebuildTimer.value = null
      if (disposed) return
      void applyChange(e.path, e.kind)
    }, REBUILD_DEBOUNCE_MS)
  }

  onMounted(() => {
    const pending = fsService.onFsChange(onFsChangeHandler)
    Promise.resolve(pending)
      .then((unlisten) => {
        if (disposed) unlisten?.()
        else unlistenFs = unlisten
      })
      .catch(() => {
        // Registration failed (test/fallback gateway): keep existing behavior.
      })
  })

  onBeforeUnmount(() => {
    disposed = true
    cancelPendingRebuild()
    unlistenFs?.()
    unlistenFs = null
    generation += 1
  })

  /** Drop the graph and its counts. The caller clears the canvas layout too:
   *  the panel owns that ordering because neither half can see the other. */
  function clear(): void {
    generation += 1
    graph.value = null
    noteCount.value = 0
    edgeCount.value = 0
    totalNotes.value = 0
    truncated.value = false
    loading.value = false
    failed.value = false
  }

  return {
    vault,
    openNote,
    loading,
    failed,
    truncated,
    noteCount,
    edgeCount,
    totalNotes,
    capValue,
    graph,
    contentsRecord,
    degreeOf,
    rebuildTimer,
    rebuild,
    clear,
  }
}
