/**
 * Who may ask the user to name a new file, and who may not.
 *
 * The `!path` branch of `saveTab` opens a native Save-As dialog. That is
 * correct for exactly the callers that speak for the user, and the rescue loop
 * is one of them: it runs `settle` on an untitled dirty tab only AFTER the user
 * answered "save" to an explicit prompt about that tab (`untitled-rescue.ts`),
 * so the dialog it raises is the question they just answered.
 *
 * It is the one caller whose answer is not a keystroke or a focus change — the
 * other two routes in (`Ctrl+S` and the close) have their own tests — and it is
 * also the caller that settles path'd tabs the flush missed, which are
 * background work: those must NOT be handed the licence, or a tab that lost its
 * path in between would raise a dialog nobody asked for.
 */

import { describe, expect, it, vi } from 'vitest'
import { createUntitledRescue } from './untitled-rescue'
import type { OpenTab } from './tabs'

/** The smallest document the loop reads: an id, a path and the dirty flag. */
function doc(fields: { id: string; path?: string | null; dirty?: boolean }): OpenTab {
  return {
    id: fields.id,
    path: fields.path ?? null,
    dirty: fields.dirty ?? true,
    content: '',
    savedContent: '',
  } as OpenTab
}

describe('the untitled rescue names a new file only for the save the user chose', () => {
  it('lets the save answer name a new file, because the user answered "save"', async () => {
    const untitled = doc({ id: 't1' })
    const settle = vi.fn(async () => true)
    const rescue = createUntitledRescue({
      listUntitledDirty: () => [untitled],
      listTabs: () => [untitled],
      ask: async () => 'save',
      settle,
      onDiscard: () => {},
    })

    await expect(rescue()).resolves.toBe(true)

    expect(settle).toHaveBeenCalledWith('t1', { mayNameNewFile: true })
  })

  it('settles nothing when the user answers "discard"', async () => {
    const untitled = doc({ id: 't1' })
    const settle = vi.fn(async () => true)
    const onDiscard = vi.fn()
    const rescue = createUntitledRescue({
      listUntitledDirty: () => [untitled],
      listTabs: () => [untitled],
      ask: async () => 'discard',
      settle,
      onDiscard,
    })

    await expect(rescue()).resolves.toBe(true)

    expect(settle).not.toHaveBeenCalled()
    expect(onDiscard).toHaveBeenCalledWith(untitled)
  })

  it('does not hand the licence to a path\u2019d tab that went dirty during the prompt', async () => {
    // The late half of the loop is the typing that overtook the caller's flush:
    // it has a file to go to and no user answer behind it, so it is settled the
    // way the bulk flush settles anything — with no dialogue of its own.
    const late = doc({ id: 'p1', path: '/vault/p.md' })
    const settle = vi.fn(async (id: string) => {
      expect(id).toBe('p1')
      late.dirty = false
      return true
    })
    const ask = vi.fn(async () => 'save' as const)
    const rescue = createUntitledRescue({
      listUntitledDirty: () => [],
      listTabs: () => [late],
      ask,
      settle,
      onDiscard: () => {},
    })

    await expect(rescue()).resolves.toBe(true)

    expect(ask).not.toHaveBeenCalled()
    expect(settle).toHaveBeenCalledWith('p1')
  })
})
