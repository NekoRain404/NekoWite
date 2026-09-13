import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  SUPPRESS_REAPPLY_TTL_MS,
  armSuppressReapply,
  consumeSuppressReapply,
  pruneSuppressReapply,
  shouldSuppressReapply,
} from './suppressReapply'

afterEach(() => {
  pruneSuppressReapply(null)
})

describe('suppressReapply guard', () => {
  it('starts off and stays off until armed', () => {
    expect(shouldSuppressReapply('tab-1')).toBe(false)
  })

  it('arm sets the guard until consumed once', () => {
    armSuppressReapply('tab-1')
    expect(shouldSuppressReapply('tab-1')).toBe(true)
    expect(consumeSuppressReapply('tab-1')).toBe(true)
    expect(shouldSuppressReapply('tab-1')).toBe(false)
  })

  it('consume returns false when the guard is not armed', () => {
    expect(consumeSuppressReapply('tab-1')).toBe(false)
  })

  // C1: the guard used to be one module-wide boolean, so ANY save armed it for
  // whoever changed content next. A background save (autosave timer, flushDirty,
  // closing a tab) therefore armed the guard for the tab the user had just
  // switched TO, whose re-apply was then skipped: the editor kept the previous
  // note's text while the tab held the new note's, and the next keystroke
  // published that stale text into the new note and autosaved it over the file.
  it('does not arm another tab', () => {
    armSuppressReapply('tab-1')
    expect(shouldSuppressReapply('tab-2')).toBe(false)
    expect(consumeSuppressReapply('tab-2')).toBe(false)
    // ...and the armed tab keeps its own guard until IT consumes it.
    expect(consumeSuppressReapply('tab-1')).toBe(true)
  })

  it('drops the arms of tabs that are not the active one', () => {
    armSuppressReapply('tab-1')
    armSuppressReapply('tab-2')
    pruneSuppressReapply('tab-2')
    expect(shouldSuppressReapply('tab-1')).toBe(false)
    expect(shouldSuppressReapply('tab-2')).toBe(true)
  })

  it('drops every arm when there is no active tab', () => {
    armSuppressReapply('tab-1')
    pruneSuppressReapply(null)
    expect(shouldSuppressReapply('tab-1')).toBe(false)
  })

  it('stops honouring an arm whose content change never arrived', () => {
    // The arm is consumed by the content change the save is about to make. If
    // that change never comes, the arm is left waiting - and the NEXT content
    // change (an external program rewriting the file, a conflict resolution
    // reloading it) gets swallowed instead: the editor keeps text that is no
    // longer on disk and the next autosave writes it back over the newer
    // version. An arm that outlives its partner must not be honoured.
    vi.useFakeTimers()
    try {
      armSuppressReapply('tab-1')
      expect(shouldSuppressReapply('tab-1')).toBe(true)

      vi.advanceTimersByTime(SUPPRESS_REAPPLY_TTL_MS + 1)

      expect(shouldSuppressReapply('tab-1')).toBe(false)
      // ...and a stale arm cannot be consumed as if it were still valid.
      armSuppressReapply('tab-1')
      vi.advanceTimersByTime(SUPPRESS_REAPPLY_TTL_MS + 1)
      expect(consumeSuppressReapply('tab-1')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('honours an arm consumed inside the window', () => {
    vi.useFakeTimers()
    try {
      armSuppressReapply('tab-1')
      vi.advanceTimersByTime(SUPPRESS_REAPPLY_TTL_MS - 1)
      expect(consumeSuppressReapply('tab-1')).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})