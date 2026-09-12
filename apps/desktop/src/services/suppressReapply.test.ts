import { afterEach, describe, expect, it } from 'vitest'
import {
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
})