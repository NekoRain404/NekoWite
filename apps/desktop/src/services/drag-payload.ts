/**
 * The app's own drag vocabulary: the media type a dragged *document* travels under, and the two
 * readers that ask a transfer about it.
 *
 * A drag inside this window can carry more than a file manager's `Files`. Two producers already
 * spell a document's path the same way — the vault tree, which drags a node to re-parent it
 * (`features/vault/composables/use-file-tree-drag.ts`), and the editor's tab strip, which drags the
 * document it is showing (`ui/TabBar.vue`) — so that anything accepting one accepts the other.
 * This module is that one spelling; before it existed the producer wrote the literal and every
 * consumer would have had to.
 *
 * **Why not `text/plain`, which both producers also set.** A `text/plain` drag is what every text
 * selection in the window already is, and a drop target that claimed those would be taking the
 * browser's own text drop away from the reader: a selection dragged into a textarea lands at the
 * caret without any code, and it stops doing that the moment a handler calls `preventDefault()` on
 * it. `apps/desktop/src/features/agent/components/AgentComposer.vue` declines text drags on
 * purpose and has a test pinning it. The custom type is the app saying "this is a file", which no
 * selection ever is.
 *
 * The readers exist as functions rather than as a `getData` call at each site because the two halves
 * have different rules: `types` is readable in a `dragover` and `getData` is not (the browser
 * withholds the payload until the drop), so a target that has to decide whether to accept a drag
 * must ask `carriesDraggedPath`, and only the drop itself may ask `draggedPath`.
 */

/** What a path dragged inside this window is carried as. */
export const DRAGGED_PATH_TYPE = 'text/nekowite-path'

/**
 * Whether a drag is carrying a path from this app.
 *
 * Read from `types` alone, which is the only half of a `DataTransfer` a `dragover` may look at —
 * so this is the question a drop target asks while the pointer is over it, and the answer must not
 * depend on the payload.
 */
export function carriesDraggedPath(data: DataTransfer | null): boolean {
  if (data === null) return false
  return Array.from(data.types).includes(DRAGGED_PATH_TYPE)
}

/**
 * The path a drop carried, or `null` when the transfer has none.
 *
 * Only meaningful in a `drop`: during `dragover` the payload is protected and this answers `null`
 * for even a transfer {@link carriesDraggedPath} says yes to. An empty string is treated as an
 * absence rather than as a path, which is what a producer that had nothing to hand over leaves
 * behind.
 */
export function draggedPath(data: DataTransfer | null): string | null {
  if (data === null) return null
  if (!carriesDraggedPath(data)) return null
  const path = data.getData(DRAGGED_PATH_TYPE)
  return path === '' ? null : path
}
