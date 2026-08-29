import { describe, expect, it } from 'vitest'
import { version } from './index'

describe('editor-core smoke', () => {
  it('exports version', () => {
    expect(version).toBe('0.1.0')
  })
})