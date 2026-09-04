import { describe, expect, it } from 'vitest'
import {
  collectPluginPermissions,
  DANGEROUS_PERMISSIONS,
  hasDangerousPermissions,
} from './permissions'

describe('hasDangerousPermissions', () => {
  it('is false when no permissions are declared', () => {
    expect(hasDangerousPermissions(undefined)).toBe(false)
    expect(hasDangerousPermissions({})).toBe(false)
    expect(hasDangerousPermissions({ permissions: [] })).toBe(false)
  })

  it('flags ai/fs/network as dangerous', () => {
    expect(hasDangerousPermissions({ permissions: ['ai'] })).toBe(true)
    expect(hasDangerousPermissions({ permissions: ['fs'] })).toBe(true)
    expect(hasDangerousPermissions({ permissions: ['network'] })).toBe(true)
    expect(hasDangerousPermissions({ permissions: ['ai', 'clipboard'] })).toBe(true)
  })

  it('does not flag pure UI/clipboard permissions as dangerous', () => {
    expect(hasDangerousPermissions({ permissions: ['clipboard'] })).toBe(false)
  })

  it('DANGEROUS_PERMISSIONS is the exact set the gate uses', () => {
    expect(DANGEROUS_PERMISSIONS).toEqual(['ai', 'fs', 'network'])
  })
})

describe('collectPluginPermissions', () => {
  it('merges manifest and definition permissions without duplicates', () => {
    expect(
      collectPluginPermissions({ permissions: ['fs', 'ai'] }, { permissions: ['ai', 'clipboard'] }),
    ).toEqual(['fs', 'ai', 'clipboard'])
  })

  it('ignores undefined sources and duplicates within a source', () => {
    expect(collectPluginPermissions(undefined, {}, { permissions: ['fs', 'fs'] })).toEqual(['fs'])
    expect(collectPluginPermissions()).toEqual([])
  })
})
