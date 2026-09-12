import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  askPluginPermission,
  getActiveVaultPluginIds,
  getPluginRecordedDigestForTest,
  getPluginTrustedKey,
  getPluginTrustedSourceIds,
  getPluginTrustPolicy,
  getVaultPluginAuditLogPath,
  loadVaultPlugins,
  PLUGIN_GOVERNANCE_FILE,
  resetVaultPluginStateForTests,
  setPluginIntegrityDecider,
  setPluginPermissionDecider,
  setPluginRecordedDigestForTest,
  setPluginTrustDecider,
  setPluginTrustedKey,
  setPluginTrustedSource,
  setPluginTrustPolicy,
} from './plugins'
import {
  buildPluginSignaturePayload,
  computePluginDigest,
  createMacEnvelope,
  createPluginSignature,
  isPluginUnstable,
  markPluginUnstable,
} from '@nekowite/plugin-host'
import type { PluginMeta } from '@nekowite/plugin-host'

const listMock = vi.hoisted(() => vi.fn())
const readMock = vi.hoisted(() => vi.fn())
const loadMock = vi.hoisted(() => vi.fn())
const activateMock = vi.hoisted(() => vi.fn())
const deactivateMock = vi.hoisted(() => vi.fn())
const notifyErrorMock = vi.hoisted(() => vi.fn())

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

const META = (permissions?: string[]): PluginMeta => ({
  id: '@scope/q',
  name: '@scope/q',
  version: '1.0.0',
  main: 'plugins/quote/index.js',
  permissions: permissions as never,
})

function pkg(permissions?: string[]): string {
  return JSON.stringify({ name: '@scope/q', version: '1.0.0', main: 'index.js', permissions })
}

beforeEach(() => {
  resetVaultPluginStateForTests()
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

describe('loadVaultPlugins', () => {
  it('is a silent no-op when the plugins dir is missing', async () => {
    listMock.mockRejectedValue(new Error('no plugins dir'))
    await expect(loadVaultPlugins('/vault')).resolves.toBeUndefined()
    expect(loadMock).not.toHaveBeenCalled()
    expect(activateMock).not.toHaveBeenCalled()
  })

  it('loads and activates each vault plugin', async () => {
    await loadVaultPlugins('/vault')
    // The fs boundary is read through the injected adapter (root-relative paths
    // translated to vault-relative ones against the vault file service).
    expect(listMock).toHaveBeenCalledWith('/vault', 'plugins')
    expect(readMock).toHaveBeenCalledWith('/vault', 'plugins/quote/package.json')
    expect(readMock).toHaveBeenCalledWith('/vault', 'plugins/quote/index.js')
    expect(loadMock).toHaveBeenCalledTimes(1)
    expect(activateMock).toHaveBeenCalledTimes(1)
    expect(getActiveVaultPluginIds()).toEqual(['@scope/q'])
  })

  it('deactivates the previous vault’s plugins before loading a new vault', async () => {
    await loadVaultPlugins('/vaultA')
    expect(getActiveVaultPluginIds()).toEqual(['@scope/q'])
    expect(deactivateMock).not.toHaveBeenCalled()

    listMock.mockResolvedValue([
      { name: 'quote', path: '/vaultB/plugins/quote', is_dir: true, is_mdx: false },
    ])
    await loadVaultPlugins('/vaultB')
    expect(deactivateMock).toHaveBeenCalledWith('@scope/q')
    expect(getActiveVaultPluginIds()).toEqual(['@scope/q'])

    deactivateMock.mockClear()
    await loadVaultPlugins('/vaultA')
    expect(deactivateMock).toHaveBeenCalledWith('@scope/q')
  })

  it('never activates a plugin whose load failed', async () => {
    loadMock.mockResolvedValue({ ok: false, id: '@scope/q', error: 'boom' })
    await loadVaultPlugins('/vault')
    expect(activateMock).not.toHaveBeenCalled()
    expect(getActiveVaultPluginIds()).toEqual([])
  })
})

describe('CSP gate (production Tauri webview)', () => {
  it('skips the scan and surfaces one per-session notice when a vault HAS plugins and the strict CSP blocks in-window blob imports', async () => {
    // The production Tauri webview injects a strict CSP script-src (no blob:,
    // no 'unsafe-eval'). isPluginImportAllowedByCsp() detects that via the Tauri
    // runtime signal (__TAURI_INTERNALS__) and refuses to attempt the in-window
    // import, returning early so no plugin CODE is read or executed. No silent
    // failure and no repeated per-plugin CSP error: exactly ONE user-visible
    // notice per session.
    ;(window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {}
    try {
      await loadVaultPlugins('/vault')
      // The directory listing happens first (that is how we tell "has plugins"
      // from "has none"), but no plugin code is read, imported or executed — the
      // security invariant the gate exists for.
      expect(listMock).toHaveBeenCalledWith('/vault', 'plugins')
      expect(readMock).not.toHaveBeenCalled()
      expect(loadMock).not.toHaveBeenCalled()
      expect(activateMock).not.toHaveBeenCalled()

      // The gate is observable, not silent.
      expect(notifyErrorMock).toHaveBeenCalledTimes(1)
      const msg = String(notifyErrorMock.mock.calls[0]?.[0])
      expect(msg.length).toBeGreaterThan(10)
      // Localized, not a raw i18n key: the toast renders this string verbatim.
      expect(msg).not.toContain('plugin.loadingDisabled')

      // Once per session: a second load does not repeat the notice.
      notifyErrorMock.mockClear()
      await loadVaultPlugins('/vault')
      expect(notifyErrorMock).not.toHaveBeenCalled()
    } finally {
      // Restore the non-Tauri environment for the remaining tests in this file.
      delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
    }
  })

  it('says nothing at all when the vault has no plugins to disable', async () => {
    // A vault with no `plugins/` directory has nothing the policy could block.
    // Announcing a security restriction to someone who never asked for the
    // feature is not "observable instead of silent", it is a permanent alarm on
    // every launch (and it used to write a plugin audit record into every vault).
    ;(window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {}
    try {
      listMock.mockResolvedValue([])
      await loadVaultPlugins('/vault')
      expect(notifyErrorMock).not.toHaveBeenCalled()
      expect(readMock).not.toHaveBeenCalled()
      expect(loadMock).not.toHaveBeenCalled()
      expect(activateMock).not.toHaveBeenCalled()
    } finally {
      delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
    }
  })
})

describe('askPluginPermission', () => {
  it('allows a pure UI plugin with no declared permissions', async () => {
    await expect(askPluginPermission(META(), {})).resolves.toBe(true)
    expect(activateMock).not.toHaveBeenCalled()
  })

  it('allows a plugin declaring only clipboard', async () => {
    await expect(askPluginPermission(META(['clipboard']), { permissions: ['clipboard'] })).resolves.toBe(true)
  })

  it('denies a dangerous plugin by default when no decider is installed', async () => {
    await expect(askPluginPermission(META(['fs']), { permissions: ['fs'] })).resolves.toBe(false)
  })

  it('denies a dangerous plugin when the decider rejects', async () => {
    setPluginPermissionDecider(() => Promise.resolve(false))
    await expect(askPluginPermission(META(['fs']), { permissions: ['fs'] })).resolves.toBe(false)
  })

  it('allows a dangerous plugin when the decider approves', async () => {
    setPluginPermissionDecider((meta) => Promise.resolve(meta.id === '@scope/q'))
    await expect(askPluginPermission(META(['network']), { permissions: ['network'] })).resolves.toBe(true)
  })

  it('keeps the verdict for a plugin across repeated asks', async () => {
    setPluginPermissionDecider(() => Promise.resolve(true))
    expect(await askPluginPermission(META(['ai']), { permissions: ['ai'] })).toBe(true)
    // The decider should not be invoked a second time for the same id.
    expect(await askPluginPermission(META(['ai']), { permissions: ['ai'] })).toBe(true)
  })
})

describe('permission gate during loadVaultPlugins', () => {
  it('skips activation of a dangerous plugin without consent', async () => {
    readMock.mockResolvedValue(pkg(['fs']))
    loadMock.mockResolvedValue({ ok: true, id: '@scope/q', meta: META(['fs']), definition: {} })
    await loadVaultPlugins('/vault')
    expect(loadMock).not.toHaveBeenCalled()
    expect(activateMock).not.toHaveBeenCalled()
  })

  it('activates a dangerous plugin after the decider approves', async () => {
    readMock.mockResolvedValue(pkg(['ai']))
    loadMock.mockResolvedValue({ ok: true, id: '@scope/q', meta: META(['ai']), definition: {} })
    setPluginPermissionDecider(() => Promise.resolve(true))
    await loadVaultPlugins('/vault')
    expect(activateMock).toHaveBeenCalledTimes(1)
    expect(getActiveVaultPluginIds()).toEqual(['@scope/q'])
  })

  it('keys the permission verdict by vault so two vaults never share an approval', async () => {
    readMock.mockResolvedValue(pkg(['fs']))
    loadMock.mockResolvedValue({ ok: true, id: '@scope/q', meta: META(['fs']), definition: {} })
    const decider = vi.fn(() => Promise.resolve(true))
    setPluginPermissionDecider(decider)
    await loadVaultPlugins('/vaultA')
    // The first vault asks once (the pre-import gate caches the verdict for the
    // post-import re-check).
    expect(decider).toHaveBeenCalledTimes(1)
    await loadVaultPlugins('/vaultB')
    // Vault A's approval does NOT authorise the same-id plugin of vault B: the
    // dangerous capability is asked about again instead of being granted
    // silently from the other vault's verdict.
    expect(decider).toHaveBeenCalledTimes(2)
    expect(getActiveVaultPluginIds()).toEqual(['@scope/q'])
  })

  it('caches a denial for the session and points at a recovery that works', async () => {
    readMock.mockResolvedValue(pkg(['fs']))
    loadMock.mockResolvedValue({ ok: true, id: '@scope/q', meta: META(['fs']), definition: {} })
    const decider = vi.fn(() => Promise.resolve(false))
    setPluginPermissionDecider(decider)
    await loadVaultPlugins('/vault')
    expect(decider).toHaveBeenCalledTimes(1)
    expect(activateMock).not.toHaveBeenCalled()
    expect(getActiveVaultPluginIds()).toEqual([])
    // A denial is remembered for the whole session (re-prompting on every vault
    // switch would nag), so the refusal must not tell the user to reload the
    // vault — that cannot clear a session verdict. A restart can, and does.
    const msg = String(notifyErrorMock.mock.calls[0]?.[0])
    expect(msg).toContain('Restart NekoWrite to be asked again')
    expect(msg).not.toContain('reload the vault')

    // Reloading reuses the cached denial: no silent activation, no re-prompt.
    notifyErrorMock.mockClear()
    await loadVaultPlugins('/vault')
    expect(decider).toHaveBeenCalledTimes(1)
    expect(getActiveVaultPluginIds()).toEqual([])
  })
})

describe('quarantine reset on vault load (crash-restart-on-unstable)', () => {
  it('re-approves a quarantined plugin when its vault is loaded again', async () => {
    // The host quarantined the plugin after a hook timeout. `deactivatePlugin`
    // cannot clear that flag (the plugin left the host's active map when it was
    // quarantined), so nothing in the app could reset it and the refusal's
    // "re-approve it, then reload the vault" instruction was impossible to follow.
    markPluginUnstable('@scope/q', 'hook timeout')
    expect(isPluginUnstable('@scope/q')).toBe(true)

    await loadVaultPlugins('/vault')

    // Loading the vault IS the user-mediated re-approval: the quarantine is gone
    // and the plugin runs again.
    expect(isPluginUnstable('@scope/q')).toBe(false)
    expect(activateMock).toHaveBeenCalledTimes(1)
    expect(getActiveVaultPluginIds()).toEqual(['@scope/q'])
  })

  it('does not let that reset bypass the consent gate', async () => {
    readMock.mockResolvedValue(pkg(['fs']))
    loadMock.mockResolvedValue({ ok: true, id: '@scope/q', meta: META(['fs']), definition: {} })
    setPluginPermissionDecider(() => Promise.resolve(false))
    markPluginUnstable('@scope/q', 'hook timeout')

    await loadVaultPlugins('/vault')

    // Only the stability flag is dropped: the plugin is still refused by the
    // permission gate, never imported and never activated.
    expect(loadMock).not.toHaveBeenCalled()
    expect(activateMock).not.toHaveBeenCalled()
    expect(getActiveVaultPluginIds()).toEqual([])
  })
})

describe('parallel loading & isolation', () => {
  it('activates multiple plugins in deterministic sorted order', async () => {
    listMock.mockResolvedValue([
      { name: 'zzz', path: '/vault/plugins/zzz', is_dir: true, is_mdx: false },
      { name: 'aaa', path: '/vault/plugins/aaa', is_dir: true, is_mdx: false },
    ])
    readMock.mockImplementation((_vault, rel) =>
      Promise.resolve(
        rel.includes('zzz')
          ? JSON.stringify({ name: '@scope/zzz', version: '1.0.0', main: 'index.js' })
          : JSON.stringify({ name: '@scope/aaa', version: '1.0.0', main: 'index.js' }),
      ),
    )
    loadMock.mockImplementation(async (meta) => ({ ok: true, id: meta.id, meta, definition: {} }))
    activateMock.mockImplementation(async (res) => ({ ok: true, id: res.id }))
    await loadVaultPlugins('/vault')
    expect(getActiveVaultPluginIds()).toEqual(['@scope/aaa', '@scope/zzz'])
  })

  it('isolates a failing plugin so the others still activate', async () => {
    listMock.mockResolvedValue([
      { name: 'good', path: '/vault/plugins/good', is_dir: true, is_mdx: false },
      { name: 'bad', path: '/vault/plugins/bad', is_dir: true, is_mdx: false },
    ])
    readMock.mockImplementation((_vault, rel) =>
      Promise.resolve(
        rel.includes('good')
          ? JSON.stringify({ name: '@scope/good', version: '1.0.0', main: 'index.js' })
          : JSON.stringify({ name: '@scope/bad', version: '1.0.0', main: 'index.js' }),
      ),
    )
    loadMock.mockImplementation(async (meta) =>
      meta.id === '@scope/bad'
        ? { ok: false, id: meta.id, error: 'boom' }
        : { ok: true, id: meta.id, meta, definition: {} },
    )
    activateMock.mockImplementation(async (res) => ({ ok: true, id: res.id }))
    await loadVaultPlugins('/vault')
    expect(getActiveVaultPluginIds()).toEqual(['@scope/good'])
    expect(notifyErrorMock).toHaveBeenCalled()
    expect(String(notifyErrorMock.mock.calls[0]?.[0])).toContain('@scope/bad')
  })
})

describe('distinct plugin failure buckets', () => {
  it('silently skips a directory without a manifest (not a plugin)', async () => {
    readMock.mockRejectedValue(new Error('missing'))
    await loadVaultPlugins('/vault')
    expect(activateMock).not.toHaveBeenCalled()
    expect(getActiveVaultPluginIds()).toEqual([])
    expect(notifyErrorMock).not.toHaveBeenCalled()
  })

  it('routes a missing entry file to a not-found recovery hint', async () => {
    loadMock.mockRejectedValue(new Error('Cannot find module "./index.js"'))
    await loadVaultPlugins('/vault')
    expect(activateMock).not.toHaveBeenCalled()
    const msg = String(notifyErrorMock.mock.calls[0]?.[0])
    expect(msg).toContain('could not be found')
    expect(msg).toContain('Reinstall the plugin')
  })

  it('routes an invalid manifest (bad JSON) to a manifest-invalid error message', async () => {
    readMock.mockResolvedValue('not json')
    await loadVaultPlugins('/vault')
    expect(activateMock).not.toHaveBeenCalled()
    const msg = String(notifyErrorMock.mock.calls[0]?.[0])
    expect(msg).toContain('invalid manifest')
  })

  it('routes a parse/load code failure distinctly from an activation failure', async () => {
    // Load failure (import throws)
    loadMock.mockRejectedValue(new Error('SyntaxError: Unexpected token'))
    await loadVaultPlugins('/vault')
    expect(activateMock).not.toHaveBeenCalled()
    const loadMsg = String(notifyErrorMock.mock.calls[0]?.[0])
    expect(loadMsg).toContain('could not be parsed/imported')

    // Activation failure
    notifyErrorMock.mockClear()
    loadMock.mockResolvedValue({ ok: true, id: '@scope/q', meta: META(), definition: {} })
    activateMock.mockResolvedValue({ ok: false, id: '@scope/q', error: 'register failed' })
    await loadVaultPlugins('/vault')
    expect(getActiveVaultPluginIds()).toEqual([])
    const actMsg = String(notifyErrorMock.mock.calls[0]?.[0])
    expect(actMsg).toContain('failed to activate')
    expect(actMsg).toContain('Disable and re-enable the plugin')
  })

  it('routes a permission denial through a structured permission-denied error', async () => {
    readMock.mockResolvedValue(pkg(['fs']))
    loadMock.mockResolvedValue({ ok: true, id: '@scope/q', meta: META(['fs']), definition: {} })
    await loadVaultPlugins('/vault')
    expect(loadMock).not.toHaveBeenCalled()
    expect(activateMock).not.toHaveBeenCalled()
    expect(getActiveVaultPluginIds()).toEqual([])
    const msg = String(notifyErrorMock.mock.calls[0]?.[0])
    expect(msg).toContain('@scope/q')
    expect(msg).toContain('permission(s)')
    expect(msg).toContain('Restart NekoWrite to be asked again')
  })
})

describe('plugin integrity detection (gated import)', () => {
  it('records a baseline fingerprint on first approval', async () => {
    readMock.mockResolvedValue(pkg())
    loadMock.mockResolvedValue({ ok: true, id: '@scope/q', meta: META(), definition: {} })
    await loadVaultPlugins('/vault')
    expect(activateMock).toHaveBeenCalledTimes(1)
    // The digest is computed over the manifest text AND the loaded source bytes.
    expect(getPluginRecordedDigestForTest('/vault', '@scope/q')).toEqual(computePluginDigest(pkg(), pkg()))
  })

  it('keys the baseline by vault so two vaults never share an approval record', async () => {
    readMock.mockResolvedValue(pkg())
    loadMock.mockResolvedValue({ ok: true, id: '@scope/q', meta: META(), definition: {} })
    await loadVaultPlugins('/vaultA')
    await loadVaultPlugins('/vaultB')
    // The baseline is keyed by vault + id (the composite key is never just the id).
    expect(getPluginRecordedDigestForTest('/vaultA', '@scope/q')).toBeDefined()
    expect(getPluginRecordedDigestForTest('/vaultB', '@scope/q')).toBeDefined()
  })

  it('NEVER imports (executes) a plugin whose code changed since it was approved', async () => {
    readMock.mockResolvedValue(pkg(['fs']))
    loadMock.mockResolvedValue({ ok: true, id: '@scope/q', meta: META(['fs']), definition: {} })
    setPluginPermissionDecider(() => Promise.resolve(true))
    // Seed a stale fingerprint so this load's digest does not match.
    setPluginRecordedDigestForTest('/vault', '@scope/q', '1.0.0', 'deadbeef')
    await loadVaultPlugins('/vault')
    // The security boundary: the module is never imported, so its top-level
    // side effects can never run for a modified/unapproved plugin.
    expect(loadMock).not.toHaveBeenCalled()
    expect(activateMock).not.toHaveBeenCalled()
    expect(getActiveVaultPluginIds()).toEqual([])
    const msgs = notifyErrorMock.mock.calls.map((c) => String(c[0]))
    const verifyMsg = msgs.find((m) => m.includes('changed since you approved it'))
    expect(verifyMsg).toBeDefined()
    expect(verifyMsg).toContain('Re-approve it only if you trust the new version')
  })

  it('imports a modified plugin only after the user re-approves it', async () => {
    readMock.mockResolvedValue(pkg(['fs']))
    loadMock.mockResolvedValue({ ok: true, id: '@scope/q', meta: META(['fs']), definition: {} })
    setPluginPermissionDecider(() => Promise.resolve(true))
    setPluginIntegrityDecider(() => Promise.resolve(true))
    setPluginRecordedDigestForTest('/vault', '@scope/q', '1.0.0', 'deadbeef')
    await loadVaultPlugins('/vault')
    // Re-approval leads to the gated import (the module executes) and activation.
    expect(loadMock).toHaveBeenCalledTimes(1)
    expect(activateMock).toHaveBeenCalledTimes(1)
    expect(getActiveVaultPluginIds()).toEqual(['@scope/q'])
    // The new fingerprint is adopted as the baseline.
    expect(getPluginRecordedDigestForTest('/vault', '@scope/q')).not.toEqual('deadbeef')
  })
})

describe('plugin trust & signature gate (definite security requirement)', () => {
  const KEY = '4e656b6f2d6b6579' // trusted publisher key (hex-like)
  const SOURCE = 'export default {}'

  /** A manifest read that returns a signed package.json and a fixed code source. */
  function signedManifest(signature: string): { raw: string; source: string } {
    const raw = JSON.stringify({ name: '@scope/q', version: '1.0.0', main: 'index.js', signature })
    return { raw, source: SOURCE }
  }

  it('loads a plugin whose signature verifies against the trusted key', async () => {
    const payload = buildPluginSignaturePayload('@scope/q', '1.0.0', 'index.js', SOURCE, undefined)
    const signature = await createPluginSignature(payload, KEY)
    setPluginTrustedKey(KEY)
    const { raw } = signedManifest(signature)
    readMock.mockImplementation((_vault, rel) => Promise.resolve(rel.endsWith('package.json') ? raw : SOURCE))
    await loadVaultPlugins('/vault')
    // Verification passed → the gated import runs and the plugin activates.
    expect(loadMock).toHaveBeenCalledTimes(1)
    expect(activateMock).toHaveBeenCalledTimes(1)
    expect(getActiveVaultPluginIds()).toEqual(['@scope/q'])
  })

  it('refuses a plugin whose signature FAILS verification BEFORE importing it', async () => {
    // Sign with a DIFFERENT key than the one configured → verification fails.
    const payload = buildPluginSignaturePayload('@scope/q', '1.0.0', 'index.js', SOURCE, undefined)
    const badSignature = await createPluginSignature(payload, 'deadbeefdeadbeef')
    setPluginTrustedKey(KEY)
    const { raw } = signedManifest(badSignature)
    readMock.mockImplementation((_vault, rel) => Promise.resolve(rel.endsWith('package.json') ? raw : SOURCE))
    await loadVaultPlugins('/vault')
    // The signature gate runs BEFORE the import, so the module is NEVER imported
    // and no top-level side effects can run.
    expect(loadMock).not.toHaveBeenCalled()
    expect(activateMock).not.toHaveBeenCalled()
    expect(getActiveVaultPluginIds()).toEqual([])
    const msgs = notifyErrorMock.mock.calls.map((c) => String(c[0]))
    const sigMsg = msgs.find((m) => m.includes('failed verification'))
    expect(sigMsg).toBeDefined()
    expect(sigMsg).toContain('trusted publisher key')
  })

  it('refuses an unsigned plugin under the strict policy (never silently trusted)', async () => {
    setPluginTrustPolicy('require-trust')
    // No trusted key, no allowlist, no trust decider — the safe default is deny.
    readMock.mockResolvedValue(pkg()) // unsigned manifest
    await loadVaultPlugins('/vault')
    expect(loadMock).not.toHaveBeenCalled()
    expect(activateMock).not.toHaveBeenCalled()
    expect(getActiveVaultPluginIds()).toEqual([])
    const msgs = notifyErrorMock.mock.calls.map((c) => String(c[0]))
    const unsignedMsg = msgs.find((m) => m.includes('unsigned and not from a trusted source'))
    expect(unsignedMsg).toBeDefined()
  })

  it('loads an unsigned plugin under the strict policy once the user explicitly trusts its publisher', async () => {
    setPluginTrustPolicy('require-trust')
    setPluginTrustedSource('@scope', true) // publisher id for '@scope/q'
    expect(getPluginTrustedSourceIds()).toEqual(['@scope'])
    readMock.mockResolvedValue(pkg()) // unsigned manifest
    await loadVaultPlugins('/vault')
    // Trusted-source allowlist satisfied → the gated import runs.
    expect(loadMock).toHaveBeenCalledTimes(1)
    expect(activateMock).toHaveBeenCalledTimes(1)
    expect(getActiveVaultPluginIds()).toEqual(['@scope/q'])
  })

  it('trusts an unsigned plugin under the strict policy after a trust decider approves, and records the publisher', async () => {
    setPluginTrustPolicy('require-trust')
    const decider = vi.fn(() => Promise.resolve(true))
    setPluginTrustDecider(decider)
    readMock.mockResolvedValue(pkg()) // unsigned manifest
    await loadVaultPlugins('/vault')
    expect(loadMock).toHaveBeenCalledTimes(1)
    expect(decider).toHaveBeenCalledTimes(1)
    // The trust decision is recorded against the specific plugin id so the
    // plugin is not re-asked on the next reload (conservative: it does not
    // auto-trust the whole publisher).
    expect(getPluginTrustedSourceIds()).toEqual(['@scope/q'])
    expect(getActiveVaultPluginIds()).toEqual(['@scope/q'])
  })

  it('defaults to the permit-unsigned-with-notice policy (unsigned allowed, never claimed as trusted)', async () => {
    expect(getPluginTrustPolicy()).toBe('permit-unsigned-with-notice')
    expect(getPluginTrustedKey()).toBe('')
    // No key, no allowlist → permitted, not refused (existing behavior preserved).
    readMock.mockResolvedValue(pkg())
    await loadVaultPlugins('/vault')
    expect(loadMock).toHaveBeenCalledTimes(1)
    expect(getActiveVaultPluginIds()).toEqual(['@scope/q'])
    // Nothing was recorded as a trusted source for an unsigned plugin under the
    // default policy — it is not silently trusted.
    expect(getPluginTrustedSourceIds()).toEqual([])
  })
})

describe('audit log path (vault-relative, never collides with notes)', () => {
  it('chooses a deterministic hidden path under .nekowite/ that never ends in a note/doc extension', () => {
    const p = getVaultPluginAuditLogPath('/vault')
    // The audit log lives under the vault's hidden .nekowite/ dir, so it can never
    // collide with a user note/doc path.
    expect(p).toBe('/vault/.nekowite/vault-plugin-audit.log')
    expect(p).toMatch(/\.nekowite\//)
    expect(p.endsWith('.md')).toBe(false)
    expect(p.endsWith('.mdx')).toBe(false)
    expect(p.endsWith('.markdown')).toBe(false)
  })

  it('keeps the audit log distinct from the governance trust-state file', () => {
    expect(getVaultPluginAuditLogPath('/vault')).not.toMatch(/governance/)
  })
})

describe('governance trust-state file (MAC-protected, P1.8)', () => {
  it('refuses trust contained in a tampered governance file (no silent trust)', async () => {
    // A known per-install MAC key; build a VALID envelope with it, then corrupt the
    // MAC so the load detects tampering and refuses the contained trust.
    const key = 'a'.repeat(64)
    const payload = JSON.stringify({
      governance: '{}',
      trustedKey: '',
      trustedSources: ['@scope'], // the tampered file claims '@scope' is trusted
      digests: {},
    })
    const env = await createMacEnvelope(payload, key)
    const tampered = JSON.stringify({ payload: env.payload, mac: '0'.repeat(64) })

    readMock.mockImplementation((_vault, rel) => {
      if (rel.endsWith(PLUGIN_GOVERNANCE_FILE)) return Promise.resolve(tampered)
      if (rel.endsWith('.mackey')) return Promise.resolve(key)
      return Promise.resolve(pkg())
    })

    setPluginTrustPolicy('require-trust')
    await loadVaultPlugins('/vault')

    // The plugin is unsigned; the tampered file claimed '@scope' trusted, but the
    // MAC failed, so no trust is granted → refused at load, never imported.
    expect(loadMock).not.toHaveBeenCalled()
    expect(activateMock).not.toHaveBeenCalled()
    expect(getActiveVaultPluginIds()).toEqual([])
    // Nothing from the tampered file is trusted.
    expect(getPluginTrustedSourceIds()).toEqual([])
    // A notice is surfaced — non-silent.
    const msgs = notifyErrorMock.mock.calls.map((c) => String(c[0]))
    expect(msgs.some((m) => m.includes('integrity'))).toBe(true)
  })

  it('loads trust from a governance file whose MAC verifies', async () => {
    const key = 'b'.repeat(64)
    const payload = JSON.stringify({
      governance: '{}',
      trustedKey: '',
      trustedSources: ['@scope'],
      digests: {},
    })
    const env = await createMacEnvelope(payload, key)

    readMock.mockImplementation((_vault, rel) => {
      if (rel.endsWith(PLUGIN_GOVERNANCE_FILE)) return Promise.resolve(JSON.stringify(env))
      if (rel.endsWith('.mackey')) return Promise.resolve(key)
      return Promise.resolve(pkg())
    })

    setPluginTrustPolicy('require-trust')
    await loadVaultPlugins('/vault')

    // The integrity-checked file approved '@scope' — the unsigned plugin loads.
    expect(loadMock).toHaveBeenCalledTimes(1)
    expect(activateMock).toHaveBeenCalledTimes(1)
    expect(getActiveVaultPluginIds()).toEqual(['@scope/q'])
    expect(getPluginTrustedSourceIds()).toEqual(['@scope'])
  })
})

describe('consent covers the capabilities actually declared', () => {
  it('asks again when the code declares a capability the manifest did not', async () => {
    // A plugin declares permissions in its manifest AND in its code, and the
    // code declarations are only visible after the module is imported. A
    // (vault, id) cache let a plugin the user approved for fs later add ai and
    // activate with no further prompt - while the trusted-but-unsandboxed
    // notice listed the new capability among those already approved.
    const asked: string[][] = []
    const decider = vi.fn(async (_meta: PluginMeta, perms: string[]) => {
      asked.push([...perms])
      return true
    })
    setPluginPermissionDecider(decider)

    await expect(askPluginPermission(META(['fs']), { permissions: ['fs'] })).resolves.toBe(true)
    expect(asked).toEqual([['fs']])

    await expect(
      askPluginPermission(META(['fs']), { permissions: ['fs', 'ai'] }),
    ).resolves.toBe(true)
    expect(asked.length).toBe(2)
    expect(asked[1]).toContain('ai')

    // The same set again is still cached.
    await expect(
      askPluginPermission(META(['fs']), { permissions: ['fs', 'ai'] }),
    ).resolves.toBe(true)
    expect(asked.length).toBe(2)
  })
})
