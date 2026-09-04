import { describe, expect, it } from 'vitest'
import { parseSession, serializeSession } from './session'

describe('serializeSession', () => {
  it('round-trips through parseSession', () => {
    const tabs = [{ path: '/vault/a.md' }, { path: '/vault/b.md' }]
    const raw = serializeSession({ vault: '/vault', activeId: '/vault/b.md', tabs })
    expect(raw).not.toBeNull()
    expect(parseSession(raw)).toEqual({
      v: 1,
      vault: '/vault',
      paths: ['/vault/a.md', '/vault/b.md'],
      activeId: '/vault/b.md',
    })
  })

  it('stores only tabs with a real path, dropping untitled temporary tabs', () => {
    const raw = serializeSession({
      vault: '/vault',
      activeId: '/vault/a.md',
      tabs: [{ path: '/vault/a.md' }, { path: null }, { path: '' }],
    })
    const session = parseSession(raw)
    expect(session?.paths).toEqual(['/vault/a.md'])
  })

  it('drops empty/blank paths and keeps order', () => {
    const raw = serializeSession({
      vault: '/vault',
      activeId: null,
      tabs: [{ path: '' }, { path: '/vault/c.md' }, { path: '/vault/a.md' }],
    })
    expect(parseSession(raw)?.paths).toEqual(['/vault/c.md', '/vault/a.md'])
  })

  it('returns null when there is no vault', () => {
    expect(serializeSession({ vault: null, activeId: null, tabs: [{ path: '/v/a.md' }] })).toBeNull()
  })

  it('returns null when no tab has a path (nothing restorable)', () => {
    expect(serializeSession({ vault: '/vault', activeId: null, tabs: [{ path: null }] })).toBeNull()
  })

  it('serializes a null activeId as null', () => {
    const raw = serializeSession({ vault: '/vault', activeId: null, tabs: [{ path: '/v/a.md' }] })
    expect(parseSession(raw)?.activeId).toBeNull()
  })
})

describe('parseSession', () => {
  it('returns null for empty storage', () => {
    expect(parseSession(null)).toBeNull()
    expect(parseSession('')).toBeNull()
  })

  it('returns null for corrupted JSON', () => {
    expect(parseSession('{not valid json')).toBeNull()
  })

  it('returns null for non-object payloads', () => {
    expect(parseSession('42')).toBeNull()
    expect(parseSession('"hello"')).toBeNull()
    expect(parseSession('null')).toBeNull()
  })

  it('rejects an unsupported version', () => {
    expect(parseSession(JSON.stringify({ v: 999, vault: '/v', paths: ['/v/a'] }))).toBeNull()
  })

  it('rejects a missing vault and empty paths', () => {
    expect(parseSession(JSON.stringify({ v: 1, paths: ['/v/a'] }))).toBeNull()
    expect(parseSession(JSON.stringify({ v: 1, vault: '/v', paths: [] }))).toBeNull()
  })

  it('falls back activeId to null when absent or non-string', () => {
    const s = parseSession(JSON.stringify({ v: 1, vault: '/v', paths: ['/v/a.md'] }))
    expect(s?.activeId).toBeNull()
    const s2 = parseSession(JSON.stringify({ v: 1, vault: '/v', paths: ['/v/a.md'], activeId: 123 }))
    expect(s2?.activeId).toBeNull()
  })

  it('filters non-string entries out of paths', () => {
    const s = parseSession(JSON.stringify({ v: 1, vault: '/v', paths: ['/v/a.md', 7, null] }))
    expect(s?.paths).toEqual(['/v/a.md'])
  })
})
