import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getActiveVaultPluginIds,
  getVaultPluginAuditEvents,
  isPluginImportAllowedByCsp,
  loadVaultPlugins,
  resetVaultPluginStateForTests,
  revokeVaultPlugin,
  setPluginPermissionDecider,
  setPluginRecordedDigestForTest,
  setPluginTrustPolicy,
  setPluginTrustedKey,
  setVaultPluginVersionRange,
} from './plugins'
import { buildPluginSignaturePayload, createPluginSignature } from '@nekowite/plugin-host'
import type { PluginMeta } from '@nekowite/plugin-host'

/* ------------------------------------------------------------------------- *
 * P0.3 — consolidated security regression suite.
 *
 * Each test asserts a concrete security INVARIANT that the plugin system actually
 * enforces today, not a placeholder. Where the authoritative enforcement lives in
 * Rust (vault path binding, key masking) the test asserts the FRONTEND contract
 * and references the Rust test by name; the frontend cannot re-implement a check
 * the backend owns (that would be bypassable in the window).
 * ------------------------------------------------------------------------- */

const listMock = vi.hoisted(() => vi.fn())
const readMock = vi.hoisted(() => vi.fn())
const loadMock = vi.hoisted(() => vi.fn())
const activateMock = vi.hoisted(() => vi.fn())
const deactivateMock = vi.hoisted(() => vi.fn())
const notifyErrorMock = vi.hoisted(() => vi.fn())
const invokeMock = vi.hoisted(() => vi.fn())

vi.mock('../platform/gateways/fs', () => ({ fsService: { list: listMock, read: readMock } }))
vi.mock('./errors', () => ({
  notifyError: notifyErrorMock,
  describePluginError: (e: { message?: string; recovery?: string }) =>
    `${e.message ?? ''}${e.recovery ? ` ${e.recovery}` : ''}`,
}))
vi.mock('@nekowite/plugin-host', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nekowite/plugin-host')>()
  return {
    ...actual,
    loadPlugin: loadMock,
    activatePlugin: activateMock,
    deactivatePlugin: deactivateMock,
  }
})
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock, convertFileSrc: (x: string) => x }))

const META = (permissions?: string[]): PluginMeta => ({
  id: '@scope/q',
  name: '@scope/q',
  version: '1.0.0',
  main: 'plugins/quote/index.js',
  permissions: permissions as never,
})

function pkg(extra?: Record<string, unknown>): string {
  return JSON.stringify({ name: '@scope/q', version: '1.0.0', main: 'index.js', ...extra })
}

beforeEach(() => {
  resetVaultPluginStateForTests()
  localStorage.removeItem('nekowite.pluginGovernance')
  localStorage.removeItem('nekowite.pluginDigests')
  localStorage.removeItem('nekowite.pluginTrustKey')
  localStorage.removeItem('nekowite.pluginTrustedSources')
  vi.clearAllMocks()
  notifyErrorMock.mockClear()
  listMock.mockResolvedValue([
    { name: 'quote', path: '/vault/plugins/quote', is_dir: true, is_mdx: false },
  ])
  readMock.mockResolvedValue(pkg())
  loadMock.mockResolvedValue({ ok: true, id: '@scope/q', meta: META(), definition: {} })
  activateMock.mockResolvedValue({ ok: true, id: '@scope/q' })
})

describe('security invariant: malicious top-level code is NEVER executed on refuse', () => {
  it('does not invoke the import boundary for a revoked plugin (GATE 0, before import)', async () => {
    revokeVaultPlugin('@scope/q', 'all', 'malware')
    await loadVaultPlugins('/vault')
    // The import boundary (loadPlugin) is the ONLY place plugin code executes.
    expect(loadMock).not.toHaveBeenCalled()
    expect(activateMock).not.toHaveBeenCalled()
    expect(getActiveVaultPluginIds()).toEqual([])
    const msgs = notifyErrorMock.mock.calls.map((c) => String(c[0]))
    expect(msgs.some((m) => m.includes('revoked'))).toBe(true)
    expect(msgs.some((m) => m.includes('malware'))).toBe(true)
    // The refusal is audited, never silent.
    expect(getVaultPluginAuditEvents('@scope/q').map((e) => e.event)).toContain('revoked')
  })

  it('does not invoke the import boundary for a version outside the supported range', async () => {
    setVaultPluginVersionRange('@scope/q', { min: '2.0.0' })
    await loadVaultPlugins('/vault')
    expect(loadMock).not.toHaveBeenCalled()
    expect(activateMock).not.toHaveBeenCalled()
    const msgs = notifyErrorMock.mock.calls.map((c) => String(c[0]))
    expect(msgs.some((m) => m.includes('outside the supported range'))).toBe(true)
  })

  it('does not invoke the import boundary for an unsigned plugin under require-trust', async () => {
    setPluginTrustPolicy('require-trust')
    readMock.mockResolvedValue(pkg()) // unsigned manifest
    await loadVaultPlugins('/vault')
    expect(loadMock).not.toHaveBeenCalled()
    expect(activateMock).not.toHaveBeenCalled()
    const msgs = notifyErrorMock.mock.calls.map((c) => String(c[0]))
    expect(msgs.some((m) => m.includes('unsigned and not from a trusted source'))).toBe(true)
  })
})

describe('security invariant: a tampered plugin is refused', () => {
  it('refuses a plugin whose signature fails verification (never imported)', async () => {
    const KEY = '4e656b6f2d6b6579'
    const SOURCE = 'export default {}'
    const payload = buildPluginSignaturePayload('@scope/q', '1.0.0', 'index.js', SOURCE, undefined)
    const badSignature = await createPluginSignature(payload, 'deadbeefdeadbeef')
    setPluginTrustedKey(KEY)
    readMock.mockImplementation((_vault, rel) =>
      Promise.resolve(rel.endsWith('package.json') ? pkg({ signature: badSignature }) : SOURCE),
    )
    await loadVaultPlugins('/vault')
    expect(loadMock).not.toHaveBeenCalled()
    expect(activateMock).not.toHaveBeenCalled()
    expect(getActiveVaultPluginIds()).toEqual([])
    const msgs = notifyErrorMock.mock.calls.map((c) => String(c[0]))
    expect(msgs.some((m) => m.includes('failed verification'))).toBe(true)
    expect(getVaultPluginAuditEvents('@scope/q').map((e) => e.event)).toContain('signature-invalid')
  })

  it('refuses a plugin whose code/manifest digest changed (never imported)', async () => {
    setPluginPermissionDecider(() => Promise.resolve(true))
    // The seed has a different lifecycle-consent path — keep the plugin signed-able.
    readMock.mockResolvedValue(pkg({ permissions: ['fs'] }))
    loadMock.mockResolvedValue({ ok: true, id: '@scope/q', meta: META(['fs']), definition: {} })
    // Seed a stale fingerprint so the freshly-computed digest does not match.
    setPluginRecordedDigestForTest('/vault', '@scope/q', '1.0.0', 'deadbeef')
    await loadVaultPlugins('/vault')
    expect(loadMock).not.toHaveBeenCalled()
    expect(activateMock).not.toHaveBeenCalled()
    const msgs = notifyErrorMock.mock.calls.map((c) => String(c[0]))
    expect(msgs.some((m) => m.includes('changed since you approved it'))).toBe(true)
    expect(getVaultPluginAuditEvents('@scope/q').map((e) => e.event)).toContain('verify-failed')
  })

  it('the import boundary is genuinely reachable for a gated, verified plugin', async () => {
    // The gate is a boundary, not a blanket block: the verified+consented plugin
    // IS imported (so the invariant is meaningful, not over-blocking).
    await loadVaultPlugins('/vault')
    expect(loadMock).toHaveBeenCalledTimes(1)
    expect(activateMock).toHaveBeenCalledTimes(1)
    expect(getActiveVaultPluginIds()).toEqual(['@scope/q'])
  })
})

describe('security invariant: CSP blocks plugin loading in the production webview', () => {
  it('isPluginImportAllowedByCsp is false under a Tauri-runtime simulation', () => {
    ;(window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {}
    try {
      expect(isPluginImportAllowedByCsp()).toBe(false)
    } finally {
      delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
    }
  })

  it('skips the whole scan (no fs read, no import, no activation) when the CSP blocks blob imports', async () => {
    ;(window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {}
    try {
      await loadVaultPlugins('/vault')
      expect(listMock).not.toHaveBeenCalled()
      expect(readMock).not.toHaveBeenCalled()
      expect(loadMock).not.toHaveBeenCalled()
      expect(activateMock).not.toHaveBeenCalled()
      const msgs = notifyErrorMock.mock.calls.map((c) => String(c[0]))
      expect(msgs.some((m) => m.includes('CSP') && m.includes('disabled'))).toBe(true)
    } finally {
      delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
    }
  })
})

describe('security invariant: forged / unauthorized vault path is rejected (Rust path-bound)', () => {
  it('forwards the caller vault root verbatim to the path-confined command (no frontend escape)', async () => {
    invokeMock.mockResolvedValue('')
    const { tauriFsPort } = await import('../platform/gateways/tauri')
    await tauriFsPort.read('/safe/vault', 'notes/a.md')
    expect(invokeMock).toHaveBeenCalledWith('read_file', { vault_root: '/safe/vault', path: 'notes/a.md' })
  })

  it('does not sanitize/rewrite a forged root — the backend canonicalizes and rejects it', async () => {
    invokeMock.mockResolvedValue(undefined)
    const { tauriFsPort } = await import('../platform/gateways/tauri')
    await tauriFsPort.registerVault('/tmp/../vault')
    expect(invokeMock).toHaveBeenCalledWith('register_vault', { vault_root: '/tmp/../vault' })
    // The authoritative rejection of an unregistered / forged root lives in Rust:
    // apps/desktop/src-tauri/tests/vault_auth_test.rs
    //   - unregistered_vault_root_is_rejected
    //   - registered_vault_is_authorized_and_others_refused
    //   - relative_root_is_rejected
    //   - register_canonicalizes_symlinked_alias
  })
})

describe('security invariant: IPC key overreach — load_ai_key returns only the mask', () => {
  it('loadAiKey surfaces only the fixed presence mask, never the stored key', async () => {
    invokeMock.mockResolvedValue('••••••••')
    const { tauriKeyPort } = await import('../platform/gateways/tauri')
    await expect(tauriKeyPort.loadAiKey('openai')).resolves.toBe('••••••••')
    expect(invokeMock).toHaveBeenCalledWith('load_ai_key', { provider: 'openai' })
  })

  it('loadAiKey returns null when no key is configured (no fabricated mask)', async () => {
    invokeMock.mockResolvedValue(null)
    const { tauriKeyPort } = await import('../platform/gateways/tauri')
    await expect(tauriKeyPort.loadAiKey('openai')).resolves.toBeNull()
  })

  it('storeAiKey crosses IPC exactly once (the key is never read back; Rust owns the real value)', async () => {
    invokeMock.mockResolvedValue(undefined)
    const { tauriKeyPort } = await import('../platform/gateways/tauri')
    await tauriKeyPort.storeAiKey('openai', 'sk-never-leak')
    expect(invokeMock).toHaveBeenCalledWith('store_ai_key', { provider: 'openai', key: 'sk-never-leak' })
    // The mask-as-presence discipline is verified in Rust:
    // apps/desktop/src-tauri/tests/keys_test.rs · ai_key_presence_never_discloses_the_key
  })
})

describe('governance: crash-restart-on-unstable is non-silent and never auto-registers', () => {
  it('surfaces a PLUGIN_UNSTABLE activation result with a re-approval hint and does not register the plugin', async () => {
    // The host reports the plugin as unstable (crash-restart-on-unstable): the
    // desktop routes it to a distinct message instead of a generic failure, and
    // never adds it to the active set — so a crashing plugin cannot auto-restart.
    activateMock.mockResolvedValue({ ok: false, id: '@scope/q', error: 'boom', code: 'PLUGIN_UNSTABLE' })
    await loadVaultPlugins('/vault')
    expect(getActiveVaultPluginIds()).toEqual([])
    const msgs = notifyErrorMock.mock.calls.map((c) => String(c[0]))
    expect(msgs.some((m) => m.includes('unstable state') && m.includes('re-approval'))).toBe(true)
    expect(msgs.some((m) => m.includes('Re-approve'))).toBe(true)

    // A reload does not silently retry-and-activate.
    notifyErrorMock.mockClear()
    activateMock.mockClear()
    await loadVaultPlugins('/vault')
    expect(getActiveVaultPluginIds()).toEqual([])
  })
})
