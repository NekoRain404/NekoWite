/**
 * A vault switch that catches a plugin MID-ACTIVATION.
 *
 * `deactivateVaultPlugins` walked only the ids it had recorded as active, and an
 * activation still waiting on the host's init has not been recorded yet — so the
 * switch left it running, and it registered its components, commands and hooks
 * into the vault the app had already left (nothing else would ever take them
 * down: the load that owned them had returned).
 *
 * These tests drive the REAL host — only the loader is stubbed, so a definition
 * can park in `onLoad` on demand and the cancellation, the rollback and the
 * unstable bookkeeping are the host's actual code. What is asserted is the
 * app-side outcome: which ids the session believes are live, what the host was
 * left holding, and whether the cancelled plugin was quarantined.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getActiveVaultPluginIds,
  loadVaultPlugins,
  resetVaultPluginStateForTests,
  setVaultPluginDisabled,
} from './plugins'
import { getCommand, unregisterCommand } from '@nekowite/editor-core'
import { isPluginUnstable } from '@nekowite/plugin-host'
import type { PluginMeta } from '@nekowite/plugin-host'

const listMock = vi.hoisted(() => vi.fn())
const readMock = vi.hoisted(() => vi.fn())
const loadMock = vi.hoisted(() => vi.fn())
const notifyErrorMock = vi.hoisted(() => vi.fn())

vi.mock('../platform/gateways/fs', () => ({
  fsService: { list: listMock, read: readMock, write: vi.fn() },
}))
vi.mock('./errors', () => ({
  notifyError: notifyErrorMock,
  describePluginError: (e: { message?: string; recovery?: string }) =>
    `${e.message ?? ''}${e.recovery ? ` ${e.recovery}` : ''}`,
}))
// Only the loader is replaced. `activatePlugin` / `deactivatePlugin` are the
// real ones, which is the point: the cancellation under test is the host's.
vi.mock('@nekowite/plugin-host', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@nekowite/plugin-host')>()),
  loadPlugin: loadMock,
}))

/** A promise plus the handle that settles it — the seam every test below parks a
 *  plugin's activation on. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

/** Which plugin directories each vault holds. The manifest's name — and so the
 *  plugin id — is `@scope/<directory>`. */
let vaults: Record<string, string[]>

function vaultDirs(vault: string): string[] {
  return vaults[vault] ?? []
}

beforeEach(() => {
  resetVaultPluginStateForTests()
  localStorage.clear()
  vi.clearAllMocks()
  vaults = {}
  listMock.mockImplementation((vault: string) =>
    Promise.resolve(
      vaultDirs(vault).map((name) => ({
        name,
        path: `${vault}/plugins/${name}`,
        is_dir: true,
        is_mdx: false,
      })),
    ),
  )
  readMock.mockImplementation((_vault: string, rel: string) => {
    const dirName = rel.split('/')[1]
    return Promise.resolve(
      rel.endsWith('package.json')
        ? JSON.stringify({ name: `@scope/${dirName}`, version: '1.0.0', main: 'index.js' })
        : 'export default {}',
    )
  })
})

afterEach(() => {
  // The host's registries are process-global; a failed assertion must not leak a
  // command into the next test.
  unregisterCommand('a.cmd')
})

describe('a vault switch during an activation', () => {
  it('cancels an activation it catches parked at the host’s await', async () => {
    vaults = { '/vaultA': ['a'], '/vaultB': ['b'] }
    const held = deferred()
    const atAwait = deferred()
    loadMock.mockImplementation(async (meta: PluginMeta) =>
      meta.id === '@scope/a'
        ? {
            ok: true,
            id: meta.id,
            meta,
            // Registered BEFORE the await, so this is what a teardown that
            // cannot cancel leaves behind; `onLoad` never settles on its own.
            definition: {
              onLoad: () => {
                atAwait.resolve()
                return held.promise
              },
              commands: [{ id: 'a.cmd', title: 'A', run: () => undefined }],
            },
          }
        : { ok: true, id: meta.id, meta, definition: {} },
    )

    const stale = loadVaultPlugins('/vaultA')
    await atAwait.promise // vault A's plugin is inside the host's await
    await loadVaultPlugins('/vaultB') // ...and the user switches vaults
    held.resolve()
    await stale

    // The cancel took the registrations back with it, and vault A's plugin was
    // never recorded as live for the vault the app is now in.
    expect(getCommand('a.cmd')).toBeUndefined()
    expect(getActiveVaultPluginIds()).toEqual(['@scope/b'])
  })

  it('leaves the cancelled plugin off rather than quarantined as unstable', async () => {
    // The reason the vault switch cancels through `deactivatePlugin` and not by
    // aborting `ActivatePluginOptions.signal`: an abort lands in `activatePlugin`'s
    // failure branch, which marks the plugin unstable and asks the user to
    // re-approve a plugin that only ever got caught by a vault switch. This test
    // holds that line: it fails against the unfixed code (vault A's plugin is
    // still recorded live), and it fails for the abort as well.
    vaults = { '/vaultA': ['a'], '/vaultB': ['b'] }
    const held = deferred()
    const atAwait = deferred()
    loadMock.mockImplementation(async (meta: PluginMeta) => ({
      ok: true,
      id: meta.id,
      meta,
      definition:
        meta.id === '@scope/a' ? { onLoad: () => (atAwait.resolve(), held.promise) } : {},
    }))

    const stale = loadVaultPlugins('/vaultA')
    await atAwait.promise
    await loadVaultPlugins('/vaultB')
    held.resolve()
    await stale

    expect(isPluginUnstable('@scope/a')).toBe(false)
    expect(getActiveVaultPluginIds()).toEqual(['@scope/b'])
  })

  it('does not start the activations still queued behind the cap once the vault has left', async () => {
    // Only MAX_PARALLEL_PLUGIN_LOADS activations run at a time, so the plugins
    // past that limit have not reached the host when the switch arrives and the
    // cancellation above has nothing to cancel. Cancelling the running four
    // frees their workers, and without the claim check those workers start the
    // rest of the batch — the same leak, one slot further out.
    vaults = { '/vaultA': ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'], '/vaultB': ['b'] }
    const held = deferred()
    const allParked = deferred()
    let started = 0
    loadMock.mockImplementation(async (meta: PluginMeta) => ({
      ok: true,
      id: meta.id,
      meta,
      definition: {
        onLoad: () => {
          if (++started > 4) return undefined // queued behind the cap, not yet in the host
          if (started === 4) allParked.resolve()
          return held.promise
        },
      },
    }))

    const stale = loadVaultPlugins('/vaultA')
    await allParked.promise // the cap is saturated: a5 and a6 are still waiting
    await loadVaultPlugins('/vaultB')
    await stale

    expect(getActiveVaultPluginIds()).toEqual(['@scope/b'])
  })

  it('still cancels a parked activation whose id a duplicate directory also claimed', async () => {
    // Two directories may declare the same plugin name — the loader does not
    // dedupe — and the host answers the SECOND call for an id with its in-flight
    // no-op, which returns immediately. So only the task that actually started
    // the activation may take the id off the cancel list; otherwise the no-op's
    // cleanup does it while the real activation is still parked, and the switch
    // has nothing left to cancel.
    vaults = { '/vaultA': ['a', 'twin'], '/vaultB': ['b'] }
    readMock.mockImplementation((_vault: string, rel: string) => {
      const dirName = rel.split('/')[1]
      return Promise.resolve(
        rel.endsWith('package.json')
          ? JSON.stringify({
              name: `@scope/${dirName === 'twin' ? 'a' : dirName}`,
              version: '1.0.0',
              main: 'index.js',
            })
          : 'export default {}',
      )
    })
    const held = deferred()
    const atAwait = deferred()
    loadMock.mockImplementation(async (meta: PluginMeta) =>
      meta.id === '@scope/a'
        ? {
            ok: true,
            id: meta.id,
            meta,
            definition: {
              onLoad: () => {
                atAwait.resolve()
                return held.promise
              },
              commands: [{ id: 'a.cmd', title: 'A', run: () => undefined }],
            },
          }
        : { ok: true, id: meta.id, meta, definition: {} },
    )

    const stale = loadVaultPlugins('/vaultA')
    await atAwait.promise
    // Let the duplicate's no-op settle first: a switch that arrives on a LATER
    // tick than the no-op is the ordinary case, and it is the one that leaves
    // the real activation behind.
    await new Promise((resolve) => setTimeout(resolve, 0))
    await loadVaultPlugins('/vaultB')
    held.resolve()
    await stale

    expect(getCommand('a.cmd')).toBeUndefined()
  })
})

describe('what a cancelled activation reports', () => {
  /** Park vault A's single plugin in `onLoad` and hand back the handles. */
  async function parkVaultAPlugin(): Promise<{ release: () => void; stale: Promise<void> }> {
    vaults = { '/vaultA': ['a'], '/vaultB': ['b'] }
    const held = deferred()
    const atAwait = deferred()
    loadMock.mockImplementation(async (meta: PluginMeta) => ({
      ok: true,
      id: meta.id,
      meta,
      definition:
        meta.id === '@scope/a' ? { onLoad: () => (atAwait.resolve(), held.promise) } : {},
    }))
    const stale = loadVaultPlugins('/vaultA')
    await atAwait.promise
    return { release: held.resolve, stale }
  }

  /** Every message the app raised through the error channel. */
  function reported(): string[] {
    return notifyErrorMock.mock.calls.map(([message]) => String(message))
  }

  it('says nothing about a cancellation the vault switch caused', async () => {
    // The app cancelled on the user's behalf: there is nothing they can do about
    // it, and a switch that catches several plugins mid-activation would raise
    // one error per plugin over a routine action.
    const { release, stale } = await parkVaultAPlugin()
    await loadVaultPlugins('/vaultB')
    release()
    await stale

    expect(reported().filter((m) => m.includes('cancelled'))).toEqual([])
  })

  it('still reports the cancellation of a plugin the user switched off themselves', async () => {
    // The same host code path — `deactivatePlugin` cancels either way — so the
    // two are told apart by the claim: switching a plugin off does not start a
    // new vault load, and this one must keep the message its action produced.
    const { release, stale } = await parkVaultAPlugin()
    setVaultPluginDisabled('@scope/a', true)
    release()
    await stale

    expect(reported().some((m) => m.includes('activation was cancelled'))).toBe(true)
  })
})
