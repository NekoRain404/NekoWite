import { afterEach, describe, expect, it } from 'vitest'
import { armSuppressReapply, consumeSuppressReapply, shouldSuppressReapply } from './suppressReapply'

afterEach(() => {
  consumeSuppressReapply()
})

describe('suppressReapply guard', () => {
  it('starts off and stays off until armed', () => {
    expect(shouldSuppressReapply()).toBe(false)
  })

  it('arm sets the guard until consumed once', () => {
    armSuppressReapply()
    expect(shouldSuppressReapply()).toBe(true)
    expect(consumeSuppressReapply()).toBe(true)
    expect(shouldSuppressReapply()).toBe(false)
  })

  it('consume returns false when the guard is not armed', () => {
    expect(consumeSuppressReapply()).toBe(false)
  })
})
