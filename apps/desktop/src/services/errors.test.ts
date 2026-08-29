import { describe, expect, it } from 'vitest'
import { decideConflict } from './errors'

describe('decideConflict', () => {
  it('reloads silently when tab is clean', () => {
    expect(decideConflict({ dirty: false, hasDiskChange: true })).toBe('reload')
  })
  it('keeps local content on save when clean', () => {
    expect(decideConflict({ dirty: false, hasDiskChange: false })).toBe('none')
  })
  it('asks user when dirty and disk changed', () => {
    expect(decideConflict({ dirty: true, hasDiskChange: true })).toBe('ask')
  })
})
