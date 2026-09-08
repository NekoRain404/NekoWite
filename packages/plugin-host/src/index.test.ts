import { describe, expect, it } from 'vitest'
import { version } from './index'

describe('plugin-host smoke', () => {
  it('exports version', () => {
    expect(version).toBe('0.1.0')
  })
})