/**
 * The session's three clauses, as tests: the last edit before a close survives, a failed save
 * stays retryable and never reads as a success, and a refused write reloads instead of merging.
 *
 * The clock is faked before the session is created, so the debounce window is a thing a test
 * holds open and steps through rather than a race it hopes to win — the same device
 * `use-sidebar-tags-flush.test.ts` uses for the same reason. The writes go to D1's real memory
 * gateway where the paths are real (the revision rule included), and to a stub only for the arms
 * a store with defaults cannot produce: an absent record, a newer schema, a record of another
 * domain.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PET_SETTINGS_DEFAULTS,
  PET_SETTINGS_SCHEMA_VERSION,
} from '../../../platform/gateways/pet-contracts'
import type {
  PetSettingsLoad,
  PetSettingsRecord,
  PetSettingsUpdate,
  PetSettingsWrite,
} from '../../../platform/gateways/pet-contracts'
import { createMemoryPetGateway } from '../../../platform/gateways/memory-pet'
import {
  PET_SETTINGS_INITIAL_REVISION,
  petSettingsRecordFor,
  type PetSettingsRecordFor,
} from '../services/pet-settings-policy'
import { PET_SETTINGS_DEBOUNCE_MS, usePetSettings, type PetSettingsAuthority } from './use-pet-settings'

/** Past the debounce window, with the microtasks behind it drained. */
const tick = async (ms = PET_SETTINGS_DEBOUNCE_MS): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms)
  for (let i = 0; i < 3; i++) await vi.advanceTimersByTimeAsync(0)
}

/** An authority that answers what a test hands it, for the arms the double cannot produce. */
function stubAuthority(
  load: PetSettingsLoad,
  update?: PetSettingsUpdate,
): PetSettingsAuthority & { writes: PetSettingsWrite[] } {
  const writes: PetSettingsWrite[] = []
  return {
    writes,
    async readSettings() {
      return load
    },
    async updateSettings(write) {
      writes.push(write)
      return update ?? { status: 'failed', message: 'no answer configured' }
    },
  }
}

/** A stored record of `domain` with the values of this build's defaults replaced. */
function storedRecord(
  domain: 'general' | 'view',
  values: Record<string, unknown>,
  revision = PET_SETTINGS_INITIAL_REVISION + 1,
): PetSettingsRecord {
  return {
    domain,
    schemaVersion: PET_SETTINGS_SCHEMA_VERSION,
    revision,
    values: { ...PET_SETTINGS_DEFAULTS[domain], ...values },
  } as unknown as PetSettingsRecord
}

/** What the store now holds for one domain, read the way a caller has to read it. */
async function storedRecordOf<D extends keyof typeof PET_SETTINGS_DEFAULTS>(
  gateway: PetSettingsAuthority,
  domain: D,
): Promise<PetSettingsRecordFor<D>> {
  const loaded = await gateway.readSettings(domain)
  if (loaded.status !== 'current') throw new Error(`expected current, got ${loaded.status}`)
  // The load arms carry the record as the contract's union, so a caller names the domain to get
  // the arm back — the same pairing the write path checks.
  const record = petSettingsRecordFor(loaded.record, domain)
  if (record === null) throw new Error('the store answered for another domain')
  return record
}

describe('the draft, the debounce and the close path', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('reads the domain and holds no unsaved change', async () => {
    const gateway = createMemoryPetGateway()
    const session = usePetSettings({ authority: gateway, domain: 'general' })
    expect(session.status.value).toBe('loading')
    await session.load()
    expect(session.status.value).toBe('ready')
    expect(session.values.value).toEqual(PET_SETTINGS_DEFAULTS.general)
    expect(session.dirty.value).toBe(false)
  })

  it('shows the edit at once and writes nothing until the window is over', async () => {
    // §5.3's 试调外观即时预览, and the other half of it: the preview is not the confirmation.
    const gateway = createMemoryPetGateway()
    const write = vi.spyOn(gateway, 'updateSettings')
    const session = usePetSettings({ authority: gateway, domain: 'general' })
    await session.load()

    session.edit('enabled', false)
    expect(session.values.value.enabled).toBe(false)
    expect(session.status.value).toBe('pending')
    expect(session.dirty.value).toBe(true)
    expect(write).not.toHaveBeenCalled()

    await tick()
    expect(write).toHaveBeenCalledTimes(1)
    expect(write.mock.calls[0]?.[0]).toEqual({
      domain: 'general',
      revision: 1,
      values: { ...PET_SETTINGS_DEFAULTS.general, enabled: false },
    })
    expect(session.status.value).toBe('saved')
    expect(session.dirty.value).toBe(false)
  })

  it('writes the last edit when the page closes inside the debounce window', async () => {
    // §5.3's 「防抖写入不得丢掉关闭设置前最后一次修改」: the clock never reaches the window, so the
    // only thing that can publish this edit is the settle the close path awaits.
    const gateway = createMemoryPetGateway()
    const write = vi.spyOn(gateway, 'updateSettings')
    const session = usePetSettings({ authority: gateway, domain: 'general' })
    await session.load()

    session.edit('motion', 'reduced')
    await session.settle()

    expect(write).toHaveBeenCalledTimes(1)
    expect(write.mock.calls[0]?.[0]?.values).toEqual({ ...PET_SETTINGS_DEFAULTS.general, motion: 'reduced' })
    expect(session.status.value).toBe('saved')
  })

  it('coalesces edits inside one window to the value the user stopped on', async () => {
    const gateway = createMemoryPetGateway()
    const write = vi.spyOn(gateway, 'updateSettings')
    const session = usePetSettings({ authority: gateway, domain: 'view' })
    await session.load()

    session.edit('opacity', 0.4)
    await tick(100)
    session.edit('opacity', 0.9)
    await tick()
    // One write, and not one per step: a slider drag is a dozen edits and one revision.
    expect(write).toHaveBeenCalledTimes(1)
    expect(write.mock.calls[0]?.[0]?.values).toEqual({ ...PET_SETTINGS_DEFAULTS.view, opacity: 0.9 })
    expect(session.status.value).toBe('saved')
  })

  it('carries the revision the last write produced, so a session cannot conflict with itself', async () => {
    const gateway = createMemoryPetGateway()
    const session = usePetSettings({ authority: gateway, domain: 'general' })
    await session.load()

    session.edit('enabled', false)
    await tick()
    session.edit('motion', 'reduced')
    await tick()

    // The second write has to be built from revision 2, or the store refuses it as stale and the
    // user's second change is reported as somebody else's edit.
    expect(session.status.value).toBe('saved')
    const stored = await storedRecordOf(gateway, 'general')
    expect(stored.values).toEqual({ enabled: false, motion: 'reduced', ball: true })
    expect(stored.revision).toBe(3)
  })

  it('keeps an edit made while a write is in flight', async () => {
    const gateway = createMemoryPetGateway()
    const session = usePetSettings({ authority: gateway, domain: 'general' })
    await session.load()

    session.edit('enabled', false)
    const first = session.save()
    // The write has been issued and has not answered yet.
    session.edit('motion', 'reduced')
    await first

    expect(session.status.value).toBe('pending')
    expect(session.dirty.value).toBe(true)
    expect(session.values.value).toEqual({ enabled: false, motion: 'reduced', ball: true })
    await tick()
    expect(session.status.value).toBe('saved')
    expect((await storedRecordOf(gateway, 'general')).values).toEqual({
      enabled: false,
      motion: 'reduced',
      ball: true,
    })
  })
})

describe('a save that did not happen', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('leaves the edit with the user, keeps the write retryable, and does not claim success', async () => {
    const gateway = createMemoryPetGateway({ writeFailures: 1 })
    const session = usePetSettings({ authority: gateway, domain: 'general' })
    await session.load()

    session.edit('enabled', false)
    await session.settle()
    expect(session.status.value).toBe('failed')
    expect(session.dirty.value).toBe(true)
    expect(session.values.value.enabled).toBe(false)
    expect(session.problem.value).toBe('the settings could not be written')

    await session.save()
    expect(session.status.value).toBe('saved')
    expect(session.dirty.value).toBe(false)
    expect((await storedRecordOf(gateway, 'general')).values.enabled).toBe(false)
  })

  it('refuses a value the store would refuse, without asking it', async () => {
    // §5.3's 「界面和后端使用同一规则」: the page applies the same rule the store will, so an
    // impossible value never becomes a round trip the user waits on.
    const gateway = createMemoryPetGateway()
    const write = vi.spyOn(gateway, 'updateSettings')
    const session = usePetSettings({ authority: gateway, domain: 'view' })
    await session.load()

    session.edit('opacity', 42)
    await session.settle()
    expect(session.status.value).toBe('invalid')
    expect(session.problem.value).toBe('view.opacity:out-of-range')
    expect(write).not.toHaveBeenCalled()
  })

  it('reports a store that answered for another domain instead of reading it anyway', async () => {
    const authority = stubAuthority({
      status: 'current',
      record: storedRecord('view', { opacity: 0.5 }),
    })
    const session = usePetSettings({ authority, domain: 'general' })
    await session.load()
    expect(session.status.value).toBe('failed')
    expect(session.problem.value).toContain('view')
    expect(session.values.value).toEqual(PET_SETTINGS_DEFAULTS.general)
  })
})

describe('a refusal is a reload, not a merge', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('replaces the draft with what the store holds when another window moved first', async () => {
    const gateway = createMemoryPetGateway()
    const other = usePetSettings({ authority: gateway, domain: 'view' })
    const session = usePetSettings({ authority: gateway, domain: 'view' })
    await other.load()
    await session.load()

    // The other window writes first and succeeds, so the revision this session read is stale.
    other.edit('opacity', 0.3)
    await other.settle()
    expect(other.status.value).toBe('saved')

    session.edit('opacity', 0.9)
    await session.settle()
    expect(session.status.value).toBe('conflict')
    // The edit is gone and the other window's value is what the page now shows: merging either
    // way would undo the change somebody else just made (§5.3).
    expect(session.values.value.opacity).toBe(0.3)
    expect((await storedRecordOf(gateway, 'view')).values.opacity).toBe(0.3)
  })

  it('treats the newer-schema refusal as read-only, and stops writing', async () => {
    const authority = stubAuthority({
      status: 'read-only',
      reason: 'schema-newer',
      foundVersion: PET_SETTINGS_SCHEMA_VERSION + 1,
    })
    const session = usePetSettings({ authority, domain: 'general' })
    await session.load()
    expect(session.status.value).toBe('read-only')
    expect(session.values.value).toEqual(PET_SETTINGS_DEFAULTS.general)

    session.edit('enabled', false)
    await session.settle()
    // Nothing may be written over data from a newer build, and the page says why rather than
    // showing a form that pretends to save.
    expect(authority.writes).toEqual([])
    expect(session.status.value).toBe('read-only')
  })
})

describe('loading the arms a store with defaults cannot produce', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders this build’s defaults when the record is absent, and writes at its own revision', async () => {
    const authority = stubAuthority(
      {
        status: 'defaults',
        reason: 'absent',
        record: {
          domain: 'general',
          schemaVersion: PET_SETTINGS_SCHEMA_VERSION,
          revision: PET_SETTINGS_INITIAL_REVISION,
          values: PET_SETTINGS_DEFAULTS.general,
        } as PetSettingsRecord,
      },
      {
        status: 'applied',
        record: {
          domain: 'general',
          schemaVersion: PET_SETTINGS_SCHEMA_VERSION,
          revision: PET_SETTINGS_INITIAL_REVISION + 1,
          values: { ...PET_SETTINGS_DEFAULTS.general, enabled: false },
        } as PetSettingsRecord,
      },
    )
    const session = usePetSettings({ authority, domain: 'general' })
    await session.load()
    expect(session.status.value).toBe('ready')

    session.edit('enabled', false)
    await session.settle()
    expect(authority.writes).toEqual([
      { domain: 'general', revision: PET_SETTINGS_INITIAL_REVISION, values: { ...PET_SETTINGS_DEFAULTS.general, enabled: false } },
    ])
  })

  it('does not write an upgrade back on load: the backup and the migration are the store’s', async () => {
    const authority = stubAuthority({
      status: 'migrated',
      fromVersion: 0,
      repaired: ['general.motion'],
      record: storedRecord('general', { motion: 'system' }),
    })
    const session = usePetSettings({ authority, domain: 'general' })
    await session.load()
    expect(session.status.value).toBe('ready')
    expect(authority.writes).toEqual([])
  })
})

describe('the scoped reset', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('writes this domain’s defaults through the same revision-checked path', async () => {
    const authority = stubAuthority(
      {
        status: 'current',
        record: storedRecord('general', { enabled: false, motion: 'reduced' }, 4),
      },
      {
        status: 'applied',
        record: storedRecord('general', {}, 5),
      },
    )
    const session = usePetSettings({ authority, domain: 'general' })
    await session.load()

    session.resetDomain()
    expect(session.values.value).toEqual(PET_SETTINGS_DEFAULTS.general)
    await session.settle()
    expect(authority.writes).toEqual([
      { domain: 'general', revision: 4, values: PET_SETTINGS_DEFAULTS.general },
    ])
    expect(session.status.value).toBe('saved')
  })

  it('writes nothing when the domain is already at its defaults', async () => {
    const gateway = createMemoryPetGateway()
    const write = vi.spyOn(gateway, 'updateSettings')
    const session = usePetSettings({ authority: gateway, domain: 'general' })
    await session.load()

    session.resetDomain()
    await session.settle()
    // A write that changes nothing still moves the revision, and every other window's open form
    // becomes a conflict for it.
    expect(session.dirty.value).toBe(false)
    expect(write).not.toHaveBeenCalled()
  })
})

describe('dispose', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('stops the timer and leaves the pending edit visibly unsaved', async () => {
    const gateway = createMemoryPetGateway()
    const write = vi.spyOn(gateway, 'updateSettings')
    const session = usePetSettings({ authority: gateway, domain: 'general' })
    await session.load()

    session.edit('enabled', false)
    session.dispose()
    await tick(5_000)
    // The close path is `settle`, which the caller awaits; a flush fired from a teardown is a
    // write nobody waits for. What is left behind stays dirty, so the drop is visible.
    expect(write).not.toHaveBeenCalled()
    expect(session.dirty.value).toBe(true)
  })
})
