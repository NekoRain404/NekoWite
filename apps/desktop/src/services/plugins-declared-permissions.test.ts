/**
 * What the app TELLS the user about a plugin's declared capabilities, against
 * the capability the host actually granted.
 *
 * `definition` is the plugin's own module export, so `definition.permissions`
 * may be an accessor that answers differently on every read. The host reads it
 * once (`declaredPermissionsOf`, at load) and both asks the user and grants
 * `ctx.ai` from that one answer; the app read it again for its own messages, so
 * a plugin could be handed a capability no notice ever mentioned, or be shown
 * as holding one the host had refused.
 *
 * These tests run the real loader and the real activation — only the module
 * import is stubbed, because a plugin's code is a string here — so `ctx.ai` is
 * the host's actual grant and the notice is the app's actual text.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getActiveUnsandboxedPluginIds,
  getUnsandboxedPermissions,
  getVaultPluginAuditEvents,
  loadVaultPlugins,
  resetVaultPluginStateForTests,
  setPluginPermissionDecider,
} from './plugins'
import type { PluginPermission } from '@nekowite/plugin-host'

const listMock = vi.hoisted(() => vi.fn())
const readMock = vi.hoisted(() => vi.fn())
const importSourceMock = vi.hoisted(() => vi.fn())
const notifyErrorMock = vi.hoisted(() => vi.fn())

vi.mock('../platform/gateways/fs', () => ({
  fsService: { list: listMock, read: readMock, write: vi.fn() },
}))
vi.mock('./errors', () => ({
  notifyError: notifyErrorMock,
  describePluginError: (e: { message?: string; recovery?: string }) =>
    `${e.message ?? ''}${e.recovery ? ` ${e.recovery}` : ''}`,
}))
// The import is the only step a test can skip: everything after it (the pin, the
// consent gate, the assignment of `ctx.ai`) is the real code path.
vi.mock('../features/plugins/services/discovery', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../features/plugins/services/discovery')>()),
  importSource: importSourceMock,
}))

const ID = '@scope/q'

/**
 * A plugin whose declared capabilities are an accessor: `answers[0]` is what it
 * says to the read the host pins (and so asks the user about, and grants from),
 * and every read after that gets the last entry. `contexts` collects the `ctx`
 * each activation was handed, which is where the grant is visible.
 */
function varyingPlugin(answers: PluginPermission[][], contexts: unknown[]): void {
  let reads = 0
  importSourceMock.mockResolvedValue({
    default: {
      get permissions() {
        return answers[Math.min(reads++, answers.length - 1)]
      },
      onLoad: (ctx: { ai?: unknown }) => {
        contexts.push(ctx.ai)
      },
    },
  })
}

beforeEach(() => {
  resetVaultPluginStateForTests()
  localStorage.clear()
  vi.clearAllMocks()
  setPluginPermissionDecider(null)
  listMock.mockResolvedValue([
    { name: 'quote', path: '/vault/plugins/quote', is_dir: true, is_mdx: false },
  ])
  // The manifest declares nothing; every capability below is declared in code.
  readMock.mockImplementation((_vault: string, rel: string) =>
    Promise.resolve(
      rel.endsWith('package.json')
        ? JSON.stringify({ name: ID, version: '1.0.0', main: 'index.js' })
        : 'export default {}',
    ),
  )
})

describe('a plugin whose declaration varies between reads', () => {
  it('announces the capability the host granted, not a later read’s answer', async () => {
    // 'ai' to the pinned read, nothing to every read after it: the grant is made
    // (the host granted from the pin), so a notice that says nothing is wrong.
    const contexts: unknown[] = []
    varyingPlugin([['ai'], []], contexts)
    setPluginPermissionDecider(async () => true)

    await loadVaultPlugins('/vault')

    expect(contexts[0]).toBeDefined() // the plugin ran, and was handed `ctx.ai`
    expect(getActiveUnsandboxedPluginIds()).toEqual([ID])
    expect(getUnsandboxedPermissions(ID)).toEqual(['ai'])
  })

  it('does not announce a capability the host did not grant', async () => {
    // The reverse: nothing at the pin (so nothing was asked, and nothing was
    // granted), 'ai' to every read after it. A notice here claims a capability
    // the plugin does not hold.
    const contexts: unknown[] = []
    varyingPlugin([[], ['ai']], contexts)

    await loadVaultPlugins('/vault')

    expect(contexts).toEqual([undefined]) // no `ai` grant was made
    expect(getActiveUnsandboxedPluginIds()).toEqual([])
  })

  it('audits the declaration the user was asked to approve', async () => {
    // A denial is audited and reported by name. Reading the declaration again for
    // that text made it name a SMALLER set than the dialog the user refused.
    const contexts: unknown[] = []
    varyingPlugin([['ai', 'fs'], ['ai']], contexts)
    setPluginPermissionDecider(async () => false)

    await loadVaultPlugins('/vault')

    const denied = getVaultPluginAuditEvents(ID).filter((e) => e.event === 'permission-denied')
    expect(denied.at(-1)?.detail).toBe('declared permissions: ai, fs')
    expect(notifyErrorMock).toHaveBeenCalledWith(expect.stringContaining('requires permission(s): ai, fs'))
  })
})
