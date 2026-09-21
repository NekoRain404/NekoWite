import { describe, expect, it } from 'vitest'
import { PET_SETTINGS_DEFAULTS } from './pet-contracts'
import { createMemoryPetGateway, type MemoryPetGateway } from './memory-pet'

/**
 * The same write with the pet switched *off*, which is the two window switches rather than the
 * master: `general.enabled` is derived from them (`characterWindow || ball`), so a write that set
 * only the master would be recomputed to `true` against the schema's two on-by-default switches —
 * and the pet would come back on the next read. That is exactly the defect the derivation and the
 * 3→4 migration exist to prevent, seen from the side that writes.
 */
async function disable(pet: MemoryPetGateway, revision: number): Promise<void> {
  await pet.updateSettings({
    domain: 'general',
    revision,
    values: {
      ...PET_SETTINGS_DEFAULTS.general,
      characterWindow: false,
      ball: false,
      enabled: false,
    },
  })
}

describe('the double publishes the feature state the way the host does', () => {
  it('delivers the current state on subscribe, then every change', async () => {
    const pet = createMemoryPetGateway({ visible: true })
    const seen: string[] = []

    const stop = await pet.subscribeFeature((state) => {
      seen.push(`${state.enabled}/${state.visible}`)
    })
    await pet.setVisible(false)
    await pet.setVisible(true)
    stop()
    await pet.setVisible(false)

    // The first delivery is the state as it is, and the last push reaches nobody: an unsubscribe
    // that only removed one of two routes would show here as a fourth entry.
    expect(seen).toEqual(['true/true', 'true/false', 'true/true'])
  })

  it('publishes a settings write, because that is how the other window’s switch arrives', async () => {
    const pet = createMemoryPetGateway({ visible: true })
    const seen: boolean[] = []
    await pet.subscribeFeature((state) => seen.push(state.enabled))

    await disable(pet, 1)

    // §7.1's way back is a settings page in the main window, so the double has to publish from the
    // write path — a pet window in another window hears about the switch here and nowhere else.
    expect(seen).toEqual([true, false])
    expect(await pet.feature()).toEqual({ enabled: false, visible: false })
  })

  it('publishes nothing when the write was refused', async () => {
    const pet = createMemoryPetGateway({ visible: true })
    const seen: boolean[] = []
    await pet.subscribeFeature((state) => seen.push(state.enabled))

    // A revision that has moved on is refused (§5.3), so the feature did not change — and telling
    // a subscriber otherwise would have the window act on a write that never landed.
    const refused = await pet.updateSettings({
      domain: 'general',
      revision: 99,
      values: {
        ...PET_SETTINGS_DEFAULTS.general,
        characterWindow: false,
        ball: false,
        enabled: false,
      },
    })

    expect(refused.status).toBe('conflict')
    expect(seen).toEqual([true])
  })

  it('publishes every applied write on the settings channel, with the revision it landed on', async () => {
    const pet = createMemoryPetGateway({ visible: true })
    const seen: { domain: string; revision: number }[] = []
    const stop = await pet.subscribeSettings((change) => seen.push(change))

    await pet.updateSettings({
      domain: 'character',
      revision: 1,
      values: { ...PET_SETTINGS_DEFAULTS.character, characterId: 'kitty' },
    })
    await pet.updateSettings({
      domain: 'character',
      revision: 2,
      values: { ...PET_SETTINGS_DEFAULTS.character, characterId: null },
    })
    stop()
    await pet.updateSettings({
      domain: 'character',
      revision: 3,
      values: { ...PET_SETTINGS_DEFAULTS.character, characterId: 'kitty' },
    })

    // The channel the pet window draws from (§5.1's 角色与动画): a character chosen in the main
    // window's settings has to reach a window that is already open, and this is the write path
    // that carries it — a *character* write, unlike the feature channel, which only fires for
    // `general`. The revision is the record's own, so a listener can tell which state to re-read.
    expect(seen).toEqual([
      { domain: 'character', revision: 2 },
      { domain: 'character', revision: 3 },
    ])

    // And a write that was refused says nothing, for the reason the feature channel says nothing:
    // the store did not move, so a listener that re-read would be re-reading the same record.
    const refused = await pet.updateSettings({
      domain: 'character',
      revision: 1,
      values: { ...PET_SETTINGS_DEFAULTS.character },
    })
    expect(refused.status).toBe('conflict')
    expect(seen).toHaveLength(2)
  })

  it('publishes nothing for a write to another domain', async () => {
    const pet = createMemoryPetGateway({ visible: true })
    const seen: boolean[] = []
    await pet.subscribeFeature((state) => seen.push(state.enabled))

    // The feature switch is `general.enabled` and nothing else: a care or bubble write is not a
    // reason to tell every pet window that the feature changed.
    await pet.updateSettings({
      domain: 'care',
      revision: 1,
      values: { ...PET_SETTINGS_DEFAULTS.care },
    })

    expect(seen).toEqual([true])
  })
})
