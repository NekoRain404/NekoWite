import { describe, expect, it, vi } from 'vitest'
import { setPluginIntegrityDecider, setPluginPermissionDecider } from '../services/plugins'
import { useAppDialogs } from './app-dialogs'

vi.mock('../services/plugins', () => ({
  setPluginPermissionDecider: vi.fn(),
  setPluginIntegrityDecider: vi.fn(),
}))

const META = { id: 'p', name: 'p', version: '1', main: 'p' }

describe('appDialogs', () => {
  it('models conflict/permission/integrity as one union state', () => {
    const d = useAppDialogs()
    expect(d.state.value).toEqual({ kind: 'none' })
    d.showConflict('tab-1', '/vault/notes/a.md')
    expect(d.state.value).toEqual({ kind: 'conflict', tabId: 'tab-1', path: '/vault/notes/a.md' })
    d.close()
    expect(d.state.value).toEqual({ kind: 'none' })
  })

  it('resolves a permission request and clears state', () => {
    const d = useAppDialogs()
    let decision: boolean | null = null
    d.showPermission({
      meta: META,
      permissions: [],
      resolve: (allowed: boolean) => {
        decision = allowed
      },
    })
    expect(d.state.value.kind).toBe('permission')
    d.resolvePermission(true)
    expect(decision).toBe(true)
    expect(d.state.value).toEqual({ kind: 'none' })
  })

  it('resolves an integrity request and clears state', () => {
    const d = useAppDialogs()
    let decision: boolean | null = null
    d.showIntegrity({
      meta: META,
      expectedDigest: 'a',
      actualDigest: 'b',
      resolve: (reapprove: boolean) => {
        decision = reapprove
      },
    })
    expect(d.state.value.kind).toBe('integrity')
    d.resolveIntegrity(false)
    expect(decision).toBe(false)
    expect(d.state.value).toEqual({ kind: 'none' })
  })

  it('installs the plugin deciders that surface dialogs', async () => {
    const d = useAppDialogs()
    d.installPluginDeciders()

    const permDecider = vi.mocked(setPluginPermissionDecider).mock.calls[0]![0]!
    const permPromise = permDecider(META, [])
    expect(d.state.value.kind).toBe('permission')
    d.resolvePermission(true)
    expect(await permPromise).toBe(true)
    expect(d.state.value).toEqual({ kind: 'none' })

    const integrityDecider = vi.mocked(setPluginIntegrityDecider).mock.calls[0]![0]!
    const integrityPromise = integrityDecider(META, 'a', 'b')
    expect(d.state.value.kind).toBe('integrity')
    d.resolveIntegrity(true)
    expect(await integrityPromise).toBe(true)
    expect(d.state.value).toEqual({ kind: 'none' })
  })
})
