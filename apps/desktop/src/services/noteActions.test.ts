import { describe, expect, it, vi } from 'vitest'
import { NoteTargetError, noteActionTarget, readTargetContent } from './noteActions'
import type { NoteActionDeps, NoteActionTarget, NoteActionTab } from './noteActions'

/** The four injected dependencies, with every call recorded. Nothing here
 *  touches Pinia or a component, which is the point of the boundary: the
 *  resolution rule is testable on its own. An override becomes the mock's
 *  implementation, so the returned handles are always the ones in `deps`. */
function fakeDeps(impls: Partial<NoteActionDeps> = {}) {
  // The mocks take their signature from the injected interface, so a default
  // implementation needs no unused parameters of its own.
  const read = vi.fn<NoteActionDeps['read']>(impls.read ?? (async () => 'disk text'))
  const findTab = vi.fn<NoteActionDeps['findTab']>(impls.findTab ?? (() => null))
  const flushEdits = vi.fn<NoteActionDeps['flushEdits']>(impls.flushEdits ?? (async () => {}))
  const openTab = vi.fn<NoteActionDeps['openTab']>(impls.openTab ?? (async () => {}))
  const deps: NoteActionDeps = { read, findTab, flushEdits, openTab }
  return { deps, read, findTab, flushEdits, openTab }
}

const tabFor = (path: string, content: string, id = 'tab-1'): NoteActionTab => ({ id, path, content })

describe('noteActionTarget', () => {
  it('carries only the path the user right-clicked', () => {
    // The whole feature depends on the target surviving the menu: an operation
    // that reads anything else (the active tab, the selection, a cached path)
    // can act on a different note than the one under the cursor.
    const target = noteActionTarget('/vault/notes/a.md')
    expect(target).toEqual({ path: '/vault/notes/a.md' })
    expect(Object.keys(target)).toEqual(['path'])
  })

  it('keeps the tab id when the card has an open tab, and nothing else', () => {
    const target = noteActionTarget('/vault/notes/a.md', 'tab-7')
    expect(target).toEqual({ path: '/vault/notes/a.md', tabId: 'tab-7' })
    expect(Object.keys(target)).toEqual(['path', 'tabId'])
  })

  it('drops a missing tab id instead of storing an empty one', () => {
    // `tabs.tabs.find(...)?.id` is `string | undefined`, and a card whose note
    // is not open must not end up with a tabId that looks like a real handle.
    expect(noteActionTarget('/vault/notes/a.md', undefined)).toEqual({ path: '/vault/notes/a.md' })
    expect(noteActionTarget('/vault/notes/a.md', null)).toEqual({ path: '/vault/notes/a.md' })
    expect(noteActionTarget('/vault/notes/a.md', '')).toEqual({ path: '/vault/notes/a.md' })
  })

  it('refuses a target with no path rather than passing an empty one on', () => {
    // A blank path cannot name a note, and letting it through would reach a
    // read/delete call with nothing to bind to.
    expect(() => noteActionTarget('')).toThrow(NoteTargetError)
    expect(() => noteActionTarget('')).toThrow(/path/)
    expect(() => noteActionTarget('   ')).toThrow(NoteTargetError)
  })
})

describe('readTargetContent', () => {
  it('returns the open tab content for the target path, flushing pending edits first', async () => {
    // Acceptance: exporting the active note with unsaved keystrokes must export
    // the text the user can see. Both panes coalesce keystrokes through their
    // own debounce, so the tab lags the editor until something flushes it.
    const order: string[] = []
    const tab = tabFor('/vault/notes/a.md', 'stale tab text')
    const { deps, read, flushEdits } = fakeDeps({
      findTab: () => {
        order.push('findTab')
        return tab
      },
      flushEdits: async () => {
        order.push('flushEdits')
        tab.content = 'text typed inside the debounce window'
      },
    })

    await expect(readTargetContent(deps, '/vault', noteActionTarget('/vault/notes/a.md'))).resolves.toBe(
      'text typed inside the debounce window',
    )
    expect(order).toEqual(['findTab', 'flushEdits'])
    expect(read).not.toHaveBeenCalled()
    expect(flushEdits).toHaveBeenCalledTimes(1)
  })

  it('reads a note that is not open from the vault', async () => {
    // The target note usually has no tab at all; it still has to export.
    const { deps, read, flushEdits, openTab } = fakeDeps({
      read: async () => 'text read from disk',
    })

    await expect(readTargetContent(deps, '/vault', noteActionTarget('/vault/notes/b.md'))).resolves.toBe(
      'text read from disk',
    )
    expect(read).toHaveBeenCalledWith('/vault', '/vault/notes/b.md')
    // Resolution is a read: it must not open the note as a side effect, and it
    // must not flush another note's editors for no reason.
    expect(openTab).not.toHaveBeenCalled()
    expect(flushEdits).not.toHaveBeenCalled()
  })

  it('never falls back to the active tab when the target is not open', async () => {
    // THE rule this boundary exists for. The active tab holds a different
    // note's text; everything this function may return has to come from the
    // target path, so a background card cannot export or delete the wrong note.
    const activeTabText = 'the note that happens to be on screen'
    const { deps, read, openTab } = fakeDeps({
      read: async () => 'the note that was right-clicked',
    })

    const content = await readTargetContent(deps, '/vault', noteActionTarget('/vault/notes/b.md'))
    expect(content).toBe('the note that was right-clicked')
    expect(content).not.toBe(activeTabText)
    expect(read).toHaveBeenCalledExactlyOnceWith('/vault', '/vault/notes/b.md')
    expect(openTab).not.toHaveBeenCalled()
  })

  it('treats an empty note as content, not as a missing target', async () => {
    // Emptiness is a legitimate note body; only a rejected read means "gone".
    const { deps } = fakeDeps({ read: async () => '' })
    await expect(readTargetContent(deps, '/vault', noteActionTarget('/vault/notes/empty.md'))).resolves.toBe('')
  })

  it('ignores a tab that does not name the target path', async () => {
    // Defence in depth against a lookup that hands back the active tab
    // regardless of the path it was asked for: taking its content would be the
    // exact wrong-note bug, so the tab is discarded and the file is read.
    const { deps, read, flushEdits } = fakeDeps({
      findTab: () => tabFor('/vault/notes/other.md', 'another note entirely', 'tab-active'),
      read: async () => 'the target note',
    })

    await expect(readTargetContent(deps, '/vault', noteActionTarget('/vault/notes/b.md'))).resolves.toBe(
      'the target note',
    )
    expect(read).toHaveBeenCalledWith('/vault', '/vault/notes/b.md')
    expect(flushEdits).not.toHaveBeenCalled()
  })

  it('accepts the same file spelled in another way instead of dropping an open tab', async () => {
    // Windows hands back paths in several spellings; ignoring a real tab here
    // would silently export the older text on disk.
    const { deps, read } = fakeDeps({
      findTab: () => tabFor('C:\\vault\\Notes\\A.md', 'open tab text'),
      read: async () => 'disk text',
    })

    await expect(readTargetContent(deps, 'C:\\vault', noteActionTarget('c:\\vault\\notes\\a.md'))).resolves.toBe(
      'open tab text',
    )
    expect(read).not.toHaveBeenCalled()
  })

  it('keys on the path, so a stale tab id cannot redirect the read', async () => {
    // tabId is a handle the menu may carry for later actions; content is chosen
    // by path only. Looking the tab up BY ID would hand back whatever note that
    // tab holds now, which after a rename/close is a different note.
    const target: NoteActionTarget = { path: '/vault/notes/b.md', tabId: 'tab-9' }
    const { deps, read, findTab } = fakeDeps({ read: async () => 'the target note' })

    await expect(readTargetContent(deps, '/vault', target)).resolves.toBe('the target note')
    expect(findTab).toHaveBeenCalledWith('/vault/notes/b.md')
    expect(read).toHaveBeenCalledExactlyOnceWith('/vault', '/vault/notes/b.md')
  })

  it('rejects with the path when the note cannot be read', async () => {
    // The note may have been deleted or moved behind the app's back. Reporting
    // empty text would export an empty document and a delete would look
    // successful, so the failure is explicit and names what it could not find.
    const cause = new Error('read_file: No such file')
    const { deps } = fakeDeps({
      read: async () => {
        throw cause
      },
    })

    const failure = readTargetContent(deps, '/vault', noteActionTarget('/vault/notes/gone.md'))
    await expect(failure).rejects.toThrow(NoteTargetError)
    // `Error.cause` is non-enumerable, so assert it directly rather than
    // through a structural matcher. A resolve here would fail the test by name
    // instead of narrowing to a string.
    const error = await failure.then(
      () => {
        throw new Error('readTargetContent resolved for a note it could not read')
      },
      (e: unknown) => e as NoteTargetError,
    )
    expect(error.path).toBe('/vault/notes/gone.md')
    expect(error.message).toContain('/vault/notes/gone.md')
    expect(error.cause).toBe(cause)
  })

  it('rejects when no vault is open instead of guessing where to read', async () => {
    const { deps, read } = fakeDeps()
    await expect(readTargetContent(deps, null, noteActionTarget('/vault/notes/b.md'))).rejects.toThrow(
      '/vault/notes/b.md',
    )
    expect(read).not.toHaveBeenCalled()
  })

  it('rejects an empty path handed in as a raw target', async () => {
    const { deps, read, findTab } = fakeDeps()
    await expect(readTargetContent(deps, '/vault', { path: '  ' })).rejects.toThrow(NoteTargetError)
    expect(findTab).not.toHaveBeenCalled()
    expect(read).not.toHaveBeenCalled()
  })
})
