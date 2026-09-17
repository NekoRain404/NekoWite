/**
 * D7d's acceptance, as tests: every field the ledger's remaining animation, phrase and layout
 * rows needed is saved, and comes back.
 *
 * The ledger's 角色与动画 and 气泡与消息 rows could not be drawn as controls because there was
 * nowhere to save them: `character` declared two fields and `message` two, and the rows need
 * seventeen more between them. D7d added them — thirteen that fit the kinds already there and
 * six that needed a fifth — and the clause that has to hold for each one is the clause the
 * delivered pages were held to: **change the value, wait out the write, and read the store
 * back.** D7b's report states the standard as 「change the control, wait out the write, read
 * the store, close the dialog, reopen it, find the value」, and every case below does all
 * four steps.
 *
 * The path is the real one throughout: the session's `edit` → `petSettingsWrite` →
 * `decidePetSettingsWrite` → D1's `createMemoryPetGateway` (revision check included) → the
 * store's own `readSettings`. Nothing here asserts a component's internal state, and nothing
 * here writes to the store by hand — a case that passed by seeding a value would prove
 * nothing about the field it names.
 *
 * What this file cannot say is that anything *reads* these values. The schema is the half
 * D7d owns; the rows that would draw a control are D7b's and D7c's pages, and the renderers
 * that would act on the animation and layout fields are D2's and D9's. §5.2's 「不显示可点击
 * 但无效果的控件」 is the constraint on whoever draws them, and it is why this file's job
 * stops at "the value is representable and survives a save".
 */
import { describe, expect, it } from 'vitest'
import {
  PET_SETTINGS_DEFAULTS,
  PET_SETTINGS_SCHEMA_VERSION,
} from '../../../platform/gateways/pet-contracts'
import type { PetSettingsDomain } from '../../../platform/gateways/pet-contracts'
import { createMemoryPetGateway, type MemoryPetGateway } from '../../../platform/gateways/memory-pet'
import { usePetSettings } from '../composables/use-pet-settings'

/** One field of one domain, and a value of it that is not that field's default. */
interface RoundTrip {
  domain: PetSettingsDomain
  field: string
  value: unknown
}

/**
 * Every field D7d added, with upstream's own reason for it in the row.
 *
 * The values are all *different from the schema's default* on purpose — a case that wrote the
 * default back would pass against a store that ignores writes.
 */
const ROUND_TRIPS: RoundTrip[] = [
  // 角色与动画: upstream `ap_idle_mode`, `ap_idle_interval`, `ap_idle_clips`, `ap_bind_<mood>`.
  { domain: 'character', field: 'idleMode', value: 'sequential' },
  { domain: 'character', field: 'idleIntervalSeconds', value: 30 },
  { domain: 'character', field: 'idleClips', value: [1, 3, 5] },
  { domain: 'character', field: 'bindings', value: { idle: 0, working: 7, waiting: 6 } },
  // 气泡与消息: upstream `ap_font_size`, `ap_idle`, `ap_bub_*`, `ap_theme_phrases`,
  // `ap_left_click_action`, `ap_quick_bubbles`, `ap_icon_<agentKind>`.
  { domain: 'message', field: 'fontSize', value: 14 },
  { domain: 'message', field: 'idle', value: false },
  { domain: 'message', field: 'layoutMode', value: 'carousel' },
  { domain: 'message', field: 'layoutMaxRows', value: 9 },
  { domain: 'message', field: 'grouping', value: 'flat' },
  { domain: 'message', field: 'sortByKind', value: true },
  { domain: 'message', field: 'filter', value: 'attention' },
  { domain: 'message', field: 'dot', value: 'claude' },
  { domain: 'message', field: 'separator', value: 'space' },
  { domain: 'message', field: 'phraseTheme', value: 'wizard' },
  { domain: 'message', field: 'leftClick', value: 'all' },
  { domain: 'message', field: 'hiddenAgents', value: ['opencode'] },
  {
    domain: 'message',
    field: 'tokens',
    value: [
      { token: 'dot', visible: true },
      { token: 'agent', visible: true },
      { token: 'elapsed', visible: false },
    ],
  },
  { domain: 'message', field: 'quickBubbles', value: ['Hello!', 'Need a break?'] },
  { domain: 'message', field: 'agentIcons', value: { opencode: 'sym:zap', claude: 'brand:claude' } },
]

/** This build's default for one field, by name: the schema's own answer, never a literal. */
function defaultOf(domain: PetSettingsDomain, field: string): unknown {
  return (PET_SETTINGS_DEFAULTS[domain] as Record<string, unknown>)[field]
}

/** One domain's values as the store holds them, read the way a caller has to read them. */
async function storedValues(
  gateway: MemoryPetGateway,
  domain: PetSettingsDomain,
): Promise<Record<string, unknown>> {
  const loaded = await gateway.readSettings(domain)
  if (loaded.status !== 'current') throw new Error(`expected current, got ${loaded.status}`)
  const record = loaded.record
  if (record.domain !== domain) throw new Error(`the store answered for ${record.domain}`)
  return record.values as unknown as Record<string, unknown>
}

/** A session on one domain, loaded, with its `edit` typed loosely enough for a field name. */
async function openSession(
  gateway: MemoryPetGateway,
  domain: PetSettingsDomain,
): Promise<{
  values: Record<string, unknown>
  dirty: boolean
  status: string
  edit: (field: string, value: unknown) => void
  settle: () => Promise<void>
  dispose: () => void
}> {
  const session = usePetSettings({ authority: gateway, domain })
  await session.load()
  return {
    get values() {
      return session.values.value as unknown as Record<string, unknown>
    },
    get dirty() {
      return session.dirty.value
    },
    get status() {
      return session.status.value
    },
    edit: session.edit as unknown as (field: string, value: unknown) => void,
    settle: session.settle,
    dispose: session.dispose,
  }
}

describe('every field D7d added', () => {
  it('is declared by the schema, and the version says so', () => {
    // The bump is what makes §10.2 protect the new fields: a build that only knows the older
    // version meets the newer record and leaves it alone instead of defaulting what it cannot
    // read. The number moved to 3 when `general.characterWindow` arrived, and it is written out
    // here rather than compared with itself so that the next bump comes through this line.
    expect(PET_SETTINGS_SCHEMA_VERSION).toBe(3)
    for (const { domain, field } of ROUND_TRIPS) {
      expect(Object.keys(PET_SETTINGS_DEFAULTS[domain])).toContain(field)
    }
  })

  it('starts at the schema’s default, so every case below is a real change', async () => {
    const gateway = createMemoryPetGateway()
    for (const { domain, field, value } of ROUND_TRIPS) {
      const session = await openSession(gateway, domain)
      expect(session.values[field]).toEqual(defaultOf(domain, field))
      expect(session.values[field]).not.toEqual(value)
      session.dispose()
    }
  })

  it('saves what it was given, and the store holds it', async () => {
    const gateway = createMemoryPetGateway()
    for (const { domain, field, value } of ROUND_TRIPS) {
      const session = await openSession(gateway, domain)
      session.edit(field, value)
      // The draft moved, so the case is not passing because the write was skipped as unchanged.
      expect(session.dirty).toBe(true)
      await session.settle()
      expect(session.status).toBe('saved')
      expect((await storedValues(gateway, domain))[field]).toEqual(value)
      session.dispose()
    }
  })

  it('is still there when the page is closed and opened again', async () => {
    // D7b's standard, verbatim: the dialog is unmounted and reopened, and the value is read
    // back through a *new* session at the revision the store is now at.
    const gateway = createMemoryPetGateway()
    for (const { domain, field, value } of ROUND_TRIPS) {
      const first = await openSession(gateway, domain)
      first.edit(field, value)
      await first.settle()
      first.dispose()

      const reopened = await openSession(gateway, domain)
      expect(reopened.values[field]).toEqual(value)
      expect(reopened.dirty).toBe(false)
      reopened.dispose()
    }
  })

  it('saves a whole domain of them in one write, for each domain that gained fields', async () => {
    // One write, not one per field: §5.3's write is the domain, and a field that only survives
    // alone would be a field that disappears the moment a page saves everything it holds.
    for (const domain of ['character', 'message'] as const) {
      const gateway = createMemoryPetGateway()
      const wanted = ROUND_TRIPS.filter((row) => row.domain === domain)
      const session = await openSession(gateway, domain)
      for (const { field, value } of wanted) session.edit(field, value)
      await session.settle()
      expect(session.status).toBe('saved')

      const stored = await storedValues(gateway, domain)
      const expected = { ...PET_SETTINGS_DEFAULTS[domain] }
      for (const { field, value } of wanted) (expected as Record<string, unknown>)[field] = value
      expect(stored).toEqual(expected)

      const reopened = await openSession(gateway, domain)
      for (const { field, value } of wanted) expect(reopened.values[field]).toEqual(value)
      reopened.dispose()
      session.dispose()
    }
  })
})

describe('a new field refuses what it cannot hold, and keeps what the store had', () => {
  it('is refused whole when one added field is unusable, and the store is untouched', async () => {
    const gateway = createMemoryPetGateway()
    const session = await openSession(gateway, 'character')
    const before = await storedValues(gateway, 'character')
    session.edit('idleClips', [0, -1])
    await session.settle()
    // §5.3's 「保存失败展示错误并保持可重试状态，不伪装成功」: the read-only store would have
    // applied a prefix, and the draft would then differ from what is stored with nothing said.
    expect(session.status).toBe('invalid')
    expect(await storedValues(gateway, 'character')).toEqual(before)
    session.dispose()
  })

  it('does not write a draft that only looks different', async () => {
    // Structural equality, seen through the session: a distinct object holding the same members
    // is not a change, and a write that changes nothing still moves the revision and turns
    // every other window's open form into a conflict.
    const gateway = createMemoryPetGateway()
    const session = await openSession(gateway, 'character')
    session.edit('idleClips', [...PET_SETTINGS_DEFAULTS.character.idleClips])
    session.edit('bindings', { ...PET_SETTINGS_DEFAULTS.character.bindings })
    expect(session.dirty).toBe(false)

    session.edit('bindings', { working: 7 })
    expect(session.dirty).toBe(true)
    await session.settle()
    expect((await storedValues(gateway, 'character')).bindings).toEqual({ working: 7 })
    session.dispose()
  })
})
