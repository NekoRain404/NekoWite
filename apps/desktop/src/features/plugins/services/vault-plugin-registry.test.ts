/**
 * The plugin on/off switch, and the two facts a row cannot see for itself.
 *
 * `listVaultPlugins` builds every row out of the in-memory record, so the record
 * is what the user is shown. A toggle that wrote "on" into the record and then
 * failed to re-run the gates — or failed to reach the governance file — left the
 * row claiming a state the app did not hold: it read as switched on, ran
 * nothing, and was gone at the next launch. These tests pin the one call that
 * moves the switch: what the app holds, why a request was put back, and what the
 * vault's file said.
 *
 * The file side is a real in-memory filesystem, not a stub of the store: the MAC
 * envelope, the read-modify-write and the tamper detection below are the real
 * ones, because "the file accepted the decision" is a claim about actual bytes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  listVaultPlugins,
  readVaultPlugins,
  resetVaultPluginStateForTests,
  setVaultPluginDisabled,
} from './vault-plugin-registry'
import { isVaultPluginDisabled } from './governance-store'
import {
  PLUGIN_GOVERNANCE_FILE,
  PLUGIN_GOVERNANCE_MACKEY_FILE,
  type GovernanceFilePayload,
} from './governance-file'
import { createMacEnvelope, verifyMacEnvelope } from '@nekowite/plugin-host'

const fsMock = vi.hoisted(() => ({
  files: new Map<string, string>(),
  /** Set by a test to make every write reject, like a full or read-only disk. */
  writeFails: false,
  list: vi.fn(),
  read: vi.fn(),
  write: vi.fn(),
  stat: vi.fn(),
}))

vi.mock('../../../platform/gateways/fs', () => ({
  fsService: {
    list: fsMock.list,
    read: fsMock.read,
    write: fsMock.write,
    stat: fsMock.stat,
  },
}))

// The teardown half is the real host's; only its call is observed. Everything
// else (the MAC envelope, the audit ring) stays real.
const deactivateMock = vi.hoisted(() => vi.fn())
vi.mock('@nekowite/plugin-host', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@nekowite/plugin-host')>()),
  deactivatePlugin: deactivateMock,
}))

const VAULT = '/vault'
const ID = '@scope/q'
/** A known per-install MAC key: seeded where the app would have stored one. */
const KEY = 'a'.repeat(64)

function fsKey(relative: string): string {
  return `${VAULT}\u0000${relative}`
}

/** The disabled set the vault's file holds right now, or null when the file is
 *  missing or its MAC does not verify — the two answers a read refuses. */
async function fileDisabledIds(): Promise<string[] | null> {
  const raw = fsMock.files.get(fsKey(PLUGIN_GOVERNANCE_FILE))
  if (raw === undefined) return null
  const framed = JSON.parse(raw) as { payload: string; mac: string }
  if (!(await verifyMacEnvelope(framed, KEY))) return null
  return (JSON.parse(framed.payload) as GovernanceFilePayload).disabled ?? []
}

/** Seed the governance file as a MAC-protected payload — what a previous
 *  session of the app would have left behind. */
async function seedGovernanceFile(over: Partial<GovernanceFilePayload> = {}): Promise<void> {
  const payload = JSON.stringify({
    governance: '{}',
    trustedKey: '',
    trustedSources: [],
    digests: {},
    ...over,
  })
  const envelope = await createMacEnvelope(payload, KEY)
  fsMock.files.set(fsKey(PLUGIN_GOVERNANCE_FILE), JSON.stringify(envelope))
}

/** Corrupt the seeded file's MAC without touching its payload: the tampered case. */
function tamperSeededFile(): string {
  const raw = fsMock.files.get(fsKey(PLUGIN_GOVERNANCE_FILE))
  if (!raw) throw new Error('unreachable: the test seeds the file first')
  const framed = JSON.parse(raw) as { payload: string; mac: string }
  const tampered = JSON.stringify({ payload: framed.payload, mac: '0'.repeat(64) })
  fsMock.files.set(fsKey(PLUGIN_GOVERNANCE_FILE), tampered)
  return tampered
}

beforeEach(() => {
  resetVaultPluginStateForTests()
  localStorage.clear()
  vi.clearAllMocks()
  fsMock.files.clear()
  fsMock.writeFails = false
  fsMock.files.set(fsKey(PLUGIN_GOVERNANCE_MACKEY_FILE), KEY)
  fsMock.read.mockImplementation((vault: string, relative: string) => {
    const content = fsMock.files.get(`${vault}\u0000${relative}`)
    return content === undefined
      ? Promise.reject(new Error(`ENOENT: ${relative}`))
      : Promise.resolve(content)
  })
  fsMock.write.mockImplementation((vault: string, relative: string, content: string) => {
    if (fsMock.writeFails) return Promise.reject(new Error('EIO: read-only file system'))
    fsMock.files.set(`${vault}\u0000${relative}`, content)
    return Promise.resolve()
  })
  fsMock.list.mockResolvedValue([
    { name: 'quote', path: `${VAULT}/plugins/quote`, is_dir: true, is_mdx: false },
  ])
  fsMock.files.set(
    fsKey('plugins/quote/package.json'),
    JSON.stringify({ name: ID, version: '1.0.0', main: 'index.js' }),
  )
})

describe('switching a plugin off', () => {
  it('applies immediately and reports the file that took the decision', async () => {
    await seedGovernanceFile({ disabled: [] })

    const outcome = await setVaultPluginDisabled(ID, true, { vault: VAULT })

    expect(outcome).toEqual({ disabled: true, refused: null, saved: 'saved' })
    expect(isVaultPluginDisabled(ID)).toBe(true)
    // "Off" means out NOW, not at the next load.
    expect(deactivateMock).toHaveBeenCalledWith(ID)
    expect(await fileDisabledIds()).toEqual([ID])
  })

  it('reports a write that did not land rather than claiming it was saved', async () => {
    await seedGovernanceFile({ disabled: [] })
    fsMock.writeFails = true

    const outcome = await setVaultPluginDisabled(ID, true, { vault: VAULT })

    // The switch is applied in memory, but the file never took it — and that is
    // exactly the state that reverts at the next launch, so it is named.
    expect(outcome).toEqual({ disabled: true, refused: null, saved: 'failed' })
    expect(isVaultPluginDisabled(ID)).toBe(true)
    expect(await fileDisabledIds()).toEqual([])
  })

  it('never writes over a file whose MAC did not verify, and says so', async () => {
    await seedGovernanceFile({ disabled: [] })
    const asTampered = tamperSeededFile()

    const outcome = await setVaultPluginDisabled(ID, true, { vault: VAULT })

    expect(outcome).toEqual({ disabled: true, refused: null, saved: 'tampered' })
    // Overwriting an unverifiable file is how the attacker's version becomes the
    // trusted one on the next read, so the bytes are untouched.
    expect(fsMock.files.get(fsKey(PLUGIN_GOVERNANCE_FILE))).toBe(asTampered)
    expect(fsMock.write).not.toHaveBeenCalled()
  })

  it('confirms THIS plugin, so another row’s switch is not read as a failed save', async () => {
    await seedGovernanceFile({ disabled: [] })
    const write = fsMock.write.getMockImplementation()
    if (!write) throw new Error('unreachable: beforeEach installs the write')
    fsMock.write.mockImplementation(async (vault: string, relative: string, content: string) => {
      await write(vault, relative, content)
      // Another row's switch reaches the same file between this write and its
      // confirmation. Comparing whole sets would call this a save that did not
      // land, and the user would be told a decision that IS in the file is gone
      // after a restart - the same lie, in the other direction.
      if (!relative.endsWith(PLUGIN_GOVERNANCE_FILE)) return
      const framed = JSON.parse(fsMock.files.get(fsKey(relative)) ?? '') as {
        payload: string
        mac: string
      }
      const payload = JSON.parse(framed.payload) as GovernanceFilePayload
      const envelope = await createMacEnvelope(
        JSON.stringify({ ...payload, disabled: [...(payload.disabled ?? []), '@scope/other'] }),
        KEY,
      )
      fsMock.files.set(fsKey(relative), JSON.stringify(envelope))
    })

    const outcome = await setVaultPluginDisabled(ID, true, { vault: VAULT })

    expect(outcome.saved).toBe('saved')
    expect(await fileDisabledIds()).toEqual([ID, '@scope/other'])
  })

  it('defers the file when the caller names no vault to write it to', async () => {
    const outcome = await setVaultPluginDisabled(ID, true)

    expect(outcome).toEqual({ disabled: true, refused: null, saved: null })
    expect(isVaultPluginDisabled(ID)).toBe(true)
    expect(fsMock.write).not.toHaveBeenCalled()
  })
})

describe('switching a plugin back on', () => {
  it('re-runs the gates and reports the file that took the decision', async () => {
    await seedGovernanceFile({ disabled: [ID] })
    await setVaultPluginDisabled(ID, true, { vault: VAULT })

    const reload = vi.fn<(vault: string) => Promise<void>>(async () => undefined)
    const outcome = await setVaultPluginDisabled(ID, false, { vault: VAULT, reload })

    expect(outcome).toEqual({ disabled: false, refused: null, saved: 'saved' })
    expect(reload).toHaveBeenCalledWith(VAULT)
    expect(isVaultPluginDisabled(ID)).toBe(false)
    expect(await fileDisabledIds()).toEqual([])
  })

  it('clears the file BEFORE the reload, which reads the disabled set out of it', async () => {
    await seedGovernanceFile({ disabled: [ID] })
    await setVaultPluginDisabled(ID, true, { vault: VAULT })

    // What the file said at the moment the gates ran. A file that still said
    // "disabled" makes every gate skip the plugin, so the switch would report a
    // plugin as running that never came back.
    let atReload: string[] | null = null
    const outcome = await setVaultPluginDisabled(ID, false, {
      vault: VAULT,
      reload: async () => {
        atReload = await fileDisabledIds()
      },
    })

    expect(atReload).toEqual([])
    expect(outcome.saved).toBe('saved')
  })

  it('keeps the plugin off when the file would not take the decision', async () => {
    await seedGovernanceFile({ disabled: [ID] })
    await setVaultPluginDisabled(ID, true, { vault: VAULT })
    fsMock.writeFails = true

    const reload = vi.fn<(vault: string) => Promise<void>>(async () => undefined)
    const outcome = await setVaultPluginDisabled(ID, false, { vault: VAULT, reload })

    // The file still says "disabled", so a reload would only skip the plugin:
    // the record goes back to the state the app actually holds.
    expect(outcome).toEqual({
      disabled: true,
      refused: 'the library\'s plugin state file could not be written',
      saved: 'failed',
    })
    expect(reload).not.toHaveBeenCalled()
    expect(isVaultPluginDisabled(ID)).toBe(true)
  })

  it('keeps the plugin off when the file is not one this app wrote', async () => {
    // The other state the reader refuses, and it gets its own sentence: a file that is not a MAC
    // envelope is not "changed outside the app" (there is nothing of ours to change), it is
    // somebody else's — so the remedy is to leave it alone rather than to fix or remove it.
    const foreign = '{"note":"not a governance envelope"}\n'
    fsMock.files.set(fsKey(PLUGIN_GOVERNANCE_FILE), foreign)

    const reload = vi.fn<(vault: string) => Promise<void>>(async () => undefined)
    const outcome = await setVaultPluginDisabled(ID, false, { vault: VAULT, reload })

    expect(outcome).toEqual({
      disabled: true,
      refused:
        "the library's plugin state file is not one this app wrote, so nothing was written",
      saved: 'unreadable',
    })
    expect(reload).not.toHaveBeenCalled()
    // And the file is untouched, byte for byte: the write that used to happen here is the bug.
    expect(fsMock.files.get(fsKey(PLUGIN_GOVERNANCE_FILE))).toBe(foreign)
  })

  it('keeps the plugin off when the file could not be verified', async () => {
    await seedGovernanceFile({ disabled: [ID] })
    await setVaultPluginDisabled(ID, true, { vault: VAULT })
    const asTampered = tamperSeededFile()

    const reload = vi.fn<(vault: string) => Promise<void>>(async () => undefined)
    const outcome = await setVaultPluginDisabled(ID, false, { vault: VAULT, reload })

    expect(outcome).toEqual({
      disabled: true,
      refused: 'the library\'s plugin state file was changed outside the app, so nothing was written',
      saved: 'tampered',
    })
    expect(reload).not.toHaveBeenCalled()
    expect(fsMock.files.get(fsKey(PLUGIN_GOVERNANCE_FILE))).toBe(asTampered)
  })

  it('puts the record AND the file back when the reload refuses the plugin', async () => {
    await seedGovernanceFile({ disabled: [ID] })
    await setVaultPluginDisabled(ID, true, { vault: VAULT })

    const outcome = await setVaultPluginDisabled(ID, false, {
      vault: VAULT,
      reload: async () => {
        throw new Error('integrity check failed: the plugin changed since you approved it')
      },
    })

    // The refusal is reported with the reason the gates gave, the record reads
    // "off" again, and the file agrees — otherwise the next launch would undo a
    // refusal the user was just told about.
    expect(outcome).toEqual({
      disabled: true,
      refused: 'integrity check failed: the plugin changed since you approved it',
      saved: 'saved',
    })
    expect(isVaultPluginDisabled(ID)).toBe(true)
    expect(await fileDisabledIds()).toEqual([ID])
    // A plugin the record calls off must not be left running.
    expect(deactivateMock).toHaveBeenCalledWith(ID)
  })

  it('keeps a switched-off plugin off when no library can re-run its checks', async () => {
    // Without a vault there is no load to run the gates and no file to record the
    // decision in, so "on" is not a state the app can hold - only a request it
    // has to refuse.
    await setVaultPluginDisabled(ID, true)
    expect(isVaultPluginDisabled(ID)).toBe(true)

    const outcome = await setVaultPluginDisabled(ID, false)

    expect(outcome).toEqual({
      disabled: true,
      refused: 'no library is open to re-run the plugin checks against',
      saved: null,
    })
    expect(isVaultPluginDisabled(ID)).toBe(true)
  })

  it('reads the row out of the record, so a refused switch cannot read as applied', async () => {
    await seedGovernanceFile({ disabled: [ID] })
    await setVaultPluginDisabled(ID, true, { vault: VAULT })

    await setVaultPluginDisabled(ID, false, {
      vault: VAULT,
      reload: async () => {
        throw new Error('revoked')
      },
    })

    const rows = await listVaultPlugins(VAULT)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: ID, disabled: true })
  })
})

describe('what the switch file could be established as', () => {
  // The rule the plugin list itself is held to, one layer down: "nothing here is
  // switched off" and "the file that records it could not be verified" must not
  // look alike. The rows come out of the in-memory record either way, so this
  // value is the only thing that tells the reader which of the two they are
  // looking at — and a panel that draws switches it cannot vouch for is the
  // defect the toggle path was fixed for, one layer up.
  it('reports a verified file, and the rows are its own', async () => {
    await seedGovernanceFile({ disabled: [ID] })

    const listing = await readVaultPlugins(VAULT)

    expect(listing.switches).toBe('verified')
    expect(listing.rows.map((row) => ({ id: row.id, disabled: row.disabled }))).toEqual([
      { id: ID, disabled: true },
    ])
  })

  it('reports a vault with no file yet as absent, which is not a failure', async () => {
    const listing = await readVaultPlugins(VAULT)

    expect(listing.switches).toBe('absent')
    // The row is still drawn, and switched on: a vault that has never had a
    // plugin switched off has no policy to apply, not an unreadable one.
    expect(listing.rows.map((row) => row.disabled)).toEqual([false])
  })

  it('reports a file whose MAC did not verify as tampered, and does not read it', async () => {
    await seedGovernanceFile({ disabled: [ID] })
    tamperSeededFile()

    const listing = await readVaultPlugins(VAULT)

    expect(listing.switches).toBe('tampered')
    // The file's own claim — `disabled: [ID]` — is not applied: an unverified
    // envelope is not a policy, which is the whole reason it has its own answer.
    expect(listing.rows.map((row) => row.disabled)).toEqual([false])
  })

  it('reports both shapes it cannot read as a policy as unreadable', async () => {
    fsMock.files.set(fsKey(PLUGIN_GOVERNANCE_FILE), 'not a MAC envelope at all')
    expect((await readVaultPlugins(VAULT)).switches).toBe('unreadable')

    // The other shape: a genuine envelope over bytes that are not a policy. The
    // MAC proves who wrote it, not that it means anything — and the app leaves
    // both files exactly as they are.
    const envelope = await createMacEnvelope('{ this is not json', KEY)
    fsMock.files.set(fsKey(PLUGIN_GOVERNANCE_FILE), JSON.stringify(envelope))
    expect((await readVaultPlugins(VAULT)).switches).toBe('unreadable')
  })
})
