import { describe, expect, it } from 'vitest'
import {
  assertPermission,
  collectPluginPermissions,
  DANGEROUS_PERMISSIONS,
  declaredPermissionsOf,
  hasDangerousPermissions,
  hasPermission,
} from './permissions'
import { createPluginError, PluginError } from './types'

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

describe('declaredPermissionsOf', () => {
  it('reads the definition once and gives every caller that same answer', () => {
    let reads = 0
    const definition = {
      get permissions() {
        reads += 1
        return reads === 1 ? (['fs'] as const) : (['ai'] as const)
      },
    }
    expect(declaredPermissionsOf({ permissions: ['clipboard'] }, definition)).toEqual(['clipboard', 'fs'])
    expect(declaredPermissionsOf({ permissions: ['clipboard'] }, definition)).toEqual(['clipboard', 'fs'])
    expect(reads).toBe(1)
  })

  it('hands out a host-owned frozen copy, so a later mutation cannot reach a consumer', () => {
    // A plugin keeping a reference to the array it declared could otherwise push
    // a capability into a set the host has already judged.
    const theirs: string[] = ['fs']
    const definition = { permissions: theirs as never }
    const pinned = declaredPermissionsOf(undefined, definition)
    theirs.push('ai')
    expect(pinned).toEqual(['fs'])
    expect(Object.isFrozen(pinned)).toBe(true)
  })

  it('reports what a definition declaring nothing at all declares', () => {
    expect(declaredPermissionsOf(undefined, undefined)).toEqual([])
    expect(declaredPermissionsOf({ permissions: ['fs'] }, undefined)).toEqual(['fs'])
  })
})

describe('hasPermission', () => {
  it('is true when the permission is declared', () => {
    expect(hasPermission({ permissions: ['fs'] }, 'fs')).toBe(true)
  })
  it('is false when the permission is absent', () => {
    expect(hasPermission({ permissions: ['fs'] }, 'network')).toBe(false)
  })
  it('is false for an empty/undefined declaration', () => {
    expect(hasPermission(undefined, 'fs')).toBe(false)
    expect(hasPermission({}, 'ai')).toBe(false)
  })
})

describe('assertPermission', () => {
  it('does not throw when the permission is present', () => {
    expect(() => assertPermission({ permissions: ['fs'] }, 'fs')).not.toThrow()
  })

  it('throws a PLUGIN_PERMISSION_DENIED PluginError with a clear ask + recovery', () => {
    let err: unknown
    try {
      assertPermission({ permissions: ['clipboard'] }, 'fs', { pluginId: 'p1', detail: 'read the workspace' })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(PluginError)
    const pe = err as PluginError
    expect(pe.code).toBe('PLUGIN_PERMISSION_DENIED')
    expect(pe.pluginId).toBe('p1')
    expect(pe.message).toContain('"fs"')
    expect(pe.message).toContain('read the workspace')
    expect(pe.recovery).toContain('Grant the "fs" permission')
  })
})

describe('createPluginError', () => {
  it('supplies default message + recovery from the code', () => {
    const err = createPluginError('PLUGIN_PERMISSION_DENIED', { pluginId: 'p1' })
    expect(err.code).toBe('PLUGIN_PERMISSION_DENIED')
    expect(err.phase).toBe('run')
    expect(err.message.length).toBeGreaterThan(0)
    expect(err.recovery).toContain('Grant the requested permission')
  })

  it('defaults load-code errors to the load phase and allows a custom message/recovery', () => {
    const err = createPluginError('PLUGIN_MANIFEST_INVALID', {
      pluginId: 'p1',
      message: 'Bad manifest',
      recovery: 'Fix the manifest',
    })
    expect(err.phase).toBe('load')
    expect(err.message).toBe('Bad manifest')
    expect(err.recovery).toBe('Fix the manifest')
  })

  it('preserves the cause on the error', () => {
    const cause = new Error('root')
    const err = createPluginError('PLUGIN_HOOK_ERROR', { pluginId: 'p1', cause })
    expect(err.cause).toBe(cause)
  })
})
