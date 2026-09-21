/**
 * The governance file's two writers, and the one rule both of them have to obey.
 *
 * The reader's contract names the states this app may not touch: content that is not a MAC envelope
 * ("Present, but not a MAC envelope we wrote — … **Never clobber it**") and an envelope whose MAC
 * does not verify ("TAMPERED"). Neither writer obeyed it. `persistDisabledPlugins` treated a foreign
 * file as "no payload yet" and wrote a fresh one over it; the debounced writer wrote the in-memory
 * records with **no read at all**, so any mutation that schedules a save — trusting a key, revoking
 * a plugin, moving a version range — could replace a file this app never wrote, or one whose MAC had
 * stopped verifying, with a payload that then verifies as ours.
 *
 * These cases assert the **bytes**. "Nothing was written" is exactly the kind of claim a summary can
 * make while the file changes underneath it, so every refusal is checked against the file's content
 * rather than against a return value alone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMacEnvelope } from '@nekowite/plugin-host'
import {
  PLUGIN_GOVERNANCE_FILE,
  PLUGIN_GOVERNANCE_MACKEY_FILE,
  type GovernanceFilePayload,
} from './governance-file'
import {
  loadGovernanceFile,
  persistDisabledPlugins,
  resetGovernanceStoreForTests,
  setDisabledPluginRecord,
  setPluginTrustedKey,
} from './governance-store'

const fsMock = vi.hoisted(() => ({
  files: new Map<string, string>(),
  read: vi.fn(),
  write: vi.fn(),
  stat: vi.fn(),
  list: vi.fn(),
}))

vi.mock('../../../platform/gateways/fs', () => ({
  fsService: {
    read: fsMock.read,
    write: fsMock.write,
    stat: fsMock.stat,
    list: fsMock.list,
  },
}))

const VAULT = '/vault'
const ID = '@scope/q'
/** A known per-install MAC key: seeded where the app would have stored one. */
const KEY = 'b'.repeat(64)

const fileKey = (relative: string): string => `${VAULT}\u0000${relative}`

/** The bytes of the governance file right now, or null when it does not exist. */
const governanceBytes = (): string | null => fsMock.files.get(fileKey(PLUGIN_GOVERNANCE_FILE)) ?? null

/** Seed the file as a MAC-protected payload — what a previous session would have left. */
async function seedGovernanceFile(over: Partial<GovernanceFilePayload> = {}): Promise<void> {
  const payload = JSON.stringify({
    governance: '{}',
    trustedKey: '',
    trustedSources: [],
    digests: {},
    ...over,
  })
  fsMock.files.set(fileKey(PLUGIN_GOVERNANCE_FILE), JSON.stringify(await createMacEnvelope(payload, KEY)))
}

/** A file at that path that this app did not write: someone else's, or a stale read. */
const FOREIGN = '{"note":"this is not a governance envelope"}\n'
function seedForeignFile(): string {
  fsMock.files.set(fileKey(PLUGIN_GOVERNANCE_FILE), FOREIGN)
  return FOREIGN
}

/** The same envelope with its MAC broken: tampered, in the reader's vocabulary. */
async function seedTamperedFile(): Promise<string> {
  await seedGovernanceFile()
  const raw = governanceBytes() ?? ''
  const framed = JSON.parse(raw) as { payload: string }
  const tampered = JSON.stringify({ payload: framed.payload, mac: '0'.repeat(64) })
  fsMock.files.set(fileKey(PLUGIN_GOVERNANCE_FILE), tampered)
  return tampered
}

beforeEach(() => {
  resetGovernanceStoreForTests()
  fsMock.files.clear()
  vi.clearAllMocks()
  fsMock.files.set(fileKey(PLUGIN_GOVERNANCE_MACKEY_FILE), KEY)
  fsMock.read.mockImplementation((vault: string, relative: string) => {
    const content = fsMock.files.get(`${vault}\u0000${relative}`)
    return content === undefined
      ? Promise.reject(new Error(`ENOENT: ${relative}`))
      : Promise.resolve(content)
  })
  fsMock.write.mockImplementation((vault: string, relative: string, content: string) => {
    fsMock.files.set(`${vault}\u0000${relative}`, content)
    return Promise.resolve()
  })
  fsMock.stat.mockRejectedValue(new Error('ENOENT'))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('the switch write, when the file is not ours to overwrite', () => {
  it('leaves a foreign file exactly as it found it, and says the file is unreadable', async () => {
    const planted = seedForeignFile()
    setDisabledPluginRecord(ID, true)

    const result = await persistDisabledPlugins(VAULT, ID)

    expect(result).toBe('unreadable')
    expect(governanceBytes()).toBe(planted)
    // And the write was not even attempted: a `write` that landed and was then followed by a
    // matching-bytes check would pass the assertion above while still having destroyed the file's
    // inode, its mode and its mtime.
    expect(fsMock.write).not.toHaveBeenCalled()
  })

  it('still writes a vault whose file does not exist yet', async () => {
    // The control for the case above: `absent` is a first run, not a refusal, and a guard that
    // refused everything would leave a vault unable to record a decision at all.
    setDisabledPluginRecord(ID, true)

    const result = await persistDisabledPlugins(VAULT, ID)

    expect(result).toBe('saved')
    expect(governanceBytes()).not.toBeNull()
  })
})

describe('the debounced write, which had no read at all', () => {
  /** Drive one debounced save: set a key (a real mutation) and let the timer fire.
   *
   *  Real timers and a real wait, because the write is a promise chain started *inside* the
   *  debounce timer: `vi.runAllTimersAsync()` fires the timer and the first await, and this spec
   *  then asserted before the file write had run — which read as "the writer refused" and was
   *  really "the test looked too early". The debounce is 250 ms; 400 is enough and costs the file
   *  four fifths of a second. */
  async function scheduleOneSave(): Promise<void> {
    await loadGovernanceFile(VAULT)
    setPluginTrustedKey('trusted-key-material')
    await new Promise((resolve) => setTimeout(resolve, 400))
  }

  it('refuses a foreign file, whatever mutation asked for the save', async () => {
    const planted = seedForeignFile()

    await scheduleOneSave()

    expect(governanceBytes()).toBe(planted)
    expect(fsMock.write).not.toHaveBeenCalled()
  })

  it('refuses a file whose MAC stopped verifying', async () => {
    const planted = await seedTamperedFile()

    await scheduleOneSave()

    expect(governanceBytes()).toBe(planted)
    expect(fsMock.write).not.toHaveBeenCalled()
  })

  it('writes when the file is ours and verifies — the control', async () => {
    await seedGovernanceFile()

    await scheduleOneSave()

    // The mutation was persisted: the scheduled write is only refused on the two states that are
    // not ours, and a guard that refused everything would be a different bug.
    expect(fsMock.write).toHaveBeenCalled()
    expect(governanceBytes()).not.toBeNull()
  })

  it('writes a vault with no file yet, which is how the first one is created', async () => {
    await scheduleOneSave()

    expect(governanceBytes()).not.toBeNull()
  })
})
