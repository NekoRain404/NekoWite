/**
 * The app's own drag vocabulary, read the way a drop target reads it.
 *
 * The two cases that matter are the ones a target gets wrong: a transfer that is *only* a text
 * selection must not be claimed (the browser's own text drop into a field is the reader's), and a
 * transfer that carries the app's type but no payload must not be read as a path. The third — that
 * `types` answers during a `dragover` while `getData` does not — is why the two readers are two
 * functions rather than one, and it is pinned here as a shape: a target that decided with
 * `draggedPath` would refuse every drag it was asked about.
 */
import { describe, expect, it } from 'vitest'
import { carriesDraggedPath, draggedPath, DRAGGED_PATH_TYPE } from './drag-payload'

/** A transfer as the producers build one. `getData` mirrors a real one: it answers only the types
 *  the transfer was given. */
function transfer(entries: Record<string, string>): DataTransfer {
  const types = Object.keys(entries)
  return {
    types,
    effectAllowed: 'copy',
    getData: (type: string) => entries[type] ?? '',
  } as unknown as DataTransfer
}

describe('the app’s drag payload', () => {
  it('is read by either half of a transfer a producer filled in', () => {
    const data = transfer({ [DRAGGED_PATH_TYPE]: '/vault/note.md', 'text/plain': '/vault/note.md' })

    expect(carriesDraggedPath(data)).toBe(true)
    expect(draggedPath(data)).toBe('/vault/note.md')
  })

  it('does not claim a text selection', () => {
    // Every selection in the window is this transfer, and a target that took it would be
    // swallowing the browser's own drop into a textarea.
    const selection = transfer({ 'text/plain': 'a sentence the reader highlighted' })

    expect(carriesDraggedPath(selection)).toBe(false)
    expect(draggedPath(selection)).toBeNull()
  })

  it('is an absence when the transfer carries the type and nothing in it', () => {
    expect(carriesDraggedPath(transfer({ [DRAGGED_PATH_TYPE]: '' }))).toBe(true)
    expect(draggedPath(transfer({ [DRAGGED_PATH_TYPE]: '' }))).toBeNull()
  })

  it('answers null for no transfer at all', () => {
    expect(carriesDraggedPath(null)).toBe(false)
    expect(draggedPath(null)).toBeNull()
  })
})
